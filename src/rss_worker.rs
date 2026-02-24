use std::time::Duration;

use askama::Template;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    configuration::Settings,
    email_templates::{BlogPostEmailHtml, BlogPostEmailText},
    startup::get_connection_pool,
};

pub async fn run_rss_worker(configuration: Settings) -> Result<(), anyhow::Error> {
    let pool = get_connection_pool(&configuration.database);
    let rss_config = &configuration.rss_feed;

    if !rss_config.enabled {
        tracing::info!("RSS worker is disabled, sleeping indefinitely");
        loop {
            tokio::time::sleep(Duration::from_secs(3600)).await;
        }
    }

    let http_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;

    tracing::info!(
        feed_url = %rss_config.feed_url,
        poll_interval_secs = rss_config.poll_interval_secs,
        "RSS worker started"
    );

    loop {
        match poll_and_process(&pool, &http_client, &rss_config.feed_url).await {
            Ok(count) => {
                if count > 0 {
                    tracing::info!("Processed {} new RSS entries", count);
                }
            }
            Err(e) => {
                tracing::error!(
                    error.cause_chain = ?e,
                    error.message = %e,
                    "RSS poll failed"
                );
            }
        }

        tokio::time::sleep(Duration::from_secs(rss_config.poll_interval_secs)).await;
    }
}

#[tracing::instrument(skip_all, fields(feed_url = %feed_url))]
async fn poll_and_process(
    pool: &PgPool,
    client: &reqwest::Client,
    feed_url: &str,
) -> Result<usize, anyhow::Error> {
    let response = client.get(feed_url).send().await?.text().await?;
    let channel = response
        .parse::<rss::Channel>()
        .map_err(|e| anyhow::anyhow!("Failed to parse RSS feed: {}", e))?;

    // On first run (empty table), seed all entries without sending emails
    let is_first_run = is_table_empty(pool).await?;
    if is_first_run {
        tracing::info!(
            "First run detected — seeding {} existing entries without sending emails",
            channel.items().len()
        );
    }

    let mut count = 0;
    for item in channel.items() {
        let guid = item
            .guid()
            .map(|g| g.value().to_string())
            .or_else(|| item.link().map(String::from))
            .unwrap_or_default();

        if guid.is_empty() {
            tracing::warn!("Skipping RSS item with no guid or link");
            continue;
        }

        if entry_exists(pool, &guid).await? {
            continue;
        }

        let title = item.title().unwrap_or("New Blog Post");
        let link = item.link().unwrap_or("");
        let description = item.description().unwrap_or("");
        let pub_date = item
            .pub_date()
            .and_then(|d| DateTime::parse_from_rfc2822(d).ok())
            .map(|d| d.with_timezone(&Utc));

        if is_first_run {
            insert_rss_entry(pool, &guid, title, link, pub_date, None).await?;
        } else {
            let issue_id = create_newsletter_from_post(pool, title, description, link).await?;
            insert_rss_entry(pool, &guid, title, link, pub_date, Some(issue_id)).await?;
            tracing::info!(
                title = title,
                url = link,
                newsletter_issue_id = %issue_id,
                "Created newsletter from new blog post"
            );
            count += 1;
        }
    }

    Ok(count)
}

async fn is_table_empty(pool: &PgPool) -> Result<bool, anyhow::Error> {
    let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM rss_feed_entries")
        .fetch_one(pool)
        .await?;
    Ok(row.0 == 0)
}

async fn entry_exists(pool: &PgPool, guid: &str) -> Result<bool, anyhow::Error> {
    let row: (bool,) =
        sqlx::query_as("SELECT EXISTS(SELECT 1 FROM rss_feed_entries WHERE guid = $1)")
            .bind(guid)
            .fetch_one(pool)
            .await?;
    Ok(row.0)
}

async fn insert_rss_entry(
    pool: &PgPool,
    guid: &str,
    title: &str,
    url: &str,
    published_at: Option<DateTime<Utc>>,
    newsletter_issue_id: Option<Uuid>,
) -> Result<(), anyhow::Error> {
    sqlx::query(
        r#"
        INSERT INTO rss_feed_entries (guid, title, url, published_at, newsletter_issue_id)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (guid) DO NOTHING
        "#,
    )
    .bind(guid)
    .bind(title)
    .bind(url)
    .bind(published_at)
    .bind(newsletter_issue_id)
    .execute(pool)
    .await?;
    Ok(())
}

async fn create_newsletter_from_post(
    pool: &PgPool,
    title: &str,
    description: &str,
    post_url: &str,
) -> Result<Uuid, anyhow::Error> {
    let html_template = BlogPostEmailHtml {
        title: title.to_string(),
        description: description.to_string(),
        post_url: post_url.to_string(),
    };
    let text_template = BlogPostEmailText {
        title: title.to_string(),
        description: description.to_string(),
        post_url: post_url.to_string(),
    };

    let html_content = html_template
        .render()
        .expect("Failed to render blog post HTML template");
    let text_content = text_template
        .render()
        .expect("Failed to render blog post text template");

    let newsletter_issue_id = Uuid::new_v4();

    let mut transaction = pool.begin().await?;

    sqlx::query(
        "INSERT INTO newsletter_issues (newsletter_issue_id, title, text_content, html_content, published_at) VALUES ($1, $2, $3, $4, NOW())",
    )
    .bind(newsletter_issue_id)
    .bind(title)
    .bind(&text_content)
    .bind(&html_content)
    .execute(transaction.as_mut())
    .await?;

    sqlx::query(
        "INSERT INTO issue_delivery_queue (newsletter_issue_id, subscriber_email) SELECT $1, email FROM subscriptions WHERE status = 'confirmed'",
    )
    .bind(newsletter_issue_id)
    .execute(transaction.as_mut())
    .await?;

    transaction.commit().await?;

    Ok(newsletter_issue_id)
}
