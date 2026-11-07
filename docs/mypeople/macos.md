# MyPeople for macOS: architecture

A native SwiftUI app for your contacts, as the Android app is, plus message imports, Google sync, and
Ask. Reading messages for facts, finding profiles, and collecting photos stay in the CLI. This page
records why it is built the way it is. To build and run it, see
[`macos/mypeople/README.md`](../../macos/mypeople/README.md).

## Decision

**The Mac app is a native shell around the Python CLI's own code. It contains no domain
logic that can change data.** The CLI gains one command, `mypeople app-server`: a
long-running local engine that the app starts as a child process and talks to over
stdin/stdout.

```
┌─ MyPeople.app (SwiftUI, not sandboxed) ─────────────┐
│  Screens  →  AppModel (@MainActor, @Observable)     │
│                 │  Records + pure derivations       │  ported from Logic.kt
│  MyPeopleKit:   EngineClient ── ProcessTransport    │
└─────────────────────┬───────────────────────────────┘
                      │ newline-delimited JSON over stdio; no sockets
┌─ mypeople app-server ▼──────────────────────────────┐
│  serial lane   one connection; every edit, in order │
│  view thread   own connection; full refresh, watch  │
│  slow lane     snapshot and vCard export            │
│  job runner    one `mypeople …` child process each  │
└───┬──────────────────────────────────────┬──────────┘
    ▼                                      ▼
publish / ops / replica / contacts      mypeople import | ask | google | transfer
    └──────────► ~/.mypeople/mypeople.db ◄─┘
```

The reasoning comes down to who owns the rules:

- **The replicated object graph already has two implementations** (Python and Kotlin),
  kept in step by shared fixtures. It is a causal DAG with field-level registers. A third
  implementation would be the riskiest code in the project and would add nothing.
- **The app needs code that already exists in Python:** publishing the view, merging, vCards,
  and the Bluetooth listener.
- **The Mac is next to the Python engine.** Android owns its local graph and transport;
  this shell makes synchronous engine calls instead of implementing another reducer.
  All trusted peers receive the complete graph, not only a phone-safe memory subset.

### Alternatives rejected

| Option | Why not |
| --- | --- |
| Swift reads and writes SQLite directly | Duplicates replication, migrations, moment ranking, and merge rules; a bug corrupts the address book for every peer |
| Shell out to `mypeople … --json` per action | Half a second of startup per click, no shared cache, and interactive commands (`socials review`, `dupes --merge`) have no such mode |
| Embed Python with PythonKit | Crashes in native extensions take the UI down; Python threads cannot be cancelled; signing and packaging get harder |
| Local HTTP server | A listening socket is new attack surface for private data, and its lifetime is not tied to the app. Stdio has neither problem |
| Web/Electron UI | Not a native Mac app |

## Two contracts, both reused

The app reuses the two contracts the phone already speaks, so every screen means the same
thing on both platforms:

1. **Read: the published view.** Python projects graph-backed SQL into `person`, `event`,
   `profile`, `moment`, and `dupes` records. Android projects its local graph into the same
   screen models. Swift's models match `Model.kt`; `Derivations.swift` ports `Logic.kt`.
2. **Write: operations.** `ops.apply()` covers aliases, notes, facts, relationship overrides,
   profile decisions, moment feedback, and "not the same person". Contact edits take the
   same path as `mypeople contact …` (`replica.change`) rather than the older
   `contact_save` op, so they are recorded in causal history immediately.

The Mac view differs from the phone's in four ways, all in `appserver.py`:

- `contact_change` records are left out, because the engine owns history.
- `card.photo`, `card.originals`, and `card.source_records` are stripped. A card can hold a
  megabyte of base64, and only the editor needs the full card, which it loads with
  `contact.get`.
- Each person gains an `avatar_path`, because the file is right there on disk.
- Each phone field gains `dial` and `dial_ext`, so Swift never reimplements phone number
  parsing. They are display hints, and a save strips them before they can reach the card.

## Keeping the view fresh and fast

A full `publish.records()` takes about 2.2 s on a synthetic database the size of a real
install (2,600 people, 329k messages). That is fine in the background and unacceptable after
every click, so there are two refresh paths. Both read the engine's persistent graph index
(`docs/mypeople/indexed-store.md`), so a scoped refresh, an edit or a contact's history touch only
that contact's rows rather than replaying every commit:

- **Scoped refresh.** After an edit, the serial lane rebuilds only the people it touched
  (`publish.records(people=…)`) and sends the difference as a `view.delta` *before* the
  response. When `await engine.call(…)` returns, the UI already shows the result.
- **Full refresh.** A view thread polls `PRAGMA data_version` every 2 s, which notices commits
  from any other process: a terminal CLI, an extraction run, a Bluetooth exchange. It recomputes
  in the background, diffs, and sends a delta. It also picks up moments and duplicate groups,
  and reruns when the date changes. Refreshes are throttled to at least 5 s apart and five
  times the last duration, so a long extraction in a terminal cannot pin a core.

A full refresh that overlaps an edit is discarded and rerun, so stale data can never overwrite
a scoped update. Deltas carry a version; if Swift ever sees a gap it asks for a new snapshot.

- **Launch.** A launch must not wait for a full refresh. The engine keeps the last view it published in
  `app-cache/<db>-view.json` beside the database (0600, written atomically), and answers the first
  `view.snapshot` from it once the database has opened. It then refreshes as usual and sends the
  difference as a delta. The cache is keyed by database path, protocol, CLI version and cache format,
  and anything that doesn't match is ignored. It is only a starting point: edits are always checked
  against the database. The app also reuses the login shell's `PATH` from the last launch, and
  looks again in the background.

## Notes and facts belong to the contact

The [versioned graph](versioned-graph.md) is authoritative. Native splitting loads exact
associations, reviews selected/remaining scope, and submits the original causal frontier to
`contact.split`; stale reviews refuse the mutation. Swift never infers message ownership.

Notes and claims are graph objects with explicit person-attribution edges. The compatibility
`events` projection shows memory notes/facts on the contact; card notes remain a separate derived
card field. `events.source` preserves what you wrote versus imported/derived assertions.

- **A note keeps your words.** It is `type = 'note'`, `source = 'manual'`, saved as a plain edit with
  no model involved. `note` isn't in `EVENT_TYPES`, so the model can't produce one.
- **Facts are derived from it later, in the CLI.** `mypeople extract` reads unread notes, which have
  a null `source_ref`, and adds any facts it finds beside the note with `source = 'note'`. A model
  failure leaves the note saved and unread.
- **Merges carry them** with the rest of a person's records.
- **Phones get them in the memory snapshot,** and send new ones back as queued operations.
- **Every peer reconciles them through the graph,** including decisions, retractions and raw
  source material: see [graph replication](versioned-graph.md).

## Long-running work runs as CLI processes

Imports, questions, Google sync and phone exchanges run as `python -m mypeople …` children, supervised by the engine.
Threads would not work: Python cannot interrupt a thread, and the Bluetooth listener must own its
main thread. Child processes mean:

- **Cancel is Ctrl-C.** The engine sends SIGINT, then escalates.
- **A crash in a native extension cannot take the app down.**
- **No orchestration is duplicated.** Job arguments come from an allowlisted table
  (`JOBS` in `appjobs.py`), and every built command line is validated by the CLI's real `argparse` parser,
  both at runtime and in tests. The two cannot drift apart unnoticed.

The pairing QR reaches the app through one small addition: `jobevents.emit()` prints a sentinel line
only when `MYPEOPLE_JOB_EVENTS` is set.

**Only Ask calls a model from the app.** Reading messages for facts has no job, and an older phone
can still queue that request, so the app's transfer jobs always pass `--no-enrich`, which leaves it
for the next CLI transfer. A question stays out of job announcements (`_public`).

## Data safety

- **Stdout is protected.** At startup the engine moves protocol traffic to a private
  descriptor and points fds 0 and 1 elsewhere, so a stray `print()` or `input()` deep in a
  domain function cannot corrupt the stream or consume a request.
- **Compare-and-swap on contact saves.** `replica.edit` diffs against the current card, so
  saving a stale editor would silently revert someone else's change. `contact.get` returns a
  fingerprint, `contact.save` refuses a mismatch, and the editor keeps the draft and offers to
  reload. Unknown card keys round-trip through Swift unchanged.
- **Serialized writes.** One connection, one lane, rollback on any error. SQLite's 60 s busy
  timeout coordinates with other CLI processes; a timeout becomes a `busy` error, never a
  half-written edit. Mutations are never retried automatically.
- **Hostile strings stay inert.** URLs from scraped profiles open only over http(s). Evidence
  quotes and names render as plain text. Control characters are stripped from job output.
- **The view only offers what will work.** `can_undo_merge` applies the same check as the undo
  itself. A moment that was merely surfaced doesn't block an undo, but one you acted on does.
- **Nothing is logged to disk.** Engine stderr and job output stay in bounded memory buffers. The only
  thing written outside the database is the view cache, which holds nothing the database doesn't.
- **Tests use synthetic data only.** The engine honours `MYPEOPLE_DB`, and the Swift
  integration test runs against a throwaway database.

## Window and process lifetime

There is one window, because the model holds one selection and one current screen. Closing it
does not quit the app, as with Mail: running work carries on, and the Dock icon brings the window
back to the same engine. Only quitting stops the engine, and it asks first if anything is running.

The engine starts from the window's `.task`, so a launch must always open the window. AppKit's
window restoration can prevent that: a window closed before quitting stays closed at the next
launch, leaving no window and no engine. `defaultLaunchBehavior` and `restorationBehavior` did not
change this when tested, so the app registers `ApplePersistenceIgnoreState` at startup.

## macOS permissions

The app cannot be sandboxed: it reads `~/.mypeople` and spawns an interpreter. Importing iMessage needs
Full Disk Access, which Settings reports and explains.
`NSBluetoothAlwaysUsageDescription` lives in the app's Info.plist. Without it, macOS would kill the
Bluetooth child outright as soon as it touched the radio.

## Finding the CLI

The app accompanies the CLI rather than bundling it. It looks, in order, at: the path chosen in
Settings, `$MYPEOPLE_BIN`, `~/.local/bin/mypeople`, Homebrew paths, the login shell's `PATH`,
and finally a repository checkout, which runs through `uv run --all-extras`. The handshake
compares protocol versions, and an older CLI gets a precise instruction to update rather than a
confusing failure. GUI apps start with a minimal `PATH`, so the login shell's is captured once
and passed on.

Bundling a relocatable Python later would change only `EngineLocator`.

## Feature parity

| Android | macOS |
| --- | --- |
| Home: Today, Recently in touch, Upcoming | Today, Upcoming |
| People: search, sort, A–Z, favorites, trash, create | People, with multi-select merge, trash, and vCard export |
| Person: hero, reach actions, notes and facts, evidence, relationship, links | Person (Call and Message hand off to FaceTime and Messages) |
| Contact editor and conflict resolution | Contact editor and conflict resolution |
| Rename, nicknames, add fact, add note, relationship settings | Same |
| Review: profiles, duplicates | Review: profiles, duplicates, conflicts |
| vCard import and export, migration report | Same; export runs in the engine (`contact.export`) so the card format has one owner |
| Bluetooth QR, encrypted files | Phone screen (the Mac's side of the same exchange) |
| Encrypted phone backup | `transfer export` on the Phone screen |
| Android Provider account, QR camera | Not applicable on a Mac |

**Mac only:** message imports, Google sign-in and sync, phone number recovery, Ask, and the model
setting they use.

**CLI only:** `extract`, `socials find`, `photos`, `instagram-links`, and the model's verdict in
`dupes --merge`. Their results appear in both apps. The CLI remains complete on its own.

## Testing

- **Python, `tests/test_appserver.py`:** the real engine over real stdio against synthetic
  databases. It covers framing and stdout protection, read-your-writes ordering, scoped-versus-full
  equivalence, compare-and-swap, job argument validation against the real parser, cancellation,
  and that reading messages stays out of the app's jobs.
- **Python, `tests/test_notes_and_facts.py`:** notes saved without a model, read once by `extract`,
  and reconciled through merges and `transfer merge` in any order.
- **Swift, `MyPeopleKit/Tests`:** the client against a fake transport, derivations ported from
  `LogicTest.kt`, and lossless card round trips.
- **Cross-language:** `EngineIntegrationTests` starts the real Python engine from Swift against a
  throwaway database and decodes the replies the screens rely on. The fixture `engine-view.json`
  is checked by both suites, so a change to the record shape fails on whichever side falls behind.
- **Screens have no automated tests.** They were driven by hand on invented data. The window
  lifetime rules above are the kind of thing only that catches, so recheck them when changing scenes.

## Deliberate boundaries

- A release pipeline (notarization, Sparkle, DMG) is not included yet. CI builds and tests
  unsigned, and `scripts/build-local.sh` makes a locally signed copy.
- The app shows no message bodies beyond the short samples `dupes` already shows.
- The app still needs the CLI and Python on the same Mac, and reads that Mac's database. A second
  Mac gets contacts, notes and facts from a memory file.
- If the engine is not running, the last view stays browsable but cannot be edited. Unlike the
  phone there is no offline queue, because the database is on the same machine.
