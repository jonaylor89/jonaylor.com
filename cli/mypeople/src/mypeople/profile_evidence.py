"""Bounded, unauthenticated public profile metadata, with a local metadata cache.

No arbitrary link crawling. Each redirect is scoped and DNS-checked; HTTPS is
connected to the checked IP while retaining hostname/SNI verification. Page text
is untrusted data, never instructions. Raw HTML and cookies are not persisted.
"""

from __future__ import annotations

import datetime as dt
import http.client
import json
import re
import socket
import ssl
import time
import urllib.parse
from html.parser import HTMLParser
from concurrent.futures import ThreadPoolExecutor

from .profile_urls import host_for, profile_url, site, username_for, youtube_channel_url
from .public_network import UnsafeURL, public_address

# YouTube puts profile metadata after >1 MB of inline styles/scripts. Keep a
# bounded 2 MB budget rather than silently truncating real identity metadata.
MAX_BYTES = 2_000_000
CACHE_VERSION = 3  # Invalidate browser error shells and metadata missing canonical channel IDs.
DUOLINGO_API = "https://www.duolingo.com/2017-06-30/users"


class _PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, host, address, timeout):
        super().__init__(host, timeout=timeout, context=ssl.create_default_context())
        self.address = address

    def connect(self):
        sock = socket.create_connection((self.address, 443), self.timeout)
        try:
            self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
        except BaseException:
            sock.close()
            raise


def _duolingo_api_username(url: str) -> str | None:
    """Allow only our exact anonymous username lookup, not arbitrary API routes."""
    try:
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
    except ValueError:
        return None
    values = query.get("username", [])
    if len(values) != 1 or not re.fullmatch(r"[\w.-]{1,80}", values[0]):
        return None
    expected = DUOLINGO_API + "?" + urllib.parse.urlencode({"username": values[0]})
    return values[0] if url == expected else None


def request(url: str, timeout: float) -> tuple[int, dict, bytes]:
    parts = urllib.parse.urlsplit(url)
    api_username = _duolingo_api_username(url)
    if (profile_url(url) is None and api_username is None) or parts.scheme != "https" or any(c.isspace() or ord(c) < 32 for c in url):
        raise UnsafeURL("Not a supported HTTPS profile URL")
    connection = _PinnedHTTPS(parts.hostname, public_address(parts.hostname), timeout)
    try:
        target = urllib.parse.urlunsplit(("", "", parts.path or "/", parts.query, ""))
        connection.request("GET", target, headers={"User-Agent": "MyPeople/0.1 (public profile metadata)",
                                                   "Accept": "application/json" if api_username else "text/html", "Accept-Encoding": "identity"})
        response = connection.getresponse()
        return response.status, {k.lower(): v for k, v in response.getheaders()}, response.read(MAX_BYTES)
    finally:
        connection.close()


class Metadata(HTMLParser):
    def __init__(self, url: str):
        super().__init__(convert_charrefs=True)
        self.url = url
        self.in_title = False
        self.seen_title = False
        self.svg_depth = 0
        self.in_heading = False
        self.heading = ""
        self.browser_error = False
        self.canonical_url = None
        self.title = ""
        self.meta: dict[str, str] = {}
        self.links: list[str] = []
        self.identity_links: list[str] = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if attrs.get('id') in ('main-frame-error', 'main-frame-error-content', 'interstitial-wrapper'):
            self.browser_error = True
        if tag == "svg":
            self.svg_depth += 1
        if tag == "title" and not self.seen_title and not self.svg_depth:
            self.in_title = True
            self.seen_title = True  # Ignore later SVG/tool-tip titles in the body.
        if tag == "h1" and not self.heading.strip():
            self.in_heading = True
        if tag == "meta":
            name = (attrs.get("property") or attrs.get("name") or "").lower()
            if name in ("description", "og:title", "og:description", "twitter:description"):
                self.meta[name] = (attrs.get("content") or "")[:1200]
        if tag in ("a", "link") and attrs.get("href"):
            url = urllib.parse.urljoin(self.url, attrs['href'])
            parts = urllib.parse.urlsplit(url)
            if parts.scheme not in ("https", "http") or parts.username or parts.password:
                return
            # Only retain public account links; don't collect arbitrary URLs or tokens.
            canonical = profile_url(url)
            # YouTube emits this tag late, outside <head>. Accept its first
            # channel canonical only on YouTube pages, never plain links/og:url.
            if tag == 'link' and self.canonical_url is None and 'canonical' in (attrs.get('rel') or '').split() and site(self.url) == 'youtube':
                self.canonical_url = youtube_channel_url(url)
            if canonical and len(self.links) < 100 and canonical not in self.links:
                self.links.append(canonical)
            owned = "me" in (attrs.get('rel') or '').split() or attrs.get('itemprop') == 'sameAs'
            if owned and canonical and len(self.identity_links) < 100 and canonical not in self.identity_links:
                self.identity_links.append(canonical)

    def handle_endtag(self, tag):
        if tag == "svg":
            self.svg_depth = max(0, self.svg_depth - 1)
        if tag == "title":
            self.in_title = False
        if tag == "h1":
            self.in_heading = False

    def handle_data(self, data):
        if self.in_title:
            self.title = (self.title + data)[:300]
        if self.in_heading:
            self.heading = (self.heading + data)[:300]


def fetch(url: str, timeout: float = 8, get=request, *, prefer_api: bool = True) -> dict:
    """Return a concise metadata snapshot, including inaccessible outcomes."""
    result = {"url": url, "access": "error", "title": "", "description": "", "links": [],
              "identity_links": [], "observed_at": dt.datetime.now(dt.timezone.utc).isoformat()}
    current = url
    deadline = time.monotonic() + timeout
    try:
        canonical = profile_url(url)
        api_username = username_for(canonical) if canonical and site(canonical) == "duolingo" and prefer_api else None
        api_url = DUOLINGO_API + "?" + urllib.parse.urlencode({"username": api_username}) if api_username else None
        if api_url:
            if urllib.parse.urlsplit(url).scheme != "https":
                raise UnsafeURL("Duolingo lookup requires HTTPS")
            current = api_url
        for _ in range(4):
            # API lookups cannot follow redirects to another user, endpoint, or host.
            scoped = current == api_url if api_url else profile_url(current) is not None
            if not scoped or urllib.parse.urlsplit(current).scheme != "https":
                raise UnsafeURL("Redirect left supported profile routes")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Profile request budget exceeded")
            status, headers, body = get(current, remaining)
            result.update(http_status=status, final_url=current)
            if status in (301, 302, 303, 307, 308):
                current = urllib.parse.urljoin(current, headers.get('location', ''))
                continue
            if status != 200:
                result['access'] = {404: 'not_found', 410: 'not_found', 401: 'private', 403: 'blocked',
                                    429: 'blocked'}.get(status, 'error')
                return result
            if api_username:
                if "json" not in headers.get("content-type", "").lower():
                    result["access"] = "empty"
                    return result
                data = json.loads(body[:MAX_BYTES])
                if not isinstance(data, dict) or not isinstance(data.get("users"), list):
                    raise ValueError("Malformed Duolingo public user response")
                users = [u for u in data["users"] if isinstance(u, dict) and isinstance(u.get("username"), str)
                         and u["username"].casefold() == api_username.casefold()]
                if not data["users"]:
                    result["access"] = "not_found"
                    return result
                if len(users) != 1:
                    raise ValueError("Duolingo response did not identify exactly the requested username")
                user = users[0]
                name = user.get("name") if isinstance(user.get("name"), str) else ""
                bio = user.get("bio") if isinstance(user.get("bio"), str) else ""
                # Do not retain IDs, learning activity, friend graphs, or other API fields.
                result.update(access="ok", title=f'{name[:200]} (@{user["username"][:80]}) | Duolingo'.strip(),
                              description=bio[:1200], transport="duolingo_api")
                return result
            if 'html' not in headers.get('content-type', '').lower():
                result['access'] = 'empty'
                return result
            parser = Metadata(current)
            parser.feed(body[:MAX_BYTES].decode('utf-8', errors='replace'))
            title = parser.title.strip() or parser.meta.get('og:title', '')
            description = parser.meta.get('description') or parser.meta.get('og:description') or parser.meta.get('twitter:description', '')
            result.update(title=title, description=description, links=parser.links, identity_links=parser.identity_links)
            if parser.canonical_url:
                result['canonical_url'] = parser.canonical_url
            combined = (title + ' ' + description).lower()
            normalized_title = title.casefold().strip()
            generic = normalized_title in ('', 'tiktok - make your day', 'youtube', 'instagram', 'threads', 'medium', 'x', 'github', 'dribbble', 'duolingo')
            generic = generic or normalized_title.removeprefix('www.') == host_for(current)
            browser_errors = ("this site can’t be reached", "this site can't be reached", "your connection is not private",
                              "this page isn’t working", "this page isn't working")
            missing = ('page not found', 'user not found', "this page isn't available", 'this page isn’t available')
            # Selenium/FlareSolverr reports status=200 even on real 404 pages.
            # Use explicit error titles or a generic shell with a 404 heading.
            if parser.browser_error or any(s in parser.heading.casefold() for s in browser_errors):
                result['access'] = 'error'
                result['detail'] = 'Browser network or privacy error page; no profile evidence.'
            elif any(s in title.casefold() for s in missing) or (generic and parser.heading.strip().casefold() in ('404', 'not found', *missing)):
                result['access'] = 'not_found'
            elif any(s in title.lower() for s in ('attention required', 'just a moment', 'access denied', 'sign in', 'log in', 'captcha')):
                result['access'] = 'blocked'
            elif any(s in combined for s in ('private profile', 'private account', 'profile isn’t public', "profile isn't public")):
                result['access'] = 'private'
            elif generic and (not description or site(current) == 'duolingo'):
                result['access'] = 'empty'
            else:
                result['access'] = 'ok'
            return result
        raise UnsafeURL("Too many redirects")
    except (OSError, ValueError, http.client.HTTPException) as exc:
        result['access'] = 'blocked' if isinstance(exc, UnsafeURL) else 'error'
        result['detail'] = str(exc)[:160]
        return result


def collect(conn, url: str, fetcher=fetch, timeout: float = 8, max_age: float = 86400) -> dict | None:
    now = time.time()
    row = conn.execute("SELECT * FROM profile_fetches WHERE url = ?", (url,)).fetchone()
    if row:
        saved = json.loads(row['evidence'])
        if saved.get('parser_version') == CACHE_VERSION:
            ttl = max_age if saved['access'] == 'ok' else min(max_age, 900)
            if now - row['fetched_at'] < ttl:
                return saved
    if fetcher is None:  # Cache-only lookup for collect_many.
        return None
    value = {**fetcher(url, timeout=timeout), 'parser_version': CACHE_VERSION}
    conn.execute("INSERT OR REPLACE INTO profile_fetches (url, fetched_at, evidence) VALUES (?, ?, ?)",
                 (url, now, json.dumps(value)))
    return value


def collect_many(conn, urls, fetcher=fetch, timeout: float = 8, retry_inaccessible: bool = False) -> dict[str, dict]:
    """Fetch at most four profiles concurrently; SQLite stays on the calling thread."""
    urls = list(dict.fromkeys(urls))
    results = {url: collect(conn, url, fetcher=None) for url in urls}
    if retry_inaccessible:
        results = {url: None if value and value['access'] in ('blocked', 'empty') else value for url, value in results.items()}
    pending = [url for url in urls if results[url] is None]
    if pending:
        with ThreadPoolExecutor(max_workers=4) as pool:
            values = pool.map(lambda url: fetcher(url, timeout=timeout), pending)
            for url, value in zip(pending, values):
                value = {**value, 'parser_version': CACHE_VERSION}
                results[url] = value
                conn.execute("INSERT OR REPLACE INTO profile_fetches (url, fetched_at, evidence) VALUES (?, ?, ?)",
                             (url, time.time(), json.dumps(value)))
    return results
