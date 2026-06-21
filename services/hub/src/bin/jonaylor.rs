use anyhow::{Context, Result, anyhow, bail};
use hub::configuration::get_configuration;
use hub::startup::get_connection_pool;
use hub::vault::keys::issue_api_key;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

#[derive(Debug, Default, Deserialize, Serialize)]
struct Config {
    base_url: String,
    token: Option<String>,
    #[serde(default)]
    pi_thread_vault_data_dir: Option<String>,
    #[serde(default)]
    pi_thread_vault_default_visibility: Option<String>,
    #[serde(default)]
    pi_thread_vault_redaction_enabled: Option<bool>,
    #[serde(default)]
    pi_thread_vault_memory_enabled: Option<bool>,
    #[serde(default)]
    pi_thread_vault_memory_user_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct ShareResponse {
    thread_id: String,
    share_kind: String,
    share_url: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() || flag(&args, "--help") || flag(&args, "-h") {
        print_help();
        return Ok(());
    }

    let command = args.remove(0);
    match command.as_str() {
        "auth" => auth(args).await,
        "login" => {
            args.insert(0, "login".to_string());
            auth(args).await
        }
        "api" => api(args).await,
        "paste" => paste(args).await,
        "newsletter" => newsletter(args).await,
        "subscriptions" | "subscription" => subscriptions(args).await,
        "memory" | "memories" => memory(args).await,
        "vault" => vault(args).await,
        "github" => github(args).await,
        other => bail!("unknown command {other}; run `jonaylor --help`"),
    }
}

async fn auth(mut args: Vec<String>) -> Result<()> {
    let sub = pop_subcommand(&mut args, "auth")?;
    match sub.as_str() {
        "login" => {
            let token =
                take_option(&mut args, "--token")?.or_else(|| std::env::var("JONAYLOR_TOKEN").ok());
            let base_url = take_option(&mut args, "--base-url")?
                .or_else(|| std::env::var("JONAYLOR_BASE_URL").ok())
                .unwrap_or_else(|| "https://hub.jonaylor.com".to_string());
            let client_name =
                take_option(&mut args, "--client-name")?.unwrap_or_else(default_client_id);
            reject_extra(&args)?;

            if let Some(token) = token {
                write_config(&config_for_token(&base_url, &token))?;
                println!("Saved credentials to {}", config_path()?.display());
                Ok(())
            } else {
                browser_login(&base_url, &client_name).await
            }
        }
        "status" => {
            reject_extra(&args)?;
            let config = load_config()?;
            println!("base_url: {}", config.base_url);
            println!(
                "token: {}",
                present(configured_token(&config).ok().as_deref())
            );
            println!(
                "memory_enabled: {}",
                config.pi_thread_vault_memory_enabled.unwrap_or(false)
            );
            println!("memory_user_id: {}", memory_user_id(&config, None));
            Ok(())
        }
        "issue-token" | "issue" => {
            let name = take_option(&mut args, "--name")?
                .or_else(|| take_positional(&mut args, "name").ok())
                .context("a client name is required (--name \"laptop\")")?;
            reject_extra(&args)?;
            issue_token(&name).await
        }
        other => bail!("unknown auth command {other}"),
    }
}

async fn api(mut args: Vec<String>) -> Result<()> {
    let sub = pop_subcommand(&mut args, "api")?;
    match sub.as_str() {
        "request" => {
            let method = take_positional(&mut args, "method")?;
            let path = take_positional(&mut args, "path")?;
            let body = take_option(&mut args, "--body")?;
            let content_type = take_option(&mut args, "--content-type")?
                .unwrap_or_else(|| "application/json".to_string());
            let no_auth = take_bool(&mut args, "--no-auth");
            reject_extra(&args)?;
            let config = load_config()?;
            let client = reqwest::Client::new();
            let mut request = client.request(method.parse()?, url(&config, &path)?);
            if !no_auth {
                request = request.headers(auth_headers(&configured_token(&config)?)?);
            }
            if let Some(body) = body {
                request = request
                    .header(CONTENT_TYPE, content_type)
                    .body(read_arg_body(&body)?);
            }
            print_response(request.send().await?).await
        }
        other => bail!("unknown api command {other}"),
    }
}

async fn paste(mut args: Vec<String>) -> Result<()> {
    let sub = pop_subcommand(&mut args, "paste")?;
    match sub.as_str() {
        "create" => {
            let file = take_option(&mut args, "--file")?;
            let json_output = take_bool(&mut args, "--json");
            reject_extra(&args)?;
            let content = match file.as_deref() {
                Some("-") | None => read_stdin()?,
                Some(path) => {
                    fs::read_to_string(path).with_context(|| format!("failed to read {path}"))?
                }
            };
            let config = load_config()?;
            let response = reqwest::Client::new()
                .put(url(&config, "/api/pastes")?)
                .headers(auth_headers(&configured_token(&config)?)?)
                .header(CONTENT_TYPE, "text/plain; charset=utf-8")
                .body(content)
                .send()
                .await?;
            let status = response.status();
            let text = response.text().await?;
            if !status.is_success() {
                bail!("server returned {status}: {text}");
            }
            let public_url = text.trim().to_string();
            if json_output {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&json!({ "url": public_url }))?
                );
            } else {
                println!("{public_url}");
            }
            Ok(())
        }
        other => bail!("unknown paste command {other}"),
    }
}

async fn newsletter(mut args: Vec<String>) -> Result<()> {
    let sub = pop_subcommand(&mut args, "newsletter")?;
    match sub.as_str() {
        "publish" => {
            let title = take_option(&mut args, "--title")?.context("--title is required")?;
            let html_file =
                take_option(&mut args, "--html-file")?.context("--html-file is required")?;
            let text_file =
                take_option(&mut args, "--text-file")?.context("--text-file is required")?;
            reject_extra(&args)?;
            let config = load_config()?;
            let response = reqwest::Client::new()
                .post(url(&config, "/api/newsletters")?)
                .headers(auth_headers(&configured_token(&config)?)?)
                .json(&json!({
                    "title": title,
                    "html_content": fs::read_to_string(&html_file).with_context(|| format!("failed to read {html_file}"))?,
                    "text_content": fs::read_to_string(&text_file).with_context(|| format!("failed to read {text_file}"))?,
                }))
                .send()
                .await?;
            print_response(response).await
        }
        other => bail!("unknown newsletter command {other}"),
    }
}

async fn subscriptions(mut args: Vec<String>) -> Result<()> {
    let sub = pop_subcommand(&mut args, "subscriptions")?;
    match sub.as_str() {
        "subscribe" => {
            let email = take_option(&mut args, "--email")?.context("--email is required")?;
            let name = take_option(&mut args, "--name")?;
            reject_extra(&args)?;
            let config = load_config()?;
            let response = reqwest::Client::new()
                .post(url(&config, "/api/subscriptions")?)
                .json(&json!({ "email": email, "name": name }))
                .send()
                .await?;
            print_response(response).await
        }
        other => bail!("unknown subscriptions command {other}"),
    }
}

async fn memory(mut args: Vec<String>) -> Result<()> {
    let sub = pop_subcommand(&mut args, "memory")?;
    match sub.as_str() {
        "add" => {
            let user_id = take_option(&mut args, "--user-id")?;
            let file = take_option(&mut args, "--file")?;
            let json_output = take_bool(&mut args, "--json");
            let text = match file.as_deref() {
                Some("-") => read_stdin()?,
                Some(path) => {
                    fs::read_to_string(path).with_context(|| format!("failed to read {path}"))?
                }
                None => {
                    if args.is_empty() {
                        bail!("memory text is required (or pass --file PATH|-)");
                    }
                    let text = args.join(" ");
                    args.clear();
                    text
                }
            };
            reject_extra(&args)?;
            if text.trim().is_empty() {
                bail!("memory text cannot be empty");
            }

            let config = load_config()?;
            let user_id = memory_user_id(&config, user_id);
            let response = reqwest::Client::new()
                .post(url(&config, "/api/memory")?)
                .headers(auth_headers(&configured_token(&config)?)?)
                .json(&json!({ "user_id": user_id, "text": text }))
                .send()
                .await?;
            let value = response_json(response).await?;
            if json_output {
                println!("{}", serde_json::to_string_pretty(&value)?);
            } else {
                println!(
                    "{}",
                    value
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Memory extraction queued")
                );
            }
            Ok(())
        }
        "search" => {
            let user_id = take_option(&mut args, "--user-id")?;
            let json_output = take_bool(&mut args, "--json");
            if args.is_empty() {
                bail!("search query is required");
            }
            let query = args.join(" ");
            args.clear();
            reject_extra(&args)?;

            let config = load_config()?;
            let user_id = memory_user_id(&config, user_id);
            let response = reqwest::Client::new()
                .post(url(&config, "/api/memory/search")?)
                .headers(auth_headers(&configured_token(&config)?)?)
                .json(&json!({ "user_id": user_id, "query": query }))
                .send()
                .await?;
            let value = response_json(response).await?;
            if json_output {
                println!("{}", serde_json::to_string_pretty(&value)?);
            } else {
                print_memory_matches(&value);
            }
            Ok(())
        }
        "list" | "ls" => {
            let user_id = take_option(&mut args, "--user-id")?;
            let json_output = take_bool(&mut args, "--json");
            reject_extra(&args)?;

            let config = load_config()?;
            let user_id = memory_user_id(&config, user_id);
            let response = reqwest::Client::new()
                .get(url(
                    &config,
                    &format!("/api/memory/{}", urlencoding::encode(&user_id)),
                )?)
                .headers(auth_headers(&configured_token(&config)?)?)
                .send()
                .await?;
            let value = response_json(response).await?;
            if json_output {
                println!("{}", serde_json::to_string_pretty(&value)?);
            } else {
                print_memories(&value);
            }
            Ok(())
        }
        other => bail!("unknown memory command {other}"),
    }
}

async fn vault(mut args: Vec<String>) -> Result<()> {
    let sub = pop_subcommand(&mut args, "vault")?;
    match sub.as_str() {
        "current-thread" => {
            let json_output = take_bool(&mut args, "--json");
            reject_extra(&args)?;
            let value = read_current_thread_context()?;
            if json_output {
                println!("{}", serde_json::to_string_pretty(&value)?);
            } else {
                let thread_id = value.get("threadId").and_then(Value::as_str).unwrap_or("");
                let thread_url = value.get("threadUrl").and_then(Value::as_str).unwrap_or("");
                let share_url = value
                    .get("shareUrl")
                    .or_else(|| value.get("publicUrl"))
                    .and_then(Value::as_str);
                println!("thread_id: {thread_id}");
                println!("thread_url: {thread_url}");
                if let Some(url) = share_url {
                    println!("share_url: {url}");
                }
            }
            Ok(())
        }
        "share-thread" => {
            let thread_id = take_positional(&mut args, "thread-id")?;
            let json_output = take_bool(&mut args, "--json");
            reject_extra(&args)?;
            let share = create_thread_share(&thread_id).await?;
            if json_output {
                println!("{}", serde_json::to_string_pretty(&share)?);
            } else {
                println!("{}", share.share_url);
            }
            Ok(())
        }
        "share-current-thread" => {
            let json_output = take_bool(&mut args, "--json");
            reject_extra(&args)?;
            let mut context = read_current_thread_context()?;
            let thread_id = context
                .get("threadId")
                .and_then(Value::as_str)
                .context("current thread context does not contain threadId")?
                .to_string();
            let share = create_thread_share(&thread_id).await?;
            if let Some(object) = context.as_object_mut() {
                object.insert(
                    "shareUrl".to_string(),
                    Value::String(share.share_url.clone()),
                );
                object.insert(
                    "publicUrl".to_string(),
                    Value::String(share.share_url.clone()),
                );
            }
            write_current_thread_context(&context)?;
            if json_output {
                println!("{}", serde_json::to_string_pretty(&share)?);
            } else {
                println!("{}", share.share_url);
            }
            Ok(())
        }
        other => bail!("unknown vault command {other}"),
    }
}

async fn github(mut args: Vec<String>) -> Result<()> {
    let sub = pop_subcommand(&mut args, "github")?;
    match sub.as_str() {
        "pi-threads-block" => {
            let label = take_option(&mut args, "--label")?
                .unwrap_or_else(|| "current coding-agent thread".to_string());
            let explicit_url = take_option(&mut args, "--url")?;
            reject_extra(&args)?;
            let share_url = if let Some(url) = explicit_url {
                url
            } else {
                create_share_for_current_thread_if_needed().await?
            };
            println!("<!-- pi-threads:start -->");
            println!("## Pi threads");
            println!("- [{label}]({share_url})");
            println!("<!-- pi-threads:end -->");
            Ok(())
        }
        other => bail!("unknown github command {other}"),
    }
}

async fn create_share_for_current_thread_if_needed() -> Result<String> {
    let context = read_current_thread_context()?;
    if let Some(url) = context
        .get("shareUrl")
        .or_else(|| context.get("publicUrl"))
        .and_then(Value::as_str)
        .filter(|url| url.contains("/s/"))
    {
        return Ok(url.to_string());
    }
    let thread_id = context
        .get("threadId")
        .and_then(Value::as_str)
        .context("current thread context does not contain threadId")?;
    let share = create_thread_share(thread_id).await?;
    let mut context = context;
    if let Some(object) = context.as_object_mut() {
        object.insert(
            "shareUrl".to_string(),
            Value::String(share.share_url.clone()),
        );
        object.insert(
            "publicUrl".to_string(),
            Value::String(share.share_url.clone()),
        );
    }
    write_current_thread_context(&context)?;
    Ok(share.share_url)
}

fn config_for_token(base_url: &str, token: &str) -> Config {
    Config {
        base_url: normalize_base_url(base_url),
        token: Some(token.to_string()),
        pi_thread_vault_data_dir: None,
        pi_thread_vault_default_visibility: Some("private".to_string()),
        pi_thread_vault_redaction_enabled: Some(true),
        pi_thread_vault_memory_enabled: Some(false),
        pi_thread_vault_memory_user_id: None,
    }
}

async fn create_thread_share(thread_id: &str) -> Result<ShareResponse> {
    let config = load_config()?;
    let response = reqwest::Client::new()
        .post(url(
            &config,
            &format!("/api/v1/threads/{thread_id}/shares"),
        )?)
        .headers(auth_headers(&configured_token(&config)?)?)
        .json(&json!({ "share_kind": "secret-link" }))
        .send()
        .await?;
    let status = response.status();
    let text = response.text().await?;
    if !status.is_success() {
        bail!("server returned {status}: {text}");
    }
    serde_json::from_str(&text).context("failed to parse share response")
}

fn load_config() -> Result<Config> {
    let path = config_path()?;
    let mut config = match fs::read_to_string(&path) {
        Ok(content) => parse_toml_config(&content),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Config::default(),
        Err(error) => {
            return Err(error).with_context(|| format!("failed to read {}", path.display()));
        }
    };
    fill_config_defaults(&mut config);
    Ok(config)
}

fn fill_config_defaults(config: &mut Config) {
    if config.base_url.is_empty() {
        config.base_url = std::env::var("JONAYLOR_BASE_URL")
            .unwrap_or_else(|_| "https://hub.jonaylor.com".to_string());
    }
    config.base_url = normalize_base_url(&config.base_url);
}

fn write_config(config: &Config) -> Result<()> {
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let content = format_config_toml(config);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&path)?;
        file.write_all(content.as_bytes())?;
    }
    #[cfg(not(unix))]
    {
        fs::write(&path, content)?;
    }
    Ok(())
}

fn config_path() -> Result<PathBuf> {
    if let Ok(path) = std::env::var("JONAYLOR_CONFIG") {
        return Ok(PathBuf::from(path));
    }
    Ok(config_dir()?.join("config.toml"))
}

fn config_dir() -> Result<PathBuf> {
    let base = std::env::var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|_| std::env::var("HOME").map(|home| PathBuf::from(home).join(".config")))
        .context("HOME is not set")?;
    Ok(base.join("jonaylor"))
}

fn parse_toml_config(content: &str) -> Config {
    let values = read_toml_like_values(content);
    let bool_value = |key: &str| values.get(key).and_then(|value| value.parse::<bool>().ok());
    Config {
        base_url: values.get("base_url").cloned().unwrap_or_default(),
        token: values.get("token").cloned(),
        pi_thread_vault_data_dir: values.get("pi_thread_vault.data_dir").cloned(),
        pi_thread_vault_default_visibility: values
            .get("pi_thread_vault.default_visibility")
            .cloned(),
        pi_thread_vault_redaction_enabled: bool_value("pi_thread_vault.redaction_enabled"),
        pi_thread_vault_memory_enabled: bool_value("pi_thread_vault.memory_enabled"),
        pi_thread_vault_memory_user_id: values.get("pi_thread_vault.memory_user_id").cloned(),
    }
}

fn read_toml_like_values(content: &str) -> std::collections::BTreeMap<String, String> {
    let mut values = std::collections::BTreeMap::new();
    let mut section: Option<String> = None;
    for raw_line in content.lines() {
        let line = raw_line
            .split_once('#')
            .map_or(raw_line, |(before, _)| before)
            .trim();
        if line.is_empty() {
            continue;
        }
        if let Some(name) = line
            .strip_prefix('[')
            .and_then(|line| line.strip_suffix(']'))
        {
            section = Some(name.trim().to_string());
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let key = match &section {
            Some(section) => format!("{section}.{key}"),
            None => key.to_string(),
        };
        values.insert(key, unquote_toml_value(value.trim()));
    }
    values
}

fn unquote_toml_value(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        value[1..value.len() - 1]
            .replace("\\\"", "\"")
            .replace("\\\\", "\\")
    } else {
        value.to_string()
    }
}

fn format_config_toml(config: &Config) -> String {
    let data_dir = config
        .pi_thread_vault_data_dir
        .clone()
        .unwrap_or_else(default_pi_thread_vault_data_dir);
    let default_visibility = config
        .pi_thread_vault_default_visibility
        .clone()
        .unwrap_or_else(|| "private".to_string());
    let redaction_enabled = config.pi_thread_vault_redaction_enabled.unwrap_or(true);
    let memory_enabled = config.pi_thread_vault_memory_enabled.unwrap_or(false);
    let memory_user_id = config
        .pi_thread_vault_memory_user_id
        .clone()
        .unwrap_or_else(default_memory_user_id);

    format!(
        "base_url = \"{}\"\ntoken = \"{}\"\n\n[pi_thread_vault]\ndata_dir = \"{}\"\ndefault_visibility = \"{}\"\nredaction_enabled = {}\nmemory_enabled = {}\nmemory_user_id = \"{}\"\n",
        toml_escape(&config.base_url),
        toml_escape(config.token.as_deref().unwrap_or_default()),
        toml_escape(&data_dir),
        toml_escape(&default_visibility),
        redaction_enabled,
        memory_enabled,
        toml_escape(&memory_user_id)
    )
}

fn toml_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn default_pi_thread_vault_data_dir() -> String {
    let base = std::env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|_| std::env::var("HOME").map(|home| Path::new(&home).join(".local/share")))
        .unwrap_or_else(|_| PathBuf::from(".local/share"));
    base.join("jonaylor")
        .join("pi-thread-vault")
        .display()
        .to_string()
}

fn default_client_id() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            let output = Command::new("hostname").output().ok()?;
            let hostname = String::from_utf8(output.stdout).ok()?;
            let hostname = hostname.trim();
            (!hostname.is_empty()).then(|| hostname.to_string())
        })
        .unwrap_or_else(|| "default".to_string())
}

fn default_memory_user_id() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            let output = Command::new("whoami").output().ok()?;
            let username = String::from_utf8(output.stdout).ok()?;
            let username = username.trim();
            (!username.is_empty()).then(|| username.to_string())
        })
        .unwrap_or_else(default_client_id)
}

fn memory_user_id(config: &Config, explicit: Option<String>) -> String {
    explicit
        .or_else(|| std::env::var("JONAYLOR_MEMORY_USER_ID").ok())
        .or_else(|| config.pi_thread_vault_memory_user_id.clone())
        .unwrap_or_else(default_memory_user_id)
}

fn current_thread_context_path() -> Result<PathBuf> {
    if let Ok(path) = std::env::var("JONAYLOR_THREAD_CONTEXT") {
        return Ok(PathBuf::from(path));
    }
    let config = load_config()?;
    let data_dir = config
        .pi_thread_vault_data_dir
        .unwrap_or_else(default_pi_thread_vault_data_dir);
    Ok(PathBuf::from(data_dir).join("current-thread.json"))
}

fn read_current_thread_context() -> Result<Value> {
    let path = current_thread_context_path()?;
    let content = fs::read_to_string(&path).with_context(|| {
        format!(
            "failed to read {}; wait for pi-thread-vault to sync or run /thread-retry-sync",
            path.display()
        )
    })?;
    serde_json::from_str(&content).context("failed to parse current thread context")
}

fn write_current_thread_context(value: &Value) -> Result<()> {
    let path = current_thread_context_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, format!("{}\n", serde_json::to_string_pretty(value)?))?;
    Ok(())
}

fn auth_headers(token: &str) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}"))?,
    );
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/json, text/plain"),
    );
    Ok(headers)
}

async fn browser_login(base_url: &str, client_name: &str) -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").context("failed to bind localhost callback")?;
    listener.set_nonblocking(true)?;
    let callback = format!("http://{}/callback", listener.local_addr()?);
    let login_url = format!(
        "{}/cli-login?callback={}&client_name={}",
        normalize_base_url(base_url),
        urlencoding::encode(&callback),
        urlencoding::encode(client_name),
    );

    println!("Opening browser to authorize jonaylor CLI...");
    println!("If it does not open, visit:\n{login_url}\n");
    open_browser(&login_url);

    let started_at = Instant::now();
    let mut stream = loop {
        match listener.accept() {
            Ok((stream, _)) => break stream,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                if started_at.elapsed() > Duration::from_secs(300) {
                    bail!("timed out waiting for browser login callback");
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(error) => return Err(error).context("failed to accept login callback"),
        }
    };
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;

    let mut buffer = [0u8; 8192];
    let n = stream
        .read(&mut buffer)
        .context("failed to read login callback")?;
    let request = String::from_utf8_lossy(&buffer[..n]);
    let target = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .context("invalid login callback request")?;
    let params = parse_query(target.split_once('?').map_or("", |(_, query)| query));
    let token = params
        .get("token")
        .filter(|value| !value.is_empty())
        .context("login callback did not include a token")?;
    let callback_base_url = params
        .get("base_url")
        .map(String::as_str)
        .unwrap_or(base_url);

    write_config(&config_for_token(callback_base_url, token))?;

    let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<!doctype html><html><body><h1>jonaylor CLI authorized</h1><p>You can close this tab.</p></body></html>";
    let _ = stream.write_all(response.as_bytes());
    println!("Saved credentials to {}", config_path()?.display());
    Ok(())
}

fn open_browser(url: &str) {
    let result = if cfg!(target_os = "macos") {
        Command::new("open").arg(url).status()
    } else if cfg!(target_os = "linux") {
        Command::new("xdg-open").arg(url).status()
    } else {
        return;
    };
    if let Err(error) = result {
        eprintln!("Could not open browser automatically: {error}");
    }
}

fn parse_query(query: &str) -> std::collections::BTreeMap<String, String> {
    let mut out = std::collections::BTreeMap::new();
    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = urlencoding::decode(key).map_or_else(|_| key.to_string(), |value| value.into());
        let value =
            urlencoding::decode(value).map_or_else(|_| value.to_string(), |value| value.into());
        out.insert(key, value);
    }
    out
}

fn configured_token(config: &Config) -> Result<String> {
    config
        .token
        .clone()
        .or_else(|| std::env::var("JONAYLOR_TOKEN").ok())
        .context("no token configured; run `jonaylor auth login --token ...`")
}

async fn issue_token(name: &str) -> Result<()> {
    let name = name.trim();
    if name.is_empty() {
        bail!("client name cannot be empty");
    }

    let configuration = get_configuration().context("Failed to load configuration")?;
    let pool = get_connection_pool(&configuration.database);

    sqlx::query("SELECT 1")
        .execute(&pool)
        .await
        .context("Failed to connect to Postgres — make sure migrations have run")?;

    let key = issue_api_key(&pool, name)
        .await
        .context("Failed to issue API token")?;

    eprintln!("Issued API token for {:?}", key.name);
    eprintln!("  client_id    {}", key.client_id);
    eprintln!("  token_prefix {}", key.token_prefix);
    eprintln!("  created_at   {}", key.created_at);
    eprintln!();
    eprintln!("Copy the token below now — it will not be shown again.");
    eprintln!();
    println!("{}", key.plaintext_token);

    Ok(())
}

fn url(config: &Config, path: &str) -> Result<String> {
    let path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    Ok(format!("{}{}", config.base_url.trim_end_matches('/'), path))
}

async fn response_json(response: reqwest::Response) -> Result<Value> {
    let status = response.status();
    let text = response.text().await?;
    if !status.is_success() {
        bail!("server returned {status}: {text}");
    }
    serde_json::from_str(&text).with_context(|| format!("server returned invalid JSON: {text}"))
}

fn print_memory_matches(value: &Value) {
    let Some(memories) = value.get("memories").and_then(Value::as_array) else {
        println!("No memories found");
        return;
    };
    if memories.is_empty() {
        println!("No memories found");
        return;
    }
    for memory in memories {
        let fact = memory.get("fact").and_then(Value::as_str).unwrap_or("");
        let similarity = memory
            .get("similarity")
            .and_then(Value::as_f64)
            .map(|score| format!(" [{:.0}%]", score * 100.0))
            .unwrap_or_default();
        println!("-{similarity} {fact}");
    }
}

fn print_memories(value: &Value) {
    let Some(memories) = value.get("memories").and_then(Value::as_array) else {
        println!("No memories stored");
        return;
    };
    if memories.is_empty() {
        println!("No memories stored");
        return;
    }
    for memory in memories {
        let fact = memory.get("fact").and_then(Value::as_str).unwrap_or("");
        println!("- {fact}");
    }
}

async fn print_response(response: reqwest::Response) -> Result<()> {
    let status = response.status();
    let text = response.text().await?;
    if !status.is_success() {
        bail!("server returned {status}: {text}");
    }
    print!("{text}");
    if !text.ends_with('\n') {
        println!();
    }
    Ok(())
}

fn read_arg_body(arg: &str) -> Result<String> {
    if arg == "-" {
        read_stdin()
    } else if let Some(path) = arg.strip_prefix('@') {
        fs::read_to_string(path).with_context(|| format!("failed to read {path}"))
    } else {
        Ok(arg.to_string())
    }
}

fn read_stdin() -> Result<String> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    Ok(input)
}

fn pop_subcommand(args: &mut Vec<String>, parent: &str) -> Result<String> {
    if args.is_empty() || flag(args, "--help") || flag(args, "-h") {
        print_help();
        bail!("missing {parent} subcommand");
    }
    Ok(args.remove(0))
}

fn take_positional(args: &mut Vec<String>, name: &str) -> Result<String> {
    let index = args
        .iter()
        .position(|arg| !arg.starts_with('-'))
        .ok_or_else(|| anyhow!("{name} is required"))?;
    Ok(args.remove(index))
}

fn take_option(args: &mut Vec<String>, name: &str) -> Result<Option<String>> {
    let Some(index) = args.iter().position(|arg| arg == name) else {
        return Ok(None);
    };
    args.remove(index);
    if index >= args.len() {
        bail!("{name} requires a value");
    }
    Ok(Some(args.remove(index)))
}

fn take_bool(args: &mut Vec<String>, name: &str) -> bool {
    if let Some(index) = args.iter().position(|arg| arg == name) {
        args.remove(index);
        true
    } else {
        false
    }
}

fn reject_extra(args: &[String]) -> Result<()> {
    if let Some(arg) = args.first() {
        bail!("unexpected argument {arg}");
    }
    Ok(())
}

fn flag(args: &[String], name: &str) -> bool {
    args.iter().any(|arg| arg == name)
}

fn normalize_base_url(url: &str) -> String {
    url.trim_end_matches('/').to_string()
}

fn present(value: Option<&str>) -> &'static str {
    match value {
        Some(value) if !value.is_empty() => "configured",
        _ => "missing",
    }
}

fn print_help() {
    println!(
        r#"jonaylor — CLI for Johannes' Hub

Usage:
  jonaylor login [--base-url https://hub.jonaylor.com] [--client-name NAME]
  jonaylor auth login --base-url https://hub.jonaylor.com --token TOKEN
  jonaylor auth status
  jonaylor auth issue-token --name "descriptive client name"
  jonaylor paste create [--file PATH|-] [--json]
  jonaylor newsletter publish --title TITLE --html-file HTML --text-file TEXT
  jonaylor subscriptions subscribe --email EMAIL [--name NAME]
  jonaylor memory add [--user-id USER] [--file PATH|-] [TEXT] [--json]
  jonaylor memory search [--user-id USER] QUERY [--json]
  jonaylor memory list [--user-id USER] [--json]
  jonaylor vault current-thread [--json]
  jonaylor vault share-thread THREAD_ID [--json]
  jonaylor vault share-current-thread [--json]
  jonaylor github pi-threads-block [--url SHARE_URL] [--label LABEL]
  jonaylor api request METHOD PATH [--body @file|-|literal] [--content-type TYPE] [--no-auth]

Environment fallbacks:
  JONAYLOR_BASE_URL, JONAYLOR_TOKEN, JONAYLOR_CONFIG.
  JONAYLOR_MEMORY_USER_ID overrides the configured memory user.
"#
    );
}
