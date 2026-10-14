use crate::helpers::{TestApp, spawn_app};
use wiremock::matchers::{method, path};
use wiremock::{Mock, ResponseTemplate};

async fn post_download(app: &TestApp, body: serde_json::Value) -> reqwest::Response {
    app.api_client
        .post(format!("{}/api/downloads", app.address))
        .json(&body)
        .send()
        .await
        .expect("Failed to execute request")
}

/// The thank-you email is sent from a spawned task, so wait for it to arrive.
async fn wait_for_emails(app: &TestApp, expected: usize) -> Vec<wiremock::Request> {
    for _ in 0..50 {
        let received = app.email_server.received_requests().await.unwrap();
        if received.len() >= expected {
            return received;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    app.email_server.received_requests().await.unwrap()
}

async fn mount_email_ok(app: &TestApp) {
    Mock::given(path("/email"))
        .and(method("POST"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&app.email_server)
        .await;
}

#[tokio::test]
async fn download_is_recorded_and_thank_you_email_offers_subscription() {
    let app = spawn_app().await;
    mount_email_ok(&app).await;

    let response = post_download(
        &app,
        serde_json::json!({"email": "Ursula@Gmail.com", "app": "parlo"}),
    )
    .await;
    assert_eq!(202, response.status().as_u16());

    let row = sqlx::query!("SELECT email, app FROM downloads")
        .fetch_one(&app.db_pool)
        .await
        .expect("Failed to fetch download");
    assert_eq!(row.email, "ursula@gmail.com");
    assert_eq!(row.app, "parlo");

    let emails = wait_for_emails(&app, 1).await;
    assert_eq!(emails.len(), 1);
    let body: serde_json::Value = serde_json::from_slice(&emails[0].body).unwrap();
    assert_eq!(body["Subject"], "Thanks for downloading Parlo");
    assert!(
        body["TextBody"]
            .as_str()
            .unwrap()
            .contains("consider subscribing")
    );

    // Downloading doesn't subscribe anyone; clicking the link in the email does.
    let status = sqlx::query_scalar!("SELECT status FROM subscriptions")
        .fetch_one(&app.db_pool)
        .await
        .unwrap();
    assert_eq!(status, "pending_confirmation");

    let link = app.get_confirmation_links(&emails[0]).html;
    let response = reqwest::get(link).await.unwrap();
    assert_eq!(200, response.status().as_u16());

    let status = sqlx::query_scalar!("SELECT status FROM subscriptions")
        .fetch_one(&app.db_pool)
        .await
        .unwrap();
    assert_eq!(status, "confirmed");
}

#[tokio::test]
async fn confirmed_subscribers_get_a_thank_you_without_subscribe_prompt() {
    let app = spawn_app().await;
    mount_email_ok(&app).await;

    sqlx::query!(
        "INSERT INTO subscriptions (id, email, subscribed_at, status) VALUES ('8a5bd5a5-6c42-4f8c-9d8a-2f7b1b6f0a11', 'ursula@gmail.com', '2026-01-01T00:00:00+00:00', 'confirmed')"
    )
    .execute(&app.db_pool)
    .await
    .unwrap();

    post_download(
        &app,
        serde_json::json!({"email": "ursula@gmail.com", "app": "paperclock"}),
    )
    .await;

    let emails = wait_for_emails(&app, 1).await;
    assert_eq!(emails.len(), 1);
    let body: serde_json::Value = serde_json::from_slice(&emails[0].body).unwrap();
    assert!(
        !body["TextBody"]
            .as_str()
            .unwrap()
            .contains("consider subscribing")
    );
}

#[tokio::test]
async fn repeat_downloads_are_recorded_but_only_emailed_once() {
    let app = spawn_app().await;
    mount_email_ok(&app).await;

    for _ in 0..3 {
        let response = post_download(
            &app,
            serde_json::json!({"email": "ursula@gmail.com", "app": "saintjohn"}),
        )
        .await;
        assert_eq!(202, response.status().as_u16());
    }

    let count = sqlx::query_scalar!(r#"SELECT COUNT(*) as "count!: i64" FROM downloads"#)
        .fetch_one(&app.db_pool)
        .await
        .unwrap();
    assert_eq!(count, 3);

    let emails = wait_for_emails(&app, 2).await;
    assert_eq!(emails.len(), 1);
}

#[tokio::test]
async fn honeypot_submissions_are_silently_dropped() {
    let app = spawn_app().await;

    let response = post_download(
        &app,
        serde_json::json!({"email": "bot@example.com", "app": "parlo", "website": "spam.example"}),
    )
    .await;
    assert_eq!(202, response.status().as_u16());

    let count = sqlx::query_scalar!(r#"SELECT COUNT(*) as "count!: i64" FROM downloads"#)
        .fetch_one(&app.db_pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn invalid_requests_are_rejected() {
    let app = spawn_app().await;

    let test_cases = vec![
        (
            serde_json::json!({"email": "ursula@gmail.com", "app": "mino"}),
            "unknown app",
        ),
        (
            serde_json::json!({"email": "not-an-email", "app": "parlo"}),
            "invalid email",
        ),
        (
            serde_json::json!({"email": "", "app": "parlo"}),
            "empty email",
        ),
    ];

    for (body, description) in test_cases {
        let response = post_download(&app, body).await;
        assert_eq!(
            400,
            response.status().as_u16(),
            "The API did not return 400 for {description}"
        );
    }
}
