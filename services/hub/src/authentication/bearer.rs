use axum::http::HeaderMap;

/// Verifies an `Authorization: Bearer <token>` header against the expected token.
///
/// Uses constant-time comparison to prevent timing-based side-channel attacks.
pub fn verify_bearer_token(headers: &HeaderMap, expected_token: &str) -> bool {
    let provided = match headers
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    {
        Some(t) => t,
        None => return false,
    };
    constant_time_eq::constant_time_eq(provided.as_bytes(), expected_token.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matching_tokens_pass() {
        let mut headers = HeaderMap::new();
        headers.insert("Authorization", "Bearer my-secret-token".parse().unwrap());
        assert!(verify_bearer_token(&headers, "my-secret-token"));
    }

    #[test]
    fn mismatched_tokens_fail() {
        let mut headers = HeaderMap::new();
        headers.insert("Authorization", "Bearer wrong-token".parse().unwrap());
        assert!(!verify_bearer_token(&headers, "my-secret-token"));
    }

    #[test]
    fn missing_header_fails() {
        let headers = HeaderMap::new();
        assert!(!verify_bearer_token(&headers, "my-secret-token"));
    }

    #[test]
    fn non_bearer_scheme_fails() {
        let mut headers = HeaderMap::new();
        headers.insert("Authorization", "Basic abc123".parse().unwrap());
        assert!(!verify_bearer_token(&headers, "abc123"));
    }

    #[test]
    fn empty_token_fails_against_non_empty() {
        let mut headers = HeaderMap::new();
        headers.insert("Authorization", "Bearer ".parse().unwrap());
        assert!(!verify_bearer_token(&headers, "some-token"));
    }
}
