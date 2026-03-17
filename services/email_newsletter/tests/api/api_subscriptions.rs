use crate::helpers::spawn_app;
use wiremock::matchers::{method, path};
use wiremock::{Mock, ResponseTemplate};

#[tokio::test]
async fn api_subscribe_returns_200_for_valid_json() {
    let app = spawn_app().await;

    Mock::given(path("/email"))
        .and(method("POST"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&app.email_server)
        .await;

    let response = app
        .api_client
        .post(&format!("{}/api/subscriptions", &app.address))
        .json(&serde_json::json!({
            "name": "le guin",
            "email": "ursula@gmail.com"
        }))
        .send()
        .await
        .expect("Failed to execute request");

    assert_eq!(200, response.status().as_u16());

    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["status"], "confirmation_sent");
}

#[tokio::test]
async fn api_subscribe_returns_400_for_invalid_data() {
    let app = spawn_app().await;

    let test_cases = vec![
        (
            serde_json::json!({"name": "Ursula", "email": ""}),
            "empty email",
        ),
        (
            serde_json::json!({"name": "Ursula", "email": "not-an-email"}),
            "invalid email",
        ),
    ];

    for (body, description) in test_cases {
        let response = app
            .api_client
            .post(&format!("{}/api/subscriptions", &app.address))
            .json(&body)
            .send()
            .await
            .expect("Failed to execute request");

        assert_eq!(
            400,
            response.status().as_u16(),
            "The API did not return 400 when the payload was {}",
            description,
        );
    }
}

#[tokio::test]
async fn api_subscribe_accepts_missing_or_empty_name() {
    let app = spawn_app().await;

    let test_cases = vec![
        (
            serde_json::json!({"email": "ursula@gmail.com"}),
            "missing name",
        ),
        (
            serde_json::json!({"name": "", "email": "ursula@gmail.com"}),
            "empty name",
        ),
    ];

    for (body, description) in test_cases {
        let _mock_guard = Mock::given(path("/email"))
            .and(method("POST"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount_as_scoped(&app.email_server)
            .await;

        let response = app
            .api_client
            .post(&format!("{}/api/subscriptions", &app.address))
            .json(&body)
            .send()
            .await
            .expect("Failed to execute request");

        assert_eq!(
            200,
            response.status().as_u16(),
            "The API did not accept a payload with {}",
            description,
        );
    }
}

#[tokio::test]
async fn api_subscribe_returns_422_for_missing_fields() {
    let app = spawn_app().await;

    let response = app
        .api_client
        .post(&format!("{}/api/subscriptions", &app.address))
        .json(&serde_json::json!({"name": "le guin"}))
        .send()
        .await
        .expect("Failed to execute request");

    assert_eq!(422, response.status().as_u16());
}

#[tokio::test]
async fn api_subscribe_persists_subscriber() {
    let app = spawn_app().await;

    Mock::given(path("/email"))
        .and(method("POST"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&app.email_server)
        .await;

    app.api_client
        .post(&format!("{}/api/subscriptions", &app.address))
        .json(&serde_json::json!({
            "name": "le guin",
            "email": "ursula@gmail.com"
        }))
        .send()
        .await
        .expect("Failed to execute request");

    let saved = sqlx::query!("SELECT email, name, status FROM subscriptions")
        .fetch_one(&app.db_pool)
        .await
        .expect("Failed to fetch saved subscription");

    assert_eq!(saved.email, "ursula@gmail.com");
    assert_eq!(saved.name.as_deref(), Some("le guin"));
    assert_eq!(saved.status, "pending_confirmation");
}

#[tokio::test]
async fn api_subscribe_sends_confirmation_email() {
    let app = spawn_app().await;

    Mock::given(path("/email"))
        .and(method("POST"))
        .respond_with(ResponseTemplate::new(200))
        .expect(1)
        .mount(&app.email_server)
        .await;

    app.api_client
        .post(&format!("{}/api/subscriptions", &app.address))
        .json(&serde_json::json!({
            "name": "le guin",
            "email": "ursula@gmail.com"
        }))
        .send()
        .await
        .expect("Failed to execute request");
}
