//! Per-alias inbound webhooks: a forwarded mail is POSTed, parsed, to the
//! alias's `webhook_url` with the same durable retry semantics as the outbox.

use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;

use crate::harness::spawn_app_with_smtp;
use weiterleitung::alias::insert_alias;
use weiterleitung::delivery::list_recent;
use weiterleitung::domain::EmailAddress;
use weiterleitung::mailbox::insert_mailbox;
use weiterleitung::webhook::drain_webhooks;

struct Recorded {
    body: String,
    content_type: Option<String>,
}

type Recordings = Arc<Mutex<Vec<Recorded>>>;

async fn record_ok(
    State(recordings): State<Recordings>,
    headers: HeaderMap,
    body: String,
) -> StatusCode {
    recordings.lock().unwrap().push(Recorded {
        body,
        content_type: headers
            .get(axum::http::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string),
    });
    StatusCode::OK
}

async fn record_fail() -> StatusCode {
    StatusCode::INTERNAL_SERVER_ERROR
}

/// A throwaway HTTP endpoint that remembers what was POSTed to `/hook`.
async fn start_sink() -> (String, Recordings) {
    let recordings: Recordings = Arc::new(Mutex::new(Vec::new()));
    let app = Router::new()
        .route("/hook", post(record_ok))
        .with_state(recordings.clone());
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("Failed to bind the webhook sink");
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://127.0.0.1:{port}/hook"), recordings)
}

#[tokio::test]
async fn a_forwarded_mail_is_posted_to_the_alias_webhook() {
    let app = spawn_app_with_smtp(|_| {}).await;
    let (hook_url, recordings) = start_sink().await;
    let mailbox = insert_mailbox(
        &app.pool,
        &EmailAddress::parse("me@personal.example").unwrap(),
        true,
    )
    .await
    .unwrap();
    let alias_address = EmailAddress::parse("shop.1a2b@example.com").unwrap();
    insert_alias(
        &app.pool,
        &alias_address,
        &mailbox.mailbox_id,
        None,
        None,
        Some(hook_url),
    )
    .await
    .unwrap();

    let reply = app
        .smtp()
        .await
        .send_mail(
            "support@shop.example",
            "shop.1a2b@example.com",
            "From: Shop Support <support@shop.example>\n\
             To: shop.1a2b@example.com\n\
             Subject: Your order\n\
             Message-ID: <abc@shop.example>\n\
             \n\
             It shipped.\n",
        )
        .await;
    assert!(reply.starts_with("250"), "The mail was refused: {reply}");

    let client = reqwest::Client::new();
    let drained = drain_webhooks(&app.pool, &client, 8).await.unwrap();
    assert_eq!(drained, 1);

    let payload: serde_json::Value = {
        let received = recordings.lock().unwrap();
        assert_eq!(received.len(), 1);
        assert!(
            received[0]
                .content_type
                .as_deref()
                .is_some_and(|value| value.starts_with("application/json"))
        );
        serde_json::from_str(&received[0].body).unwrap()
    };
    assert_eq!(payload["alias"], "shop.1a2b@example.com");
    assert_eq!(payload["from"]["address"], "support@shop.example");
    assert_eq!(payload["from"]["name"], "Shop Support");
    assert_eq!(payload["subject"], "Your order");
    assert_eq!(payload["message_id"], "abc@shop.example");
    assert!(
        payload["text"]
            .as_str()
            .is_some_and(|text| text.contains("It shipped."))
    );
    assert!(
        payload["received_at"]
            .as_str()
            .is_some_and(|t| !t.is_empty())
    );

    let (status,): (String,) = sqlx::query_as("SELECT status FROM webhook_deliveries LIMIT 1")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(status, "delivered");
}

#[tokio::test]
async fn a_failing_endpoint_keeps_the_delivery_pending() {
    let app = spawn_app_with_smtp(|_| {}).await;
    let sink = Router::new().route("/hook", post(record_fail));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, sink).await.unwrap() });
    let hook_url = format!("http://127.0.0.1:{port}/hook");

    let mailbox = insert_mailbox(
        &app.pool,
        &EmailAddress::parse("me@personal.example").unwrap(),
        true,
    )
    .await
    .unwrap();
    let alias_address = EmailAddress::parse("flaky@example.com").unwrap();
    insert_alias(
        &app.pool,
        &alias_address,
        &mailbox.mailbox_id,
        None,
        None,
        Some(hook_url),
    )
    .await
    .unwrap();

    let reply = app
        .smtp()
        .await
        .send_mail(
            "support@shop.example",
            "flaky@example.com",
            "From: support@shop.example\nSubject: Hi\n\nHello\n",
        )
        .await;
    assert!(reply.starts_with("250"), "The mail was refused: {reply}");

    let client = reqwest::Client::new();
    drain_webhooks(&app.pool, &client, 8).await.unwrap();

    let (status, attempts, last_error): (String, i64, Option<String>) =
        sqlx::query_as("SELECT status, attempts, last_error FROM webhook_deliveries LIMIT 1")
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert_eq!(status, "pending");
    assert_eq!(attempts, 1);
    assert!(last_error.is_some());
}

#[tokio::test]
async fn an_alias_without_a_webhook_still_forwards() {
    let app = spawn_app_with_smtp(|_| {}).await;
    let mailbox = insert_mailbox(
        &app.pool,
        &EmailAddress::parse("me@personal.example").unwrap(),
        true,
    )
    .await
    .unwrap();
    let alias_address = EmailAddress::parse("plain@example.com").unwrap();
    insert_alias(
        &app.pool,
        &alias_address,
        &mailbox.mailbox_id,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    let reply = app
        .smtp()
        .await
        .send_mail(
            "support@shop.example",
            "plain@example.com",
            "From: support@shop.example\nSubject: Hi\n\nHello\n",
        )
        .await;
    assert!(reply.starts_with("250"), "The mail was refused: {reply}");
    assert_eq!(list_recent(&app.pool, 10).await.unwrap().len(), 1);

    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM webhook_deliveries")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn replies_through_a_reverse_alias_do_not_fire_the_webhook() {
    let app = spawn_app_with_smtp(|_| {}).await;
    let (hook_url, recordings) = start_sink().await;
    let mailbox = insert_mailbox(
        &app.pool,
        &EmailAddress::parse("me@personal.example").unwrap(),
        true,
    )
    .await
    .unwrap();
    let alias_address = EmailAddress::parse("shop.9z8y@example.com").unwrap();
    insert_alias(
        &app.pool,
        &alias_address,
        &mailbox.mailbox_id,
        None,
        None,
        Some(hook_url),
    )
    .await
    .unwrap();

    // The forward creates the contact and its reverse alias.
    let reply = app
        .smtp()
        .await
        .send_mail(
            "support@shop.example",
            "shop.9z8y@example.com",
            "From: support@shop.example\nSubject: Hi\n\nHello\n",
        )
        .await;
    assert!(reply.starts_with("250"), "The mail was refused: {reply}");
    let reverse_alias = list_recent(&app.pool, 1).await.unwrap()[0]
        .envelope_from
        .clone();

    let reply = app
        .smtp()
        .await
        .send_mail(
            "me@personal.example",
            &reverse_alias,
            "From: me@personal.example\nSubject: Re: Hi\n\nThanks\n",
        )
        .await;
    assert!(reply.starts_with("250"), "The reply was refused: {reply}");

    // Only the forward queued a webhook delivery; the reply did not.
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM webhook_deliveries")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    assert!(recordings.lock().unwrap().is_empty());
}
