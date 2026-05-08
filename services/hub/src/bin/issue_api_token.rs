use anyhow::{Context, Result, bail};
use hub::configuration::get_configuration;
use hub::startup::get_connection_pool;
use hub::vault::keys::issue_api_key;

#[tokio::main]
async fn main() -> Result<()> {
    let name = parse_name()?;

    let configuration = get_configuration().context("Failed to load configuration")?;
    let pool = get_connection_pool(&configuration.database);

    sqlx::query("SELECT 1")
        .execute(&pool)
        .await
        .context("Failed to connect to Postgres — make sure migrations have run")?;

    let key = issue_api_key(&pool, &name)
        .await
        .context("Failed to issue API key")?;

    eprintln!("Issued API key for {:?}", key.name);
    eprintln!("  client_id    {}", key.client_id);
    eprintln!("  token_prefix {}", key.token_prefix);
    eprintln!("  created_at   {}", key.created_at);
    eprintln!();
    eprintln!("Copy the token below now — it will not be shown again.");
    eprintln!();
    // The plaintext token goes to stdout so it can be piped to a clipboard / file
    // without capturing the surrounding metadata noise.
    println!("{}", key.plaintext_token);

    Ok(())
}

fn parse_name() -> Result<String> {
    let mut args = std::env::args().skip(1);
    let mut name: Option<String> = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" | "-h" => {
                print_help();
                std::process::exit(0);
            }
            "--name" => {
                name = Some(args.next().context("--name requires a value")?);
            }
            other if name.is_none() && !other.starts_with('-') => {
                name = Some(other.to_string());
            }
            other => bail!("unexpected argument {other}"),
        }
    }
    let name = name.context("a client name is required (--name \"Pi extension on laptop\")")?;
    let trimmed = name.trim();
    if trimmed.is_empty() {
        bail!("client name cannot be empty");
    }
    Ok(trimmed.to_string())
}

fn print_help() {
    println!(
        "Mint a new pi-thread-vault API key and persist its hash in vault_clients.\n\n\
         Usage:\n  cargo run --bin issue_api_token -- [--name] \"<descriptive client name>\"\n\n\
         The plaintext token is printed to stdout once. Only its SHA-256 hash is\n\
         stored in the database, so a lost token cannot be recovered — revoke and\n\
         issue a new one if you need to rotate.\n\n\
         Database connection comes from the standard hub configuration\n\
         (configuration/*.yaml + APP_DATABASE__* env overrides)."
    );
}
