use crate::helpers::spawn_app;

#[tokio::test]
async fn home_page_is_visible_to_anonymous_visitors() {
    let app = spawn_app().await;

    let response = app.get_home().await;

    assert!(response.status().is_success());
    let html_page = response.text().await.unwrap();
    assert!(html_page.contains("jonaylor.com hub"));
    assert!(html_page.contains("href=\"https://www.jonaylor.com/\""));
    assert!(html_page.contains("href=\"/login\""));
    assert!(html_page.contains("section-list"));
}

#[tokio::test]
async fn home_links_to_admin_dashboard_when_signed_in() {
    let app = spawn_app().await;
    app.test_user.login(&app).await;

    let response = app.get_home().await;

    assert!(response.status().is_success());
    let html_page = response.text().await.unwrap();
    assert!(html_page.contains("href=\"/admin/dashboard\""));
    assert!(!html_page.contains("href=\"/login\""));
}
