//! The machine-facing JSON API: Bearer-token auth and the mailbox/alias CRUD.

use crate::harness::{TestApp, spawn_app};

const API_KEY: &str = "test-api-key";

fn url(app: &TestApp, path: &str) -> String {
    format!("{}/api{path}", app.address)
}

#[tokio::test]
async fn the_api_rejects_requests_without_a_valid_token() {
    let app = spawn_app().await;
    let client = TestApp::client();

    let response = client
        .get(url(&app, "/aliases"))
        .send()
        .await
        .expect("Failed to execute the request");
    assert_eq!(response.status().as_u16(), 401);
    let body: serde_json::Value = response
        .json()
        .await
        .expect("Failed to decode the error body");
    assert_eq!(body["error"], "unauthorized");

    let response = client
        .get(url(&app, "/aliases"))
        .bearer_auth("wrong-key")
        .send()
        .await
        .expect("Failed to execute the request");
    assert_eq!(response.status().as_u16(), 401);
}

#[tokio::test]
async fn mailboxes_can_be_created_listed_and_deleted() {
    let app = spawn_app().await;
    let client = TestApp::client();

    let response = client
        .post(url(&app, "/mailboxes"))
        .bearer_auth(API_KEY)
        .json(&serde_json::json!({"email": "Real.Inbox@Example.org", "is_default": true}))
        .send()
        .await
        .expect("Failed to execute the request");
    assert_eq!(response.status().as_u16(), 201);
    let created: serde_json::Value = response.json().await.expect("Failed to decode the mailbox");
    assert_eq!(created["email"], "real.inbox@example.org");
    assert_eq!(created["is_default"], true);
    assert!(created["created_at"].is_string());
    let mailbox_id = created["mailbox_id"].as_str().unwrap().to_string();

    let response = client
        .get(url(&app, "/mailboxes"))
        .bearer_auth(API_KEY)
        .send()
        .await
        .expect("Failed to execute the request");
    assert_eq!(response.status().as_u16(), 200);
    let mailboxes: serde_json::Value = response
        .json()
        .await
        .expect("Failed to decode the mailbox list");
    let mailboxes = mailboxes.as_array().expect("Expected a JSON array");
    assert_eq!(mailboxes.len(), 1);
    assert_eq!(mailboxes[0]["mailbox_id"], mailbox_id);

    let response = client
        .delete(url(&app, &format!("/mailboxes/{mailbox_id}")))
        .bearer_auth(API_KEY)
        .send()
        .await
        .expect("Failed to execute the request");
    assert_eq!(response.status().as_u16(), 204);
}

#[tokio::test]
async fn an_invalid_mailbox_address_is_rejected() {
    let app = spawn_app().await;

    let response = TestApp::client()
        .post(url(&app, "/mailboxes"))
        .bearer_auth(API_KEY)
        .json(&serde_json::json!({"email": "not-an-address"}))
        .send()
        .await
        .expect("Failed to execute the request");

    assert_eq!(response.status().as_u16(), 400);
    let body: serde_json::Value = response
        .json()
        .await
        .expect("Failed to decode the error body");
    assert!(body["error"].is_string());
}

/// Creates a mailbox through the API and returns its `mailbox_id`.
async fn create_mailbox(client: &reqwest::Client, app: &TestApp) -> String {
    let response = client
        .post(url(app, "/mailboxes"))
        .bearer_auth(API_KEY)
        .json(&serde_json::json!({"email": "me@personal.example"}))
        .send()
        .await
        .expect("Failed to execute the request");
    assert_eq!(response.status().as_u16(), 201);
    let mailbox: serde_json::Value = response.json().await.expect("Failed to decode the mailbox");
    mailbox["mailbox_id"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn aliases_support_the_full_lifecycle() {
    let app = spawn_app().await;
    let client = TestApp::client();
    let mailbox_id = create_mailbox(&client, &app).await;

    let response = client
        .post(url(&app, "/aliases"))
        .bearer_auth(API_KEY)
        .json(&serde_json::json!({
            "local_part": "shop",
            "mailbox_id": mailbox_id,
            "note": "online shops",
            "expires_at": "2030-01-01T00:00:00Z",
            "webhook_url": "https://hooks.example.com/inbound"
        }))
        .send()
        .await
        .expect("Failed to execute the request");
    assert_eq!(response.status().as_u16(), 201);
    let alias: serde_json::Value = response.json().await.expect("Failed to decode the alias");
    assert_eq!(alias["address"], "shop@example.com");
    assert_eq!(alias["mailbox_id"], mailbox_id);
    assert_eq!(alias["mailbox_email"], "me@personal.example");
    assert_eq!(alias["enabled"], true);
    let alias_id = alias["alias_id"].as_str().unwrap().to_string();

    // The detail endpoint round-trips expires_at/webhook_url and embeds contacts.
    let response = client
        .get(url(&app, &format!("/aliases/{alias_id}")))
        .bearer_auth(API_KEY)
        .send()
        .await
        .expect("Failed to execute the request");
    assert_eq!(response.status().as_u16(), 200);
    let detail: serde_json::Value = response
        .json()
        .await
        .expect("Failed to decode the alias detail");
    assert_eq!(detail["expires_at"], "2030-01-01T00:00:00+00:00");
    assert_eq!(detail["webhook_url"], "https://hooks.example.com/inbound");
    assert_eq!(detail["note"], "online shops");
    assert_eq!(detail["contacts"], serde_json::json!([]));

    // The alias shows up in the list too.
    let response = client
        .get(url(&app, "/aliases"))
        .bearer_auth(API_KEY)
        .send()
        .await
        .expect("Failed to execute the request");
    assert_eq!(response.status().as_u16(), 200);
    let aliases: serde_json::Value = response
        .json()
        .await
        .expect("Failed to decode the alias list");
    let aliases = aliases.as_array().expect("Expected a JSON array");
    assert_eq!(aliases.len(), 1);
    assert_eq!(aliases[0]["alias_id"], alias_id);

    // The same address cannot be created twice.
    let response = client
        .post(url(&app, "/aliases"))
        .bearer_auth(API_KEY)
        .json(&serde_json::json!({"local_part": "shop", "mailbox_id": mailbox_id}))
        .send()
        .await
        .expect("Failed to execute the request");
    assert_eq!(response.status().as_u16(), 409);

    // PATCH disables the alias and clears the webhook; the note stays.
    let response = client
        .patch(url(&app, &format!("/aliases/{alias_id}")))
        .bearer_auth(API_KEY)
        .json(&serde_json::json!({"enabled": false, "webhook_url": null}))
        .send()
        .await
        .expect("Failed to execute the request");
    assert_eq!(response.status().as_u16(), 200);
    let patched: serde_json::Value = response
        .json()
        .await
        .expect("Failed to decode the patched alias");
    assert_eq!(patched["enabled"], false);
    assert!(patched["webhook_url"].is_null());
    assert_eq!(patched["note"], "online shops");
    assert_eq!(patched["expires_at"], "2030-01-01T00:00:00+00:00");

    let response = client
        .delete(url(&app, &format!("/aliases/{alias_id}")))
        .bearer_auth(API_KEY)
        .send()
        .await
        .expect("Failed to execute the request");
    assert_eq!(response.status().as_u16(), 204);

    let response = client
        .get(url(&app, &format!("/aliases/{alias_id}")))
        .bearer_auth(API_KEY)
        .send()
        .await
        .expect("Failed to execute the request");
    assert_eq!(response.status().as_u16(), 404);
}

#[tokio::test]
async fn unknown_ids_and_mailboxes_are_reported() {
    let app = spawn_app().await;
    let client = TestApp::client();

    for path in ["/aliases/does-not-exist"] {
        let response = client
            .get(url(&app, path))
            .bearer_auth(API_KEY)
            .send()
            .await
            .expect("Failed to execute the request");
        assert_eq!(response.status().as_u16(), 404);
    }

    let response = client
        .patch(url(&app, "/aliases/does-not-exist"))
        .bearer_auth(API_KEY)
        .json(&serde_json::json!({"enabled": false}))
        .send()
        .await
        .expect("Failed to execute the request");
    assert_eq!(response.status().as_u16(), 404);

    let response = client
        .post(url(&app, "/aliases"))
        .bearer_auth(API_KEY)
        .json(&serde_json::json!({"mailbox_id": "does-not-exist"}))
        .send()
        .await
        .expect("Failed to execute the request");
    assert_eq!(response.status().as_u16(), 404);
}

#[tokio::test]
async fn the_message_list_is_a_json_array() {
    let app = spawn_app().await;

    let response = TestApp::client()
        .get(url(&app, "/messages"))
        .bearer_auth(API_KEY)
        .send()
        .await
        .expect("Failed to execute the request");

    assert_eq!(response.status().as_u16(), 200);
    let messages: serde_json::Value = response
        .json()
        .await
        .expect("Failed to decode the message list");
    assert!(
        messages
            .as_array()
            .expect("Expected a JSON array")
            .is_empty()
    );
}
