use rand::RngCore;
use secrecy::{ExposeSecret, Secret};
use sha2::{Digest, Sha256};

/// Prefix shared by every Hub API token.
pub const API_TOKEN_PREFIX: &str = "ptv_";
pub const API_TOKEN_RANDOM_BYTES: usize = 32;
pub const API_TOKEN_RANDOM_CHARS: usize = 43;
pub const API_TOKEN_DISPLAY_PREFIX_LEN: usize = 12;

#[derive(Clone, Debug)]
pub struct ApiToken(Secret<String>);

impl ApiToken {
    pub fn generate() -> Self {
        let mut bytes = [0u8; API_TOKEN_RANDOM_BYTES];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        Self(Secret::new(format!(
            "{API_TOKEN_PREFIX}{}",
            base64::encode_config(bytes, base64::URL_SAFE_NO_PAD)
        )))
    }

    pub fn parse(value: String) -> Result<Self, String> {
        if !value.starts_with(API_TOKEN_PREFIX) {
            return Err(format!("API token must start with {API_TOKEN_PREFIX}"));
        }
        let suffix = &value[API_TOKEN_PREFIX.len()..];
        if suffix.len() != API_TOKEN_RANDOM_CHARS {
            return Err(format!(
                "API token must have a {API_TOKEN_RANDOM_CHARS}-character random suffix"
            ));
        }
        if !suffix
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("API token suffix must be base64url without padding".to_string());
        }
        Ok(Self(Secret::new(value)))
    }

    pub fn expose_secret(&self) -> &str {
        self.0.expose_secret()
    }

    pub fn hash(&self) -> ApiTokenHash {
        ApiTokenHash::from_secret(self.expose_secret())
    }

    pub fn display_prefix(&self) -> String {
        self.expose_secret()
            .chars()
            .take(API_TOKEN_DISPLAY_PREFIX_LEN)
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiTokenHash(String);

impl ApiTokenHash {
    pub fn from_secret(value: &str) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(value.as_bytes());
        Self(format!("sha256:{}", hex::encode(hasher.finalize())))
    }

    pub fn parse(value: String) -> Result<Self, String> {
        let Some(hex) = value.strip_prefix("sha256:") else {
            return Err("API token hash must start with sha256:".to_string());
        };
        if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("API token hash must contain a SHA-256 hex digest".to_string());
        }
        Ok(Self(value))
    }
}

impl AsRef<str> for ApiTokenHash {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiClientName(String);

impl ApiClientName {
    pub fn parse(value: String) -> Result<Self, String> {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return Err("client name is required".to_string());
        }
        if trimmed.chars().count() > 128 {
            return Err("client name must not exceed 128 characters".to_string());
        }
        Ok(Self(trimmed.to_string()))
    }
}

impl AsRef<str> for ApiClientName {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for ApiClientName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}
