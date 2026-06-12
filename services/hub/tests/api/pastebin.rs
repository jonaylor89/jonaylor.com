use crate::helpers::{assert_is_redirect_to, spawn_app};

#[tokio::test]
async fn pastebin_admin_is_available_from_the_dashboard() {
    let app = spawn_app().await;
    app.test_user.login(&app).await;

    let dashboard = app.get_admin_dashboard_html().await;
    assert!(dashboard.contains(r#"href="/admin/pastebin""#));

    let response = app
        .api_client
        .get(format!("{}/admin/pastebin", &app.address))
        .send()
        .await
        .expect("Failed to execute request");

    assert!(response.status().is_success());
    let html = response.text().await.unwrap();
    assert!(html.contains("Pastebin"));
    assert!(html.contains("new paste"));
}

#[tokio::test]
async fn you_must_be_logged_in_to_access_pastebin_admin() {
    let app = spawn_app().await;

    let response = app
        .api_client
        .get(format!("{}/admin/pastebin", &app.address))
        .send()
        .await
        .expect("Failed to execute request");

    assert_is_redirect_to(&response, "/login");
}

#[tokio::test]
async fn create_and_read_a_paste_from_the_admin_form() {
    let app = spawn_app().await;
    app.test_user.login(&app).await;

    let response = app
        .api_client
        .post(format!("{}/admin/pastebin", &app.address))
        .form(&serde_json::json!({
            "content": "fn main() {\n    println!(\"hello paste\");\n}\n",
        }))
        .send()
        .await
        .expect("Failed to execute request");

    assert_eq!(response.status().as_u16(), 303);
    let location = response
        .headers()
        .get("Location")
        .unwrap()
        .to_str()
        .unwrap();
    assert!(location.starts_with("/p/"));

    let html = app
        .api_client
        .get(format!("{}{}", &app.address, location))
        .header("User-Agent", "Mozilla/5.0")
        .send()
        .await
        .expect("Failed to execute request")
        .text()
        .await
        .unwrap();
    assert!(html.contains("hello paste"));
    assert!(html.contains("plain text"));

    let raw = app
        .api_client
        .get(format!("{}{}?raw=1", &app.address, location))
        .send()
        .await
        .expect("Failed to execute request");
    assert_eq!(raw.status().as_u16(), 200);
    assert_eq!(
        raw.headers().get("Content-Type").unwrap(),
        "text/plain; charset=utf-8"
    );
    assert_eq!(
        raw.text().await.unwrap(),
        "fn main() {\n    println!(\"hello paste\");\n}\n"
    );
}

#[tokio::test]
async fn api_can_create_pastes_with_bearer_token() {
    let app = spawn_app().await;

    let unauthorized = app
        .api_client
        .put(format!("{}/api/pastes", &app.address))
        .body("secret snippet")
        .send()
        .await
        .expect("Failed to execute request");
    assert_eq!(unauthorized.status().as_u16(), 401);

    let response = app
        .api_client
        .put(format!("{}/api/pastes", &app.address))
        .header("Authorization", format!("Bearer {}", app.api_bearer_token))
        .body("secret snippet")
        .send()
        .await
        .expect("Failed to execute request");

    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(
        response.headers().get("Content-Type").unwrap(),
        "text/plain; charset=utf-8"
    );
    let url = response.text().await.unwrap();
    let paste_path = reqwest::Url::parse(url.trim()).unwrap().path().to_string();
    assert!(paste_path.starts_with("/p/"));

    let raw = app
        .api_client
        .get(format!("{}{}?raw=1", &app.address, paste_path))
        .send()
        .await
        .expect("Failed to execute request")
        .text()
        .await
        .unwrap();
    assert_eq!(raw, "secret snippet");
}
