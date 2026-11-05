"""Opt-in, unauthenticated avatar lookup by known email address.

Only SHA-256 identifiers go over the wire; hashes are still identifying data.
Never infer addresses from names/handles, fetch profiles, or accept defaults.
"""

from __future__ import annotations

import hashlib
import re
import time
import urllib.parse

from . import photos, profile_evidence, social_photos
from .public_network import UnsafeURL, public_address

SIZE = 512
MAX_BYTES = 8_000_000
HOSTS = {"gravatar.com", "www.gravatar.com", "secure.gravatar.com"}
QUERY = {"s": str(SIZE), "d": "404", "r": "g"}


def avatar_url(email: str) -> str | None:
    email = email.strip().lower()
    if (not re.fullmatch(r"[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+", email)
            or any(ord(c) < 32 for c in email)):
        return None
    digest = hashlib.sha256(email.encode("utf-8")).hexdigest()
    return f"https://gravatar.com/avatar/{digest}?" + urllib.parse.urlencode(QUERY)


def targets(conn, person_id: int | None = None) -> list[dict]:
    selected = {}
    rows = conn.execute(
        "SELECT p.id, p.name, i.value FROM people p JOIN identifiers i ON i.person_id = p.id "
        "WHERE p.merged_into IS NULL AND p.is_me = 0 AND i.kind = 'email' "
        "AND (? IS NULL OR p.id = ?) ORDER BY p.id, i.id", (person_id, person_id))
    for row in rows:
        if url := avatar_url(row["value"]):
            selected[row["id"], url] = {"person_id": row["id"], "name": row["name"], "url": url, "source": "gravatar"}
    return list(selected.values())


def _allowed(url: str) -> bool:
    try:
        p = urllib.parse.urlsplit(url)
        return bool(p.scheme == "https" and p.hostname in HOSTS and not p.username and not p.password
                    and p.port is None and not p.fragment and not any(c.isspace() or ord(c) < 32 for c in url)
                    and re.fullmatch(r"/avatar/[0-9a-f]{64}", p.path)
                    and sorted(urllib.parse.parse_qsl(p.query, keep_blank_values=True)) == sorted(QUERY.items()))
    except ValueError:
        return False


def request(url: str, timeout: float) -> tuple[int, dict, bytes]:
    if not _allowed(url):
        raise UnsafeURL("Not a scoped Gravatar avatar URL")
    p = urllib.parse.urlsplit(url)
    connection = profile_evidence._PinnedHTTPS(p.hostname, public_address(p.hostname), timeout)
    try:
        connection.request("GET", p.path + "?" + p.query, headers={
            "User-Agent": "MyPeople/0.1 (Gravatar avatars)", "Accept": "image/jpeg, image/png",
            "Accept-Encoding": "identity"})
        response = connection.getresponse()
        body = response.read(MAX_BYTES + 1)
        if len(body) > MAX_BYTES:
            raise ValueError("Gravatar image exceeded size limit")
        return response.status, {k.lower(): v for k, v in response.getheaders()}, body
    finally:
        connection.close()


def download(url: str, timeout: float = 15, get=request) -> bytes:
    original = urllib.parse.urlsplit(url).path
    deadline = time.monotonic() + timeout
    for _ in range(4):
        # Redirects may change only the known Gravatar host, never the hash or
        # d=404. In particular, no fallback-image URL can be followed.
        if not _allowed(url) or urllib.parse.urlsplit(url).path != original:
            raise UnsafeURL("Redirect left the requested Gravatar avatar")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Gravatar request budget exceeded")
        status, headers, body = get(url, remaining)
        if status in (301, 302, 303, 307, 308):
            url = urllib.parse.urljoin(url, headers.get("location", ""))
            continue
        if status == 404:
            raise ValueError("No Gravatar avatar (HTTP 404)")
        if status != 200 or not headers.get("content-type", "").lower().startswith("image/"):
            raise ValueError(f"Gravatar unavailable (HTTP {status})")
        if len(body) > MAX_BYTES or not photos.image_width(body):
            raise ValueError("Expected a JPEG or PNG Gravatar avatar")
        return body
    raise ValueError("Too many Gravatar redirects")


def collect(conn, selected: list[dict], *, again=False, fetch=download, progress=print) -> dict:
    # Reuse the existing photo store and per-person/URL cache, not browser code.
    stats = social_photos.collect(conn, selected, again=again, lookup=lambda url: (url, "Gravatar HTTPS"),
                                  fetch=lambda url, source: fetch(url), progress=progress)
    return {"emails": stats.pop("accounts"), **stats}
