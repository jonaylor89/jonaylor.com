# Extraction progress

Extraction can spend hours on one person's history. The CLI now reports every
**batch**, rather than going quiet until the entire person is finished.

```sh
uv run mypeople --llm ds4 extract --all
```

On a terminal, a compact, teal-and-amber live dashboard shows:

```text
MYPEOPLE / EXTRACTION   ds4 · deepseek-v4-flash
RUN    ━━━━━━━╸                                                 9%
5,855/62,380 messages · 12/134 batches · 0/37 people · 90 new events

Ada Lovelace
PERSON ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━      94%
5,855/6,227 messages · batch 13/13 · 90 new events · ~3m 30s left
⠋ Model working 2m 30s · 372 messages · 2026-10-01 → 2026-11-02
elapsed 45m 00s · ETA ~7h 07m · last batch 4m 00s
Saved after each batch · Ctrl-C to pause safely
```

This is an illustrative frame, not a record of actual messages. Progress never
prints conversation bodies, extracted facts, or model reasoning. Names, dates,
counts, and model identifiers are shown.

## What the numbers mean

- **RUN** covers the people/history selected for this invocation. `--limit`,
  `--since`, `--person`, `--all`, and `--reverse` keep their existing meanings.
- **PERSON** shows how far through the current person's unread history you are.
  The current batch's date range helps you see it moving through the years.
- **Messages, batches, and events advance after the database commit.** The
  spinner and request timer keep moving during a long model call, but do not
  pretend to know its token-level percentage. “Saving checkpoint” is a distinct
  phase between the model response and the commit.
- **ETA warms up after two model batches.** It uses the last eight batch timings
  and formatted/truncated input size, with an overhead allowance for tiny
  requests. Both whole-run and current-person estimates are shown. These are
  rough estimates: model reasoning, output length, growing known-event context,
  throttling, and other GPU work can all change the pace. A restart warms up a
  new estimate; it does not discard saved extraction work.
- A read-only planning pass counts batches before starting. Estimates reconcile
  with actual unread work when each person starts. If another extractor reads
  messages first (for example, `--reverse` in a second process), those messages
  advance the counters without being charged as this model's throughput.

A short completion line for each person stays in the terminal's scrollback.
The dashboard uses the normal screen, not a full-screen alternate buffer, adapts
to narrow terminals, and restores the cursor on completion, errors, or Ctrl-C.

## Plain logs and scripts

Progress goes to **stderr**, leaving stdout for run summaries. Redirect stderr
for timestamped, flushed batch logs with no cursor movement or ANSI sequences:

```sh
uv run mypeople --llm ds4 extract --all 2>extract-progress.log
```

Plain logs include batch starts and saved checkpoints. If a request takes a long
time, a heartbeat is emitted every minute. The renderer never accesses SQLite
from its refresh/heartbeat thread.

```sh
# Explicit plain output; also useful for screen readers and terminal recording:
uv run mypeople --llm ds4 extract --all --progress plain

# Old-style summaries only, with no preliminary planning pass/dashboard:
uv run mypeople --llm ds4 extract --all --progress off
```

`--progress auto` is the default: live on stderr's TTY, plain on redirected
stderr, `TERM=dumb`, or CI. `NO_COLOR` disables colors; use `plain` to disable
animation as well. Dry runs and empty queues do not start the dashboard or call
the model.

## Pause and resume

Press **Ctrl-C** to stop cleanly (exit status 130), then rerun the same command.
Completed batches, their events, and their read flags have already been saved.
The in-flight batch may need to run again. On model failure, the UI stops at the
last saved count, prints the error, and explains how to resume.

Already-running Python processes do not pick up the new display automatically.
Leave them running, or interrupt and resume deliberately; there is no need to
reset extraction flags or re-import messages.
