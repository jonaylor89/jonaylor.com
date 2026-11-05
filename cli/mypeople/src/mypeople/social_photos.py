"""Photos from known accounts only; no discovery, model calls, or paid APIs.

Public requests are bounded and DNS-pinned. Authenticated browsing is an explicit,
optional fallback (see photo_browser.py). Signed image URLs are not persisted.
"""

from __future__ import annotations

import http.client
import json
import random
import re
import time
import urllib.parse
from html.parser import HTMLParser
from pathlib import Path

from . import photos, profile_evidence
from .profile_urls import profile_url, site
from .public_network import UnsafeURL, public_address

SOURCES = ("linkedin", "instagram")
MAX_IMAGE = 8_000_000
IG_API = "https://www.instagram.com/api/v1/users/web_profile_info/?username="


def account_url(source: str, value: str) -> str | None:
    value = value.removeprefix("@")
    pattern = r"[A-Za-z0-9._]{1,30}" if source == "instagram" else r"[A-Za-z0-9_-]{1,100}"
    if source not in SOURCES or not re.fullmatch(pattern, value):
        return None
    return profile_url(f"https://{source}.com/" + ("in/" if source == "linkedin" else "") + value)


def targets(conn, source: str, person_id: int | None = None) -> list[dict]:
    """A rejection vetoes imported handles too. DM display names are never handles."""
    selected = {}
    for person in conn.execute("SELECT id, name FROM people WHERE merged_into IS NULL AND is_me = 0 ORDER BY id"):
        pid = person["id"]
        if person_id is not None and person_id != pid:
            continue
        rows = conn.execute("SELECT url, status FROM profiles WHERE person_id = ?", (pid,)).fetchall()
        rejected = {profile_url(r["url"]) for r in rows if r["status"] == "rejected"}
        urls = {profile_url(r["url"]) for r in rows if r["status"] == "confirmed"}
        for row in conn.execute("SELECT value, source FROM identifiers WHERE person_id = ? AND kind = ?", (pid, source)):
            if row["source"] == "manual" or source == "linkedin" and row["source"] == "linkedin":
                urls.add(account_url(source, row["value"]))
        for url in sorted(u for u in urls if u and site(u) == source and u not in rejected):
            selected[pid, url] = {"person_id": pid, "name": person["name"], "url": url, "source": source}
    return list(selected.values())


def image_allowed(url: str, source: str) -> bool:
    try:
        p = urllib.parse.urlsplit(url)
        host = (p.hostname or "").lower()
        if p.scheme != "https" or p.username or p.password or p.port is not None or p.fragment or len(url) > 8192:
            return False
        if any(c.isspace() or ord(c) < 32 for c in url):
            return False
        if source == "linkedin":
            return host == "media.licdn.com" and not any(s in p.path.lower() for s in ("ghost", "default", "logo"))
        return (source == "instagram" and (host.endswith(".cdninstagram.com") or host.endswith(".fbcdn.net"))
                and not any(s in p.path.lower() for s in ("rsrc.php", "anonymoususer", "default_avatar")))
    except ValueError:
        return False


def request(url: str, timeout: float, *, source: str, image: bool = False) -> tuple[int, dict, bytes]:
    """One request, no implicit redirects, proxies, credentials, or decompression."""
    p = urllib.parse.urlsplit(url)
    if image:
        valid = image_allowed(url, source)
    else:
        canonical = profile_url(url)
        valid = bool(canonical and site(canonical) == source and not p.query and not p.fragment
                     and p.path.rstrip("/") == urllib.parse.urlsplit(canonical).path)
        if source == "instagram" and url.startswith(IG_API):
            handle = urllib.parse.unquote(url[len(IG_API):])
            valid = account_url(source, handle) is not None and url == IG_API + urllib.parse.quote(handle, safe="")
    if not valid or p.scheme != "https":
        raise UnsafeURL("Not a scoped photo URL")
    connection = profile_evidence._PinnedHTTPS(p.hostname, public_address(p.hostname), timeout)
    try:
        headers = {"User-Agent": "Mozilla/5.0 (compatible; MyPeople/0.1)", "Accept-Encoding": "identity"}
        if url.startswith(IG_API):
            headers["X-IG-App-ID"] = "936619743392459"  # Public Instagram web client, not a credential.
        connection.request("GET", urllib.parse.urlunsplit(("", "", p.path or "/", p.query, "")), headers=headers)
        response = connection.getresponse()
        limit = MAX_IMAGE if image else profile_evidence.MAX_BYTES
        body = response.read(limit + 1)
        if len(body) > limit:
            raise ValueError("Photo response exceeded size limit")
        return response.status, {k.lower(): v for k, v in response.getheaders()}, body
    finally:
        connection.close()


def download(url: str, source: str, timeout: float = 15, get=request) -> bytes:
    deadline = time.monotonic() + timeout
    for _ in range(4):
        if not image_allowed(url, source):
            raise UnsafeURL("Image left platform CDN")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Image request budget exceeded")
        status, headers, body = get(url, remaining, source=source, image=True)
        if status in (301, 302, 303, 307, 308):
            url = urllib.parse.urljoin(url, headers.get("location", ""))
            continue
        if status != 200 or not headers.get("content-type", "").lower().startswith("image/"):
            raise ValueError(f"Image unavailable (HTTP {status})")
        if len(body) > MAX_IMAGE or not photos.image_width(body):
            raise ValueError("Expected a JPEG or PNG profile photo")
        return body
    raise ValueError("Too many image redirects")


class Images(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.urls = []
        self.account = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "meta":
            key = (a.get("property") or a.get("name") or "").lower()
            if key in ("og:image", "twitter:image") and a.get("content"):
                self.urls.append(a["content"])
        if tag == "link" and "canonical" in (a.get("rel") or "").split():
            self.account = profile_url(a.get("href", ""))


def instagram_image(data: dict, handle: str) -> str | None:
    user = data.get("data", {}).get("user", {})
    if (not isinstance(user, dict) or user.get("has_anonymous_profile_picture")
            or str(user.get("username", "")).casefold() != handle.casefold()):
        return None
    return user.get("profile_pic_url_hd") or user.get("profile_pic_url")


def public_image(url: str, timeout: float = 15, get=request) -> tuple[str | None, str]:
    source = site(url)
    if source not in SOURCES or profile_url(url) != url:
        return None, "invalid account"
    handle = url.rsplit("/", 1)[-1]
    deadline = time.monotonic() + timeout
    if source == "instagram":
        try:
            status, headers, body = get(IG_API + urllib.parse.quote(handle, safe=""), timeout, source=source)
            if status == 200 and "json" in headers.get("content-type", ""):
                image = instagram_image(json.loads(body), handle)
                if isinstance(image, str) and image_allowed(image, source):
                    return image, "public API"
        except (OSError, ValueError, TypeError, AttributeError, http.client.HTTPException):
            pass  # Try the public page, but never another account or a search.
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return None, "public request timed out"
    try:
        # Only allow redirects that still identify the exact requested account.
        current = url
        for _ in range(4):
            if profile_url(current) != url or urllib.parse.urlsplit(current).scheme != "https":
                return None, "login or different-account redirect"
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None, "public request timed out"
            # Normalize www/trailing-slash redirects back to our scoped route.
            status, headers, body = get(current, remaining, source=source)
            if status in (301, 302, 303, 307, 308):
                current = urllib.parse.urljoin(current, headers.get("location", ""))
                continue
            if status != 200:
                return None, f"public page HTTP {status}; try --browser"
            snapshot = profile_evidence.fetch(url, get=lambda *a: (status, headers, body))
            if snapshot["access"] != "ok":
                return None, f"public page {snapshot['access']}; try --browser"
            parser = Images()
            parser.feed(body.decode("utf-8", errors="replace"))
            if parser.account and parser.account != url:
                return None, "page identifies a different account"
            for image in parser.urls:
                if image_allowed(image, source):
                    return image, "public page"
            return None, "no public profile image; try --browser"
    except (OSError, ValueError, http.client.HTTPException):
        return None, "public request failed; try --browser"
    return None, "too many profile redirects"


def collect(conn, selected: list[dict], *, again=False, browser=None, lookup=public_image, fetch=download, progress=print,
            delay: float = 0, max_failures: int | None = None) -> dict:
    """delay: minimum seconds (up to double, randomly) between uncached lookups.
    max_failures: stop after this many uncached lookups fail in a row, e.g. when rate limited."""
    stats = {"accounts": len(selected), "saved": 0, "unchanged": 0, "cached": 0, "unavailable": 0}
    looked_up = streak = 0
    for target in selected:
        if max_failures and streak >= max_failures:
            progress(f"Stopped after {streak} failed lookups in a row; the site may be rate limiting. Rerun later.")
            break
        pid, source, url = target["person_id"], target["source"], target["url"]
        row = conn.execute("SELECT * FROM photo_fetches WHERE person_id = ? AND url = ?", (pid, url)).fetchone()
        ttl = 86400 if row and row["status"] == "ok" else 900
        # Explicit browser runs should retry previous anonymous failures immediately.
        if not again and row and time.time() - row["fetched_at"] < ttl and (row["status"] == "ok" or browser is None):
            saved = conn.execute("SELECT path FROM photos WHERE person_id = ? AND source = ?", (pid, source)).fetchone()
            if row["status"] != "ok" or saved and Path(saved["path"]).is_file():
                stats["cached"] += 1
                progress(f"{target['name']} ({source}): cached {row['status']}; {row['detail']}")
                continue
        if delay and looked_up:
            time.sleep(random.uniform(delay, delay * 2))
        looked_up += 1
        status, detail = "unavailable", "no image"
        try:
            image, detail = lookup(url)
            if not image and browser is not None:
                image, detail = browser.image(url)
            if image:
                data = fetch(image, source)
                changed = photos.save(conn, pid, source, data)
                stats["saved" if changed else "unchanged"] += 1
                status = "ok"
                detail += f"; {photos.image_width(data)}px" + (" saved" if changed else " (existing photo is as large or larger)")
        except (OSError, ValueError, http.client.HTTPException) as exc:
            detail = str(exc)[:160]
        if status != "ok":
            stats["unavailable"] += 1
        streak = streak + 1 if status != "ok" else 0
        conn.execute("INSERT INTO photo_fetches (person_id, url, fetched_at, status, detail) VALUES (?, ?, ?, ?, ?) "
                     "ON CONFLICT (person_id, url) DO UPDATE SET fetched_at=excluded.fetched_at, status=excluded.status, detail=excluded.detail",
                     (pid, url, time.time(), status, detail))
        conn.commit()  # Resumable even if the next account is interrupted.
        progress(f"{target['name']} ({source}): {detail}")
    return stats
