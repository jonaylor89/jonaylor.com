use rand::Rng;

pub const MAX_PASTE_BYTES: usize = 256 * 1024;
const PASTE_ID_LEN: usize = 8;
const PASTE_ID_ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PasteId(String);

impl PasteId {
    pub fn generate() -> Self {
        let mut rng = rand::thread_rng();
        let id = (0..PASTE_ID_LEN)
            .map(|_| {
                let index = rng.gen_range(0..PASTE_ID_ALPHABET.len());
                PASTE_ID_ALPHABET[index] as char
            })
            .collect();
        Self(id)
    }

    pub fn parse(value: String) -> Result<Self, PasteIdError> {
        if value.len() != PASTE_ID_LEN {
            return Err(PasteIdError::InvalidLength {
                expected: PASTE_ID_LEN,
                actual: value.len(),
            });
        }
        if !value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        {
            return Err(PasteIdError::InvalidCharacters);
        }
        Ok(Self(value))
    }
}

impl AsRef<str> for PasteId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for PasteId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PasteIdError {
    #[error("paste id must be {expected} characters, got {actual}")]
    InvalidLength { expected: usize, actual: usize },

    #[error("paste id must contain only lowercase letters and digits")]
    InvalidCharacters,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PasteContent(String);

impl PasteContent {
    pub fn parse(value: String) -> Result<Self, PasteContentError> {
        if value.is_empty() {
            return Err(PasteContentError::Empty);
        }
        if value.len() > MAX_PASTE_BYTES {
            return Err(PasteContentError::TooLarge {
                max_bytes: MAX_PASTE_BYTES,
                actual_bytes: value.len(),
            });
        }
        Ok(Self(value))
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PasteContentError {
    #[error("paste content is required")]
    Empty,

    #[error("paste must be at most {max_bytes} bytes")]
    TooLarge {
        max_bytes: usize,
        actual_bytes: usize,
    },
}

impl AsRef<str> for PasteContent {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl From<PasteContent> for String {
    fn from(content: PasteContent) -> Self {
        content.0
    }
}
