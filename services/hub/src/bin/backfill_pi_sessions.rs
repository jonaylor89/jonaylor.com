use anyhow::{Context, Result, bail};
use hub::configuration::get_configuration;
use hub::startup::get_connection_pool;
use hub::vault::{new_id, prepare_blob_dirs, strip_nuls, strip_nuls_json, strip_nuls_opt};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone)]
struct Args {
    paths: Vec<PathBuf>,
    data_dir: Option<PathBuf>,
    default_visibility: Option<String>,
    dry_run: bool,
    limit: Option<usize>,
}

#[derive(Debug)]
struct SessionImport {
    path: PathBuf,
    external_session_id: String,
    title: Option<String>,
    cwd: Option<String>,
    repo_remote: Option<String>,
    repo_branch: Option<String>,
    repo_head: Option<String>,
    created_at: String,
    updated_at: String,
    events: Vec<EventImport>,
}

#[derive(Debug)]
struct EventImport {
    external_event_id: String,
    parent_external_event_id: Option<String>,
    role: String,
    kind: String,
    content: Option<String>,
    metadata: Value,
    created_at: Option<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = parse_args()?;
    let configuration = get_configuration().context("Failed to load configuration")?;
    let data_dir = args
        .data_dir
        .clone()
        .unwrap_or_else(|| configuration.vault.data_dir.clone());
    let default_visibility = args
        .default_visibility
        .clone()
        .unwrap_or_else(|| configuration.vault.default_visibility.clone());

    let mut files = discover_session_files(if args.paths.is_empty() {
        vec![home_dir().join(".pi/agent/sessions")]
    } else {
        args.paths.clone()
    })?;
    if let Some(limit) = args.limit {
        files.truncate(limit);
    }

    if files.is_empty() {
        bail!("no Pi session JSONL files found");
    }

    if args.dry_run {
        let mut events = 0;
        for file in &files {
            events += parse_session(file)?.events.len();
        }
        println!(
            "would import {} sessions and {} events into {}",
            files.len(),
            events,
            configuration.database.database_name
        );
        return Ok(());
    }

    prepare_blob_dirs(&data_dir)
        .await
        .context("Failed to prepare blob directories")?;
    let pool = get_connection_pool(&configuration.database);
    // Verify connectivity early so we fail fast if the DB isn't migrated.
    sqlx::query("SELECT 1")
        .execute(&pool)
        .await
        .context("Failed to connect to Postgres — make sure migrations have run")?;

    let mut scanned = 0usize;
    let mut accepted_events = 0u64;
    for file in files {
        let session =
            parse_session(&file).with_context(|| format!("parsing {}", file.display()))?;
        let (thread_id, accepted) = import_session(&pool, &session, &default_visibility).await?;
        if accepted > 0 {
            persist_raw_copy(&data_dir, &thread_id, &session.path)?;
        }
        scanned += 1;
        accepted_events += accepted;
    }

    println!(
        "imported/scanned {} sessions; accepted {} new events into {}",
        scanned, accepted_events, configuration.database.database_name
    );
    Ok(())
}

fn parse_args() -> Result<Args> {
    let mut args = Args {
        paths: Vec::new(),
        data_dir: None,
        default_visibility: None,
        dry_run: false,
        limit: None,
    };
    let mut iter = std::env::args().skip(1);
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--help" | "-h" => {
                print_help();
                std::process::exit(0);
            }
            "--dry-run" => args.dry_run = true,
            "--data-dir" => {
                args.data_dir = Some(PathBuf::from(
                    iter.next().context("--data-dir needs a value")?,
                ))
            }
            "--default-visibility" => {
                args.default_visibility =
                    Some(iter.next().context("--default-visibility needs a value")?)
            }
            "--limit" => args.limit = Some(iter.next().context("--limit needs a value")?.parse()?),
            value if value.starts_with('-') => bail!("unknown flag {value}"),
            value => args.paths.push(PathBuf::from(value)),
        }
    }
    Ok(args)
}

fn print_help() {
    println!(
        "Backfill pi-coding-agent JSONL sessions into the merged vault on Postgres.\n\n\
         Usage:\n  cargo run --bin backfill_pi_sessions -- [options] [session-file-or-dir ...]\n\n\
         Database connection is read from the standard hub configuration\n\
         (configuration/*.yaml + APP_DATABASE__* env overrides). Run migrations first.\n\n\
         Options:\n  --dry-run\n  --data-dir PATH          blob storage root (default: vault.data_dir from config)\n  --default-visibility V   default: vault.default_visibility from config\n  --limit N"
    );
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn discover_session_files(paths: Vec<PathBuf>) -> Result<Vec<PathBuf>> {
    let mut files = BTreeSet::new();
    for path in paths {
        let path = expand_tilde(path);
        if path.is_file() && path.extension().is_some_and(|ext| ext == "jsonl") {
            files.insert(path);
        } else if path.is_dir() {
            collect_jsonl(&path, &mut files)?;
        }
    }
    Ok(files.into_iter().collect())
}

fn collect_jsonl(dir: &Path, out: &mut BTreeSet<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            collect_jsonl(&path, out)?;
        } else if path.extension().is_some_and(|ext| ext == "jsonl") {
            out.insert(path);
        }
    }
    Ok(())
}

fn expand_tilde(path: PathBuf) -> PathBuf {
    let Some(value) = path.to_str() else {
        return path;
    };
    if value == "~" {
        return home_dir();
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return home_dir().join(rest);
    }
    path
}

fn parse_session(path: &Path) -> Result<SessionImport> {
    let content = fs::read_to_string(path)?;
    let mut header: Option<Value> = None;
    let mut entries = Vec::new();

    for (line_number, line) in content.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(line)
            .with_context(|| format!("invalid JSON at {}:{}", path.display(), line_number + 1))?;
        if value.get("type").and_then(Value::as_str) == Some("session") && header.is_none() {
            header = Some(value);
        } else {
            entries.push(value);
        }
    }

    let session_id = header
        .as_ref()
        .and_then(|v| v.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .rsplit_once('_')
                .map(|(_, id)| id)
                .unwrap_or("unknown")
                .to_string()
        });
    let cwd = header
        .as_ref()
        .and_then(|v| v.get("cwd"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| cwd_from_session_path(path));
    let events = events_from_entries(entries);
    let created_at = header
        .as_ref()
        .and_then(|v| v.get("timestamp"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| events.first().and_then(|e| e.created_at.clone()))
        .unwrap_or_else(|| timestamp_from_filename(path));
    let updated_at = events
        .iter()
        .filter_map(|e| e.created_at.as_deref())
        .max()
        .unwrap_or(&created_at)
        .to_string();
    let (repo_remote, repo_branch, repo_head) = detect_repo(cwd.as_deref());

    Ok(SessionImport {
        path: path.to_path_buf(),
        external_session_id: session_id,
        title: derive_title(&events),
        cwd,
        repo_remote,
        repo_branch,
        repo_head,
        created_at,
        updated_at,
        events,
    })
}

fn events_from_entries(entries: Vec<Value>) -> Vec<EventImport> {
    let mut out = Vec::new();
    for entry in entries {
        let entry_type = entry
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let entry_id = entry
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let parent_id = entry
            .get("parentId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let timestamp = entry
            .get("timestamp")
            .and_then(Value::as_str)
            .map(str::to_string);

        if entry_type == "message" {
            let msg = entry.get("message").unwrap_or(&Value::Null);
            let role = msg.get("role").and_then(Value::as_str).unwrap_or("unknown");
            let content = msg.get("content").unwrap_or(&Value::Null);
            match role {
                "user" => out.push(EventImport {
                    external_event_id: entry_id,
                    parent_external_event_id: parent_id,
                    role: "user".into(),
                    kind: "message".into(),
                    content: Some(extract_text(content)),
                    metadata: serde_json::json!({ "entry": entry }),
                    created_at: timestamp,
                }),
                "assistant" => {
                    let blocks: Vec<Value> = content.as_array().cloned().unwrap_or_else(|| {
                        vec![serde_json::json!({ "type": "text", "text": extract_text(content) })]
                    });
                    for (index, block) in blocks.iter().enumerate() {
                        let block_type = block
                            .get("type")
                            .and_then(Value::as_str)
                            .unwrap_or("message");
                        let (kind, content) = match block_type {
                            "text" => (
                                "message",
                                block
                                    .get("text")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string(),
                            ),
                            "thinking" | "reasoning" => (
                                "thinking",
                                block
                                    .get("thinking")
                                    .or_else(|| block.get("text"))
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string(),
                            ),
                            "toolCall" => {
                                let payload = serde_json::json!({
                                    "toolName": block.get("name"),
                                    "input": block.get("arguments").unwrap_or(&Value::Null),
                                });
                                (
                                    "tool_call",
                                    serde_json::to_string_pretty(&payload).unwrap_or_default(),
                                )
                            }
                            other => (
                                other,
                                serde_json::to_string_pretty(block).unwrap_or_default(),
                            ),
                        };
                        out.push(EventImport {
                            external_event_id: format!("{entry_id}:{index}"),
                            parent_external_event_id: parent_id.clone(),
                            role: "assistant".into(),
                            kind: kind.into(),
                            content: Some(content),
                            metadata: serde_json::json!({ "entry_id": entry_id, "block": block, "stopReason": msg.get("stopReason") }),
                            created_at: timestamp.clone(),
                        });
                    }
                }
                "toolResult" | "tool" => out.push(EventImport {
                    external_event_id: entry_id,
                    parent_external_event_id: parent_id,
                    role: "tool".into(),
                    kind: "tool_result".into(),
                    content: Some(extract_text(content)),
                    metadata: serde_json::json!({
                        "entry": entry,
                        "toolName": msg.get("toolName"),
                        "toolCallId": msg.get("toolCallId"),
                        "isError": msg.get("isError"),
                    }),
                    created_at: timestamp,
                }),
                other => out.push(EventImport {
                    external_event_id: entry_id,
                    parent_external_event_id: parent_id,
                    role: other.into(),
                    kind: "message".into(),
                    content: Some(extract_text(content)),
                    metadata: serde_json::json!({ "entry": entry }),
                    created_at: timestamp,
                }),
            }
        } else if matches!(
            entry_type,
            "model_change"
                | "thinking_level_change"
                | "label"
                | "custom_message"
                | "compaction"
                | "branch_summary"
        ) {
            out.push(EventImport {
                external_event_id: entry_id,
                parent_external_event_id: parent_id,
                role: "system".into(),
                kind: entry_type.into(),
                content: Some(summarize_entry(&entry)),
                metadata: serde_json::json!({ "entry": entry }),
                created_at: timestamp,
            });
        }
    }
    out
}

fn extract_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| {
                if let Some(s) = item.as_str() {
                    Some(s.to_string())
                } else {
                    item.get("text")
                        .or_else(|| item.get("content"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    }
}

fn summarize_entry(entry: &Value) -> String {
    match entry
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
    {
        "model_change" => format!(
            "model: {}/{}",
            entry.get("provider").and_then(Value::as_str).unwrap_or(""),
            entry.get("modelId").and_then(Value::as_str).unwrap_or("")
        ),
        "thinking_level_change" => format!(
            "thinking: {}",
            entry
                .get("thinkingLevel")
                .and_then(Value::as_str)
                .unwrap_or("")
        ),
        "label" => format!(
            "label: {}",
            entry.get("label").and_then(Value::as_str).unwrap_or("")
        ),
        _ => extract_text(
            entry
                .get("content")
                .or_else(|| entry.get("summary"))
                .unwrap_or(entry),
        ),
    }
}

async fn import_session(
    pool: &PgPool,
    session: &SessionImport,
    default_visibility: &str,
) -> Result<(String, u64)> {
    let existing: Option<String> =
        sqlx::query_scalar("SELECT id FROM vault_threads WHERE external_session_id = $1")
            .bind(&session.external_session_id)
            .fetch_optional(pool)
            .await?;
    let thread_id = existing.unwrap_or_else(|| new_id("thr"));

    sqlx::query(
        r#"INSERT INTO vault_threads (
             id, external_session_id, title, cwd, repo_remote, repo_branch, repo_head,
             default_visibility, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (external_session_id) DO UPDATE SET
             title       = COALESCE(EXCLUDED.title,       vault_threads.title),
             cwd         = COALESCE(EXCLUDED.cwd,         vault_threads.cwd),
             repo_remote = COALESCE(EXCLUDED.repo_remote, vault_threads.repo_remote),
             repo_branch = COALESCE(EXCLUDED.repo_branch, vault_threads.repo_branch),
             repo_head   = COALESCE(EXCLUDED.repo_head,   vault_threads.repo_head),
             updated_at  = EXCLUDED.updated_at"#,
    )
    .bind(&thread_id)
    .bind(strip_nuls(&session.external_session_id))
    .bind(strip_nuls_opt(session.title.clone()))
    .bind(strip_nuls_opt(session.cwd.clone()))
    .bind(strip_nuls_opt(session.repo_remote.clone()))
    .bind(strip_nuls_opt(session.repo_branch.clone()))
    .bind(strip_nuls_opt(session.repo_head.clone()))
    .bind(default_visibility)
    .bind(&session.created_at)
    .bind(&session.updated_at)
    .execute(pool)
    .await?;

    let mut accepted = 0;
    for event in &session.events {
        let hash = event_hash(&session.external_session_id, event);
        let mut metadata = event.metadata.clone();
        strip_nuls_json(&mut metadata);
        let result = sqlx::query(
            r#"INSERT INTO vault_thread_events (
                 id, thread_id, external_event_id, parent_external_event_id, event_hash, role,
                 kind, content, redacted, metadata_json, created_at, inserted_at
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, $9, $10, $11)
               ON CONFLICT (thread_id, event_hash) DO NOTHING"#,
        )
        .bind(new_id("evt"))
        .bind(&thread_id)
        .bind(strip_nuls(&event.external_event_id))
        .bind(strip_nuls_opt(event.parent_external_event_id.clone()))
        .bind(hash)
        .bind(strip_nuls(&event.role))
        .bind(strip_nuls(&event.kind))
        .bind(strip_nuls_opt(event.content.clone()))
        .bind(serde_json::to_string(&metadata)?)
        .bind(&event.created_at)
        .bind(event.created_at.as_deref().unwrap_or(&session.updated_at))
        .execute(pool)
        .await?;
        accepted += result.rows_affected();
    }

    Ok((thread_id, accepted))
}

fn event_hash(session_id: &str, event: &EventImport) -> String {
    let payload = serde_json::json!({
        "session": session_id,
        "external_event_id": event.external_event_id,
        "role": event.role,
        "kind": event.kind,
        "content": event.content,
        "created_at": event.created_at,
    });
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(&payload).unwrap_or_default());
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

fn derive_title(events: &[EventImport]) -> Option<String> {
    events
        .iter()
        .find(|event| event.role == "user" && event.content.as_deref().is_some_and(has_words))
        .and_then(|event| event.content.as_deref())
        .map(compact_title)
}

fn has_words(value: &str) -> bool {
    value
        .split_whitespace()
        .any(|word| word.chars().any(char::is_alphanumeric))
}

fn compact_title(content: &str) -> String {
    let mut title = content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("```") && !line.starts_with('{'))
        .unwrap_or(content)
        .trim_start_matches('#')
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if title.len() <= 80 {
        return title;
    }
    title.truncate(80);
    if let Some(index) = title.rfind(' ').filter(|index| *index >= 48) {
        title.truncate(index);
    }
    format!(
        "{}…",
        title.trim_end_matches(&['.', ',', ':', ';', '-'][..])
    )
}

fn cwd_from_session_path(path: &Path) -> Option<String> {
    let name = path.parent()?.file_name()?.to_string_lossy();
    if name.starts_with("--") && name.ends_with("--") {
        let parts = name
            .trim_matches('-')
            .split('-')
            .filter(|p| !p.is_empty())
            .collect::<Vec<_>>();
        if !parts.is_empty() {
            return Some(format!("/{}", parts.join("/")));
        }
    }
    None
}

fn timestamp_from_filename(path: &Path) -> String {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    if name.len() >= 19 {
        let date = &name[0..10];
        let time = name[11..19].replace('-', ":");
        format!("{date}T{time}Z")
    } else {
        "1970-01-01T00:00:00Z".into()
    }
}

fn detect_repo(cwd: Option<&str>) -> (Option<String>, Option<String>, Option<String>) {
    let Some(cwd) = cwd else {
        return (None, None, None);
    };
    if !Path::new(cwd).exists() {
        return (None, None, None);
    }
    let git_remote = run_cmd(
        "git",
        &["-C", cwd, "config", "--get", "remote.origin.url"],
        None,
    );
    let git_branch = run_cmd("git", &["-C", cwd, "branch", "--show-current"], None);
    let git_head = run_cmd("git", &["-C", cwd, "rev-parse", "--short=12", "HEAD"], None);

    if run_cmd("jj", &["root"], Some(cwd)).is_some() {
        let jj_remotes = run_cmd("jj", &["git", "remote", "list"], Some(cwd));
        let jj_remote = jj_remotes.as_deref().and_then(|remotes| {
            let rows = remotes.lines().filter_map(|line| {
                let parts = line.split_whitespace().collect::<Vec<_>>();
                (parts.len() >= 2).then_some((parts[0], parts[1]))
            });
            rows.clone()
                .find(|(name, _)| *name == "origin")
                .or_else(|| rows.into_iter().next())
                .map(|(_, url)| url.to_string())
        });
        let bookmarks = run_cmd(
            "jj",
            &[
                "log",
                "-r",
                "@",
                "--no-graph",
                "-T",
                "bookmarks.join(\", \")",
            ],
            Some(cwd),
        );
        let change = run_cmd(
            "jj",
            &["log", "-r", "@", "--no-graph", "-T", "change_id.short()"],
            Some(cwd),
        );
        let commit = run_cmd(
            "jj",
            &["log", "-r", "@", "--no-graph", "-T", "commit_id.short()"],
            Some(cwd),
        );
        return (
            jj_remote.or(git_remote),
            bookmarks
                .or(git_branch)
                .or_else(|| change.map(|c| format!("jj:{c}"))),
            commit.or(git_head),
        );
    }

    (git_remote, git_branch, git_head)
}

fn run_cmd(cmd: &str, args: &[&str], cwd: Option<&str>) -> Option<String> {
    let mut command = Command::new(cmd);
    command.args(args);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn persist_raw_copy(data_dir: &Path, thread_id: &str, source: &Path) -> Result<()> {
    let raw_dir = data_dir.join("blobs/raw_sessions");
    fs::create_dir_all(&raw_dir)?;
    let dest = raw_dir.join(format!("{thread_id}.jsonl"));
    if !dest.exists() {
        fs::copy(source, dest)?;
    }
    Ok(())
}
