use std::time::Duration;

use crate::configuration::Settings;
use crate::startup::get_connection_pool;

/// Deletes expired aliases until the process is shut down.
pub async fn run_alias_cleanup_until_stopped(configuration: Settings) -> Result<(), anyhow::Error> {
    let pool = get_connection_pool(&configuration.database).await;
    let interval = Duration::from_secs(configuration.aliases.cleanup_interval_secs);

    tracing::info!("Alias cleanup worker started");
    loop {
        match crate::alias::delete_expired_aliases(&pool).await {
            Ok(deleted) => {
                if deleted > 0 {
                    tracing::info!(deleted, "Deleted expired aliases");
                }
            }
            Err(e) => {
                tracing::error!(
                    error.cause_chain = ?e,
                    error.message = %e,
                    "Failed to delete expired aliases",
                );
            }
        }
        tokio::time::sleep(interval).await;
    }
}
