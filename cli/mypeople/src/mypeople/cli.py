"""mypeople: a memory for the people in your life."""

from __future__ import annotations

import argparse
import datetime as dt
import json
from functools import partial
from contextlib import ExitStack
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

from . import db, identity, moments, relationships
from .events import CURRENT_STATE, EVENT_TYPES, forget, remember, current_profile, events_for, format_date, is_superseded


def _date(value: str) -> dt.date:
    return dt.date.fromisoformat(value)


def _positive_int(value: str) -> int:
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return number


def _public_username(value: str) -> str:
    from .osint import public_username

    try:
        return public_username(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from None


def _default_since() -> dt.date:
    return dt.date.today() - dt.timedelta(days=730)


def cmd_import(conn, args) -> None:
    if args.source == "vcf":
        from .importers.vcard import import_vcards

        stats = import_vcards(conn, Path(args.path))
    elif args.source == "imessage":
        from .importers.imessage import DEFAULT_DB, import_imessage

        path = Path(args.path) if args.path else DEFAULT_DB
        try:
            stats = import_imessage(conn, path, args.since)
        except Exception as e:  # sqlite3 gives "unable to open" without Full Disk Access
            sys.exit(f"Couldn't read {path}: {e}\nGrant your terminal Full Disk Access in System Settings > Privacy & Security.")
    elif args.source == "whatsapp":
        from .importers.whatsapp import DEFAULT_DIR, import_whatsapp

        path = Path(args.path) if args.path else DEFAULT_DIR
        try:
            stats = import_whatsapp(conn, path, args.since)
        except Exception as e:  # sqlite3 gives "unable to open" without Full Disk Access
            sys.exit(f"Couldn't read WhatsApp data in {path}: {e}\nGrant your terminal Full Disk Access in System Settings > Privacy & Security.")
    elif args.source == "gvoice":
        from .importers.gvoice import import_gvoice

        if not args.path:
            sys.exit("Pass the Takeout Voice folder, e.g. ~/Desktop/Takeout/Voice")
        stats = import_gvoice(conn, Path(args.path).expanduser(), args.since)
    elif args.source == "snapchat":
        from .importers.snapchat import import_snapchat

        if not args.path:
            sys.exit("Pass the unzipped Snapchat export folder, e.g. ~/Desktop/mydata~1234")
        stats = import_snapchat(conn, Path(args.path).expanduser(), args.since)
    elif args.source == "instagram":
        from .importers.instagram import import_instagram

        if not args.path:
            sys.exit("Pass the unzipped Instagram export folder, e.g. ~/Desktop/instagram-yourname-2026-10-23-abc")
        stats = import_instagram(conn, Path(args.path).expanduser(), args.since)
    elif args.source == "linkedin":
        from .importers.linkedin import import_linkedin

        if not args.path:
            sys.exit("Pass the unzipped LinkedIn export folder, e.g. ~/Desktop/Basic_LinkedInDataExport_10-24-2026")
        stats = import_linkedin(conn, Path(args.path).expanduser(), args.since)
    elif args.source == "signal":
        from .importers.signal import SignalError, import_signal

        if not args.path:
            sys.exit("Pass a Signal JSONL snapshot made with signal_export.py (see docs/signal.md).")
        try:
            stats = import_signal(conn, Path(args.path).expanduser(), args.since)
        except SignalError as e:
            sys.exit(str(e))
    elif args.source == "telegram":
        from .importers.telegram import TelegramError, import_telegram

        if not args.path:
            sys.exit("Pass the Telegram Desktop JSON export folder or result.json file.")
        try:
            stats = import_telegram(conn, Path(args.path).expanduser(), args.since)
        except TelegramError as e:
            sys.exit(str(e))
    elif args.source == "twitter":
        from .importers.twitter import import_twitter

        if not args.path:
            sys.exit("Pass the unzipped X archive folder, e.g. ~/Desktop/twitter-2026-10-27-abc")
        root = Path(args.path).expanduser()
        names = Path(args.names).expanduser() if args.names else None
        stats = import_twitter(conn, root, args.since, names)
        if args.review and stats["unnamed"] and _review_x(conn, root):
            more = import_twitter(conn, root, args.since, names)  # bring in the newly named conversations
            stats = {**more, "interactions": stats["interactions"] + more["interactions"]}
        stats.pop("unnamed_accounts")
        if stats["unnamed"] and not args.review:
            print(f"{stats['unnamed']} people you wrote to aren't named in the archive. "
                  "Run again with --review to see each conversation and say who it is.")
    elif args.source == "google":
        from . import google
        from .importers.gcontacts import FIELDS, import_google_contacts

        try:
            stats = import_google_contacts(conn, google.fetch_contacts(FIELDS), google.find_label())
        except google.GoogleError as e:
            sys.exit(str(e))
    elif args.source == "mino":
        from .importers.mino import DEFAULT_DB, import_mino

        path = Path(args.path) if args.path else DEFAULT_DB
        if not path.exists():
            sys.exit(f"No Mino mail store at {path}. Is Mino installed and signed in?")
        stats = import_mino(conn, path, args.since)
    else:
        from .importers.mbox import import_mbox

        if not args.me and not identity.my_addresses(conn):
            sys.exit("Pass --me with your own address(es), or mark your own record with `mypeople me`, so MyPeople can tell sent mail from received.")
        stats = import_mbox(conn, Path(args.path), args.me or [], args.since)
    print(", ".join(f"{v} {k}" for k, v in stats.items()))


def _review_x(conn, root: Path) -> int:
    """Go through X conversations the archive doesn't name, and record who each one is with."""
    from .importers import twitter

    todo = twitter.unnamed(conn, root)
    print(f"\n{len(todo)} conversations to name. Type who it is: a name, an @handle, or both (\"Ana Lopez @ana\").")
    print("An existing name or #id links them to someone you have. "
          "[o]pen their profile on X · [m]ore messages · [s]kip · [q]uit")
    named = 0
    for number, u in enumerate(todo, 1):
        start = max(0, len(u.messages) - 8)
        batch = u.messages[start:]
        print(f"\n── {number} of {len(todo)} · {len(u.messages)} messages, {u.messages[0][0][:7]} to {u.messages[-1][0][:7]} " + "─" * 16)
        if u.tweets_shared:
            print(f"  They sent you tweets by: {', '.join('@' + a for a in u.tweets_shared[:5])}")
        while True:
            for at, mine, text in batch:
                print(f"  {at[:10]}  {'you ' if mine else 'them'}: {' '.join(text.split())[:160]}")
            batch = []
            answer = input("  Who is this? ").strip()
            if answer.lower() in ("q", "quit"):
                return named
            if answer.lower() in ("", "s", "skip"):
                break
            if answer.lower() == "o":
                subprocess.run(["open", u.link])
                continue
            if answer.lower() == "m":
                if start == 0:
                    print("  That's the whole conversation.")
                else:
                    print("  Earlier:")
                    batch, start = u.messages[max(0, start - 20):start], max(0, start - 20)
                continue
            words = answer.split()
            handle = next((w.lstrip("@") for w in words if w.startswith("@")), None)
            name = " ".join(w for w in words if not w.startswith("@")) or None
            person_id = None
            if name and name.startswith("#") and name[1:].isdigit():
                person_id = identity.lookup(conn, name[1:])["id"]
            elif name:
                same = conn.execute(
                    "SELECT id, name FROM people WHERE merged_into IS NULL AND is_me = 0 AND (lower(name) = lower(?) "
                    "OR id IN (SELECT person_id FROM aliases WHERE lower(alias) = lower(?)))", (name, name)).fetchall()
                if len(same) > 1:
                    print("  Several people are called that: " + ", ".join(f"{r['name']} (#{r['id']})" for r in same)
                          + ". Type #id to pick one, or a fuller name for someone new.")
                    continue
                if same and input(f"  Link to {same[0]['name']} (#{same[0]['id']}), whom you already have? [y/n] ").strip().lower() == "y":
                    person_id = same[0]["id"]
            pid = twitter.name_account(conn, u.account_id, name, handle, person_id)
            print(f"  Saved: {conn.execute('SELECT name FROM people WHERE id = ?', (pid,)).fetchone()['name']} (#{pid}).")
            named += 1
            break
    return named


def _model():
    from .extract import default_model

    return default_model()


def _llm_errors():
    from .llm import LLMError

    return (LLMError,)


def cmd_extract(conn, args) -> None:
    from .extract import extract_note, extract_person, pending_notes, pending_people, plan_person

    # One named person, or --all, means their whole history unless --since says otherwise.
    since = args.since or (None if args.all or args.person else _default_since())
    if args.person:
        p = identity.lookup(conn, args.person)
        todo = [{"id": p["id"], "name": p["name"], "pending": "?"}]
    else:
        pending = pending_people(conn, since)
        if args.reverse:
            pending.reverse()
        todo = pending if args.all else pending[: args.limit]
        waiting = sum(p["pending"] for p in pending)
        window = "all time" if since is None else f"since {since.isoformat()}"
        print(f"{len(pending)} people with {waiting} unread messages ({window}); this run reads {len(todo)} of them.")
    notes = pending_notes(conn, p["id"] if args.person else None)
    if not todo and not notes:
        print("Nothing new to read.")
        return
    if args.dry_run:
        if notes:
            print(f"{len(notes)} unread note{'s' if len(notes) != 1 else ''}")
        for p in todo:
            print(f"{p['name']} (#{p['id']}): {p['pending']} new messages")
        return
    from .llm import backend

    model = _model()
    b = backend()
    print(f"Using {b.model} ({b.name}).", flush=True)
    from .extraction_progress import ExtractionProgress

    mode = args.progress
    total = 0
    try:
        for note in notes:
            total += extract_note(conn, model, note["person_id"], note["value"])
    except _llm_errors() as e:
        sys.exit(f"Couldn't read a note about {note['name']}: {e}\nIt's saved; rerun to try again.")
    if not todo:
        print(f"Done. {total} new events.", flush=True)
        return
    display = None
    current_name = "batch preparation"
    try:
        if mode != "off":
            print("Preparing batch estimates…", file=sys.stderr, flush=True)
        plans = [plan_person(conn, p["id"], since) for p in todo] if mode != "off" else []
        with ExtractionProgress(plans, b.name, b.model, mode) as display:
            for n, p in enumerate(todo, 1):
                current_name = p["name"]
                added = extract_person(conn, model, p["id"], since,
                                       progress=display.update if display.enabled else None)
                total += added
                if not display.enabled:
                    print(f"[{n}/{len(todo)}] {p['name']}: {added} new event{'s' if added != 1 else ''}", flush=True)
    except KeyboardInterrupt:
        if display is None or not display.enabled:
            print("Paused. Rerun the same command to resume from saved batches.", file=sys.stderr)
        sys.exit(130)
    except _llm_errors() as e:
        sys.exit(f"Extraction failed for {current_name}: {e}")
    print(f"Done. {total} new events.", flush=True)


def cmd_today(conn, args) -> None:
    today = args.date or dt.date.today()
    chosen = moments.today_moments(conn, today, args.n, record=not args.preview)
    print(today.strftime("%A, %B %-d"))
    if not chosen:
        print("\nNothing today. That's fine.")
        return
    for m in chosen:
        row = conn.execute("SELECT id FROM moments WHERE key = ?", (m.key,)).fetchone()
        tag = f"#{row['id']} " if row else ""
        print(f"\n  {m.reason}\n    {m.context}  {tag}[{m.kind}]")


def cmd_people(conn, args) -> None:
    rows = conn.execute(
        "SELECT id, name FROM people WHERE merged_into IS NULL AND is_me = 0 AND lower(name) LIKE lower(?)",
        (f"%{args.query or ''}%",),
    ).fetchall()
    rels = sorted(((relationships.infer(conn, r["id"]), r) for r in rows), key=lambda x: -x[0].closeness)
    for rel, r in rels[: args.limit]:
        last = f"{rel.days_since}d ago" if rel.days_since is not None else "never"
        cadence = f"every ~{round(rel.cadence_days)}d" if rel.cadence_days else ""
        print(f"#{r['id']:<5} {r['name'][:28]:<28} {rel.closeness:4.2f}  {rel.category:<12} {rel.trend:<9} {last:<10} {cadence}")


def cmd_show(conn, args) -> None:
    p = identity.lookup(conn, args.person)
    rel = relationships.infer(conn, p["id"])
    ids = conn.execute("SELECT kind, value FROM identifiers WHERE person_id = ?", (p["id"],)).fetchall()
    nicknames = identity.aliases(conn, p["id"])
    print(f"{p['name']} (#{p['id']})" + (f", also called {', '.join(nicknames)}" if nicknames else "") + (" — this is you" if p["is_me"] else ""))
    if ids:
        print("  " + ", ".join(i["value"] for i in ids if i["kind"] != "google"))
    from .socials import confirmed

    links = confirmed(conn, p["id"])
    if links:
        print("  " + "  ".join(l["url"] for l in links))
    cadence = f", usually every ~{round(rel.cadence_days)} days" if rel.cadence_days else ""
    last = f"last talked {rel.days_since} days ago via {rel.last_channel}" if rel.days_since is not None else "no conversations yet"
    print(f"  {rel.category}, closeness {rel.closeness:.2f}, {rel.trend}{cadence}; {last}")
    events = events_for(conn, p["id"])
    if not events:
        print("\n  No events yet. Try `mypeople extract --person` or `mypeople note`.")
        return
    profile = current_profile(events)
    if profile:
        print("  Now: " + " · ".join(profile[t]["value"] for t in CURRENT_STATE if t in profile))
    print()
    for e in events:
        conf = "" if e["confidence"] >= 0.8 else f" ({e['confidence']:.0%} sure)"
        old = " (superseded)" if is_superseded(e, profile) else ""
        print(f"  #{e['id']:<5} {format_date(e['date']):<14} {e['type']:<11} {e['value']}{old}{conf}  [{e['source']}]")
        if args.evidence and e["evidence"]:
            print(f"         “{e['evidence']}”")


def cmd_note(conn, args) -> None:
    from .extract import extract_note

    p = identity.lookup(conn, args.person)
    try:
        added = extract_note(conn, _model(), p["id"], " ".join(args.text))
    except _llm_errors() as e:
        sys.exit(f"Saved your note, but couldn't read it for facts: {e}\nRun `mypeople extract` to try again.")
    print(f"Noted. {added} new event{'s' if added != 1 else ''} for {p['name']}.")


def cmd_add(conn, args) -> None:
    p = identity.lookup(conn, args.person)
    eid = remember(conn, p["id"], args.type, args.value, args.date)
    conn.commit()
    print(f"Added #{eid} for {p['name']}." if eid else "Already known.")


def cmd_forget(conn, args) -> None:
    row = conn.execute("SELECT person_id, type, value, date FROM events WHERE id = ?", (args.event_id,)).fetchone()
    if row is not None:
        forget(conn, row["person_id"], row["type"], row["value"], row["date"])
    conn.commit()
    print("Forgotten." if row is not None else f"No event #{args.event_id}.")


def cmd_set(conn, args) -> None:
    p = identity.lookup(conn, args.person)
    fields = {}
    for pair in args.fields:
        key, _, value = pair.partition("=")
        key = {"cadence": "cadence_days"}.get(key, key)
        if key == "category" and value not in relationships.CATEGORIES:
            sys.exit(f"category must be one of {', '.join(relationships.CATEGORIES)}")
        if key in ("closeness", "cadence_days"):
            value = float(value) if value else None
        if key == "muted":
            value = int(value.lower() in ("1", "true", "yes"))
        fields[key] = value or None
    try:
        relationships.set_override(conn, p["id"], **fields)
    except ValueError as e:
        sys.exit(str(e))
    print(f"Updated {p['name']}.")


def cmd_me(conn, args) -> None:
    if args.people:
        ids = [identity.lookup(conn, q)["id"] for q in args.people]
        keep = identity.set_me(conn, ids)
        conn.commit()
        print(f"Got it. #{keep} is you; your addresses and numbers won't become people.")
    user = identity.me(conn)
    if not user:
        print("MyPeople doesn't know which record is you yet. Run `mypeople me NAME…` with each record of yours.")
        return
    ids = conn.execute("SELECT value FROM identifiers WHERE person_id = ?", (user["id"],)).fetchall()
    nicknames = identity.aliases(conn, user["id"])
    print(f"You: {user['name']} (#{user['id']})" + (f", also called {', '.join(nicknames)}" if nicknames else ""))
    print("  " + (", ".join(i["value"] for i in ids) or "no addresses or numbers yet"))


def cmd_alias(conn, args) -> None:
    p = identity.lookup(conn, args.person)
    if args.remove:
        conn.executemany("DELETE FROM aliases WHERE person_id = ? AND lower(alias) = lower(?)", [(p["id"], n) for n in args.names])
    else:
        for name in args.names:
            identity.add_alias(conn, p["id"], name)
    conn.commit()
    nicknames = identity.aliases(conn, p["id"])
    print(f"{p['name']} is also called: {', '.join(nicknames)}" if nicknames else f"{p['name']} has no nicknames.")


def cmd_rename(conn, args) -> None:
    p = identity.lookup(conn, args.person)
    from . import replica
    replica.capture(conn)
    uid = conn.execute("SELECT contact_uid FROM people WHERE id=?", (identity.canonical(conn, p["id"]),)).fetchone()[0]
    replica.change(conn, uid, values={"name": args.name, "user_edited": True})
    conn.commit()
    print(f"{p['name']} is now {args.name}.")


def cmd_dupes(conn, args) -> None:
    from . import dupes

    groups = dupes.to_review(conn, same_names=not args.first_names)
    if not groups:
        print("No people share a name, or you've reviewed them all.")
        return
    prompt = "  [m]erge all · pick some (e.g. 1 3) · [n]ot the same · [a]sk the model · [p]hotos · [s]kip · [q]uit: "
    merged = 0
    for number, group in enumerate(groups, 1):
        cards = [dupes.card(conn, p) for p in group]
        partial = len({" ".join(p["name"].lower().split()) for p in group}) > 1
        title = f"{group[0]['name']}, or one of these?" if partial else group[0]["name"]
        print(f"\n── {title}  ({number} of {len(groups)}) " + "─" * 20)
        print(dupes.render(cards))
        for clue in dupes.shared_clues(cards, conn):
            print(f"  · {clue}")
        if not args.merge:
            continue
        while True:
            answer = input(prompt).strip().lower()
            if answer == "a":
                try:
                    v = dupes.judge(cards)
                    print(f"  Model: {'same person' if v.same_person else 'different people'} "
                          f"({v.confidence:.0%} one person). {v.reason}")
                except _llm_errors() as e:
                    print(f"  Couldn't ask the model: {e}")
                continue
            if answer == "p":
                paths = [path for c in cards for path in c.photos]
                if paths:
                    subprocess.run(["open", *paths])
                else:
                    print("  No photos for these records.")
                continue
            picked = [int(x) for x in answer.replace(",", " ").split() if x.isdigit()]
            if answer == "m":
                picked = list(range(1, len(group) + 1))
            if picked and (len(set(picked)) < 2 or not all(1 <= i <= len(group) for i in picked)):
                print(f"  Pick at least two of 1–{len(group)}.")
                continue
            break
        if answer == "q":
            break
        if answer == "n":
            dupes.mark_distinct(conn, [p["id"] for p in group])
            print("  Noted; they won't come up again.")
        elif picked:
            chosen = [group[i - 1] for i in sorted(set(picked))]
            from . import replica
            replica.capture(conn)
            keep = dupes.merge(conn, chosen, commit=False)
            replica.capture(conn)
            conn.commit()
            keep = identity.canonical(conn, keep)
            merged += len(chosen) - 1
            name = conn.execute("SELECT name FROM people WHERE id = ?", (keep,)).fetchone()["name"]
            print(f"  Merged into {name} (#{keep}).")
    if args.merge:
        print(f"\nMerged {merged} record{'s' if merged != 1 else ''}.")
    else:
        print(f"\n{len(groups)} groups to review. Go through them with `mypeople dupes --merge`.")


def cmd_merge(conn, args) -> None:
    keep, drop = identity.lookup(conn, args.keep), identity.lookup(conn, args.drop)
    from . import replica, contact_cli
    replica.capture(conn)
    uids = [conn.execute("SELECT contact_uid FROM people WHERE id=?", (p["id"],)).fetchone()[0] for p in (keep, drop)]
    combined = contact_cli.merge(conn, uids, preferred=uids[0])
    conn.commit()
    print(f"Merged into {combined.card['name']} ({combined.uid}).")


def cmd_dismiss(conn, args) -> None:
    cur = conn.execute("UPDATE moments SET status = ? WHERE id = ?", (args.status, args.moment_id))
    conn.commit()
    print("Thanks, noted." if cur.rowcount else f"No moment #{args.moment_id}.")


def cmd_ask(conn, args) -> None:
    from .ask import ask

    try:
        print(ask(conn, " ".join(args.question)))
    except _llm_errors() as e:
        sys.exit(f"Couldn't answer: {e}")


def cmd_photos(conn, args) -> None:
    from . import photos

    if args.source in ("social", "linkedin", "instagram", "gravatar"):
        from . import gravatar, social_photos
        from .photo_browser import PhotoBrowser, BrowserError

        sources = social_photos.SOURCES if args.source == "social" else (args.source,)
        if args.path:
            sys.exit("Remote photos don't take a data folder; use --person NAME to select a contact.")
        if args.source == "gravatar" and (args.browser or args.login):
            sys.exit("Gravatar needs neither --browser nor --login; omit those flags.")
        if args.login and (args.source == "social" or args.dry_run):
            sys.exit("--login requires --source linkedin or instagram and cannot be used with --dry-run.")
        person_id = identity.lookup(conn, args.person)["id"] if args.person else None
        selected = (gravatar.targets(conn, person_id) if args.source == "gravatar" else
                    [t for s in sources for t in social_photos.targets(conn, s, person_id)])
        if args.source != "gravatar":
            # Prioritize missing photos across both platforms before limiting the batch.
            with_photo = {r["person_id"] for r in conn.execute("SELECT person_id, path FROM photos")
                          if Path(r["path"]).is_file()}
            selected.sort(key=lambda t: t["person_id"] in with_photo)
        if args.limit:
            selected = selected[:args.limit]
        if args.dry_run:
            for t in selected:
                print(f"{t['name']} ({t['source']}): {t['url']}")
            label = "email addresses" if args.source == "gravatar" else "known accounts"
            print(f"{len(selected)} {label}; no requests made.")
            return
        try:
            with ExitStack() as stack:
                browser = stack.enter_context(PhotoBrowser()) if args.browser or args.login else None
                if args.login:
                    browser.login(args.source)
                    print("Dedicated login session saved locally; run photos --browser to fetch photos.")
                    return
                stats = (gravatar.collect(conn, selected, again=args.again) if args.source == "gravatar" else
                         social_photos.collect(conn, selected, again=args.again, browser=browser,
                                               delay=args.delay, max_failures=args.max_failures))
        except BrowserError as exc:
            sys.exit(str(exc))
        print(", ".join(f"{k}: {v}" for k, v in stats.items()))
        return
    if args.person or args.limit or args.again or args.browser or args.login or args.dry_run:
        sys.exit("--person, --limit, --again and --dry-run require a remote --source; --browser/--login require a social source.")
    for source in photos.SOURCES if args.source == "all" else (args.source,):
        print(photos.collect(conn, source, Path(args.path) if args.path else None))
    with_photo = conn.execute(
        "SELECT COUNT(DISTINCT p.person_id) FROM photos p JOIN people pe ON pe.id = p.person_id WHERE pe.merged_into IS NULL"
    ).fetchone()[0]
    print(f"{with_photo} people have a photo.")


def cmd_instagram_links(conn, args) -> None:
    from . import instagram_links
    from .photo_browser import PhotoBrowser, BrowserError

    person_id = identity.lookup(conn, args.person)["id"] if args.person else None
    selected = instagram_links.targets(conn, person_id, again=args.again)[:args.limit]
    if args.dry_run:
        for t in selected:
            print(f"{t['name']}: thread {t['thread']}")
        print(f"{len(selected)} DM threads to read; no requests made.")
        return
    try:
        with PhotoBrowser() as browser:
            stats = instagram_links.collect(conn, selected, browser, delay=args.delay)
    except BrowserError as exc:
        sys.exit(str(exc))
    print(", ".join(f"{k}: {v}" for k, v in stats.items()))
    if stats["suggested"]:
        print("Display-name mismatches were saved as suggestions; check them with `mypeople socials review`.")


def cmd_google(conn, args) -> None:
    from . import google

    try:
        if args.action == "login":
            google.login()
            print(f"Signed in. Token saved to {google.TOKEN_PATH}.")
            return
        selected = None
        if args.person:
            selected = set()
            for query in args.person:
                person = identity.lookup(conn, query)
                if person["trashed"] or person["is_me"]:
                    raise google.GoogleError(f"{person['name']}: cannot export a trashed or self contact.")
                selected.add(person["id"])
        if args.min_messages < 0:
            raise google.GoogleError("--min-messages must be zero or greater.")
        contacts = google.fetch_contacts()
        warnings = []
        changes = google.plan(conn, contacts, create=args.create, with_photos=args.photos,
                              min_interactions=args.min_messages, with_notes=not args.no_notes,
                              person_ids=selected, warnings=warnings)
        for warning in warnings:
            print(f"Warning: {warning}")
        updates = [c for c in changes if c.resource]
        print(f"{len(contacts)} Google contacts; {len(updates)} to update" + (f", {len(changes) - len(updates)} to create" if args.create else "") + ".")
        if not args.apply:
            for c in changes[: args.show]:
                print(f"  {c.name} (#{c.person_id}): {', '.join(c.notes)}")
                if args.show_fields:
                    preview = {k: v for k, v in c.fields.items() if k != "biographies"}
                    print(json.dumps(preview, ensure_ascii=False, indent=2))
            if len(changes) > args.show:
                print(f"  … and {len(changes) - args.show} more (--show N to list more)")
            if args.show_notes:
                for c in changes[: args.show]:
                    if "biographies" in c.fields:
                        print(f"\n{c.name}:\n{c.fields['biographies'][0]['value']}")
            print("\nNothing written. Re-run with --apply to make these changes.")
            return
        google.apply(conn, changes)
        print("Done. To roll back, use Undo changes in Google Contacts settings.")
    except google.GoogleError as e:
        sys.exit(str(e))


def cmd_socials(conn, args) -> None:
    from . import autumn, socials

    if args.person_flag:
        if args.person and args.person != args.person_flag:
            sys.exit("Give one person, either as PERSON or --person.")
        args.person = args.person_flag
    if args.autumn and args.action != "find":
        sys.exit("--autumn is only valid with socials find.")
    if args.autumn and args.osint_only:
        sys.exit("--autumn cannot be combined with --osint-only; use --osint to combine discovery sources.")
    if args.usernames and (args.action != "find" or not args.person or not (args.osint or args.osint_only)):
        sys.exit("--username requires one PERSON and --osint or --osint-only.")
    if args.action == "review":
        pending = socials.suggestions(conn, include_diagnostics=args.include_diagnostics)
        if not pending:
            print("No reviewable suggestions. Use `socials review --all` for inaccessible/conflicting or extra LinkedIn leads.")
            return
        print(f"{len(pending)} profiles. Assessments are not confirmations. y = yes, n = not them, s = skip, q = quit.")
        for s in pending:
            if not args.include_diagnostics and not socials.reviewable(conn, s):
                continue  # A previous answer may have confirmed this person's LinkedIn.
            print(f"\n{s['name']} (#{s['person_id']}) → {s['url']}  [{s['assessment']}]")
            print(f"  {s['title']}\n  why: {s['reason']}\n  {s['snippet'][:300]}")
            evidence = json.loads(s["evidence"])
            page = evidence.get("page", {})
            print(f"  access: {page.get('access', 'not fetched')} · checked: {page.get('observed_at', 'unknown')}")
            for match in evidence.get("matches", []):
                print(f"  {match['evidence_id']} / {match['fact_id']}: \"{match['quote']}\"")
            sources = sorted({v["source"] for v in json.loads(s["sources"])})
            print(f"  discovered via: {', '.join(sources) or 'legacy search'}")
            answer = input("  Is this them? [y/n/s/q] ").strip().lower()
            if answer == "q":
                break
            if answer in ("y", "n"):
                socials.set_status(conn, s["id"], "confirmed" if answer == "y" else "rejected")
        return

    scanners = None
    source = None
    if args.osint or args.osint_only:
        from . import osint as scanners
    if args.person:
        todo = [identity.lookup(conn, args.person)]
    elif args.osint_only:
        todo = scanners.to_search(conn, args.closest)
    else:
        selection = {"autumn": True} if args.autumn else {}
        todo = socials.to_search(conn, args.closest, again=args.again, **selection)
    if not todo:
        print("No people with known reusable usernames." if args.osint_only else
              "Everyone in range has been searched. Use --again, or --osint-only to enrich known usernames without Exa.")
        return

    if scanners:
        backends = scanners.available()
        if not backends:
            print("OSINT libraries not installed. Run `uv sync --extra osint`.")
            return
        options = {}
        if args.osint_timeout != 30:
            options["timeout"] = args.osint_timeout
        if args.usernames:
            options["usernames"] = args.usernames
        source = partial(scanners.candidates, **options) if options else scanners.candidates
        print(f"OSINT: {', '.join(backends)}; supported sites only; known public usernames and bounded variants.")

    with ExitStack() as stack:
        fetch_options = {}
        if args.autumn:
            fetch_options.update(autumn=True, again=args.again, autumn_timeout=args.autumn_timeout)
        if args.flaresolverr:
            from .flaresolverr import FlareSolverr, FlareSolverrError
            print("Starting temporary FlareSolverr Docker container (blocked/empty profile metadata only).")
            try:
                browser = stack.enter_context(FlareSolverr(timeout=args.flaresolverr_timeout))
            except FlareSolverrError as exc:
                sys.exit(str(exc))
            fetch_options.update(fetcher=browser, retry_inaccessible=True)
        expense = ("Autumn credits; no Exa searches" if args.autumn else
                   "no Exa searches" if args.osint_only else f"about ${0.014 * len(todo):.2f} in Exa searches")
        print(f"Searching for {len(todo)} people ({expense}; up to one verification batch/person, plus malformed-response retry).")
        total_cost = total = 0
        for n, p in enumerate(todo, 1):
            if scanners and not args.usernames and not scanners.handles_for(conn, p["id"]):
                print(f"[{n}/{len(todo)}] {p['name']}: no known public username "
                      "in account identifiers or confirmed profiles.")
                if args.osint_only:
                    continue
            if not args.osint_only and not socials.searchable(p["name"]):
                print(f"[{n}/{len(todo)}] {p['name']}: skipped, needs a full name (`mypeople rename`)")
                continue
            try:
                found, cost = socials.find(conn, p["id"], osint=source, exa=not (args.osint_only or args.autumn), **fetch_options)
            except (socials.ExaError, autumn.AutumnError) as e:
                sys.exit(str(e))
            except _llm_errors() as e:
                sys.exit(f"Couldn't assess profiles for {p['name']}: {e}")
            total += found
            total_cost += cost
            print(f"[{n}/{len(todo)}] {p['name']}: {found} new reviewable profiles")
        billing = "Autumn credits reported per task; no Exa cost" if args.autumn else f"Exa cost ${total_cost:.3f}"
        print(f"Done. {total} new reviewable profiles ({billing}). "
              "Run `mypeople socials review`; add --all for inaccessible/conflicting leads.")


def cmd_transfer(conn, args) -> None:
    import tempfile
    from . import transfer

    try:
        password = transfer.key_file(args.password_file or transfer.KEY_FILE, create=args.action in ("export", "qr"))
        if args.action in ("export", "qr"):
            path = args.path or Path.home() / "Downloads" / "MyPeople-memory.sherloq"
            if args.action == "qr":
                from . import bluetooth
                source, _ = transfer._prepare(conn)
                database = (args.db or db.default_path()).resolve()
                def exchange(encrypted):
                    # The native Bluetooth worker is not the CLI's main thread.
                    worker = db.connect(database)
                    try:
                        stats = transfer.apply_edits(worker, encrypted, password, enrich=not args.no_enrich)
                        print(f"Phone edits: {stats['applied']} applied, {stats['failed']} rejected, "
                              f"{stats['already_applied']} already received, {stats['deferred']} deferred.", flush=True)
                        with tempfile.TemporaryDirectory(prefix="mypeople-sync-") as temp:
                            reply = args.path or Path(temp) / "memory.sherloq"
                            published = transfer.export_snapshot(worker, reply, password, include_photos=not args.no_photos, compact_photos=True,
                                                                 peer=transfer.unpack(transfer.decrypt(encrypted, password)))
                            print(f"Fresh memory: {published['updated']} changed view records, {published['changes']} contact changes, {published['photos']} new photos.", flush=True)
                            return reply.read_bytes()
                    finally:
                        worker.close()
                print("The private QR syncs phone edits first, then returns fresh memory. Don’t share it.")
                bluetooth.serve(path, password, source, minutes=args.minutes, show=not args.no_open, exchange=exchange,
                                publisher=conn.execute("SELECT publisher FROM transfer_state WHERE slot=1").fetchone()[0])
            else:
                stats = transfer.export_snapshot(conn, path, password, include_photos=not args.no_photos)
                print(f"Exported {stats['records']} records and {stats['photos']} photos to {path}.")
                print(f"Transfer passphrase: stored privately in {args.password_file or transfer.KEY_FILE}; enter it once on your phone.")
                if args.send:
                    subprocess.run(["open", "-a", "Bluetooth File Exchange", str(path.resolve())], check=True)
        elif args.action == "merge":
            if args.path is None:
                sys.exit("Choose a memory file: mypeople transfer merge /path/to/MyPeople-memory.sherloq")
            done = transfer.merge_snapshot(conn, args.path, password)
            print(f"Reconciled {done['contacts']} contact changes, {done['facts_added']} facts added and "
                  f"{done['facts_forgotten']} forgotten. No messages were imported.")
            if done["conflicts"]:
                print(f"{done['conflicts']} contacts have two versions of something. See `mypeople contact conflicts`.")
        else:
            if args.path is None:
                sys.exit("Choose the edits file: mypeople transfer import /path/to/MyPeople-edits.sherloq")
            stats = transfer.import_edits(conn, args.path, password, enrich=not args.no_enrich)
            print(f"Applied {stats['applied']}; rejected {stats['failed']}; already received {stats['already_applied']}; deferred {stats['deferred']}.")
            print("Export a new memory file and send it back to acknowledge these edits on your phone.")
    except (transfer.TransferError, OSError) as exc:
        sys.exit(str(exc))


def cmd_recover_phones(conn, args) -> None:
    import json
    from . import phone_recovery, transfer

    sources = phone_recovery.Sources(conn)
    try:
        if args.google_json:
            sources.google(json.loads(args.google_json.read_text()))
        elif args.google:
            from . import google
            sources.google(google.fetch_contacts("names,emailAddresses,phoneNumbers,metadata"))
        if args.imessage.exists():
            sources.imessage(args.imessage)
        if args.whatsapp.exists():
            sources.whatsapp(args.whatsapp)
        if args.addressbook.exists():
            for path in sorted(args.addressbook.rglob("*.abcddb")):
                sources.addressbook(path)
        plan = sources.plan()
        report = args.report or Path.home() / ".mypeople" / "recovery" / "phone-recovery-preview.json"
        transfer.write_file(report, json.dumps(plan, ensure_ascii=False, indent=2).encode())
        print(f"{len(plan['changes'])} contacts repairable; {len(plan['unresolved'])} unresolved numbers; {len(plan['ambiguous'])} conflicting numbers.")
        print(f"Private preview: {report}")
        if args.apply:
            result = phone_recovery.apply(conn, plan, args.backup_dir)
            print(f"Repaired {result['applied']} contacts; skipped {result['skipped_changed']} changed concurrently.")
            print(f"Backup: {result['backup']}\nAudit journal: {result['report']}")
        else:
            print("Preview only. Use --apply after reviewing; sources are always read-only.")
    except (OSError, sqlite3.Error, ValueError, RuntimeError) as exc:
        sys.exit(f"Phone recovery stopped: {exc}")


def cmd_app_server(conn, args) -> None:
    from . import appserver

    appserver.serve((args.db or db.default_path()).expanduser().resolve())


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="mypeople", description=__doc__)
    parser.add_argument("--db", type=Path, help="database path (default ~/.mypeople/mypeople.db or $MYPEOPLE_DB)")
    parser.add_argument("--llm", choices=("codex", "lmstudio", "ds4", "claude"), help="model backend (default codex, or $MYPEOPLE_LLM)")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("import", help="import contacts, iMessages, or email")
    p.add_argument("source", choices=("vcf", "google", "imessage", "whatsapp", "instagram", "mino", "mbox", "gvoice", "snapchat", "linkedin", "twitter", "telegram", "signal"))
    p.add_argument("path", nargs="?", help="file or folder to import (imessage, whatsapp, and mino default to their local stores)")
    p.add_argument("--me", action="append", help="your own email address (mbox; repeatable; optional once `mypeople me` is set)")
    p.add_argument("--since", type=_date, help="only import from this date (YYYY-MM-DD)")
    p.add_argument("--review", action="store_true", help="twitter: go through conversations the archive doesn't name and say who each is with")
    p.add_argument("--names", help="twitter: a file naming accounts the archive doesn't, one \"ID @handle Display Name\" per line")
    p.set_defaults(func=cmd_import)

    p = sub.add_parser("extract", help="read new messages and record life events (uses the model)")
    p.add_argument("--person", help="only this person")
    p.add_argument("--limit", type=int, default=25, help="max people per run (default 25)")
    p.add_argument("--since", type=_date, help="ignore messages before this date (default: two years ago; all history with --person or --all)")
    p.add_argument("--all", action="store_true", help="everyone, all history: no --limit and no --since cutoff")
    p.add_argument("--reverse", action="store_true",
                   help="least close first; run alongside a normal run so the two meet in the middle")
    p.add_argument("--dry-run", action="store_true", help="show who would be processed")
    p.add_argument("--progress", choices=("auto", "plain", "off"), default="auto",
                   help="batch progress: live on a terminal, plain logs when redirected; off keeps person-level summaries")
    p.set_defaults(func=cmd_extract)

    p = sub.add_parser("today", help="today's moments")
    p.add_argument("--date", type=_date, help="pretend it's this date")
    p.add_argument("-n", type=int, default=moments.DEFAULT_LIMIT, help="max moments")
    p.add_argument("--preview", action="store_true", help="don't mark moments as shown")
    p.set_defaults(func=cmd_today)

    p = sub.add_parser("people", help="list people by closeness")
    p.add_argument("query", nargs="?")
    p.add_argument("--limit", type=int, default=50)
    p.set_defaults(func=cmd_people)

    p = sub.add_parser("show", help="one person's profile and timeline")
    p.add_argument("person")
    p.add_argument("--evidence", action="store_true", help="show the quote behind each event")
    p.set_defaults(func=cmd_show)

    p = sub.add_parser("note", help="tell MyPeople something you learned (uses the model)")
    p.add_argument("person")
    p.add_argument("text", nargs="+")
    p.set_defaults(func=cmd_note)

    p = sub.add_parser("add", help="add an event by hand")
    p.add_argument("person")
    p.add_argument("type", choices=EVENT_TYPES)
    p.add_argument("value")
    p.add_argument("--date", help="YYYY, YYYY-MM, YYYY-MM-DD, or --MM-DD")
    p.set_defaults(func=cmd_add)

    p = sub.add_parser("forget", help="mark an event as wrong")
    p.add_argument("event_id", type=int)
    p.set_defaults(func=cmd_forget)

    p = sub.add_parser("set", help="correct a relationship, e.g. category=family cadence=14 muted=yes")
    p.add_argument("person")
    p.add_argument("fields", nargs="+")
    p.set_defaults(func=cmd_set)

    p = sub.add_parser("me", help="mark which record(s) are you, or show your record")
    p.add_argument("people", nargs="*", help="your record(s); several are merged into one")
    p.set_defaults(func=cmd_me)

    p = sub.add_parser("alias", help="add nicknames, e.g. mypeople alias \"Robert Lee\" Rob Bobby")
    p.add_argument("person")
    p.add_argument("names", nargs="+")
    p.add_argument("--remove", action="store_true", help="remove these nicknames instead")
    p.set_defaults(func=cmd_alias)

    from . import contact_cli
    contact_cli.parser(sub)

    p = sub.add_parser("rename", help="give someone a name, e.g. an unknown number")
    p.add_argument("person")
    p.add_argument("name")
    p.set_defaults(func=cmd_rename)

    p = sub.add_parser("dupes", help="list people who share a name, and optionally merge them")
    p.add_argument("--merge", action="store_true", help="ask about each group and merge the ones you confirm")
    p.add_argument("--first-names", action="store_true", help="only people known by a first name, next to full-name namesakes")
    p.set_defaults(func=cmd_dupes)

    p = sub.add_parser("merge", help="merge two records of the same person")
    p.add_argument("keep")
    p.add_argument("drop")
    p.set_defaults(func=cmd_merge)

    for name, status in (("done", "done"), ("dismiss", "dismissed")):
        p = sub.add_parser(name, help=f"mark a moment as {status}")
        p.add_argument("moment_id", type=int)
        p.set_defaults(func=cmd_dismiss, status=status)

    p = sub.add_parser("ask", help="ask a question, e.g. \"who do I know in Lisbon?\" (uses the model)")
    p.add_argument("question", nargs="+")
    p.set_defaults(func=cmd_ask)

    p = sub.add_parser("socials", help="find public profiles with Exa or Autumn (and optional OSINT); you confirm each one")
    p.add_argument("action", choices=("find", "review"))
    p.add_argument("person", nargs="?", help="one person (default: your closest people)")
    p.add_argument("--person", dest="person_flag", metavar="PERSON", help="same as the PERSON argument")
    p.add_argument("--closest", type=_positive_int, default=10, help="how many eligible people to search (default 10)")
    p.add_argument("--again", action="store_true", help="repeat the selected provider's completed searches (and pay again)")
    p.add_argument("--autumn", action="store_true", help="use Autumn research instead of Exa; requires AUTUMN_API_KEY and spends credits")
    p.add_argument("--autumn-timeout", type=_positive_int, default=600, help="seconds to wait per Autumn task; rerun to resume (default 600)")
    group = p.add_mutually_exclusive_group()
    group.add_argument("--osint", action="store_true", help="add scoped username discovery to Exa or Autumn search")
    group.add_argument("--osint-only", action="store_true", help="scoped handle discovery without Exa calls or costs; automatically reuse known usernames")
    p.add_argument("--username", dest="usernames", action="append", default=[], type=_public_username,
                   help="explicit public handle for one PERSON; requires --osint/--osint-only; repeatable, not a confirmation")
    p.add_argument("--osint-timeout", type=_positive_int, default=30, help="seconds per scanner request / Maigret scan (default 30)")
    p.add_argument("--all", dest="include_diagnostics", action="store_true", help="review inaccessible/conflicting and suppressed extra LinkedIn leads too")
    p.add_argument("--flaresolverr", action="store_true", help="use a temporary Docker FlareSolverr fallback for blocked/empty profile metadata")
    p.add_argument("--flaresolverr-timeout", type=_positive_int, default=60, help="browser challenge timeout in seconds (default 60)")
    p.set_defaults(func=cmd_socials)

    p = sub.add_parser("photos", help="collect local/Google pictures or fetch LinkedIn, Instagram, or Gravatar photos")
    p.add_argument("--source", choices=("all", "whatsapp", "contacts", "google", "social", "linkedin", "instagram", "gravatar"), default="all",
                   help="all keeps local/Google collection; social fetches LinkedIn/Instagram; gravatar is opt-in email-hash lookup")
    p.add_argument("path", nargs="?", help="with a local --source: its data folder, if not in the usual place")
    p.add_argument("--person", help="remote sources: only this contact's known accounts/emails")
    p.add_argument("--limit", type=_positive_int, help="remote sources: maximum number of accounts or email addresses; social sources prioritize contacts without photos")
    p.add_argument("--dry-run", action="store_true", help="list remote lookup targets without network requests or browser startup")
    p.add_argument("--again", action="store_true", help="retry remote photos now, ignoring the fetch cache")
    p.add_argument("--browser", action="store_true", help="fall back to a dedicated signed-in browser (optional browser extra)")
    p.add_argument("--login", action="store_true", help="sign in to one social source in the dedicated browser, without fetching photos")
    p.add_argument("--delay", type=float, default=0, help="social sources: minimum seconds between lookups (up to double that, randomly)")
    p.add_argument("--max-failures", type=_positive_int, help="social sources: stop after this many failed lookups in a row")
    p.set_defaults(func=cmd_photos)

    p = sub.add_parser("instagram-links", help="save the Instagram username of each 1:1 DM contact, read from your signed-in photo browser")
    p.add_argument("--person", help="only this contact's DM threads")
    p.add_argument("--limit", type=_positive_int, help="maximum number of threads to read (busiest first)")
    p.add_argument("--dry-run", action="store_true", help="list threads without opening the browser")
    p.add_argument("--again", action="store_true", help="re-read threads already read")
    p.add_argument("--delay", type=float, default=4.0, help="minimum seconds between threads (default 4; up to double that, randomly)")
    p.set_defaults(func=cmd_instagram_links)

    p = sub.add_parser("google", help="export current contact cards and enrich Google Contacts without deleting or merging")
    p.add_argument("action", choices=("login", "sync"))
    p.add_argument("--apply", action="store_true", help="write the changes (default: only show them)")
    p.add_argument("--photos", action="store_true", help="also upload photos to contacts that have none")
    p.add_argument("--no-notes", action="store_true", help="leave Google notes alone; omit both card notes and generated notes")
    p.add_argument("--create", action="store_true", help="also create contacts for people Google doesn't have (labelled MyPeople)")
    p.add_argument("--person", action="append", metavar="PERSON", help="only this name or numeric ID; repeat for several. With --create, bypass message-history requirements")
    p.add_argument("--min-messages", type=int, default=20, help="with unselected --create, require this many interactions and at least one outgoing interaction (default 20)")
    p.add_argument("--show", type=int, default=25, help="how many changes to list in a dry run")
    p.add_argument("--show-notes", action="store_true", help="print the complete proposed notes for the listed changes")
    p.add_argument("--show-fields", action="store_true", help="print proposed structured fields in dry runs (notes require --show-notes)")
    p.set_defaults(func=cmd_google)

    p = sub.add_parser("transfer", help="exchange encrypted memory and edits files over Bluetooth or USB")
    p.add_argument("action", choices=("qr", "export", "import", "merge"))
    p.add_argument("path", nargs="?", type=Path, help="memory output or phone edits input (.sherloq)")
    p.add_argument("--password-file", type=Path, help="private file containing the shared transfer passphrase")
    p.add_argument("--no-photos", action="store_true", help="make a smaller memory file without photos")
    p.add_argument("--no-enrich", action="store_true", help="leave model-backed requests queued for later")
    p.add_argument("--send", action="store_true", help="open Bluetooth File Exchange after exporting (macOS)")
    p.add_argument("--minutes", type=int, default=10, help="QR pairing lifetime (default 10 minutes)")
    p.add_argument("--no-open", action="store_true", help="create the private QR without opening its image")
    p.set_defaults(func=cmd_transfer)

    p = sub.add_parser("recover-phones", help="preview recovery of original country codes from linked source metadata")
    p.add_argument("--google", action="store_true", help="read original Google Contacts using MyPeople's existing Google login; never writes to Google")
    p.add_argument("--google-json", type=Path, help="use a private People API connections JSON snapshot instead")
    p.add_argument("--imessage", type=Path, default=Path.home() / "Library/Messages/chat.db")
    p.add_argument("--whatsapp", type=Path, default=Path.home() / "Library/Group Containers/group.net.whatsapp.WhatsApp.shared")
    p.add_argument("--addressbook", type=Path, default=Path.home() / "Library/Application Support/AddressBook")
    p.add_argument("--report", type=Path, help="private JSON preview, including unresolved/ambiguous numbers")
    p.add_argument("--backup-dir", type=Path, default=Path.home() / ".mypeople/recovery")
    p.add_argument("--apply", action="store_true", help="back up, then apply only unambiguous repairs; preserve concurrent/manual changes")
    p.set_defaults(func=cmd_recover_phones)

    p = sub.add_parser("app-server", help="the local engine behind the macOS app; speaks JSON over stdin/stdout")
    p.set_defaults(func=cmd_app_server, needs_db=False)
    return parser


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    if args.llm:
        os.environ["MYPEOPLE_LLM"] = args.llm
    conn = db.connect(args.db) if getattr(args, "needs_db", True) else None
    try:
        args.func(conn, args)
    except identity.PersonNotFound as e:
        sys.exit(str(e))
    finally:
        if conn:
            conn.close()
