use anyhow::Context;
use axum::extract::State;
use axum::response::Json;
use sqlx::PgPool;

use crate::authentication::AuthenticatedUser;
use crate::utils::e500;

#[derive(serde::Serialize)]
pub struct StatsResponse {
    subscribers: SubscriberStats,
    delivery_queue: DeliveryQueueStats,
    dead_letter_queue: i64,
    newsletters_sent: i64,
}

#[derive(serde::Serialize)]
pub struct SubscriberStats {
    total: i64,
    confirmed: i64,
    pending: i64,
}

#[derive(serde::Serialize)]
pub struct DeliveryQueueStats {
    pending: i64,
    retrying: i64,
}

#[tracing::instrument(name = "Get admin stats", skip_all)]
pub async fn admin_stats(
    _user: AuthenticatedUser,
    State(pool): State<PgPool>,
) -> Result<Json<StatsResponse>, crate::utils::AppError> {
    let total_subscribers =
        sqlx::query_scalar!(r#"SELECT COUNT(*) as "count!" FROM subscriptions"#)
            .fetch_one(&pool)
            .await
            .context("Failed to count subscribers")
            .map_err(e500)?;

    let confirmed_subscribers = sqlx::query_scalar!(
        r#"SELECT COUNT(*) as "count!" FROM subscriptions WHERE status = 'confirmed'"#
    )
    .fetch_one(&pool)
    .await
    .context("Failed to count confirmed subscribers")
    .map_err(e500)?;

    let pending_subscribers = sqlx::query_scalar!(
        r#"SELECT COUNT(*) as "count!" FROM subscriptions WHERE status = 'pending_confirmation'"#
    )
    .fetch_one(&pool)
    .await
    .context("Failed to count pending subscribers")
    .map_err(e500)?;

    let queue_pending = sqlx::query_scalar!(
        r#"SELECT COUNT(*) as "count!" FROM issue_delivery_queue WHERE attempt_count = 0"#
    )
    .fetch_one(&pool)
    .await
    .context("Failed to count pending deliveries")
    .map_err(e500)?;

    let queue_retrying = sqlx::query_scalar!(
        r#"SELECT COUNT(*) as "count!" FROM issue_delivery_queue WHERE attempt_count > 0"#
    )
    .fetch_one(&pool)
    .await
    .context("Failed to count retrying deliveries")
    .map_err(e500)?;

    let dead_letters = sqlx::query_scalar!(r#"SELECT COUNT(*) as "count!" FROM dead_letter_queue"#)
        .fetch_one(&pool)
        .await
        .context("Failed to count dead letters")
        .map_err(e500)?;

    let newsletters_sent =
        sqlx::query_scalar!(r#"SELECT COUNT(*) as "count!" FROM newsletter_issues"#)
            .fetch_one(&pool)
            .await
            .context("Failed to count newsletters")
            .map_err(e500)?;

    Ok(Json(StatsResponse {
        subscribers: SubscriberStats {
            total: total_subscribers,
            confirmed: confirmed_subscribers,
            pending: pending_subscribers,
        },
        delivery_queue: DeliveryQueueStats {
            pending: queue_pending,
            retrying: queue_retrying,
        },
        dead_letter_queue: dead_letters,
        newsletters_sent,
    }))
}
