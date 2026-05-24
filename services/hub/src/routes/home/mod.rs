use askama::Template;
use axum::response::{Html, IntoResponse};

use crate::session_state::TypedSession;
use crate::web_templates::HomeTemplate;

pub async fn home(session: TypedSession) -> impl IntoResponse {
    let is_signed_in = matches!(session.get_user_id().await, Ok(Some(_)));
    Html(HomeTemplate { is_signed_in }.render().unwrap()).into_response()
}
