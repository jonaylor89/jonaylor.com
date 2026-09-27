use anyhow::Context;
use sqlx::SqlitePool;
use std::time::Duration;

use crate::configuration::Settings;
use crate::startup::get_connection_pool;
use crate::webhook::queue::{self, QueuedDelivery};

const BATCH_SIZE: i64 = 10;

/// POSTs queued webhook deliveries until the process is shut down.
pub async fn run_webhook_worker_until_stopped(
    configuration: Settings,
) -> Result<(), anyhow::Error> {
    let pool = get_connection_pool(&configuration.database).await;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(configuration.webhooks.timeout_secs))
        .build()
        .context("Failed to build the webhook HTTP client")?;
    let poll_interval = Duration::from_secs(configuration.webhooks.poll_interval_secs);
    let max_attempts = configuration.webhooks.max_attempts;

    let requeued = queue::requeue_interrupted(&pool).await?;
    if requeued > 0 {
        tracing::warn!(
            requeued,
            "Requeued webhook deliveries left mid-flight by a previous run"
        );
    }

    tracing::info!("Webhook worker started");
    loop {
        match drain_webhooks(&pool, &client, max_attempts).await {
            Ok(0) | Err(_) => tokio::time::sleep(poll_interval).await,
            Ok(_) => {}
        }
    }
}

/// Delivers every webhook that is due right now and reports how many were
/// claimed. Callers that need a single pass (tests, one-shot runs) use this
/// instead of the polling loop.
#[tracing::instrument(name = "Drain webhook deliveries", skip(pool, client))]
pub async fn drain_webhooks(
    pool: &SqlitePool,
    client: &reqwest::Client,
    max_attempts: i64,
) -> Result<usize, anyhow::Error> {
    let deliveries = queue::claim_due(pool, BATCH_SIZE).await?;
    let claimed = deliveries.len();

    for delivery in deliveries {
        if let Err(e) = deliver(pool, client, &delivery, max_attempts).await {
            tracing::error!(
                error.cause_chain = ?e,
                error.message = %e,
                delivery_id = %delivery.delivery_id,
                "Failed to process a queued webhook delivery",
            );
        }
    }

    Ok(claimed)
}

#[tracing::instrument(
    name = "Deliver webhook",
    skip(pool, client, delivery),
    fields(delivery_id = %delivery.delivery_id, url = %delivery.url)
)]
async fn deliver(
    pool: &SqlitePool,
    client: &reqwest::Client,
    delivery: &QueuedDelivery,
    max_attempts: i64,
) -> Result<(), anyhow::Error> {
    // The stored document round-trips through `Value` so the body the endpoint
    // receives is byte-identical to what was queued.
    let payload = serde_json::from_str::<serde_json::Value>(&delivery.payload)
        .context("Failed to parse the stored webhook payload")?;

    match client.post(&delivery.url).json(&payload).send().await {
        Ok(response) if response.status().is_success() => {
            queue::mark_delivered(pool, &delivery.delivery_id).await?;
            tracing::info!("Webhook delivered");
        }
        Ok(response) => {
            let error = format!("The endpoint answered {}", response.status());
            queue::mark_attempt_failed(
                pool,
                &delivery.delivery_id,
                delivery.attempts,
                max_attempts,
                &error,
            )
            .await?;
            tracing::warn!(error = %error, "Webhook delivery attempt failed");
        }
        Err(e) => {
            queue::mark_attempt_failed(
                pool,
                &delivery.delivery_id,
                delivery.attempts,
                max_attempts,
                &e.to_string(),
            )
            .await?;
            tracing::warn!(error = %e, "Webhook delivery attempt failed");
        }
    }

    Ok(())
}
