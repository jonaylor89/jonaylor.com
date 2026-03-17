use chrono::Utc;
use email_newsletter::issue_delivery_queue::{ExecutionOutcome, try_execute_tasks};
use email_newsletter::routes::generate_unsubscribe_url;
use sqlx::{PgPool, Row};
use uuid::Uuid;
use wiremock::matchers::{method, path};
use wiremock::{Match, Mock, Request, ResponseTemplate};

use crate::helpers::spawn_queue_worker_app;

#[derive(Debug)]
struct QueueEntry {
    attempt_count: i32,
    last_attempted_at: Option<chrono::DateTime<Utc>>,
    error_message: Option<String>,
}

#[derive(Debug)]
struct DeadLetterEntry {
    attempt_count: i32,
    last_error: String,
    failed_at: chrono::DateTime<Utc>,
}

struct RecipientMatcher {
    recipient: String,
}

impl Match for RecipientMatcher {
    fn matches(&self, request: &Request) -> bool {
        let Ok(body) = serde_json::from_slice::<serde_json::Value>(&request.body) else {
            return false;
        };

        body.get("To").and_then(|value| value.as_str()) == Some(self.recipient.as_str())
    }
}

#[tokio::test]
async fn try_execute_tasks_returns_empty_queue_when_there_is_nothing_to_process() {
    let app = spawn_queue_worker_app().await;

    let outcome = try_execute_tasks(
        &app.db_pool,
        &app.email_client,
        &app.hmac_secret,
        &app.base_url,
    )
    .await
    .unwrap();

    assert!(matches!(outcome, ExecutionOutcome::EmptyQueue));
    assert!(
        app.email_server
            .received_requests()
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn try_execute_tasks_sends_all_queued_emails_and_removes_them_from_the_queue() {
    let app = spawn_queue_worker_app().await;
    let recipients = ["alice@example.com", "bob@example.com", "carol@example.com"];

    let issue_id = create_issue(
        &app.db_pool,
        "Weekly digest",
        "Plain body",
        "<p>HTML body</p>",
    )
    .await;
    for recipient in recipients {
        enqueue_task(&app.db_pool, issue_id, recipient, 0, None, None).await;
    }

    Mock::given(path("/email"))
        .and(method("POST"))
        .respond_with(ResponseTemplate::new(200))
        .expect(recipients.len() as u64)
        .mount(&app.email_server)
        .await;

    let outcome = try_execute_tasks(
        &app.db_pool,
        &app.email_client,
        &app.hmac_secret,
        &app.base_url,
    )
    .await
    .unwrap();

    assert!(matches!(outcome, ExecutionOutcome::TaskCompleted));
    assert_eq!(queue_len(&app.db_pool).await, 0);

    let requests = app.email_server.received_requests().await.unwrap();
    assert_eq!(requests.len(), recipients.len());

    let expected_unsubscribe_url =
        generate_unsubscribe_url(&app.base_url, recipients[0], &app.hmac_secret);
    let first_request_body: serde_json::Value =
        serde_json::from_slice(&requests[0].body).expect("email request body should be valid JSON");

    assert_eq!(first_request_body["Subject"], "Weekly digest");
    assert_eq!(first_request_body["To"], recipients[0]);
    assert!(
        first_request_body["HtmlBody"]
            .as_str()
            .unwrap()
            .contains("<p>HTML body</p>")
    );
    assert!(
        first_request_body["HtmlBody"]
            .as_str()
            .unwrap()
            .contains(&expected_unsubscribe_url)
    );
    assert_eq!(
        first_request_body["TextBody"].as_str().unwrap(),
        format!("Plain body\n\n---\nUnsubscribe: {expected_unsubscribe_url}")
    );
    assert_eq!(
        header_value(&first_request_body, "List-Unsubscribe"),
        Some(expected_unsubscribe_url.as_str())
    );
    assert_eq!(
        header_value(&first_request_body, "List-Unsubscribe-Post"),
        Some("List-Unsubscribe=One-Click")
    );
}

#[tokio::test]
async fn try_execute_tasks_keeps_retryable_failures_in_the_queue_and_tracks_the_attempt() {
    let app = spawn_queue_worker_app().await;
    let email = "retry-me@example.com";
    let issue_id = create_issue(&app.db_pool, "Retry me", "Body", "<p>Body</p>").await;
    enqueue_task(&app.db_pool, issue_id, email, 0, None, None).await;

    Mock::given(path("/email"))
        .and(method("POST"))
        .respond_with(ResponseTemplate::new(500))
        .expect(1)
        .mount(&app.email_server)
        .await;

    let outcome = try_execute_tasks(
        &app.db_pool,
        &app.email_client,
        &app.hmac_secret,
        &app.base_url,
    )
    .await
    .unwrap();

    assert!(matches!(outcome, ExecutionOutcome::TaskCompleted));

    let queue_entry = get_queue_entry(&app.db_pool, issue_id, email)
        .await
        .expect("queue entry should still exist after a retryable failure");
    assert_eq!(queue_entry.attempt_count, 1);
    assert!(queue_entry.last_attempted_at.is_some());
    assert!(
        queue_entry
            .error_message
            .as_deref()
            .unwrap()
            .contains("500 Internal Server Error")
    );
    assert!(
        get_dead_letter_entry(&app.db_pool, issue_id, email)
            .await
            .is_none()
    );
}

#[tokio::test]
async fn try_execute_tasks_respects_backoff_and_skips_recent_failures() {
    let app = spawn_queue_worker_app().await;
    let email = "backoff@example.com";
    let issue_id = create_issue(&app.db_pool, "Backoff", "Body", "<p>Body</p>").await;
    let last_attempted_at = Utc::now();
    enqueue_task(
        &app.db_pool,
        issue_id,
        email,
        1,
        Some(last_attempted_at),
        Some("previous failure"),
    )
    .await;

    Mock::given(path("/email"))
        .and(method("POST"))
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(&app.email_server)
        .await;

    let outcome = try_execute_tasks(
        &app.db_pool,
        &app.email_client,
        &app.hmac_secret,
        &app.base_url,
    )
    .await
    .unwrap();

    assert!(matches!(outcome, ExecutionOutcome::TaskCompleted));

    let queue_entry = get_queue_entry(&app.db_pool, issue_id, email)
        .await
        .expect("queue entry should remain in the queue while backoff is active");
    assert_eq!(queue_entry.attempt_count, 1);
    assert_eq!(
        queue_entry.error_message.as_deref(),
        Some("previous failure")
    );
    assert!(queue_entry.last_attempted_at.is_some());
    assert!(
        get_dead_letter_entry(&app.db_pool, issue_id, email)
            .await
            .is_none()
    );
}

#[tokio::test]
async fn try_execute_tasks_moves_a_task_to_the_dead_letter_queue_after_the_final_retry() {
    let app = spawn_queue_worker_app().await;
    let email = "give-up@example.com";
    let issue_id = create_issue(&app.db_pool, "Exhaust retries", "Body", "<p>Body</p>").await;
    enqueue_task(
        &app.db_pool,
        issue_id,
        email,
        4,
        Some(Utc::now() - chrono::Duration::days(1)),
        Some("previous failure"),
    )
    .await;

    Mock::given(path("/email"))
        .and(method("POST"))
        .respond_with(ResponseTemplate::new(500))
        .expect(1)
        .mount(&app.email_server)
        .await;

    let outcome = try_execute_tasks(
        &app.db_pool,
        &app.email_client,
        &app.hmac_secret,
        &app.base_url,
    )
    .await
    .unwrap();

    assert!(matches!(outcome, ExecutionOutcome::TaskCompleted));
    assert!(
        get_queue_entry(&app.db_pool, issue_id, email)
            .await
            .is_none()
    );

    let dead_letter = get_dead_letter_entry(&app.db_pool, issue_id, email)
        .await
        .expect("task should be moved to the dead letter queue");
    assert_eq!(dead_letter.attempt_count, 5);
    assert!(dead_letter.last_error.contains("500 Internal Server Error"));
    assert!(dead_letter.failed_at <= Utc::now());
}

#[tokio::test]
async fn try_execute_tasks_moves_invalid_emails_to_the_dead_letter_queue_without_retrying() {
    let app = spawn_queue_worker_app().await;
    let email = "not-an-email";
    let issue_id = create_issue(&app.db_pool, "Invalid email", "Body", "<p>Body</p>").await;
    enqueue_task(&app.db_pool, issue_id, email, 0, None, None).await;

    Mock::given(path("/email"))
        .and(method("POST"))
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(&app.email_server)
        .await;

    let outcome = try_execute_tasks(
        &app.db_pool,
        &app.email_client,
        &app.hmac_secret,
        &app.base_url,
    )
    .await
    .unwrap();

    assert!(matches!(outcome, ExecutionOutcome::TaskCompleted));
    assert!(
        get_queue_entry(&app.db_pool, issue_id, email)
            .await
            .is_none()
    );

    let dead_letter = get_dead_letter_entry(&app.db_pool, issue_id, email)
        .await
        .expect("invalid emails should be dead-lettered immediately");
    assert_eq!(dead_letter.attempt_count, 0);
    assert!(
        dead_letter
            .last_error
            .contains("not-an-email is not a valid subscriber email")
    );
}

#[tokio::test]
async fn try_execute_tasks_continues_processing_other_tasks_when_one_delivery_fails() {
    let app = spawn_queue_worker_app().await;
    let success_email = "ok@example.com";
    let failing_email = "fail@example.com";

    let issue_id = create_issue(&app.db_pool, "Mixed batch", "Body", "<p>Body</p>").await;
    enqueue_task(&app.db_pool, issue_id, success_email, 0, None, None).await;
    enqueue_task(&app.db_pool, issue_id, failing_email, 0, None, None).await;

    Mock::given(path("/email"))
        .and(method("POST"))
        .and(RecipientMatcher {
            recipient: success_email.to_string(),
        })
        .respond_with(ResponseTemplate::new(200))
        .expect(1)
        .mount(&app.email_server)
        .await;

    Mock::given(path("/email"))
        .and(method("POST"))
        .and(RecipientMatcher {
            recipient: failing_email.to_string(),
        })
        .respond_with(ResponseTemplate::new(500))
        .expect(1)
        .mount(&app.email_server)
        .await;

    let outcome = try_execute_tasks(
        &app.db_pool,
        &app.email_client,
        &app.hmac_secret,
        &app.base_url,
    )
    .await
    .unwrap();

    assert!(matches!(outcome, ExecutionOutcome::TaskCompleted));
    assert!(
        get_queue_entry(&app.db_pool, issue_id, success_email)
            .await
            .is_none()
    );

    let failing_entry = get_queue_entry(&app.db_pool, issue_id, failing_email)
        .await
        .expect("the failing task should stay queued for a retry");
    assert_eq!(failing_entry.attempt_count, 1);
    assert!(failing_entry.last_attempted_at.is_some());
    assert!(
        failing_entry
            .error_message
            .as_deref()
            .unwrap()
            .contains("500 Internal Server Error")
    );
}

async fn create_issue(pool: &PgPool, title: &str, text_content: &str, html_content: &str) -> Uuid {
    let issue_id = Uuid::new_v4();

    sqlx::query(
        "INSERT INTO newsletter_issues (newsletter_issue_id, title, text_content, html_content, published_at)
         VALUES ($1, $2, $3, $4, NOW())",
    )
    .bind(issue_id)
    .bind(title)
    .bind(text_content)
    .bind(html_content)
    .execute(pool)
    .await
    .unwrap();

    issue_id
}

async fn enqueue_task(
    pool: &PgPool,
    issue_id: Uuid,
    subscriber_email: &str,
    attempt_count: i32,
    last_attempted_at: Option<chrono::DateTime<Utc>>,
    error_message: Option<&str>,
) {
    sqlx::query(
        "INSERT INTO issue_delivery_queue (
            newsletter_issue_id,
            subscriber_email,
            attempt_count,
            last_attempted_at,
            error_message
        )
        VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(issue_id)
    .bind(subscriber_email)
    .bind(attempt_count)
    .bind(last_attempted_at)
    .bind(error_message)
    .execute(pool)
    .await
    .unwrap();
}

async fn get_queue_entry(pool: &PgPool, issue_id: Uuid, email: &str) -> Option<QueueEntry> {
    let row = sqlx::query(
        "SELECT attempt_count, last_attempted_at, error_message
         FROM issue_delivery_queue
         WHERE newsletter_issue_id = $1 AND subscriber_email = $2",
    )
    .bind(issue_id)
    .bind(email)
    .fetch_optional(pool)
    .await
    .unwrap()?;

    Some(QueueEntry {
        attempt_count: row.get("attempt_count"),
        last_attempted_at: row.get("last_attempted_at"),
        error_message: row.get("error_message"),
    })
}

async fn get_dead_letter_entry(
    pool: &PgPool,
    issue_id: Uuid,
    email: &str,
) -> Option<DeadLetterEntry> {
    let row = sqlx::query(
        "SELECT attempt_count, last_error, failed_at
         FROM dead_letter_queue
         WHERE newsletter_issue_id = $1 AND subscriber_email = $2",
    )
    .bind(issue_id)
    .bind(email)
    .fetch_optional(pool)
    .await
    .unwrap()?;

    Some(DeadLetterEntry {
        attempt_count: row.get("attempt_count"),
        last_error: row.get("last_error"),
        failed_at: row.get("failed_at"),
    })
}

async fn queue_len(pool: &PgPool) -> i64 {
    sqlx::query("SELECT COUNT(*) AS count FROM issue_delivery_queue")
        .fetch_one(pool)
        .await
        .unwrap()
        .get("count")
}

fn header_value<'a>(body: &'a serde_json::Value, header_name: &str) -> Option<&'a str> {
    body.get("Headers")
        .and_then(|headers| headers.as_array())
        .and_then(|headers| {
            headers.iter().find_map(|header| {
                let name = header.get("Name")?.as_str()?;
                let value = header.get("Value")?.as_str()?;
                (name == header_name).then_some(value)
            })
        })
}
