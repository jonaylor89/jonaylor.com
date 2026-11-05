# Live OSINT and FlareSolverr evaluation

Tested 2026-10-26 on the local OrbStack Docker daemon, using the supplied name **Johannes Naylor** and username **jonaylor89**. These are a small functional trial, not a labeled precision/recall benchmark.

Current scope has since expanded to **12 handle-based platforms**, adding Duolingo. The measurements below used the earlier 11-platform registry. Regression tests now require both Python adapters to retain Duolingo, validate its anonymous public account response, and automatically reuse known usernames from confirmed profiles and imported Snapchat/LinkedIn account identifiers. Each known handle can generate one bounded, provenance-labelled variant; a known public slug such as `chris-wren` also probes `chriswren`. Full-name search is not equivalent to username lookup, and Instagram DM display names are not usernames. No manual username flag is needed for existing contact identifiers. New discoveries remain unconfirmed leads.

## Scope and setup

- Sherlock 0.16.2 and Maigret 0.6.6, each restricted to 11 supported platforms before scanning.
- FlareSolverr Docker image `ghcr.io/flaresolverr/flaresolverr:v3.5.2`.
- Isolated databases only. `github.com/jonaylor89` was explicitly seeded as the confirmed starting profile; no other identity facts were supplied. The real contacts database was not opened or changed.
- OSINT request/scan timeout: 8 seconds. Browser budget: 60 seconds for A/B, 45 seconds for the CLI trial.
- No Exa requests or costs. No model calls were needed: name/handle alone cannot satisfy the fact-evidence threshold.

## Discovery and metadata

Discovery took **2.07 seconds**, returning **9 canonical account leads** including the seeded GitHub account. The other **8** were assessed.

| Pass | Supported | Possible | Inaccessible | Metadata-pass time |
|---|---:|---:|---:|---:|
| Direct HTTP | 1 | 4 | 3 | 1.71 s |
| With browser fallback | 1 | 5 | 2 | 5.95 s |

Both passes used exactly the same discovered URLs. The browser pass reused successful metadata from the direct pass and retried cached blocked/empty pages; its timing is not an independent cold-cache total. The Docker image was already downloaded.

A separate **fresh-database CLI run** took **10.60 seconds end to end**:

```sh
uv run --extra osint mypeople --db /tmp/mypeople-trial.sqlite socials find \
  --osint-only --closest 1 --flaresolverr \
  --osint-timeout 8 --flaresolverr-timeout 45
```

It produced **6 reviewable suggestions**, plus **2 diagnostic leads**. Only the explicitly seeded GitHub account remained confirmed, and `profile_searches` stayed empty.

### Per-account outcomes

- **X:** supported by an explicit identity link from the confirmed GitHub profile.
- **Instagram, Threads, SoundCloud, YouTube:** public metadata available; possible, not confirmed.
- **Medium:** direct access blocked; FlareSolverr recovered the profile's public metadata. Still possible, not confirmed.
- **TikTok:** generic empty shell even through the browser; inaccessible.
- **Dribbble:** HTTP 404 / non-public profile response; inaccessible. This does not establish whether an underlying private account exists.

Threads aliases were deduplicated, and GitHub/Gist were not counted as independent identities.

## Negative control

Both scoped scanners reported **zero hits** for the randomly generated username `qz784caa0b68`. This checks one nonexistent-looking handle, not the ownership accuracy of existing accounts.

An additional browser probe of a missing Medium handle returned a generic `Medium` page despite FlareSolverr reporting HTTP 200. Generic shells and explicit soft-404 evidence must therefore remain inaccessible rather than being treated as profile matches.

## Bugs found and fixed by live testing

1. YouTube placed its title and description after approximately **1.1 MB** of inline content. The previous 512 KB read limit discarded real evidence. The bounded limit is now **2 MB**.
2. Body SVG tooltip titles were appended to document titles. Only the first non-SVG document title is now used.
3. FlareSolverr hard-codes status 200 for Selenium responses. Explicit error titles/headings and generic shells are classified separately from usable profile metadata.
4. A parser-version tag invalidates old truncated/concatenated metadata immediately.

Synthetic offline regression fixtures cover all of these cases; raw HTML and browser cookies were not added to the repository.

## Real Docker validation

The opt-in integration tests exercised:

- Container startup and health, anonymous session creation, and real browser navigation.
- Authenticated CONNECT proxy use during navigation.
- Normal cleanup and cleanup after an exception.
- Real child-process SIGINT and SIGTERM handling.

The temporary container was absent after every test and after both evaluations. A final `docker ps -a --filter label=dev.mypeople.ephemeral=true` returned no containers. Downloaded Docker images intentionally remain cached.

Reproduce the live tests with:

```sh
MYPEOPLE_TEST_DOCKER=1 uv run --extra osint pytest tests/test_flaresolverr.py -q
```

## Interpretation

Discovery is substantially narrower and faster than scanning hundreds of sites. FlareSolverr added useful evidence for Medium, but did not make TikTok readable. It is a targeted recovery option, not a guarantee of access or ownership.

The ownership policy remained conservative: shared names/handles did not become supported matches, and no suggestion was auto-confirmed. Measuring actual precision/recall still requires the user's account labels and a broader representative test set.

## Review follow-up: verification cost and host-network exposure

The implementation has since changed in the following ways; the discovery-only timings above remain historical measurements, not a benchmark of these changes:

- Verification now uses one bounded batch per person (20 eligible candidates / 40,000 data-payload characters), with at most one malformed-JSON repair attempt. Overflow remains possible instead of silently buying additional batches. Provider transport retries and token-based billing still apply.
- Candidate-local citations are checked in code. A matching full owner name plus a quoted specific employer/school fact can support a single-category case; generic jobs/cities and names/handles alone cannot. This is not strict per-candidate prompt isolation: the model sees the batch, but cannot promote an evidence-free candidate using another candidate's quotes.
- The public-address egress proxy now runs on **loopback inside the FlareSolverr container**, started through `docker exec` stdin/stdout. No host proxy listener, host gateway mapping, or proxy port publication is used. The API remains published only on host localhost.

A live Codex model trial used eight entirely synthetic profiles and one known employer fact. It made **one verification request** (721 user-payload characters, 9.0 seconds): the matching full-name/employer profile was supported, five weak or mismatching profiles remained possible, the blocked page stayed inaccessible, and a separate explicit confirmed-profile link was supported without model judgment. No real contacts or private facts were used. This validates the intended gates on a small synthetic case, not real-world ownership accuracy.

The live Docker test checks successful browser navigation, an exclusively loopback-bound proxy in `/proc/net/tcp`, and Docker port bindings containing only the localhost API publication. It also fails if a proxy constructor is invoked in the host Python process. Exception, SIGINT, and SIGTERM cleanup tests still apply.
