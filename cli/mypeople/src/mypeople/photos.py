"""Profile pictures, collected from sources you already have.

- WhatsApp Desktop caches the profile photos of people you chat with under
  Media/Profile, and ChatStorage.sqlite records whose photo each file is.
- Contacts.app keeps each contact's photo in its AddressBook databases, including
  the ones people share with you over iMessage ("Share Name and Photo").
- Google Contacts serves each contact's photo through the People API.
"""

from __future__ import annotations

import re
import sqlite3
import urllib.request
from pathlib import Path

from . import identity
from .importers.whatsapp import DEFAULT_DIR, Directory


def photo_dir(conn: sqlite3.Connection) -> Path:
    """Next to the database file (a temp folder for in-memory test databases)."""
    db_file = conn.execute("PRAGMA database_list").fetchone()["file"]
    if not db_file:
        import tempfile

        return Path(tempfile.gettempdir()) / "mypeople-photos"
    return Path(db_file).parent / "photos"


def jpeg_width(data: bytes) -> int:
    """Width from a JPEG's frame header, or 0 if it can't be read."""
    i = 2
    while i + 9 < len(data) and data[0:2] == b"\xff\xd8":
        if data[i] != 0xFF:
            return 0
        marker, length = data[i + 1], int.from_bytes(data[i + 2 : i + 4], "big")
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            return int.from_bytes(data[i + 7 : i + 9], "big")
        i += 2 + length
    return 0


def image_width(data: bytes) -> int:
    """Width of a JPEG or PNG, or 0 if it's neither."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return int.from_bytes(data[16:20], "big")
    return jpeg_width(data)


def save(conn: sqlite3.Connection, person_id: int, source: str, data: bytes) -> bool:
    """Keep the larger of this and any photo already saved from the same source."""
    width = image_width(data)
    if not width:
        return False
    current = conn.execute("SELECT width, path FROM photos WHERE person_id = ? AND source = ?", (person_id, source)).fetchone()
    if current and current["width"] >= width and Path(current["path"]).is_file():
        return False
    folder = photo_dir(conn)
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{person_id}-{source}.{'png' if data[:4] == b'\x89PNG' else 'jpg'}"
    path.write_bytes(data)
    conn.execute(
        "INSERT INTO photos (person_id, source, path, width) VALUES (?, ?, ?, ?) "
        "ON CONFLICT (person_id, source) DO UPDATE SET path = excluded.path, width = excluded.width",
        (person_id, source, str(path), width),
    )
    return True


def best(conn: sqlite3.Connection, person_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM photos WHERE person_id = ? ORDER BY width DESC LIMIT 1", (person_id,)).fetchone()


def collect_whatsapp(conn: sqlite3.Connection, root: Path = DEFAULT_DIR) -> dict[str, int]:
    directory = Directory(root / "ContactsV2.sqlite")
    chats = sqlite3.connect(f"file:{root / 'ChatStorage.sqlite'}?mode=ro", uri=True)
    rows = chats.execute("SELECT ZJID, ZPATH FROM ZWAPROFILEPICTUREITEM WHERE ZPATH LIKE 'Media/Profile/%'").fetchall()
    chats.close()
    stats = {"photos": 0, "matched": 0, "saved": 0}
    for jid, rel in rows:
        file = next((f for ext in (".jpg", ".thumb") if (f := root / f"{rel}{ext}").exists()), None)
        if file is None:
            continue
        stats["photos"] += 1
        phone = directory.phone(jid)
        norm = phone and identity.normalize_handle(phone)
        person_id = norm and identity.find_by_identifier(conn, *norm)
        if not person_id or conn.execute("SELECT is_me FROM people WHERE id = ?", (person_id,)).fetchone()["is_me"]:
            continue
        stats["matched"] += 1
        stats["saved"] += save(conn, person_id, "whatsapp", file.read_bytes())
    conn.commit()
    return stats


ADDRESS_BOOK = Path.home() / "Library" / "Application Support" / "AddressBook"
_CROP = re.compile(r"\{\{(-?\d+), (-?\d+)\}, \{(\d+), (\d+)\}\}")


def _address_book_image(blob: bytes | None, support: Path) -> bytes | None:
    """Contacts stores small images inline after a 0x01 byte, and large ones as a file
    named after the UUID that follows a 0x02 byte."""
    if not blob:
        return None
    blob = bytes(blob)
    if blob[0] == 1:
        return blob[1:]
    if blob[0] == 2:
        file = support / "_EXTERNAL_DATA" / blob[1:].rstrip(b"\0").decode("ascii", "ignore")
        return file.read_bytes() if file.is_file() else None
    return None


def collect_contacts(conn: sqlite3.Connection, root: Path = ADDRESS_BOOK) -> dict[str, int]:
    stats = {"photos": 0, "matched": 0, "saved": 0}
    for db_file in [root / "AddressBook-v22.abcddb", *sorted(root.glob("Sources/*/AddressBook-v22.abcddb"))]:
        if not db_file.exists():
            continue
        support = db_file.parent / ".AddressBook-v22_SUPPORT"
        book = sqlite3.connect(f"file:{db_file}?mode=ro", uri=True)
        records = book.execute(
            "SELECT Z_PK, ZIMAGEDATA, ZTHUMBNAILIMAGEDATA, ZCROPRECT FROM ZABCDRECORD "
            "WHERE ZIMAGEDATA IS NOT NULL OR ZTHUMBNAILIMAGEDATA IS NOT NULL"
        ).fetchall()
        handles: dict[int, list[str]] = {}
        for owner, value in book.execute(
            "SELECT ZOWNER, ZFULLNUMBER FROM ZABCDPHONENUMBER UNION ALL SELECT ZOWNER, ZADDRESS FROM ZABCDEMAILADDRESS"
        ):
            if value:
                handles.setdefault(owner, []).append(value)
        book.close()
        for pk, full, thumb, crop in records:
            # The thumbnail is already cropped to the face. The full image is only usable as is
            # when its crop covers the whole picture, since the crop's origin convention is unclear.
            options = [data for data in [_address_book_image(thumb, support)] if data]
            if (data := _address_book_image(full, support)) and (width := image_width(data)):
                m = _CROP.fullmatch(crop or "")
                if not m or int(m[3]) in (0, width) and int(m[1]) == int(m[2]) == 0:
                    options.append(data)
            options = [d for d in options if image_width(d)]
            if not options:
                continue
            stats["photos"] += 1
            person_id = None
            for raw in handles.get(pk, []):
                if (norm := identity.normalize_handle(raw)) and (person_id := identity.find_by_identifier(conn, *norm)):
                    break
            if not person_id or conn.execute("SELECT is_me FROM people WHERE id = ?", (person_id,)).fetchone()["is_me"]:
                continue
            stats["matched"] += 1
            stats["saved"] += save(conn, person_id, "contacts", max(options, key=image_width))
    conn.commit()
    return stats


GOOGLE_PHOTO_SIZE = 720


def _fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=30) as response:
        return response.read()


def collect_google(conn: sqlite3.Connection, contacts: list[dict], fetch=_fetch) -> dict[str, int]:
    """Real photos (not the lettered default) from Google contacts that MyPeople knows."""
    stats = {"photos": 0, "matched": 0, "saved": 0}
    for c in contacts:
        photo = next((p for p in c.get("photos", []) if not p.get("default") and p.get("url")), None)
        if photo is None:
            continue
        stats["photos"] += 1
        person_id = identity.find_by_identifier(conn, "google", c["resourceName"])
        if not person_id or conn.execute("SELECT is_me FROM people WHERE id = ?", (person_id,)).fetchone()["is_me"]:
            continue
        stats["matched"] += 1
        # Photo URLs end in a size like "=s100"; ask for a bigger one.
        url = re.sub(r"=s\d+(-c)?$", "", photo["url"]) + f"=s{GOOGLE_PHOTO_SIZE}"
        try:
            data = fetch(url)
        except OSError:
            continue
        stats["saved"] += save(conn, person_id, "google", data)
    conn.commit()
    return stats


SOURCES = ("whatsapp", "contacts", "google")


def collect(conn: sqlite3.Connection, source: str, path: Path | None = None) -> str:
    """Collect from one source and say how it went, in one line."""
    from . import google

    try:
        if source == "whatsapp":
            stats = collect_whatsapp(conn, path or DEFAULT_DIR)
        elif source == "contacts":
            stats = collect_contacts(conn, path or ADDRESS_BOOK)
        else:
            stats = collect_google(conn, google.fetch_contacts("photos"))
    except sqlite3.Error as e:
        return f"{source}: couldn't read its data ({e}). Grant your terminal Full Disk Access in System Settings > Privacy & Security."
    except (google.GoogleError, OSError) as e:  # e.g. not logged in to Google
        return f"{source}: skipped ({e})"
    return f"{source}: {stats['photos']} photos, {stats['matched']} of people you know; {stats['saved']} new or larger."
