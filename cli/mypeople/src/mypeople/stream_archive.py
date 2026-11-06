"""Bounded, authenticated file archives. Raw content-addressed blobs never need
Base64 expansion or one enormous in-memory AES-GCM/JSON document.
"""
from __future__ import annotations

import base64
from collections.abc import Mapping
from contextlib import contextmanager
import hashlib
import io
import json
import os
from pathlib import Path
import re
import struct
import tempfile
import zipfile

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MAGIC = b"SHERLOQ2"
FRAME = 1024 * 1024
MAX_BYTES = 4 * 1024**3
MAX_FILE = MAX_BYTES + 1024**2
MAX_METADATA = 128 * 1024**2
MAX_BLOB = 128 * 1024**2
HASH = re.compile(r"[0-9a-f]{64}\Z")


def _key(password, salt):
    raw = password.encode("ascii")
    if len(raw) < 12:
        raise ValueError("Transfer passphrase must contain at least 12 ASCII characters")
    return hashlib.pbkdf2_hmac("sha256", raw, salt, 200_000, 32)


def encrypt(source, destination, password):
    salt, prefix = os.urandom(16), os.urandom(4)
    header = MAGIC + salt + prefix
    cipher = AESGCM(_key(password, salt))
    destination.write(header)
    sequence = total = 0
    while True:
        plain = source.read(FRAME)
        total += len(plain)
        if total > MAX_BYTES:
            raise ValueError("Archive exceeds the streaming size limit")
        nonce = prefix + struct.pack(">Q", sequence)
        aad = header + struct.pack(">QI", sequence, len(plain))
        destination.write(struct.pack(">I", len(plain)))
        destination.write(cipher.encrypt(nonce, plain, aad))
        sequence += 1
        if not plain:
            break


def _read(source, size):
    value = source.read(size)
    if len(value) != size:
        raise ValueError("Truncated streaming archive")
    return value


def decrypt(source, destination, password):
    header = _read(source, 28)
    if header[:8] != MAGIC:
        raise ValueError("Unsupported streaming archive")
    cipher = AESGCM(_key(password, header[8:24]))
    prefix = header[24:28]
    sequence = total = 0
    while True:
        size = struct.unpack(">I", _read(source, 4))[0]
        if size > FRAME:
            raise ValueError("Invalid encrypted archive frame")
        total += size
        if total > MAX_BYTES:
            raise ValueError("Archive exceeds the streaming size limit")
        nonce = prefix + struct.pack(">Q", sequence)
        aad = header + struct.pack(">QI", sequence, size)
        try:
            plain = cipher.decrypt(nonce, _read(source, size + 16), aad)
        except Exception:
            raise ValueError("Incorrect passphrase or damaged streaming archive") from None
        if size == 0:
            if source.read(1):
                raise ValueError("Trailing encrypted archive data")
            break
        destination.write(plain)
        sequence += 1


def is_streaming(path):
    with Path(path).open("rb") as source:
        return source.read(8) == MAGIC


class FileBlobs(Mapping):
    def __init__(self, directory, hashes):
        self.directory = Path(directory)
        self.hashes = frozenset(hashes)

    def __len__(self):
        return len(self.hashes)

    def __iter__(self):
        return iter(self.hashes)

    def __getitem__(self, key):
        if key not in self.hashes:
            raise KeyError(key)
        return base64.b64encode((self.directory / key).read_bytes()).decode("ascii")

    def open_raw(self, key):
        if key not in self.hashes:
            raise KeyError(key)
        return (self.directory / key).open("rb")


class SqlBlobs(Mapping):
    def __init__(self, conn, rows):
        self.conn = conn
        self.rows = {r[0]: (r[1], r[2]) for r in rows}  # hash, rowid, byte size
        self.raw_bytes = sum(v[1] for v in self.rows.values())

    def __len__(self):
        return len(self.rows)

    def __iter__(self):
        return iter(self.rows)

    def __getitem__(self, key):
        with self.open_raw(key) as source:
            return base64.b64encode(source.read()).decode("ascii")

    def open_raw(self, key):
        return self.conn.blobopen("graph_blobs", "content", self.rows[key][0], readonly=True)


def _copy(source, destination, limit, expected=None):
    digest = hashlib.sha256()
    size = 0
    while chunk := source.read(65536):
        size += len(chunk)
        if size > limit:
            raise ValueError("Streaming archive entry exceeds its size limit")
        digest.update(chunk)
        destination.write(chunk)
    if expected is not None and digest.hexdigest() != expected:
        raise ValueError("Damaged graph blob")
    return size


def write_memory(manifest, path, password, photos=None):
    graph = manifest["graph"]
    blobs = graph["blobs"]
    photos = photos or {}
    metadata = {"format": 2, "kind": "memory", "memory": manifest | {"graph": graph | {"blobs": {}}},
                "blob_hashes": sorted(blobs), "photo_hashes": sorted(photos)}
    if len(blobs) > 1_000_000 or len(photos) > 10000 or any(not HASH.fullmatch(h) for h in (*blobs, *photos)):
        raise ValueError("Invalid streaming archive inventory")
    # Anonymous, owner-only scratch storage. Never an export in the checkout.
    with tempfile.TemporaryFile() as plain:
        with zipfile.ZipFile(plain, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
            raw = json.dumps(metadata, ensure_ascii=False, separators=(",", ":")).encode()
            if len(raw) > MAX_METADATA:
                raise ValueError("Streaming metadata exceeds its size limit")
            archive.writestr("metadata.json", raw)
            for key in metadata["blob_hashes"]:
                source = blobs.open_raw(key) if hasattr(blobs, "open_raw") else io.BytesIO(base64.b64decode(blobs[key], validate=True))
                with source, archive.open(f"blobs/{key}", "w", force_zip64=True) as out:
                    _copy(source, out, MAX_BLOB, key)
            for key, name in photos.items():
                with Path(name).open("rb") as source, archive.open(f"photos/{key}", "w", force_zip64=True) as out:
                    _copy(source, out, 10 * 1024**2, key)
        if plain.tell() > MAX_BYTES:
            raise ValueError("Archive exceeds the streaming size limit")
        plain.seek(0)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=Path(path).parent, prefix=".encrypted-", delete=False) as out:
                temporary = Path(out.name)
                encrypt(plain, out, password)
                out.flush()
                os.fsync(out.fileno())
            os.replace(temporary, path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)


@contextmanager
def read_memory(path, password):
    if Path(path).stat().st_size > MAX_FILE:
        raise ValueError("Streaming archive exceeds its size limit")
    with tempfile.TemporaryDirectory(prefix="mypeople-authenticated-") as temporary:
        directory = Path(temporary)
        plain = directory / "archive.zip"
        with Path(path).open("rb") as source, plain.open("wb") as out:
            decrypt(source, out, password)
        blob_dir = directory / "blobs"
        blob_dir.mkdir()
        with zipfile.ZipFile(plain) as archive:
            entries = archive.infolist()
            names = [e.filename for e in entries]
            if not names or names[0] != "metadata.json" or len(set(names)) != len(names) or len(names) > 1_010_002:
                raise ValueError("Invalid streaming archive entries")
            if entries[0].file_size > MAX_METADATA or sum(e.file_size for e in entries) > MAX_BYTES:
                raise ValueError("Streaming archive exceeds its size limit")
            metadata = json.loads(archive.read(entries[0]))
            if not isinstance(metadata, dict) or metadata.get("format") != 2 or metadata.get("kind") != "memory":
                raise ValueError("Choose a memory file, not a phone backup")
            expected = metadata.get("blob_hashes", [])
            photos = metadata.get("photo_hashes", [])
            if (not isinstance(expected, list) or len(expected) > 1_000_000
                    or not isinstance(photos, list) or len(photos) > 10000
                    or any(not isinstance(h, str) or not HASH.fullmatch(h) for h in (*expected, *photos))
                    or len(set(expected)) != len(expected) or len(set(photos)) != len(photos)):
                raise ValueError("Invalid streaming archive inventory")
            allowed = {"metadata.json", *(f"blobs/{h}" for h in expected), *(f"photos/{h}" for h in photos)}
            if set(names) != allowed or any(e.is_dir() for e in entries):
                raise ValueError("Incomplete or unsafe streaming archive")
            for key in expected:
                with archive.open(f"blobs/{key}") as source, (blob_dir / key).open("wb") as out:
                    _copy(source, out, MAX_BLOB, key)
            for key in photos:
                with archive.open(f"photos/{key}") as source, open(os.devnull, "wb") as discard:
                    _copy(source, discard, 10 * 1024**2, key)
            manifest = metadata.get("memory")
            if not isinstance(manifest, dict) or not isinstance(manifest.get("graph"), dict):
                raise ValueError("Missing graph metadata")
            if manifest["graph"].get("blobs") != {}:
                raise ValueError("Inline graph blobs are not permitted in file format 2")
            manifest["graph"]["blobs"] = FileBlobs(blob_dir, expected)
            yield manifest
