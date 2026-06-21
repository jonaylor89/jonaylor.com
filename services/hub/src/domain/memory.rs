#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryUserId(String);

impl MemoryUserId {
    pub const MAX_LEN: usize = 256;

    pub fn parse(value: String) -> Result<Self, String> {
        let value = value.trim().to_string();
        if value.is_empty() {
            return Err("user_id must not be empty".to_string());
        }
        if value.len() > Self::MAX_LEN {
            return Err(format!(
                "user_id must not exceed {} characters",
                Self::MAX_LEN
            ));
        }
        Ok(Self(value))
    }
}

impl AsRef<str> for MemoryUserId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for MemoryUserId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawMemoryText(String);

impl RawMemoryText {
    pub const MAX_LEN: usize = 102_400;

    pub fn parse(value: String) -> Result<Self, String> {
        if value.is_empty() || value.len() > Self::MAX_LEN {
            return Err("text must be between 1 and 100KB".to_string());
        }
        Ok(Self(value))
    }
}

impl AsRef<str> for RawMemoryText {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryQuery(String);

impl MemoryQuery {
    pub const MAX_LEN: usize = 10_240;

    pub fn parse(value: String) -> Result<Self, String> {
        if value.is_empty() || value.len() > Self::MAX_LEN {
            return Err("query must be between 1 and 10KB".to_string());
        }
        Ok(Self(value))
    }
}

impl AsRef<str> for MemoryQuery {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryFact(String);

impl MemoryFact {
    pub const MAX_LEN: usize = 4096;

    pub fn parse(value: String) -> Result<Self, String> {
        let value = value.trim().to_string();
        if value.is_empty() {
            return Err("memory fact must not be empty".to_string());
        }
        if value.len() > Self::MAX_LEN {
            return Err(format!(
                "memory fact must not exceed {} bytes",
                Self::MAX_LEN
            ));
        }
        Ok(Self(value))
    }
}

impl AsRef<str> for MemoryFact {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SimilarityThreshold(f64);

impl SimilarityThreshold {
    pub fn parse(value: f64) -> Result<Self, String> {
        if !value.is_finite() || !(0.0..=1.0).contains(&value) {
            return Err("similarity threshold must be between 0.0 and 1.0".to_string());
        }
        Ok(Self(value))
    }

    pub fn get(self) -> f64 {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SearchLimit(i64);

impl SearchLimit {
    pub fn parse(value: i64) -> Result<Self, String> {
        if !(1..=100).contains(&value) {
            return Err("search limit must be between 1 and 100".to_string());
        }
        Ok(Self(value))
    }

    pub fn get(self) -> i64 {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryExtractionStatus {
    Pending,
    Processing,
    Failed,
    DeadLetter,
}

impl MemoryExtractionStatus {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "pending" => Ok(Self::Pending),
            "processing" => Ok(Self::Processing),
            "failed" => Ok(Self::Failed),
            "dead_letter" => Ok(Self::DeadLetter),
            other => Err(format!("unknown memory extraction status: {other}")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Processing => "processing",
            Self::Failed => "failed",
            Self::DeadLetter => "dead_letter",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemoryConflictAction {
    Update(MemoryFact),
    KeepBoth,
    KeepExisting,
}
