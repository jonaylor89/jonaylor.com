use crate::helpers::{assert_is_redirect_to, spawn_app};
use serde_json::json;

fn find_full_token(body: &str) -> Option<String> {
    let mut cursor = 0;
    while let Some(idx) = body[cursor..].find("ptv_") {
        let abs = cursor + idx;
        let candidate: String = body[abs..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
            .collect();
        if candidate.len() > 40 {
            return Some(candidate);
        }
        cursor = abs + 4;
    }
    None
}

fn ingest_one(thread_label: &str) -> serde_json::Value {
    json!({
        "client_id": "default",
        "session": {
            "external_session_id": format!("sess-{}", thread_label),
            "title": thread_label,
            "cwd": null,
            "repo_remote": null,
            "repo_branch": null,
            "repo_head": null,
        },
        "events": [
            {
                "external_event_id": "e1",
                "parent_external_event_id": null,
                "event_hash": format!("h-{}-1", thread_label),
                "role": "user",
                "kind": "message",
                "content": "investigate websocket reconnection logic",
                "metadata": {},
                "created_at": "2026-05-19T12:00:00Z"
            }
        ]
    })
}

#[tokio::test]
async fn admin_can_issue_and_revoke_api_key() {
    let app = spawn_app().await;
    let _ = app.test_user.login(&app).await;

    let create = app
        .api_client
        .post(format!("{}/admin/vault/clients", &app.address))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body("name=laptop")
        .send()
        .await
        .expect("create request");
    assert_eq!(200, create.status().as_u16());
    let body = create.text().await.unwrap();

    // The response renders the prefix (~12 chars) in one place and the full
    // plaintext token in a <pre> elsewhere — pick the long match.
    let token = find_full_token(&body).expect("full token should appear in response");
    assert!(token.len() > 40, "token should be long: {token}");

    // The new token authenticates against the ingest API.
    let ingest = app
        .post_vault_events(
            &json!({
                "client_id": "laptop",
                "session": {
                    "external_session_id": "key-test-sess",
                    "title": "key test",
                    "cwd": null, "repo_remote": null, "repo_branch": null, "repo_head": null,
                },
                "events": [{
                    "external_event_id": "e1",
                    "parent_external_event_id": null,
                    "event_hash": "key-test-hash",
                    "role": "user", "kind": "message",
                    "content": "hello",
                    "metadata": {},
                    "created_at": "2026-05-20T00:00:00Z"
                }],
            }),
            Some(&token),
        )
        .await;
    assert_eq!(200, ingest.status().as_u16(), "new token must authenticate");

    let client_id: String = sqlx::query_scalar(
        "SELECT id FROM vault_clients WHERE name = 'laptop' AND revoked_at IS NULL",
    )
    .fetch_one(&app.db_pool)
    .await
    .unwrap();

    let revoke = app
        .api_client
        .post(format!(
            "{}/admin/vault/clients/{}/revoke",
            &app.address, client_id
        ))
        .send()
        .await
        .expect("revoke request");
    assert_eq!(303, revoke.status().as_u16());

    let denied = app
        .post_vault_events(
            &json!({
                "client_id": "laptop",
                "session": {
                    "external_session_id": "key-test-sess-2",
                    "title": "post-revoke",
                    "cwd": null, "repo_remote": null, "repo_branch": null, "repo_head": null,
                },
                "events": [],
            }),
            Some(&token),
        )
        .await;
    assert_eq!(
        401,
        denied.status().as_u16(),
        "revoked token must be denied"
    );
}

#[tokio::test]
async fn anonymous_cannot_create_api_key() {
    let app = spawn_app().await;
    let response = app
        .api_client
        .post(format!("{}/admin/vault/clients", &app.address))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body("name=evil")
        .send()
        .await
        .expect("create request");
    assert_is_redirect_to(&response, "/login");

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM vault_clients WHERE name = 'evil'")
        .fetch_one(&app.db_pool)
        .await
        .unwrap();
    assert_eq!(count, 0, "anonymous request must not insert a client");
}

#[tokio::test]
async fn create_api_key_rejects_empty_name() {
    let app = spawn_app().await;
    let _ = app.test_user.login(&app).await;
    let response = app
        .api_client
        .post(format!("{}/admin/vault/clients", &app.address))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body("name=   ")
        .send()
        .await
        .expect("create request");
    assert_eq!(400, response.status().as_u16());
}

#[tokio::test]
async fn anonymous_users_are_redirected_to_login_from_threads_index() {
    let app = spawn_app().await;
    let response = app.get_threads_index().await;
    assert_is_redirect_to(&response, "/login");
}

#[tokio::test]
async fn anonymous_users_are_redirected_to_login_from_vault_admin() {
    let app = spawn_app().await;
    let response = app.get_vault_admin().await;
    assert_is_redirect_to(&response, "/login");
}

#[tokio::test]
async fn anonymous_users_are_redirected_to_login_from_vault_search() {
    let app = spawn_app().await;
    let response = app.get_vault_search("anything").await;
    assert_is_redirect_to(&response, "/login");
}

#[tokio::test]
async fn logged_in_admin_sees_ingested_thread_in_index() {
    let app = spawn_app().await;
    let _ = app
        .post_vault_events(&ingest_one("alpha"), Some(&app.vault_api_token))
        .await;

    let login = app.test_user.login(&app).await;
    assert_is_redirect_to(&login, "/admin/dashboard");

    let response = app.get_threads_index().await;
    assert_eq!(200, response.status().as_u16());
    let body = response.text().await.unwrap();
    assert!(body.contains("alpha"), "thread title should appear: {body}");
}

#[tokio::test]
async fn logged_in_admin_sees_vault_admin_page_with_test_client() {
    let app = spawn_app().await;
    // Trigger one ingest so last_seen_at gets a value on the test-client row.
    let _ = app
        .post_vault_events(&ingest_one("beta"), Some(&app.vault_api_token))
        .await;
    let _ = app.test_user.login(&app).await;

    let response = app.get_vault_admin().await;
    assert_eq!(200, response.status().as_u16());
    let body = response.text().await.unwrap();
    assert!(
        body.contains("test-client"),
        "test-client row should render"
    );
}

#[tokio::test]
async fn full_text_search_returns_matching_event() {
    let app = spawn_app().await;
    let _ = app
        .post_vault_events(&ingest_one("websockets"), Some(&app.vault_api_token))
        .await;
    let _ = app.test_user.login(&app).await;

    let response = app.get_vault_search("websocket").await;
    assert_eq!(200, response.status().as_u16());
    let body = response.text().await.unwrap();
    assert!(
        body.contains("websocket"),
        "result body should mention websocket: {body}"
    );
}

#[tokio::test]
async fn search_with_empty_query_returns_zero_results() {
    let app = spawn_app().await;
    let _ = app
        .post_vault_events(&ingest_one("idle"), Some(&app.vault_api_token))
        .await;
    let _ = app.test_user.login(&app).await;

    let response = app.get_vault_search("").await;
    assert_eq!(200, response.status().as_u16());
    let body = response.text().await.unwrap();
    assert!(
        !body.contains("0 results"),
        "empty query should not run the search at all"
    );
}

#[tokio::test]
async fn thread_page_renders_event_content() {
    let app = spawn_app().await;
    let ingest = app
        .post_vault_events(&ingest_one("rendering"), Some(&app.vault_api_token))
        .await;
    let body: serde_json::Value = ingest.json().await.unwrap();
    let thread_id = body["thread_id"].as_str().unwrap().to_string();

    let _ = app.test_user.login(&app).await;

    let response = app.get_thread_page(&thread_id).await;
    assert_eq!(200, response.status().as_u16());
    let html = response.text().await.unwrap();
    assert!(html.contains("websocket reconnection logic"));
    assert!(html.contains("rendering"));
}

#[tokio::test]
async fn thread_page_filters_numeric_tool_snapshot_artifacts() {
    let app = spawn_app().await;
    let tools_snapshot_content = json!([
        {"name": "0"},
        {"name": "1"},
        {"name": "bash"},
        {"name": "read"}
    ])
    .to_string();
    let ingest = app
        .post_vault_events(
            &json!({
                "client_id": "default",
                "session": {
                    "external_session_id": "sess-tool-snapshot-artifacts",
                    "title": "tool snapshot artifacts",
                    "cwd": null,
                    "repo_remote": null,
                    "repo_branch": null,
                    "repo_head": null,
                },
                "events": [{
                    "external_event_id": "tools",
                    "parent_external_event_id": null,
                    "event_hash": "h-tool-snapshot-artifacts",
                    "role": "system",
                    "kind": "tools_snapshot",
                    "content": tools_snapshot_content,
                    "metadata": {},
                    "created_at": "2026-05-19T12:00:00Z"
                }],
            }),
            Some(&app.vault_api_token),
        )
        .await;
    let body: serde_json::Value = ingest.json().await.unwrap();
    let thread_id = body["thread_id"].as_str().unwrap().to_string();

    let _ = app.test_user.login(&app).await;

    let response = app.get_thread_page(&thread_id).await;
    assert_eq!(200, response.status().as_u16());
    let html = response.text().await.unwrap();
    assert!(html.contains("<summary class=\"tools-header\">Available tools</summary>"));
    assert!(html.contains("<span class=\"tool-item-name\">bash</span>"));
    assert!(html.contains("<span class=\"tool-item-name\">read</span>"));
    assert!(!html.contains("<span class=\"tool-item-name\">0</span>"));
    assert!(!html.contains("<span class=\"tool-item-name\">1</span>"));
}
