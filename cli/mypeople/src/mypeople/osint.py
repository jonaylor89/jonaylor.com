"""Opt-in username discovery through scoped, optional Python scanner libraries.

Seeds come from known public account identifiers and confirmed profiles, never
private addresses, contact display names, or message text. A bounded handle
variant is a discovery lead, not evidence of ownership. No CLI setup, recursive
identity searches, remote database updates, or unsupported-platform requests.
"""

from __future__ import annotations

import asyncio
import copy
import importlib.util
import json
import logging
import re
import urllib.parse
from functools import lru_cache
from importlib import resources

from . import identity
from .profile_urls import enumeration_site, profile_url, site, username_for

LIBRARIES = {"sherlock": "sherlock_project", "maigret": "maigret"}
logger = logging.getLogger(__name__)


def public_username(value: str, *, allow_numeric: bool = False) -> str:
    """Validate a seed; numeric handles require an actual confirmed profile URL."""
    value = value.removeprefix("@")
    if not re.fullmatch(r"[\w.-]{1,253}", value) or (not allow_numeric and not any(c.isalpha() for c in value)):
        raise ValueError("Expected a public username, not an email, phone number, or URL")
    return value.lower()


def known_usernames(conn, person_id: int) -> dict[str, list[dict]]:
    """One provenance-backed username set for a contact, without modifying it.

    Snapchat exports contain actual usernames; LinkedIn exports contain public
    profile slugs. Instagram DM identifiers are display names, so are NOT seeds.
    """
    person_id = identity.canonical(conn, person_id)
    profiles = conn.execute("SELECT url, status FROM profiles WHERE person_id = ? ORDER BY id", (person_id,)).fetchall()
    rejected = {profile_url(r["url"]) for r in profiles if r["status"] == "rejected"}
    known: dict[str, list[dict]] = {}

    def add(value, origin):
        if not value:
            return
        try:
            value = public_username(value, allow_numeric=origin["type"] == "confirmed_profile")
        except ValueError:
            return
        origins = known.setdefault(value, [])
        if origin not in origins:
            origins.append(origin)

    for row in profiles:
        url = profile_url(row["url"])
        if row["status"] != "confirmed" or not url or url in rejected:
            continue
        platform = site(url)
        handle = username_for(url)
        if platform == "linkedin":
            # A known public slug can seed discovery, but is not a LinkedIn
            # scanner route or cross-platform ownership evidence.
            handle = urllib.parse.unquote(url.rsplit("/", 1)[-1])
        add(handle, {"type": "confirmed_profile", "site": platform, "url": url})

    rows = conn.execute(
        "SELECT kind, value, source FROM identifiers WHERE person_id = ? "
        "AND kind IN ('snapchat', 'linkedin') AND (source = kind OR source = 'manual') ORDER BY id",
        (person_id,))
    for row in rows:
        kind = row["kind"]
        try:
            value = public_username(row["value"])
        except ValueError:
            continue
        # Group UUIDs, display names, and malformed/private identifiers cannot
        # become Snapchat usernames, even if mislabeled in an old import.
        if kind == "snapchat" and not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9._-]{1,13}[a-zA-Z0-9]", value):
            continue
        if kind == "linkedin" and profile_url("https://linkedin.com/in/" + urllib.parse.quote(value, safe="")) in rejected:
            continue  # An imported identifier must not bypass a human rejection.
        add(value, {"type": "contact_identifier", "site": kind, "source": row["source"]})
    return known


def handles_for(conn, person_id: int) -> list[str]:
    """Exact known usernames, shared by eligibility checks and scanner seeding."""
    return list(known_usernames(conn, person_id))


def _scan_seeds(conn, person_id: int, usernames: list[str] | None = None) -> dict[str, list[dict]]:
    seeds: dict[str, list[dict]] = {}
    for handle, origins in known_usernames(conn, person_id).items():
        variants = [(handle, "exact")]
        if any(o["site"] == "bsky" for o in origins):
            # Keep custom DNS handles intact; only the known default namespace
            # has a portable local username. Never compact a whole domain.
            compact = handle.removesuffix(".bsky.social") if handle.count(".") == 2 else handle
            transformation = "bsky_localpart"
        else:
            compact = re.sub(r"[._-]", "", handle)
            transformation = "separatorless"
        if compact != handle and len(compact) >= 3 and any(c.isalpha() for c in compact):
            variants.append((compact, transformation))
        for value, transformation in variants:
            seeds.setdefault(value, []).extend(
                {**origin, "known_username": handle, "transformation": transformation} for origin in origins)
    # Optional explicit inputs remain exact one-off seeds, never identifiers.
    for handle in map(public_username, usernames or []):
        origin = {"type": "explicit_input", "known_username": handle, "transformation": "exact"}
        if origin not in seeds.setdefault(handle, []):
            seeds[handle].append(origin)
    return seeds


def to_search(conn, limit: int) -> list:
    """OSINT-only targets: known usernames, independent of Exa search history."""
    from .relationships import infer

    rows = conn.execute("SELECT id, name FROM people WHERE merged_into IS NULL AND is_me = 0").fetchall()
    rows = [r for r in rows if handles_for(conn, r["id"])]
    return sorted(rows, key=lambda r: -infer(conn, r["id"]).closeness)[:limit]


def available() -> list[str]:
    return [name for name, module in LIBRARIES.items() if importlib.util.find_spec(module) is not None]


@lru_cache(maxsize=1)
def _sherlock_sites() -> dict:
    data = json.loads(resources.files("sherlock_project").joinpath("resources/data.json").read_text(encoding="utf-8"))
    exclusions = resources.files("mypeople").joinpath("data/sherlock-exclusions.txt").read_text(encoding="utf-8")
    excluded = {line.strip().casefold() for line in exclusions.splitlines() if line.strip() and not line.startswith("#")}
    return {name: info for name, info in data.items()
            if isinstance(info, dict) and name.casefold() not in excluded and not info.get("isNSFW")
            and enumeration_site(info.get("url", ""))}


@lru_cache(maxsize=1)
def _maigret_database():
    from maigret.sites import MaigretDatabase

    with resources.as_file(resources.files("maigret").joinpath("resources/data.json")) as path:
        return MaigretDatabase().load_from_path(str(path))


def _sherlock(username: str, timeout: float) -> list[str]:
    from sherlock_project.notify import QueryNotify
    from sherlock_project.result import QueryStatus
    from sherlock_project.sherlock import sherlock

    # Engines mutate site objects; cache the database, not per-run mutable state.
    sites = copy.deepcopy(_sherlock_sites())
    if "." in username:
        for info in sites.values():
            if site(info["url"]) == "bsky":
                for key in ("url", "urlProbe"):
                    if key in info:
                        info[key] = info[key].replace("{}.bsky.social", "{}")
    if not sites:
        return []
    results = sherlock(username, sites, QueryNotify(), timeout=timeout)
    return [r["url_user"] for r in results.values()
            if r.get("status") is not None and r["status"].status == QueryStatus.CLAIMED and r.get("url_user")]


async def _maigret(username: str, timeout: float) -> list[str]:
    from maigret import search

    db = _maigret_database()
    names = [s.name for s in db.sites if enumeration_site(s.url)]
    if not names:
        return []  # Maigret treats names=[] as ALL sites, not an empty selection.
    selected = db.ranked_sites_dict(names=names, disabled=False)
    # ranked_sites_dict may append mirrors whose source matches a selected name.
    sites = copy.deepcopy({n: s for n, s in selected.items() if n in names and enumeration_site(s.url)})
    if not sites:
        return []
    if "." in username:
        for s in sites.values():
            if site(s.url) == "bsky":
                s.url = s.url.replace("{username}.bsky.social", "{username}")
                s.url_probe = s.url_probe.replace("{username}.bsky.social", "{username}")
    results = await asyncio.wait_for(
        search(username=username, site_dict=sites, logger=logger, timeout=timeout,
               is_parsing_enabled=False, is_enrich_enabled=False, id_type="username", no_progressbar=True),
        timeout=timeout,
    )
    return [r["url_user"] for r in results.values()
            if r.get("status") is not None and r["status"].is_found() and r.get("url_user")]


def run_backend(backend: str, username: str, timeout: float = 30) -> list[str]:
    """Isolate optional-library failures; timeout bounds requests and Maigret's scan."""
    if backend not in LIBRARIES:
        raise ValueError(f"Unknown OSINT backend: {backend}")
    if timeout <= 0:
        raise ValueError("OSINT timeout must be positive")
    try:
        if backend == "sherlock":
            return _sherlock(username, timeout)
        return asyncio.run(_maigret(username, timeout))
    except ImportError:
        return []
    except Exception as exc:
        logger.warning("OSINT %s failed: %s", backend, exc)
        return []


def candidates(conn, person_id: int, runner=run_backend, timeout: float = 30,
               usernames: list[str] | None = None) -> list[dict]:
    seeds = _scan_seeds(conn, person_id, usernames)
    found: dict[str, dict] = {}
    for username, origins in seeds.items():
        for backend in LIBRARIES:
            for url in runner(backend, username, timeout):
                key = profile_url(url)
                if key is None or username_for(key) is None:
                    continue
                if key not in found:
                    found[key] = {"url": key, "title": username, "snippet": "", "sources": []}
                found[key]["sources"].append({"source": backend, "url": url, "handle": username, "seed_sources": origins})
    return list(found.values())
