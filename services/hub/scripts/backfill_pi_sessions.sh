#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Backfill pi-coding-agent JSONL sessions into pi-thread-vault via the HTTP ingest API.

Usage:
  scripts/backfill_pi_sessions.sh [options] [session-file-or-dir ...]

If no paths are provided, the script scans ~/.pi/agent/sessions.

Options:
  --server-url URL       Vault server URL (default: config/env or http://127.0.0.1:8000)
  --api-token TOKEN      Vault API token (default: config/env JONAYLOR_TOKEN)
  --client-id ID         Client id to send with API batches (default: config/hostname)
  --config PATH          Config file (default: ~/.config/jonaylor/config.toml)
  --dry-run              Parse and summarize without posting
  --limit N              Only process the first N discovered files
  --batch-bytes N        Target max request size before chunking (default: 1500000)
  -h, --help             Show this help

Requires: bash, jq, curl, and shasum/sha256sum.
Config values are read from ~/.config/jonaylor/config.toml using the same keys as the CLI/extension:
base_url, token, and pi_thread_vault.client_id.
EOF
}

server_url=""
api_token=""
client_id=""
config_file="${JONAYLOR_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/jonaylor/config.toml}"
dry_run=0
limit=""
batch_bytes="${JONAYLOR_BACKFILL_BATCH_BYTES:-1500000}"
paths=()

die() {
  echo "error: $*" >&2
  exit 1
}

read_toml_value() {
  local key="$1"
  local file="$2"
  [[ -f "$file" ]] || return 1
  awk -v wanted="$key" '
    function trim(s) { sub(/^[[:space:]]+/, "", s); sub(/[[:space:]]+$/, "", s); return s }
    function unquote(s) { s=trim(s); sub(/[[:space:]]*(#.*)?$/, "", s); s=trim(s); if ((substr(s,1,1)=="\"" && substr(s,length(s),1)=="\"") || (substr(s,1,1)=="'"'"'" && substr(s,length(s),1)=="'"'"'")) s=substr(s,2,length(s)-2); return s }
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    /^\[/ { section=$0; gsub(/^\[[[:space:]]*|[[:space:]]*\]$/, "", section); next }
    index($0, "=") {
      name=trim(substr($0, 1, index($0, "=") - 1));
      full=section ? section "." name : name;
      if (full == wanted) { print unquote(substr($0, index($0, "=") + 1)); found=1; exit }
    }
    END { if (!found) exit 1 }
  ' "$file"
}

expand_path() {
  case "$1" in
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s/%s\n' "$HOME" "${1#~/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

sha256_hex() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

json_string() {
  jq -Rn --arg value "$1" '$value'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server-url)
      [[ $# -ge 2 ]] || die "--server-url needs a value"
      server_url="$2"
      shift 2
      ;;
    --server-url=*)
      server_url="${1#*=}"
      shift
      ;;
    --api-token)
      [[ $# -ge 2 ]] || die "--api-token needs a value"
      api_token="$2"
      shift 2
      ;;
    --api-token=*)
      api_token="${1#*=}"
      shift
      ;;
    --client-id)
      [[ $# -ge 2 ]] || die "--client-id needs a value"
      client_id="$2"
      shift 2
      ;;
    --client-id=*)
      client_id="${1#*=}"
      shift
      ;;
    --config)
      [[ $# -ge 2 ]] || die "--config needs a value"
      config_file="$2"
      shift 2
      ;;
    --config=*)
      config_file="${1#*=}"
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --limit)
      [[ $# -ge 2 ]] || die "--limit needs a value"
      limit="$2"
      shift 2
      ;;
    --limit=*)
      limit="${1#*=}"
      shift
      ;;
    --batch-bytes)
      [[ $# -ge 2 ]] || die "--batch-bytes needs a value"
      batch_bytes="$2"
      shift 2
      ;;
    --batch-bytes=*)
      batch_bytes="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      while [[ $# -gt 0 ]]; do
        paths+=("$1")
        shift
      done
      ;;
    -*)
      die "unknown flag $1"
      ;;
    *)
      paths+=("$1")
      shift
      ;;
  esac
done

[[ -z "$limit" || "$limit" =~ ^[0-9]+$ ]] || die "--limit must be a non-negative integer"
[[ "$batch_bytes" =~ ^[1-9][0-9]*$ ]] || die "--batch-bytes must be a positive integer"

command -v jq >/dev/null 2>&1 || die "jq is required"
if [[ "$dry_run" -eq 0 ]]; then
  command -v curl >/dev/null 2>&1 || die "curl is required"
fi
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
  die "sha256sum or shasum is required"
fi

if [[ -z "$server_url" ]]; then
  server_url="${JONAYLOR_BASE_URL:-$(read_toml_value base_url "$config_file" || true)}"
fi
server_url="${server_url:-http://127.0.0.1:8000}"
server_url="${server_url%/}"

if [[ -z "$api_token" ]]; then
  api_token="${JONAYLOR_TOKEN:-$(read_toml_value token "$config_file" || true)}"
fi

if [[ -z "$client_id" ]]; then
  client_id="$(read_toml_value pi_thread_vault.client_id "$config_file" || true)"
fi
client_id="${client_id:-backfill-$(hostname 2>/dev/null || echo local)}"

if [[ "$dry_run" -eq 0 && -z "$api_token" ]]; then
  die "missing API token; set JONAYLOR_TOKEN, add token to $config_file, or pass --api-token"
fi

if [[ ${#paths[@]} -eq 0 ]]; then
  paths=("$HOME/.pi/agent/sessions")
fi

files=()
for input in "${paths[@]}"; do
  expanded="$(expand_path "$input")"
  if [[ -f "$expanded" && "$expanded" == *.jsonl ]]; then
    files+=("$expanded")
  elif [[ -d "$expanded" ]]; then
    while IFS= read -r found; do
      [[ -n "$found" ]] && files+=("$found")
    done < <(find "$expanded" -type f -name '*.jsonl' | sort)
  else
    echo "warning: skipping $input (not a JSONL file or directory)" >&2
  fi
done

if [[ ${#files[@]} -eq 0 ]]; then
  die "no Pi session JSONL files found"
fi

if [[ -n "$limit" ]]; then
  files=("${files[@]:0:limit}")
fi

fallback_session_id() {
  local name stem
  name="$(basename "$1")"
  stem="${name%.jsonl}"
  if [[ "$stem" == *_* ]]; then
    printf '%s\n' "${stem##*_}"
  else
    printf 'unknown\n'
  fi
}

fallback_timestamp() {
  local name date time
  name="$(basename "$1")"
  if [[ ${#name} -ge 19 ]]; then
    date="${name:0:10}"
    time="${name:11:8}"
    printf '%sT%sZ\n' "$date" "${time//-/:}"
  else
    printf '1970-01-01T00:00:00Z\n'
  fi
}

fallback_cwd() {
  local dir name trimmed
  dir="$(dirname "$1")"
  name="$(basename "$dir")"
  if [[ "$name" == --*-- ]]; then
    trimmed="${name#--}"
    trimmed="${trimmed%--}"
    trimmed="${trimmed//-//}"
    printf '/%s\n' "$trimmed"
  fi
}

run_cmd() {
  local cwd="$1"
  shift
  "$@" 2>/dev/null | head -n 1 | tr -d '\r' || true
}

detect_repo_json() {
  local cwd="$1"
  local remote="" branch="" head=""
  if [[ -n "$cwd" && -d "$cwd" ]]; then
    remote="$(run_cmd "$cwd" git -C "$cwd" config --get remote.origin.url)"
    branch="$(run_cmd "$cwd" git -C "$cwd" branch --show-current)"
    head="$(run_cmd "$cwd" git -C "$cwd" rev-parse --short=12 HEAD)"
    if (cd "$cwd" && jj root >/dev/null 2>&1); then
      local jj_remote jj_bookmarks jj_change jj_commit
      jj_remote="$(cd "$cwd" && jj git remote list 2>/dev/null | awk 'NR==1 || $1=="origin" {print $2; if ($1=="origin") exit}' | head -n 1)"
      jj_bookmarks="$(cd "$cwd" && jj log -r @ --no-graph -T 'bookmarks.join(", ")' 2>/dev/null | head -n 1)"
      jj_change="$(cd "$cwd" && jj log -r @ --no-graph -T 'change_id.short()' 2>/dev/null | head -n 1)"
      jj_commit="$(cd "$cwd" && jj log -r @ --no-graph -T 'commit_id.short()' 2>/dev/null | head -n 1)"
      [[ -n "$jj_remote" ]] && remote="$jj_remote"
      [[ -n "$jj_bookmarks" ]] && branch="$jj_bookmarks"
      [[ -z "$branch" && -n "$jj_change" ]] && branch="jj:$jj_change"
      [[ -n "$jj_commit" ]] && head="$jj_commit"
    fi
  fi
  jq -n \
    --arg remote "$remote" \
    --arg branch "$branch" \
    --arg head "$head" \
    '{repo_remote: (if $remote == "" then null else $remote end), repo_branch: (if $branch == "" then null else $branch end), repo_head: (if $head == "" then null else $head end)} | with_entries(select(.value != null))'
}

build_base_payload() {
  local file="$1" fallback_id="$2" fallback_time="$3" cwd="$4" repo_json="$5" out_payload="$6"
  jq -s \
    --arg client_id "$client_id" \
    --arg fallback_id "$fallback_id" \
    --arg fallback_time "$fallback_time" \
    --arg fallback_cwd "$cwd" \
    --argjson repo "$repo_json" \
    '
    def text:
      if type == "string" then .
      elif type == "array" then map(if type == "string" then . else ((.text // .content // "") | if type == "string" then . else tojson end) end) | join("\n")
      elif . == null then ""
      else tojson end;
    def words: test("[[:alnum:]]");
    def compact_title:
      (split("\n") | map(gsub("^\\s+|\\s+$"; "")) | map(select(. != "" and (startswith("```") | not) and (startswith("{") | not))) | first) // .
      | gsub("^#+"; "")
      | gsub("^\\s+|\\s+$"; "")
      | gsub("\\s+"; " ")
      | if length <= 80 then . else .[0:80] + "…" end;
    def summarize:
      if .type == "model_change" then "model: \(.provider // "")/\(.modelId // "")"
      elif .type == "thinking_level_change" then "thinking: \(.thinkingLevel // "")"
      elif .type == "label" then "label: \(.label // "")"
      else (.content // .summary // . | text) end;
    def event($id; $parent; $role; $kind; $content; $metadata; $created):
      {external_event_id: $id, parent_external_event_id: $parent, role: $role, kind: $kind, content: $content, metadata: $metadata, created_at: $created};
    def assistant_event($entry; $msg; $parent; $created):
      (($msg.content | if type == "array" then . else [{type:"text", text:(. | text)}] end) | to_entries[])
      | .key as $index
      | .value as $block
      | ($block.type // "message") as $block_type
      | if $block_type == "text" then
          event("\($entry.id // "unknown"):\($index)"; $parent; "assistant"; "message"; ($block.text // ""); {entry_id: ($entry.id // "unknown"), block: $block, stopReason: $msg.stopReason}; $created)
        elif $block_type == "thinking" or $block_type == "reasoning" then
          event("\($entry.id // "unknown"):\($index)"; $parent; "assistant"; "thinking"; ($block.thinking // $block.text // ""); {entry_id: ($entry.id // "unknown"), block: $block, stopReason: $msg.stopReason}; $created)
        elif $block_type == "toolCall" then
          event("\($entry.id // "unknown"):\($index)"; $parent; "assistant"; "tool_call"; ({toolName: $block.name, input: ($block.arguments // null)} | tojson); {entry_id: ($entry.id // "unknown"), block: $block, stopReason: $msg.stopReason}; $created)
        else
          event("\($entry.id // "unknown"):\($index)"; $parent; "assistant"; $block_type; ($block | tojson); {entry_id: ($entry.id // "unknown"), block: $block, stopReason: $msg.stopReason}; $created)
        end;
    def events:
      [ .[] | select((.type == "session") | not) as $entry
        | ($entry.id // "unknown") as $id
        | ($entry.parentId // null) as $parent
        | ($entry.timestamp // null) as $created
        | if $entry.type == "message" then
            ($entry.message // {}) as $msg
            | ($msg.role // "unknown") as $role
            | if $role == "user" then event($id; $parent; "user"; "message"; ($msg.content | text); {entry: $entry}; $created)
              elif $role == "assistant" then assistant_event($entry; $msg; $parent; $created)
              elif $role == "toolResult" or $role == "tool" then event($id; $parent; "tool"; "tool_result"; ($msg.content | text); {entry: $entry, toolName: $msg.toolName, toolCallId: $msg.toolCallId, isError: $msg.isError}; $created)
              else event($id; $parent; $role; "message"; ($msg.content | text); {entry: $entry}; $created)
              end
          elif (["model_change", "thinking_level_change", "label", "custom_message", "compaction", "branch_summary"] | index($entry.type)) then
            event($id; $parent; "system"; $entry.type; ($entry | summarize); {entry: $entry}; $created)
          else empty end ];
    (first(.[] | select(.type == "session")) // {}) as $header
    | events as $events
    | ($header.id // $fallback_id) as $session_id
    | ($header.cwd // (if $fallback_cwd == "" then null else $fallback_cwd end)) as $cwd
    | ($header.timestamp // ($events[0].created_at // $fallback_time)) as $created_at
    | ([ $events[].created_at | select(. != null) ] | max // $created_at) as $updated_at
    | {
        client_id: $client_id,
        session: {
          external_session_id: $session_id,
          title: ([ $events[] | select(.role == "user" and (.content | words)) | .content | compact_title ][0]),
          cwd: $cwd,
          repo_remote: $repo.repo_remote,
          repo_branch: $repo.repo_branch,
          repo_head: $repo.repo_head,
          created_at: $created_at,
          updated_at: $updated_at
        },
        events: $events
      }' "$file" > "$out_payload"
}

add_event_hashes() {
  local base_payload="$1" events_jsonl="$2" session_id event hash_input hash
  session_id="$(jq -r '.session.external_session_id' "$base_payload")"
  : > "$events_jsonl"
  while IFS= read -r event; do
    hash_input="$(jq -cS --arg session "$session_id" '{session: $session, external_event_id, role, kind, content, created_at}' <<< "$event")"
    hash="$(printf '%s' "$hash_input" | sha256_hex)"
    jq -c --arg hash "sha256:$hash" '. + {event_hash: $hash}' <<< "$event" >> "$events_jsonl"
  done < <(jq -c '.events[]' "$base_payload")
}

build_payload_from_events() {
  local base_payload="$1" events_jsonl="$2" out_payload="$3"
  jq -n \
    --arg client_id "$client_id" \
    --slurpfile base "$base_payload" \
    --slurpfile events "$events_jsonl" \
    '{client_id: $client_id, session: $base[0].session, events: $events}' > "$out_payload"
}

post_payload() {
  local payload_file="$1" response_file http_code
  response_file="$(mktemp)"
  tmp_files+=("$response_file")
  http_code="$(curl -sS -w '%{http_code}' -o "$response_file" \
    -H "Authorization: Bearer $api_token" \
    -H 'Content-Type: application/json' \
    --data-binary "@$payload_file" \
    "$server_url/api/v1/events/batch")"
  if [[ "$http_code" != 2* ]]; then
    echo "failed to import payload (HTTP $http_code, $(wc -c < "$payload_file" | tr -d ' ') bytes)" >&2
    cat "$response_file" >&2
    exit 1
  fi
  cat "$response_file"
}

tmp_files=()
cleanup() {
  if [[ ${#tmp_files[@]} -gt 0 ]]; then
    rm -rf "${tmp_files[@]}"
  fi
}
trap cleanup EXIT

processed=0
total_events=0
total_accepted=0
total_duplicates=0

for file in "${files[@]}"; do
  fallback_id="$(fallback_session_id "$file")"
  fallback_time="$(fallback_timestamp "$file")"
  cwd="$(fallback_cwd "$file" || true)"
  repo_json="$(detect_repo_json "$cwd")"

  work_dir="$(mktemp -d)"
  tmp_files+=("$work_dir")
  base_payload="$work_dir/base.json"
  events_jsonl="$work_dir/events.jsonl"
  build_base_payload "$file" "$fallback_id" "$fallback_time" "$cwd" "$repo_json" "$base_payload"
  add_event_hashes "$base_payload" "$events_jsonl"

  event_count="$(wc -l < "$events_jsonl" | tr -d ' ')"
  session_id="$(jq -r '.session.external_session_id' "$base_payload")"
  total_events=$((total_events + event_count))
  processed=$((processed + 1))

  if [[ "$dry_run" -eq 1 ]]; then
    printf 'would import %s (%s event(s), session %s)\n' "$file" "$event_count" "$session_id"
    continue
  fi

  current_events="$work_dir/current.jsonl"
  candidate_events="$work_dir/candidate.jsonl"
  candidate_payload="$work_dir/candidate-payload.json"
  : > "$current_events"
  file_accepted=0
  file_duplicates=0
  chunk_count=0
  thread_url=""

  flush_current() {
    [[ -s "$current_events" ]] || return 0
    local payload response accepted duplicates
    payload="$work_dir/payload-${chunk_count}.json"
    build_payload_from_events "$base_payload" "$current_events" "$payload"
    response="$(post_payload "$payload")"
    accepted="$(jq -r '.accepted' <<< "$response")"
    duplicates="$(jq -r '.duplicates' <<< "$response")"
    thread_url="$(jq -r '.thread_url' <<< "$response")"
    file_accepted=$((file_accepted + accepted))
    file_duplicates=$((file_duplicates + duplicates))
    chunk_count=$((chunk_count + 1))
    : > "$current_events"
  }

  while IFS= read -r event; do
    cp "$current_events" "$candidate_events"
    printf '%s\n' "$event" >> "$candidate_events"
    build_payload_from_events "$base_payload" "$candidate_events" "$candidate_payload"
    candidate_size="$(wc -c < "$candidate_payload" | tr -d ' ')"
    if [[ -s "$current_events" && "$candidate_size" -gt "$batch_bytes" ]]; then
      flush_current
    fi
    printf '%s\n' "$event" >> "$current_events"
  done < "$events_jsonl"
  flush_current

  total_accepted=$((total_accepted + file_accepted))
  total_duplicates=$((total_duplicates + file_duplicates))
  printf 'imported %s: %s accepted, %s duplicate(s) across %s request(s) -> %s\n' "$file" "$file_accepted" "$file_duplicates" "$chunk_count" "$thread_url"
done

if [[ "$dry_run" -eq 1 ]]; then
  printf 'would import %s session(s) and %s event(s)\n' "$processed" "$total_events"
else
  printf 'imported/scanned %s session(s); accepted %s new event(s), skipped %s duplicate(s)\n' "$processed" "$total_accepted" "$total_duplicates"
fi
