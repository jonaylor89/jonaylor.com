# MyPeople

A memory for the people in your life: it keeps a living timeline of what's happening with everyone you know and surfaces the few moments worth reaching out.

- [Pitch](../../docs/mypeople/pitch.md): the why, in story form.
- [Brief](../../docs/mypeople/brief.md): concept, core objects (Person, Event, Interaction, Relationship, Moment), principles, and the hard problems.
- [Android app](../../android/mypeople/README.md) · [Mac app](../../macos/mypeople/README.md) · [Contacts migration and recovery](../../docs/mypeople/contacts.md) · [Local-first contact replication](../../docs/mypeople/contact-replication.md): offline contact editing/merging, causal peer reconciliation, Android integration, and encrypted backups.

This is the first prototype: a local, single-user CLI that proves the two riskiest ideas, **event extraction** and **moment ranking**, on your own data. Everything lives in one SQLite file (`~/.mypeople/mypeople.db`, or `$MYPEOPLE_DB`). Message text is sent to the configured model during `extract`, `note`, and `ask`. Optional public-profile discovery also sends minimal identity facts to Exa/the model and public usernames/URLs to scanned websites (see [Public profiles](#public-profiles)).

## Setup

From the monorepo root, `cd cli/mypeople`, then:

```sh
uv sync --locked
```

Keep credentials outside the checkout: `~/.mypeople/secrets.ini` is loaded by default.
Set `MYPEOPLE_ENV_FILE` to use another private file; existing environment variables
win. Repository-local `.env` files are no longer auto-loaded. See the
[migration and release guide](../../docs/mypeople/monorepo.md).

### Choosing a model

Pick a backend with `--llm` or `MYPEOPLE_LLM`:

| Backend | Model | Where your messages go |
|---|---|---|
| `codex` (default) | GPT-6.1 Sol via your ChatGPT login from [pi](https://pi.dev) | ChatGPT (counts against your plan's usage limits) |
| `lmstudio` | Qwen3.8 27B in LM Studio | Nowhere, it runs on this Mac |
| `ds4` | DeepSeek V4 Flash in DwarfStar (`~/Repos/ds4`) | Nowhere, it runs on this Mac |

```sh
# LM Studio: start the server and load Qwen with a 32K context
lms server start && lms load qwen/qwen3.8-27b --context-length 32768
uv run mypeople --llm lmstudio extract --limit 10

# ds4: needs about 81 GB of memory. --power caps the GPU duty cycle (1-100) to keep
# the laptop cool; 50 runs at about half speed.
(cd ~/Repos/ds4 && ./ds4-server --ctx 32768 --power 50)
uv run mypeople --llm ds4 extract --limit 10
```

For `codex`, MyPeople reads `~/.pi/agent/auth.json` (the `openai-codex` entry) but never writes it. Pi rotates the refresh token under a file lock, so if MyPeople refreshed tokens it could log pi out. When the access token expires, MyPeople tells you to run `pi` once, which refreshes it.

Other overrides: `MYPEOPLE_MODEL`, `MYPEOPLE_LLM_URL`, `MYPEOPLE_PI_AUTH`, and `MYPEOPLE_EFFORT` (codex only, default `medium`).

## Try it on your life

```sh
# 1. Your address book. In Contacts.app: select all, File > Export > Export vCard.
uv run mypeople import vcf ~/Desktop/contacts.vcf

# 2. iMessage, read straight from ~/Library/Messages/chat.db.
#    Grant your terminal Full Disk Access first (System Settings > Privacy & Security).
uv run mypeople import imessage --since 2024-10-01

# 2b. WhatsApp chats and calls, read from WhatsApp Desktop's local stores (same Full Disk Access).
uv run mypeople import whatsapp

# 2c. Google Voice texts and voicemails, from a Google Takeout export.
uv run mypeople import gvoice ~/Desktop/Takeout/Voice

# 2d. Snapchat chats and snaps, from a "My Data" export (Settings > My Data, JSON). Pass the unzipped folder.
uv run mypeople import snapchat ~/Desktop/mydata~1234
#     Known Snapchat usernames also appear as confirmed profile links on contacts.
#     Earlier imports are backfilled automatically on the next CLI run; sync to update the app.

# 2e. Instagram DMs, from "Download your information" (JSON or English HTML, Messages + Personal information). Pass the unzipped folder.
uv run mypeople import instagram ~/Desktop/instagram-yourname-2026-10-23-abc
#     Exports name DM partners only by display name. To store their usernames as confirmed
#     Instagram links, read each imported 1:1 thread's header in the signed-in photo browser
#     (sign in once with `photos --source instagram --login`). Resumable; failures are retried.
uv run --extra browser mypeople instagram-links --dry-run
uv run --extra browser mypeople instagram-links

# 2f. LinkedIn connections and DMs, from Settings > Data privacy > Get a copy of your data. Pass the unzipped folder.
#     Connections you know get a confirmed LinkedIn link and their current job; someone you've
#     messaged becomes a person; other connections are left out.
uv run mypeople import linkedin ~/Desktop/Basic_LinkedInDataExport_10-24-2026

# 2g. X (Twitter) DMs, from Settings > Your account > Download an archive of your data. Pass the unzipped folder.
#     The archive names people only by account id; handles and names come from your tweets' mentions and replies.
#     Anyone else you wrote to is listed with a link; name them in a file ("ID @handle Display Name") and re-run.
uv run mypeople import twitter ~/Desktop/twitter-2026-10-27-abc [--names x-names.txt]

# 2h. Telegram contacts, chats, and calls, from Telegram Desktop > Settings > Advanced > Export Telegram data.
#     Select Contacts list + Personal chats and Machine-readable JSON; media is optional.
#     Pass the export folder or result.json. Re-importing is safe; --since YYYY-MM-DD limits history.
uv run mypeople import telegram "$HOME/Downloads/Telegram Desktop/DataExport_2026-11-01"
#     Contacts include international phone numbers but no Telegram IDs/usernames. Chats link
#     by a unique full name; unmatched people you wrote to become new people. Existing phone
#     fields, labels, regions and verification are preserved. `00` is an international prefix;
#     ambiguous bare local numbers stay in source provenance, not exported phone fields. Group messages
#     count only for people linked through personal chats; group membership never creates people.

# 2i. Signal Desktop history, exported locally on the Mac holding the messages and Keychain.
#     See docs/signal.md. Snapshot files are plaintext private history; keep them outside the repo.
uv run python -m mypeople.importers.signal_export ~/signal-history.jsonl
uv run mypeople import signal ~/signal-history.jsonl
#     Re-importing the same desktop history is safe. Names alone never merge people;
#     unknown group members, calls, and disappearing/view-once messages are excluded.

# 3. Email, read from the Mino mail client's local store (all signed-in accounts).
#    Re-run any time; it picks up whatever Mino has synced since.
uv run mypeople import mino
#    For full history, add a Google Takeout .mbox (takeout.google.com, Mail only).
#    Both sources key emails by Message-ID, so overlapping mail is counted once.
#    uv run mypeople import mbox ~/Downloads/All\ mail.mbox --me you@gmail.com

# 4. Read new messages and record life events (GPT-6.1 Sol). Start small.
uv run mypeople extract --dry-run
uv run mypeople extract --limit 10
# Later, everything: every person, all history (resumable; Ctrl-C any time).
uv run mypeople extract --all
# Two runs can share the work: a local model on your closest people, a fast remote one from the other end.
uv run mypeople --llm ds4 extract --all &
uv run mypeople --llm claude extract --all --reverse
# Live batch-level progress, per-person/overall bars, request timers, and ETA are automatic.
# --progress plain gives timestamped logs; --progress off keeps person-level summaries.
# Ctrl-C safely pauses at saved checkpoints. Details: docs/extraction-progress.md.

# 5. Every morning.
uv run mypeople today
```

Someone only becomes a Person if they're in your address book or you've written to them at least once, which keeps 2FA codes and newsletters out.

Instagram HTML exports retain only minute-level timestamps (read as UTC), whereas JSON retains milliseconds. Re-importing the same format is safe; avoid importing both HTML and JSON versions of the same conversations, since they have different message keys. Instagram message requests are not imported.

## Google Contacts

MyPeople can export its **current contact cards** into Google Contacts and enrich existing contacts. Missing phone numbers, emails, addresses, websites, IM handles and anniversaries are appended without removing Google's existing values or labels. Empty organizations, birthdays and notes are filled; a missing last name is added only when the first name agrees. Card birthdays take precedence over inferred birthdays. Confirmed profiles (LinkedIn, GitHub, Instagram, Snapchat, …) and nicknames are added, photos replace only default/empty avatars, and a marked notes block is refreshed without touching the rest of your Google notes. `--no-notes` omits both card notes and generated notes. It never deletes or merges Google contacts, and Google Contacts' own Settings > Undo changes rolls back up to 30 days.

One-time setup (about 5 minutes):

1. At console.cloud.google.com, create a project (e.g. "MyPeople"), then enable the **People API** (APIs & Services > Library).
2. Under Google Auth Platform (or OAuth consent screen), choose **External**, fill in the app name and your email, add yourself as a test user, then **Publish app**. A personal app in Testing mode has its sign-in expire every 7 days; published, it doesn't. Google will warn that the app is unverified, which is expected for your own app.
3. Under Clients (or Credentials), create an **OAuth client ID** of type **Desktop app**, download its JSON, and save it as `~/.mypeople/google-client.json`.

```sh
uv run mypeople photos                          # profile pictures from WhatsApp, Contacts.app, and Google Contacts
uv run mypeople google login                    # opens your browser once
uv run mypeople import google                    # bring Google Contacts into MyPeople (names, numbers, birthdays, jobs)
uv run mypeople google sync                     # dry run: shows what would change
uv run mypeople google sync --show-notes        # ...including the notes block
uv run mypeople google sync --photos --apply    # write it
uv run mypeople google sync --photos --no-notes --apply   # structured contact fields and photos; no notes
uv run mypeople google sync --create --apply    # bulk creation: >=20 interactions, including one outgoing
# Explicit selection bypasses message-history requirements; repeat --person for several.
uv run mypeople google sync --create --person "Chris Wren" --show-fields  # preview card fields
uv run mypeople google sync --create --person "Chris Wren" --photos --apply
uv run mypeople google sync --create --person 42 --person 73 --apply     # numeric IDs avoid ambiguous names
```

`--person` limits both updates and creation; it does not imply `--create` or `--apply`. Without selection, `--create` remains conservative: at least `--min-messages` interactions (default 20), at least one outgoing interaction, and a meaningful name. Selected contacts need no conversations. `--show-fields` displays the proposed structured values; `--show-notes` displays proposed notes. Dry runs do not write to Google.

Exported phones come **only from current contact cards**, normalized to full international numbers with extensions and labels. Historical matching identifiers, removed emails/numbers, retained originals, and invalid/unverified legacy phone suffixes are never exported as contact details. Re-import originals or verify the card to recover old numbers. Existing Google values are retained even if removed locally: this is an additive export, not a deletion/overwrite mirror.

Matching uses stored Google contact IDs, otherwise unambiguous current phone/email keys—never names. Legacy records without cards can still match via old identifiers, but those identifiers are not exported as contact details. Shared household or conflicting keys are skipped with a warning, as are unresolved replicated contact conflicts. Trashed/self/merged-away contacts are excluded. Missing linked Google records are not automatically recreated. A MyPeople identity matching multiple Google contacts can enrich each copy but does not merge them.

### Apple Contacts.app and duplicates

For Google-account contacts to appear in **Apple Contacts.app**, add/enable your Google account under **macOS System Settings → Internet Accounts → Google → Contacts**. MyPeople → Google → Contacts.app then uses the existing Google account connection. This does **not** update iCloud or “On My Mac” contacts; direct Apple/iCloud sync is not implemented. To bring those contacts into MyPeople, export a vCard from Contacts.app and run `mypeople import vcf PATH`.

Keep merging separate from sync. `mypeople dupes` previews local duplicate candidates and `mypeople dupes --merge` asks for confirmation; these affect MyPeople, not Google's records. Review Google duplicates in **Google Contacts → Merge & fix** and confirm the intended merges there. A name match alone is never permission for Google sync to combine people. Back up/export contacts before merging; replicated MyPeople merges currently cannot be split.

## Gravatar photos (no browser or login)

Use existing contact emails to fetch [Gravatar avatars](https://docs.gravatar.com/sdk/images/)
without a browser, session, API key, or extra dependencies:

```sh
uv run mypeople photos --source gravatar --dry-run
uv run mypeople photos --source gravatar --limit 10
uv run mypeople photos --source gravatar --person "Chris Wren"
uv run mypeople photos --source gravatar --again  # bypass the retry cache
```

This is **opt-in**: neither `--source all` nor `--source social` includes Gravatar.
Each known email is trimmed, lowercased, then SHA-256 hashed before contacting
Gravatar. **Hashes are still identifying information**, not anonymous data;
Gravatar learns which identifiers are queried and your IP. Plaintext emails,
names, and messages are not sent. Dry-run lists names and hashed URLs locally
without making requests.

Only real avatars are requested (`d=404`, G-rated, 512px); missing avatars return
404 and are skipped rather than replaced with generated/default images. This
isn't a LinkedIn/Instagram photo lookup, and many emails won't have a Gravatar.
A registered avatar may be a logo or illustration rather than a face. Every
distinct known email can be tried; `--limit` bounds email lookups, not people.
Your own and merged-away records are excluded, and addresses are never guessed
from handles or names.

JPEG/PNG images are cached under the separate `gravatar` photo source. Other
sources are retained; only larger images replace an existing Gravatar. The normal
largest-photo selection and Google Contacts sync pick these up automatically.
Successful lookups are cached for 24 hours and unavailable results for 15 minutes;
`--again` retries now. No profile API is fetched, and no new email data is stored.
Requests use HTTPS, DNS-checked/pinned public addresses, bounded timeouts and
redirects, and an 8 MB response limit.

## LinkedIn and Instagram profile photos

Fetch photos for **accounts you already know**, without Exa searches, model calls,
or paid scraping APIs:

```sh
uv run mypeople photos --source social --dry-run  # eligible accounts only; no network
uv run mypeople photos --source social --limit 10
uv run mypeople photos --source linkedin --person "Chris Wren"
uv run mypeople photos --source instagram --again # bypass the retry cache
uv run mypeople photos --source instagram --delay 1 --max-failures 5  # 1–2 s apart; stop if rate limited
```

Eligible accounts are confirmed LinkedIn/Instagram links, imported LinkedIn
identifiers, and explicitly manual handles for those platforms. Adding a supported
social profile URL with `contact --add website=URL` (or entering a new/changed
website in the Android contact editor) also registers a confirmed profile, usable
by photos and public-profile discovery. For example:

```sh
uv run mypeople contact edit "Chris Wren" --add website=https://www.linkedin.com/in/chris-wren/
uv run --extra browser mypeople photos --source social --browser --person "Chris Wren"
```

Confirmation is tracked per link and survives contact replication. Imported
websites, unchanged URLs, and label/name/notes/favorite edits do not confirm
profiles. Explicitly rejected profiles stay rejected; use profile review to change
that decision. Removing a website from a card does not reject its separately
confirmed social profile. Suggested or rejected profiles, your own records, and
merged-away records are skipped.
Contacts without a photo from any source go first, before `--limit` is applied
(across both platforms for `--source social`). Missing photo files count as no photo.
Contacts who already have photos remain eligible after those without.
Instagram DM imports contain **display names**, not reliable handles, and are
never used. A known Snapchat/LinkedIn handle is not assumed to belong to the same
person on Instagram; discover and confirm that account with `socials` first.

### When the sites require login

Anonymous Instagram and LinkedIn requests are frequently blocked. For these,
you can explicitly authorize a **separate local browser session**:

```sh
uv sync --extra browser
uv run --extra browser playwright install chromium
uv run --extra browser mypeople photos --source instagram --login
uv run --extra browser mypeople photos --source linkedin --login
# Sign in yourself in each dedicated window, finish 2FA, then press Enter in the terminal.
uv run --extra browser mypeople photos --source social --browser --limit 10
```

`--browser` first tries public requests, then opens the dedicated browser for
unavailable profile images. It requires a graphical desktop. Sessions live under
`~/.mypeople/photo-browser/{instagram,linkedin}` in private directories. **These
contain login credentials/cookies**: don't share or commit them; delete the
directory while the browser is closed to forget a session. MyPeople never reads
your everyday Chrome profile, asks for your password in the terminal, exports
cookies to its database, or automatically solves challenges. Sites may still
require re-login, block requests, or change their page layouts. Unavailable photos
are reported and skipped, not silently replaced with feed images.

Images are downloaded from scoped HTTPS platform CDNs with public-IP validation,
DNS pinning, bounded redirects, timeouts, and an 8 MB limit. JPEG/PNG photos are
stored beside the database under `photos/`, separately as `linkedin` and
`instagram` sources. Existing photos from other sources are retained, and only
larger photos replace a photo from the same source. The existing largest-photo
selection (including Google sync) automatically picks them up. Account URL,
attempt time, outcome, and transport are recorded locally; signed image URLs and
raw page HTML are not persisted. Successful fetches are cached for 24 hours,
failures for 15 minutes; `--again` retries now, and `--browser` immediately retries
anonymous failures. Each account is saved independently so interrupted batches
can resume.

The ordinary `photos` / `photos --source all` behavior remains local/Google only.
Nothing is uploaded to Google unless you separately run:

```sh
uv run mypeople google sync --photos             # preview
uv run mypeople google sync --photos --apply     # fills default/empty Google avatars only
```

## Public profiles

`mypeople socials find` uses [Exa](https://exa.ai) to look up public profiles. Set `EXA_API_KEY` in `.env`. Each person costs two Exa searches (about $0.014), plus **at most one verification batch per person**, not one model call per URL. Model billing still depends on tokens/provider; one JSON-repair attempt and the provider's existing transport retries can add requests. The person's name and minimal job/city/school/work-domain facts go to Exa and the configured model, never to scanned websites. Messages and phone numbers are not included.

The people-index lookup uses career/location hints only until LinkedIn is confirmed. Once it is, both search slots target non-LinkedIn platforms instead. Personal-profile searches use the name without employer/location requirements, preserving an equivalent accented spelling from a confirmed profile when available. Search-index coverage is still limited: an account can exist without being discoverable by full-name search.

### Autumn research (instead of Exa)

Set `AUTUMN_API_KEY` in your environment or `.env`, then opt in:

```sh
uv run mypeople socials find "Chris Wren" --autumn
uv run mypeople socials find --autumn --closest 3
# Optionally add the same scoped username scanners:
uv run --extra osint mypeople socials find "Chris Wren" --autumn --osint
```

Pi's Autumn MCP sign-in does **not** authenticate the standalone MyPeople CLI; it needs its own API key from [Autumn](https://platform.autumn.ai/?settings=connect). Never put keys in commands, source code, or shared output.

`--autumn` replaces Exa entirely: no Exa key, calls, or charges. It starts one Ranger research task per person, targeting at most 20 public-profile leads. **Autumn credits are spent**, plus the normal bounded verification/model costs. The task link, progress, outcome (including partial results), and credit usage are printed. Start with one person or a small `--closest` batch.

Only the name, aliases, minimal job/city/school/work-domain facts, and confirmed profile URLs are sent—not messages, phone numbers, or full email addresses. Returned URLs are restricted to supported profile routes and independently fetched/assessed through the existing pipeline. Autumn summaries are discovery hints, never quoted ownership evidence; every result still needs human confirmation.

Autumn task IDs and completion history are stored separately from Exa. Interrupted or failed polling/assessment reuses the saved task on rerun, including explicit person lookups. `--autumn-timeout SECONDS` bounds the wait per person (default 600); it does not cancel cloud work. Resolve questions/failures in the printed task link, then rerun. `--again` starts a new paid task only after the saved search was successfully imported; pending work is always resumed. `--autumn` combines with `--osint` and `--flaresolverr`, not `--osint-only`.

### Scoped OSINT libraries

Install the optional Python libraries, then enrich **known contact usernames without repeating or paying for Exa searches**:

```sh
uv sync --extra osint
uv run --extra osint mypeople socials find --osint-only --closest 10
uv run --extra osint mypeople socials find --osint-only "Chris Wren"
```

`--osint-only` automatically reuses a shared known-username set from confirmed profiles and actual imported Snapchat/LinkedIn account identifiers, regardless of Exa search history. No `--username` input is needed—even when LinkedIn is the only known profile. It doesn't require an Exa key or update that history. Each invocation scans the selected handles again; page metadata is cached. `--closest` applies *after* handle eligibility is checked.

To combine discovery sources instead, use `--osint`. Normal Exa batch selection still skips people already searched unless you pass `--again`; that flag repeats and pays for Exa searches.

Sherlock/Maigret are called as Python libraries, not CLIs. Before making requests, both are restricted to supported handle-based platforms (currently 12, including Duolingo), and Sherlock's bundled false-positive exclusion snapshot is applied offline. The site databases are cached in memory; per-run scanner state is copied. No remote database updates, unsupported-platform scans, recursive identity searches, or identifier extraction/enrichment run.

Known usernames retain their source provenance. Each can produce at most one additional bounded search variant: removing `.`, `_`, and `-` (for example, a known LinkedIn slug `chris-wren` also probes `chriswren`). A default Bluesky `name.bsky.social` handle instead contributes its local username; custom DNS handles are left intact. Variants are labelled as leads, not stored as known identifiers or treated as ownership evidence. Rejected LinkedIn profiles cannot be reintroduced through their imported identifiers. Instagram DM identifiers are display names and are **not** scanned, even when they look like usernames. No seeds come from contact names, aliases, emails, phone numbers, Google IDs, or message contents. Optional repeatable `--username HANDLE` inputs remain available for one-off explicit seeds with one person and `--osint`/`--osint-only`; they are not required for existing contact usernames. YouTube `/@handle`, `/user/name`, and `/c/name` provide handles; opaque `/channel/UC…` IDs do not. `--osint-timeout SECONDS` sets the scanner request timeout and Maigret's total scan budget (default 30). No scanner API fees apply, but metadata fetches contact the public sites and model assessment fees may apply.

### Optional FlareSolverr browser fallback

With a local Docker daemon running, add `--flaresolverr` to retry blocked or empty **profile metadata** in an anonymous browser:

```sh
uv run --extra osint mypeople socials find --osint-only --closest 10 --flaresolverr
# Also works with ordinary Exa discovery:
uv run mypeople socials find "Chris Wren" --flaresolverr
```

MyPeople starts its own uniquely named `ghcr.io/flaresolverr/flaresolverr:v3.5.2` container, with a localhost-only API port, no host volume mounts, memory/process limits, and RAM-backed temporary browser files. Browser requests are serialized and use an authenticated public-address CONNECT proxy bound to **container loopback**. The proxy starts through a private `docker exec` pipe: it has no host listener, no published port, and no host gateway mapping. Arbitrary target hosts are not accepted. Returned HTML is reduced to the same metadata; cookies, screenshots, and clearance tokens are discarded.

The container and anonymous session are removed on normal completion, failures (including startup/model failures), Ctrl-C, and SIGTERM. No existing containers are reused or removed. Docker's downloaded image cache is retained. A forced SIGKILL, power loss, or unavailable Docker daemon cannot guarantee cleanup; in that case, the uniquely named container can be found with `docker ps -a --filter label=dev.mypeople.ephemeral=true` and removed with `docker rm -f NAME`.

The fallback does **not** route scanner enumeration through the browser, bypass logins, or guarantee challenge/CAPTCHA success. Missing/private pages are not retried. Failed challenges remain inaccessible, not supported. Previously cached blocks/empty pages are retried immediately when this flag is used; good metadata stays cached. `--flaresolverr-timeout SECONDS` sets the browser budget (default 60). Advanced users can override the pinned image with `MYPEOPLE_FLARESOLVERR_IMAGE`.

Run the optional real-Docker navigation and cleanup tests with `MYPEOPLE_TEST_DOCKER=1 uv run --extra osint pytest tests/test_flaresolverr.py -q`. See the [live evaluation](../../docs/mypeople/osint-evaluation.md) for measured results and remaining limitations. Like a normal browser, pages can load public third-party resources, so use the fallback only when needed.

### Evidence and human review

Discovery hits are leads, not ownership claims. MyPeople fetches public profile titles, descriptions, and links without login cookies, following only bounded redirects within supported profile routes. Requests reject non-public network addresses and pin DNS-checked IPs. HTML reads are bounded to 2 MB so late profile metadata (notably YouTube) is retained; raw HTML is then discarded. Metadata is cached locally for 24 hours (inaccessible outcomes retry after 15 minutes). Parser upgrades invalidate older cached metadata.

Duolingo uses its anonymous public username-lookup endpoint rather than treating the JavaScript app shell as a profile. The returned username must match exactly (case-insensitively); only display name, username, and optional bio are retained. IDs, learning activity, friend graphs, and other API fields are discarded. A found account still remains a lead for human review.

Each lead has an assessment **separate from** your confirmed/rejected decision:

- **Supported:** an explicit identity link from a confirmed profile; quoted evidence matching two independent known-fact categories; or a matching full name in the fetched profile title plus one quoted, specific named-employer/school fact. A city, generic job, or employer domain alone is insufficient.
- **Possible:** plausible but insufficient evidence. A matching name/handle or agreement between scanners is never enough.
- **Inaccessible:** missing, private, blocked, or empty pages without usable indexed evidence. A blocked page with historical indexed content may remain possible, never supported.
- **Conflicting:** cited evidence materially contradicts known facts; old jobs and cities alone aren't contradictions.

When needed, the model receives **one bounded batch per person** (up to 20 eligible candidates and a 40,000-character data payload). Full-name matches are prioritized deterministically. Overflow remains possible/reviewable; no extra batches are silently purchased. Malformed JSON may trigger one repair attempt for the same batch, never retries per candidate. No model call is made when no candidate has enough known facts to assess.

This trades strict single-candidate prompt isolation for predictable cost. Each verdict is still validated against **only its candidate's own quotes** and the user's known facts: another unconfirmed candidate cannot become an identity anchor, and borrowed/missing citations cannot promote a match. Duplicate, missing, or invented URL verdicts cannot promote a candidate either. Semantic matching remains a fallible model judgment; supported is still not user-confirmed.

```sh
uv run mypeople socials review        # supported first, then possible
uv run mypeople socials review --all  # also inspect inaccessible/conflicting and extra LinkedIn leads
```

Once a person has a confirmed LinkedIn, extra LinkedIn suggestions are hidden from normal review, including older stored leads. The exception requires an accessible, supported candidate with a fetched explicit identity link from a profile that is still confirmed for that person; name/employer matches or model confidence alone are not enough. New Exa searches already exclude LinkedIn once one is confirmed. Confirming a LinkedIn during review immediately skips the remaining weak LinkedIn leads for that person. `review --all` still exposes them; hiding never deletes them or changes your decisions.

Review shows public evidence, sources, and access timestamps. Only your explicit `y` confirms an account; `n` rejects it. Rescans preserve both decisions and skip judging their aliases. Known aliases such as Threads' two domains and GitHub/Gist collapse to one account. YouTube channel IDs retain case, and different YouTube route namespaces aren't guessed to be equivalent. When fetched YouTube pages explicitly declare the same canonical channel ID, a new handle URL is deduplicated against its confirmed legacy URL. Browser network/privacy error pages and bare-hostname shells are never treated as usable profile evidence.

Confirmed links appear in `mypeople show`. Suggestions and diagnostic evidence are stored locally before review, but never treated as confirmed identities.

## Commands

| | |
|---|---|
| `today [--date D] [--preview]` | Up to 5 moments, each with a reason. Each moment is shown once. |
| `people [query]` | Everyone, by inferred closeness, with trend and cadence. |
| `show PERSON [--evidence]` | Current profile, relationship, and timeline, with the source of every fact. |
| `note PERSON TEXT…` | Quick capture: "her daughter Maya starts kindergarten in September". Saves your words on the contact, then reads them for facts. If the model is unavailable the note is kept, and `extract` reads it later. |
| `socials find [PERSON \| --person PERSON] [--closest N] [--osint \| --osint-only] [--flaresolverr]` / `socials review [--all]` | Discover public profiles, collect ownership evidence, then review; OSINT-only skips Exa entirely. |
| `photos [--source S]` | Collect local/Google photos; `--source social` fetches known LinkedIn/Instagram avatars; `--source gravatar` looks up known email hashes without login. `--dry-run` previews accounts; `--browser` enables dedicated login sessions. Largest per source is kept. |
| `google login` / `google sync [--photos] [--create] [--person NAME_OR_ID] [--show-fields] [--apply]` | Export current contact cards and enrich Google Contacts; selection bypasses creation's message gate (dry run unless `--apply`). |
| `ask QUESTION…` | "who do I know in Lisbon?", "what's Priya's daughter's name?" |
| `add PERSON TYPE VALUE [--date D]` | Record an event by hand. |
| `forget EVENT_ID` | Mark an extracted event as wrong. |
| `set PERSON k=v…` | Override `category`, `closeness`, `cadence` (days), or `muted`. |
| `me [PERSON…]` | Mark which records are you (several are merged). You're left out of people, moments, and extraction; your addresses and numbers never become people, and `--me` becomes optional. |
| `alias PERSON NICKNAME…` | Nicknames (`--remove` to drop). They work in lookups, and extraction is told who "Rob" or "Mom" is. |
| `dupes [--merge] [--first-names]` | People who share a name (or a first name next to full-name namesakes, with `--first-names`), side by side: when and where you talked, what's known, and a few things each said. With `--merge`, merge all or some, open their photos, ask the model for a verdict (it sees what's on screen), or mark them as different people so they don't come up again. |
| `rename PERSON NAME`, `merge KEEP DROP` | Fix identity resolution by hand. |
| `done ID`, `dismiss ID` | Feedback on a moment (stored for tuning ranking later). |

PERSON can be an id (`#12` → `12`), a name or nickname, a unique part of one, or `me`.

## How it works

- **Identity** (`identity.py`, `contacts.py`): user-maintained contact cards preserve original numbers, labels and address-book properties separately from matching identifiers and inferred events. International numbers are not truncated; legacy NANP matching keys remain compatible. Shared household contact keys are allowed and treated as ambiguous. Contact edits and merges have replicated causal history, explicit conflict choices, and UUID redirects. Splitting replicated merges is not yet supported; legacy-only merges retain guarded undo.
- **Events** (`events.py`): every fact has a type, value, date (possibly partial or year-less), source, and confidence. The current profile (job, home, school) is derived from the latest event of each type, so nothing is stored as a bare field.
- **Extraction** (`extract.py`): per person, new messages go to the model along with recent earlier messages and the already-known events. The model is constrained by a strict JSON schema and returns only new, dated, quoted facts. A watermark makes reruns incremental and cheap.
- **Model** (`llm.py`): standard-library HTTP clients for the ChatGPT Codex backend and for local OpenAI-style servers. Extraction is constrained to a JSON schema where the server supports it, and always validated, with one retry if the model's JSON doesn't fit. Local backends use smaller message chunks to fit a 32K context.
- **Relationships** (`relationships.py`): closeness comes from frequency, reciprocity, and recency over the past year. Cadence is the median gap between conversation days. The trend is growing, steady, or drifting. User overrides win.
- **Moments** (`moments.py`): candidates are anniversaries (including losses), birthdays, upcoming plans, fresh life events, open promises, and drifting relationships. Each is scored by kind, timeliness, closeness, and confidence. A moment is shown only above a score floor, at most once per person per day, and once ever (drift has a 30-day cooldown). A quiet day prints nothing.

## Tests

```sh
uv run --locked pytest
```

The importers are tested against a synthetic `chat.db`, `.vcf`, and `.mbox`. Extraction and the model client are tested with fakes, so the tests never make network calls.

## Not yet

Location-aware prompts, gift and intro suggestions, and the year in review. Android, encrypted Bluetooth sync, and opt-in public-profile discovery are implemented; see the app and feature documentation above. The brief's "last time you talked he was nervous" context line also needs an LLM pass over recent messages. Right now the context is the last-contact time plus the most relevant other fact.
