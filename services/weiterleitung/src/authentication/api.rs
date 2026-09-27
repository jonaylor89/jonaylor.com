use axum::Json;
use axum::extract::FromRequestParts;
use axum::http::StatusCode;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use secrecy::ExposeSecret;

use crate::startup::AppState;

/// Authenticates machine clients against the `api.key` Bearer token.
///
/// With no key configured every request is rejected.
#[derive(Clone, Copy, Debug)]
pub struct ApiAuth;

pub struct ApiAuthRejection;

impl IntoResponse for ApiAuthRejection {
    fn into_response(self) -> Response {
        (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "unauthorized"})),
        )
            .into_response()
    }
}

impl FromRequestParts<AppState> for ApiAuth {
    type Rejection = ApiAuthRejection;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let Some(expected) = state.api.key.as_ref() else {
            return Err(ApiAuthRejection);
        };

        let header = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .ok_or(ApiAuthRejection)?;
        let (scheme, token) = header.split_once(' ').ok_or(ApiAuthRejection)?;
        if !scheme.eq_ignore_ascii_case("bearer") || token.is_empty() {
            return Err(ApiAuthRejection);
        }

        if !constant_time_eq(token.as_bytes(), expected.expose_secret().as_bytes()) {
            return Err(ApiAuthRejection);
        }

        Ok(Self)
    }
}

/// Byte-wise comparison that does not short-circuit on the first mismatch, so
/// the token's content does not leak through timing.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter()
        .zip(b.iter())
        .fold(0u8, |accumulator, (x, y)| accumulator | (x ^ y))
        == 0
}
