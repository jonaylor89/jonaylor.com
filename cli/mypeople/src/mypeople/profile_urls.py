"""Canonical account URLs and reusable usernames. No suffix-based platform guesses."""

import re
import urllib.parse

DOMAINS = {
    "linkedin.com": "linkedin", "x.com": "x", "twitter.com": "x",
    "instagram.com": "instagram", "github.com": "github", "gist.github.com": "github",
    "threads.net": "threads", "threads.com": "threads", "tiktok.com": "tiktok",
    "soundcloud.com": "soundcloud", "behance.net": "behance", "dribbble.com": "dribbble",
    "duolingo.com": "duolingo", "snapchat.com": "snapchat",
    "bsky.app": "bsky", "youtube.com": "youtube", "medium.com": "medium", "substack.com": "substack",
}
RESERVED = {"p", "reel", "reels", "explore", "search", "hashtag", "i", "intent", "share",
            "orgs", "topics", "tags", "login", "signup", "settings", "about", "features", "marketplace"}


def host_for(url: str) -> str:
    try:
        return (urllib.parse.urlsplit(url).hostname or "").lower().removeprefix("www.").removeprefix("m.")
    except ValueError:
        return ""


def site(url: str) -> str:
    host = host_for(url)
    if host in DOMAINS:
        return DOMAINS[host]
    if host.endswith(".medium.com") and host.count(".") == 2:
        return "medium"
    if host.endswith(".substack.com") and host.count(".") == 2:
        return "substack"
    return host.split(".")[-2] if host.count(".") else host


def profile_url(url: str) -> str | None:
    """Normalize only known profile routes. YouTube channel IDs retain their case."""
    try:
        parts = urllib.parse.urlsplit(url)
        if parts.scheme not in ("https", "http") or parts.username or parts.password or parts.port is not None:
            return None
    except ValueError:
        return None
    host = host_for(url)
    path = [urllib.parse.unquote(p) for p in parts.path.split("/") if p]
    if any(any(c in p for c in ("/", "\\", "?", "#")) or any(c.isspace() or ord(c) < 32 for c in p) for p in path):
        return None
    # A subdomain does not inherit the identity namespace of its parent domain.
    if host not in DOMAINS:
        if host.count(".") == 2 and host.endswith((".medium.com", ".substack.com")):
            return f"https://{host}"
        return None
    name = DOMAINS[host]
    if name == "linkedin":
        if len(path) >= 2 and path[0] in ("in", "pub"):
            return f"https://linkedin.com/in/{path[1].lower()}"
        if len(path) >= 2 and path[0] == "posts" and "_" in path[1]:
            return f"https://linkedin.com/in/{path[1].split('_')[0].lower()}"
        return None
    if name in ("x", "instagram", "github", "threads", "tiktok", "soundcloud", "behance", "dribbble"):
        if not path or path[0].lower() in RESERVED:
            return None
        domain = {"x": "x.com", "github": "github.com", "threads": "threads.com"}.get(name, host)
        handle = path[0].lower()
        if name in ("threads", "tiktok"):
            handle = "@" + handle.lstrip("@")
        return f"https://{domain}/{handle}"
    if name == "snapchat":
        if len(path) == 2 and path[0] == "add" and re.fullmatch(r"[a-zA-Z][a-zA-Z0-9._-]{1,13}[a-zA-Z0-9]", path[1]):
            return f"https://www.snapchat.com/add/{path[1].lower()}"
        return None
    if name == "duolingo":
        if len(path) == 2 and path[0] == "profile":
            return f"https://duolingo.com/profile/{path[1].lower()}"
        return None
    if name == "bsky" and len(path) >= 2 and path[0] == "profile":
        return f"https://bsky.app/profile/{path[1].lower()}"
    if name == "medium":
        return f"https://medium.com/{path[0].lower()}" if path and path[0].startswith("@") else None
    if name == "youtube" and path:
        if path[0].startswith("@"):
            return f"https://youtube.com/{path[0].lower()}"
        if len(path) >= 2 and path[0] in ("channel", "c", "user"):
            handle = path[1] if path[0] == "channel" else path[1].lower()
            return f"https://youtube.com/{path[0]}/{handle}"
    return None


def username_for(url: str) -> str | None:
    """Reusable handle, not a name slug, channel ID, publication, or section route."""
    canonical = profile_url(url)
    if canonical is None:
        return None
    parts = urllib.parse.urlsplit(canonical)
    path = [p for p in parts.path.split("/") if p]
    name = site(canonical)
    if name in ("linkedin", "substack"):
        return None
    if name in ("duolingo", "snapchat"):
        return path[1]
    if name == "bsky":
        return path[1] if not path[1].startswith("did:") else None
    if name == "medium" and parts.hostname != "medium.com":
        return parts.hostname.split(".")[0]
    if name == "youtube":
        if path[0].startswith("@"):
            return path[0][1:]
        return path[1] if path[0] in ("user", "c") else None
    return path[0].lstrip("@") if path else None


def youtube_channel_url(url: str) -> str | None:
    """An exact, case-sensitive channel identity, not a guessed handle alias."""
    canonical = profile_url(url)
    prefix = "https://youtube.com/channel/"
    if canonical and canonical.startswith(prefix) and re.fullmatch(r"UC[A-Za-z0-9_-]{22}", canonical[len(prefix):]):
        return canonical
    return None


def enumeration_site(url_template: str) -> bool:
    """Only profile families whose results we can actually retain as handle leads."""
    probe = url_template.replace("{username}", "mypeopleprobe").replace("{}", "mypeopleprobe")
    return username_for(probe) is not None and host_for(probe) not in ("gist.github.com", "snapchat.com")
