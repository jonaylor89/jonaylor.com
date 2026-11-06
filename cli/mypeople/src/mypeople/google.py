"""One-way sync into Google Contacts through the People API.

MyPeople only fills blanks: a birthday where Google has none, nicknames it
doesn't list, a last name where Google has only the same first name, links to
confirmed profiles it doesn't list, a photo where the contact has only the default
avatar, and a marked "MyPeople" block in the notes that it rewrites without touching the rest.
Current contact cards supply names, verified numbers, emails and other address-book
fields. Existing Google details are retained. It never deletes or merges contacts.
Matching uses stored Google links or unambiguous current phone/email keys, not names.

Setup: a Google Cloud OAuth client of type "Desktop app", with the People API
enabled, saved as ~/.mypeople/google-client.json. `mypeople google login` then
stores a refresh token next to it.
"""

from __future__ import annotations

import base64
import datetime as dt
import hashlib
import http.server
import json
import os
import re
import secrets
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from dataclasses import dataclass, field
from pathlib import Path

from . import contacts as contact_cards
from . import google_cards, identity, photos, relationships
from .events import CURRENT_STATE, current_profile, events_for, month_day
from .profile_urls import site

HOME = Path.home() / ".mypeople"
CLIENT_PATH = HOME / "google-client.json"
TOKEN_PATH = HOME / "google-token.json"
SCOPE = "https://www.googleapis.com/auth/contacts"
API = "https://people.googleapis.com/v1"
PERSON_FIELDS = "names,emailAddresses,phoneNumbers,birthdays,nicknames,biographies,photos,urls,memberships,metadata,organizations,addresses,imClients,events"
BEGIN, END = "── Sherloq ──", "── end Sherloq ──"
LABEL = "Sherloq"
WRITE_PAUSE = 1.0  # the People API limits writes per minute per user
MIN_BIRTHDAY_CONFIDENCE = 0.8
PLAIN_NAME = re.compile(r"[^\W\d_][\w .'’-]*")  # a person's name, not an address or a headline
# How each site's links are labelled in Google Contacts.
SITE_LABELS = {
    "linkedin": "LinkedIn", "github": "GitHub", "instagram": "Instagram", "x": "X", "threads": "Threads",
    "tiktok": "TikTok", "bsky": "Bluesky", "medium": "Medium", "substack": "Substack", "youtube": "YouTube",
    "soundcloud": "SoundCloud", "behance": "Behance", "dribbble": "Dribbble", "snapchat": "Snapchat",
}


class GoogleError(RuntimeError):
    pass


# --- auth -------------------------------------------------------------------


def _client() -> dict:
    if not CLIENT_PATH.exists():
        raise GoogleError(
            f"No OAuth client at {CLIENT_PATH}. Create a Desktop-app OAuth client in Google Cloud "
            "(with the People API enabled), download its JSON, and save it there."
        )
    data = json.loads(CLIENT_PATH.read_text())
    return data.get("installed") or data.get("web") or data


def _post_form(url: str, fields: dict) -> dict:
    request = urllib.request.Request(url, data=urllib.parse.urlencode(fields).encode(), method="POST")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as e:
        raise GoogleError(f"Google sign-in failed ({e.code}): {e.read().decode(errors='replace')[:300]}") from None


def _save_token(token: dict) -> None:
    token["expires_at"] = time.time() + token.get("expires_in", 3600) - 60
    TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_PATH.write_text(json.dumps(token))
    os.chmod(TOKEN_PATH, 0o600)


def login() -> None:
    """Browser sign-in with a loopback redirect and PKCE; stores a refresh token."""
    client = _client()
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(16)
    result: dict[str, str] = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            query = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(self.path).query))
            if "code" in query or "error" in query:
                result.update(query)
            self.send_response(200)
            self.send_header("content-type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write("MyPeople is signed in. You can close this tab.".encode() if "code" in query else b"Sign-in failed.")

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    redirect = f"http://127.0.0.1:{server.server_port}"
    url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
        "client_id": client["client_id"], "redirect_uri": redirect, "response_type": "code", "scope": SCOPE,
        "code_challenge": challenge, "code_challenge_method": "S256", "state": state,
        "access_type": "offline", "prompt": "consent",
    })
    print(f"Opening your browser to sign in to Google. If it doesn't open, visit:\n{url}")
    webbrowser.open(url)
    while not result:
        server.handle_request()
    server.server_close()
    if result.get("state") != state or "code" not in result:
        raise GoogleError(f"Sign-in didn't complete: {result.get('error', 'state mismatch')}")
    token = _post_form("https://oauth2.googleapis.com/token", {
        "client_id": client["client_id"], "client_secret": client.get("client_secret", ""), "code": result["code"],
        "code_verifier": verifier, "grant_type": "authorization_code", "redirect_uri": redirect,
    })
    _save_token(token)


def access_token() -> str:
    if not TOKEN_PATH.exists():
        raise GoogleError("Not signed in to Google. Run `mypeople google login` first.")
    token = json.loads(TOKEN_PATH.read_text())
    if time.time() < token.get("expires_at", 0):
        return token["access_token"]
    if "refresh_token" not in token:
        raise GoogleError("The Google sign-in has expired. Run `mypeople google login` again.")
    client = _client()
    fresh = _post_form("https://oauth2.googleapis.com/token", {
        "client_id": client["client_id"], "client_secret": client.get("client_secret", ""),
        "refresh_token": token["refresh_token"], "grant_type": "refresh_token",
    })
    fresh.setdefault("refresh_token", token["refresh_token"])
    _save_token(fresh)
    return fresh["access_token"]


def api(method: str, path: str, body: dict | None = None, params: dict | None = None) -> dict:
    url = f"{API}/{path}" + ("?" + urllib.parse.urlencode(params) if params else "")
    for attempt in range(5):
        request = urllib.request.Request(
            url, data=json.dumps(body).encode() if body is not None else None, method=method,
            headers={"authorization": f"Bearer {access_token()}", "content-type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            if e.code in (429, 500, 503) and attempt < 4:
                time.sleep(2 ** (attempt + 2))
                continue
            if e.code == 403 and ("SERVICE_DISABLED" in detail or "has not been used" in detail):
                project = _client().get("project_id", "")
                raise GoogleError(
                    "The People API isn't enabled for your Google Cloud project yet. Enable it at "
                    f"https://console.cloud.google.com/apis/library/people.googleapis.com?project={project} "
                    "and retry in a few minutes."
                ) from None
            raise GoogleError(f"Google API {method} {path} failed ({e.code}): {detail[:500]}") from None
    raise AssertionError("unreachable")


def fetch_contacts(fields: str = PERSON_FIELDS) -> list[dict]:
    contacts, page = [], None
    while True:
        params = {"personFields": fields, "pageSize": 1000, **({"pageToken": page} if page else {})}
        data = api("GET", "people/me/connections", params=params)
        contacts += data.get("connections", [])
        page = data.get("nextPageToken")
        if not page:
            return contacts


# --- planning ---------------------------------------------------------------


@dataclass
class Change:
    person_id: int
    name: str
    resource: str | None  # None means create
    etag: str | None = None
    fields: dict = field(default_factory=dict)  # People API field name -> full new list
    notes: list[str] = field(default_factory=list)  # human-readable summary
    photo: str | None = None
    photo_data: str | None = None  # current card's base64 JPEG/PNG; never a dry-run file write


def mypeople_block(conn: sqlite3.Connection, person_id: int, today: dt.date) -> str | None:
    events = [e for e in events_for(conn, person_id) if e["source"] != "vcard"]
    rel = relationships.infer(conn, person_id, today)
    lines = []
    profile = current_profile(events)
    now = [profile[t]["value"].rstrip(".") for t in CURRENT_STATE if t in profile]
    if now:
        lines.append("Now: " + " · ".join(now))
    family = [e["value"].rstrip(".") for e in events if e["type"] == "family"][:2]
    if family:
        lines.append("Family: " + "; ".join(family))
    interests = [e["value"].rstrip(".") for e in events if e["type"] == "interest"][:3]
    if interests:
        lines.append("Into: " + "; ".join(interests))
    last = conn.execute(
        "SELECT at, channel FROM interactions WHERE person_id = ? ORDER BY at DESC LIMIT 1", (person_id,)
    ).fetchone()
    if not lines:
        return None  # "last in touch" alone isn't worth a write, and would go stale
    if last:
        # Month granularity, so the block doesn't change (and get rewritten) every day.
        month = dt.date.fromisoformat(last["at"][:10]).strftime("%b %Y")
        category = f", {rel.category}" if rel.category != "unknown" else ""
        lines.append(f"Last in touch: {month} ({last['channel']}){category}")
    return "\n".join([BEGIN, *lines, END])


def merge_notes(existing: str, block: str) -> str:
    """Replace the MyPeople block in the notes (or append one), leaving the user's text alone."""
    start, end = existing.find(BEGIN), existing.find(END)
    if start >= 0 and end > start:
        existing = existing[:start] + existing[end + len(END):]
    existing = existing.strip()
    return f"{existing}\n\n{block}" if existing else block


def _birthday(conn: sqlite3.Connection, person_id: int, today: dt.date) -> dict | None:
    best = None
    for e in events_for(conn, person_id):
        if e["type"] == "birthday" and e["confidence"] >= MIN_BIRTHDAY_CONFIDENCE and (md := month_day(e["date"])):
            date = {"month": md[0], "day": md[1]}
            # A birthday mentioned in messages is dated by when it was celebrated, so a recent
            # year is that occurrence, not the birth year. Only keep years that could be births.
            if len(e["date"]) == 10 and e["date"][:4].isdigit() and int(e["date"][:4]) <= today.year - 10:
                date["year"] = int(e["date"][:4])
            if best is None or ("year" in date and "year" not in best):
                best = date
    return {"date": best} if best else None


def split_name(name: str) -> tuple[str, str] | None:
    """'Andrea Göschel' -> ('Andrea', 'Göschel'). None for one-word names, addresses and the like."""
    words = name.split()
    if len(words) < 2 or not PLAIN_NAME.fullmatch(name) or identity.looks_like_identifier(name):
        return None
    return words[0], " ".join(words[1:])


def _names(contact: dict, name: str, desired: dict | None = None) -> list[dict] | None:
    """The contact's names with MyPeople's last name added, if Google has the same first name and no last name."""
    if desired is None:
        split = split_name(name)
    else:
        split = (desired["givenName"], desired["familyName"]) if desired.get("givenName") and desired.get("familyName") else None
    names = contact.get("names", [])
    primary = next((n for n in names if n.get("metadata", {}).get("primary")), names[0] if names else None)
    if split is None or primary is None or primary.get("familyName"):
        return None
    given = (primary.get("givenName") or "").strip()
    if given.casefold() != split[0].casefold():
        return None  # "Mom", or a different spelling: the contact's own name wins
    updated = {k: v for k, v in primary.items() if k in ("givenName", "middleName", "honorificPrefix", "honorificSuffix")}
    updated["familyName"] = split[1]
    return [updated if n is primary else n for n in names]


def _comparable(url: str) -> str:
    return re.sub(r"^https?://(www\.|m\.)?", "", url.strip().lower()).rstrip("/")


def links(conn: sqlite3.Connection, person_id: int) -> list[dict]:
    """Confirmed public profiles and Snapchat usernames, as People API urls labelled by site."""
    urls = [r["url"] for r in conn.execute(
        "SELECT url FROM profiles WHERE person_id = ? AND status = 'confirmed' ORDER BY site, url", (person_id,))]
    from urllib.parse import quote
    from .profile_urls import profile_url
    rejected = {profile_url(r["url"]) for r in conn.execute(
        "SELECT url FROM profiles WHERE person_id=? AND status='rejected'", (person_id,))}
    urls += [url for r in conn.execute(
        "SELECT value FROM identifiers WHERE person_id=? AND kind='snapchat' "
        "AND source IN ('snapchat', 'manual') ORDER BY value", (person_id,))
        if (url := profile_url("https://www.snapchat.com/add/" + quote(r["value"].strip(), safe=""))) and url not in rejected]
    out, seen = [], set()
    for url in urls:
        if _comparable(url) not in seen:
            seen.add(_comparable(url))
            out.append({"value": url, "type": SITE_LABELS.get(site(url), "profile")})
    return out


def _has_real_photo(contact: dict) -> bool:
    return any(not p.get("default") for p in contact.get("photos", []))


def _matching(
    conn: sqlite3.Connection, remote: list[dict], warnings: list[str],
) -> tuple[dict[int, list[dict]], set[int]]:
    """Use stable links, otherwise all current keys; never choose the first hit."""
    rows = conn.execute("SELECT * FROM people WHERE merged_into IS NULL AND is_me=0 AND trashed=0").fetchall()
    active = {r["id"] for r in rows}
    index: dict[tuple, set[int]] = {}
    for row in rows:
        card = contact_cards.card_for(row)
        if card is not None:
            for f in card.get("fields", []):
                kind = f.get("kind")
                value = (contact_cards.contact_phone(card, f)[0] if kind == "phone"
                         else identity.normalize_email(f.get("value", "")) if kind == "email" else None)
                if value:
                    index.setdefault((kind, value), set()).add(row["id"])
        if card is None or (card.get("legacy_unverified") and not card.get("user_edited")):
            # A graph always has a derived card, including legacy-only people.
            # Historical identifiers remain matching hints, never export authority.
            for ident in conn.execute("SELECT kind, value FROM identifiers WHERE person_id=?", (row["id"],)):
                kind, value = ident
                value = contact_cards.phone(value)[0] if kind == "phone" else identity.normalize_email(value) if kind == "email" else None
                if value:
                    index.setdefault((kind, value), set()).add(row["id"])
    links: dict[str, int] = {}
    for row in conn.execute("SELECT person_id, value FROM identifiers WHERE kind='google'"):
        pid = identity.canonical(conn, row["person_id"])
        # Retain inactive links too, so their remote keys cannot match someone else.
        links[row["value"]] = pid
    matched, blocked = {}, set()
    for c in remote:
        resource = c["resourceName"]
        if resource in links:
            pid = links[resource]
            if pid in active:
                matched.setdefault(pid, []).append(c)
            continue
        candidates = set()
        for p in c.get("phoneNumbers", []):
            number = contact_cards.phone(p.get("canonicalForm") or p.get("value", ""))[0]
            candidates.update(index.get(("phone", number), ()))
        for e in c.get("emailAddresses", []):
            candidates.update(index.get(("email", identity.normalize_email(e.get("value", ""))), ()))
        if len(candidates) == 1:
            matched.setdefault(next(iter(candidates)), []).append(c)
        elif candidates:
            blocked.update(candidates)
            warnings.append(f"{resource}: ambiguous phone/email match; skipped (MyPeople IDs {', '.join(map(str, sorted(candidates)))}). Review separately.")
    # A missing linked Google contact is not permission to recreate it.
    resources = {c["resourceName"] for c in remote}
    for resource, pid in links.items():
        if pid in active and resource not in resources and pid not in matched:
            blocked.add(pid)
            warnings.append(f"#{pid}: linked Google contact {resource} is missing; review before creating a replacement.")
    return matched, blocked


def match(conn: sqlite3.Connection, contacts: list[dict]) -> dict[int, list[dict]]:
    """MyPeople person -> Google contacts sharing a stable link or unique keys."""
    return _matching(conn, contacts, [])[0]


def plan(
    conn: sqlite3.Connection, contacts: list[dict], create: bool = False, with_photos: bool = False,
    min_interactions: int = 20, today: dt.date | None = None, with_notes: bool = True,
    person_ids: set[int] | None = None, warnings: list[str] | None = None,
) -> list[Change]:
    if min_interactions < 0:
        raise GoogleError("--min-messages must be zero or greater.")
    today = today or dt.date.today()
    warnings = warnings if warnings is not None else []
    matched, blocked = _matching(conn, contacts, warnings)
    from . import replica
    history = replica.load(conn)
    changes: list[Change] = []
    people = conn.execute("SELECT * FROM people WHERE merged_into IS NULL AND is_me=0 AND trashed=0 ORDER BY name").fetchall()
    for p in people:
        pid, name = p["id"], p["name"]
        if person_ids is not None and pid not in person_ids:
            continue
        state = history.contact(p["contact_uid"])
        if state and state.conflicts:
            warnings.append(f"{name} (#{pid}): unresolved contact conflicts; resolve with `mypeople contact conflicts` before exporting.")
            continue
        if pid in blocked:
            continue
        if pid not in matched:
            if not create:
                continue
            if person_ids is None:
                if identity.looks_like_identifier(name):
                    continue
                n = conn.execute("SELECT COUNT(*) FROM interactions WHERE person_id = ?", (pid,)).fetchone()[0]
                sent = conn.execute("SELECT 1 FROM interactions WHERE person_id = ? AND direction = 'out' LIMIT 1", (pid,)).fetchone()
                if n < min_interactions or not sent:
                    continue
        card = contact_cards.card_for(p)
        if card is None:
            warnings.append(f"{name} (#{pid}): no current contact card; historical phone/email identifiers will not be exported. Import an address book or edit the contact first.")
        exported = google_cards.fields(card, with_notes=with_notes) if card else {}
        if card:
            omitted = sum(f.get("kind") == "phone" and bool(f.get("value", "").strip()) and not contact_cards.contact_phone(card, f)[0]
                          for f in card.get("fields", []))
            if omitted:
                warnings.append(f"{name} (#{pid}): {omitted} invalid/unverified phone number(s) omitted; re-import originals or verify the card.")
        block = mypeople_block(conn, pid, today) if with_notes else None
        birthday = (exported.get("birthdays") or [None])[0]
        if not birthday and not (card and card.get("user_edited")):
            birthday = _birthday(conn, pid, today)
        nicknames = identity.aliases(conn, pid)
        photo = photos.best(conn, pid) if with_photos else None
        photo_data = card.get("photo") if card and with_photos else None
        profile_links = google_cards.append_missing("urls", exported.get("urls", []), links(conn, pid))
        for c in matched.get(pid, []):
            ch = Change(pid, name, c["resourceName"], c.get("etag"))
            desired_name = (exported.get("names") or [None])[0]
            if card and not c.get("names"):
                ch.fields["names"] = exported.get("names") or [{"unstructuredName": name}]
                ch.notes.append("name")
            elif names := _names(c, name, desired_name):
                ch.fields["names"] = names
                ch.notes.append("last name")
            for key in ("phoneNumbers", "emailAddresses", "addresses", "imClients", "events", "urls"):
                incoming = profile_links if key == "urls" else exported.get(key, [])
                current = c.get(key, [])
                combined = google_cards.append_missing(key, current, incoming)
                if combined != current:
                    ch.fields[key] = combined
                    ch.notes.append(f"{key}: {len(combined) - len(current)} added")
            if exported.get("organizations") and not c.get("organizations"):
                ch.fields["organizations"] = exported["organizations"]
                ch.notes.append("organization")
            if birthday and not c.get("birthdays"):
                ch.fields["birthdays"] = [birthday]
                ch.notes.append(f"birthday {birthday['date']}")
            have = {n.get("value", "").lower() for n in c.get("nicknames", [])}
            missing = [n for n in nicknames if n.lower() not in have]
            if missing:
                ch.fields["nicknames"] = c.get("nicknames", []) + [{"value": n} for n in missing]
                ch.notes.append("nicknames " + ", ".join(missing))
            if with_notes:
                bios = c.get("biographies", [])
                current = bios[0].get("value", "") if bios else ""
                new = current or (exported.get("biographies") or [{}])[0].get("value", "")
                if block:
                    new = merge_notes(new, block)
                if new != current:
                    ch.fields["biographies"] = [{"value": new, "contentType": "TEXT_PLAIN"}]
                    ch.notes.append("notes")
            if (photo or photo_data) and not _has_real_photo(c):
                ch.photo_data = photo_data
                ch.photo = photo["path"] if photo and not photo_data else None
                ch.notes.append("photo (contact card)" if photo_data else f"photo ({photo['source']}, {photo['width']}px)")
            if ch.fields or ch.photo or ch.photo_data:
                changes.append(ch)
        if create and pid not in matched:
            ch = Change(pid, name, None, fields=dict(exported))
            split = split_name(name)
            ch.fields.setdefault("names", [{"givenName": split[0], "familyName": split[1]} if split else {"unstructuredName": name}])
            if profile_links:
                ch.fields["urls"] = profile_links
            if birthday:
                ch.fields["birthdays"] = [birthday]
            if nicknames:
                ch.fields["nicknames"] = [{"value": n} for n in nicknames]
            if block:
                ch.fields["biographies"] = [{"value": merge_notes((ch.fields.get("biographies") or [{}])[0].get("value", ""), block), "contentType": "TEXT_PLAIN"}]
            ch.photo_data = photo_data
            ch.photo = photo["path"] if photo and not photo_data else None
            ch.notes.append("new contact (" + ", ".join(k for k in ch.fields if k != "names") + (", photo" if ch.photo or ch.photo_data else "") + ")")
            changes.append(ch)
    return changes


# --- applying ---------------------------------------------------------------


def find_label() -> str | None:
    groups = api("GET", "contactGroups", params={"pageSize": 1000}).get("contactGroups", [])
    return next((g["resourceName"] for g in groups if g.get("name") == LABEL), None)


def _label() -> str:
    return find_label() or api("POST", "contactGroups", {"contactGroup": {"name": LABEL}})["resourceName"]


def apply(conn: sqlite3.Connection, changes: list[Change], progress=print) -> int:
    label = None
    done = 0
    for n, ch in enumerate(changes, 1):
        if ch.resource is None:
            label = label or _label()
            body = {**ch.fields, "memberships": [{"contactGroupMembership": {"contactGroupResourceName": label}}]}
            created = api("POST", "people:createContact", body, {"personFields": "metadata"})
            ch.resource = created["resourceName"]
            # Remember the link, so a contact without a phone or email isn't created twice.
            identity.add_identifier(conn, ch.person_id, "google", ch.resource, "google")
            conn.commit()
        elif ch.fields:
            body = {**ch.fields, "etag": ch.etag}
            api("PATCH", f"{ch.resource}:updateContact", body,
                {"updatePersonFields": ",".join(ch.fields), "personFields": "metadata"})
            identity.add_identifier(conn, ch.person_id, "google", ch.resource, "google")
            conn.commit()
        if ch.photo or ch.photo_data:
            time.sleep(WRITE_PAUSE)
            data = ch.photo_data or base64.b64encode(Path(ch.photo).read_bytes()).decode()
            api("PATCH", f"{ch.resource}:updateContactPhoto", {"photoBytes": data, "personFields": "metadata"})
        done += 1
        progress(f"[{n}/{len(changes)}] {ch.name}: {', '.join(ch.notes)}")
        time.sleep(WRITE_PAUSE)
    return done
