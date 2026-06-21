use rand::RngCore;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ShareKind {
    Private,
    Public,
    SecretLink,
    PasswordProtected,
}

impl ShareKind {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "private" => Ok(Self::Private),
            "public" => Ok(Self::Public),
            "secret-link" => Ok(Self::SecretLink),
            "password-protected" => Ok(Self::PasswordProtected),
            other => Err(format!("unknown share kind: {other}")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Private => "private",
            Self::Public => "public",
            Self::SecretLink => "secret-link",
            Self::PasswordProtected => "password-protected",
        }
    }

    pub fn requires_token(self) -> bool {
        matches!(self, Self::SecretLink | Self::PasswordProtected)
    }
}

impl AsRef<str> for ShareKind {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl std::fmt::Display for ShareKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.as_str().fmt(f)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum VaultVisibility {
    Private,
    Public,
}

impl VaultVisibility {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "private" => Ok(Self::Private),
            "public" => Ok(Self::Public),
            other => Err(format!("unknown vault visibility: {other}")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Private => "private",
            Self::Public => "public",
        }
    }
}

impl AsRef<str> for VaultVisibility {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl std::fmt::Display for VaultVisibility {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.as_str().fmt(f)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareToken(String);

impl ShareToken {
    pub const RANDOM_BYTES: usize = 32;
    pub const TOKEN_CHARS: usize = 43;

    pub fn generate() -> Self {
        let mut bytes = [0u8; Self::RANDOM_BYTES];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        Self(base64::encode_config(bytes, base64::URL_SAFE_NO_PAD))
    }

    pub fn parse(value: String) -> Result<Self, String> {
        if value.len() != Self::TOKEN_CHARS {
            return Err(format!(
                "share token must be {} base64url characters",
                Self::TOKEN_CHARS
            ));
        }
        if !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("share token must be base64url without padding".to_string());
        }
        Ok(Self(value))
    }
}

impl AsRef<str> for ShareToken {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for ShareToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalSessionId(String);

impl ExternalSessionId {
    pub fn parse(value: String) -> Result<Self, String> {
        parse_non_empty_bounded(value, "external_session_id", 512).map(Self)
    }
}

impl AsRef<str> for ExternalSessionId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalEventId(String);

impl ExternalEventId {
    pub fn parse(value: String) -> Result<Self, String> {
        parse_non_empty_bounded(value, "external_event_id", 512).map(Self)
    }
}

impl AsRef<str> for ExternalEventId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventHash(String);

impl EventHash {
    pub fn parse(value: String) -> Result<Self, String> {
        let value = parse_non_empty_bounded(value, "event_hash", 256)?;
        if value.contains(char::is_whitespace) {
            return Err("event_hash must not contain whitespace".to_string());
        }
        Ok(Self(value))
    }
}

impl AsRef<str> for EventHash {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultEventRole(String);

impl VaultEventRole {
    pub fn parse(value: String) -> Result<Self, String> {
        parse_non_empty_bounded(value, "event role", 64).map(Self)
    }
}

impl AsRef<str> for VaultEventRole {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultEventKind(String);

impl VaultEventKind {
    pub fn parse(value: String) -> Result<Self, String> {
        parse_non_empty_bounded(value, "event kind", 64).map(Self)
    }
}

impl AsRef<str> for VaultEventKind {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostgresSafeText(String);

impl PostgresSafeText {
    pub fn parse(value: String) -> Self {
        Self(value.replace('\0', ""))
    }
}

impl AsRef<str> for PostgresSafeText {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

fn parse_non_empty_bounded(
    mut value: String,
    field: &str,
    max_len: usize,
) -> Result<String, String> {
    value = value.replace('\0', "");
    if value.trim().is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    if value.len() > max_len {
        return Err(format!("{field} must not exceed {max_len} bytes"));
    }
    Ok(value)
}
