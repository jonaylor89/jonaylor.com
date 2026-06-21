#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewsletterTitle(String);

impl NewsletterTitle {
    pub const MAX_LEN: usize = 512;

    pub fn parse(value: String) -> Result<Self, String> {
        let value = value.trim().to_string();
        if value.is_empty() {
            return Err("newsletter title is required".to_string());
        }
        if value.len() > Self::MAX_LEN {
            return Err(format!(
                "newsletter title must not exceed {} bytes",
                Self::MAX_LEN
            ));
        }
        Ok(Self(value))
    }
}

impl AsRef<str> for NewsletterTitle {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for NewsletterTitle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewsletterHtmlContent(String);

impl NewsletterHtmlContent {
    pub const MAX_LEN: usize = 1024 * 1024;

    pub fn parse(value: String) -> Result<Self, String> {
        parse_body(value, "HTML content", Self::MAX_LEN).map(Self)
    }
}

impl AsRef<str> for NewsletterHtmlContent {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewsletterTextContent(String);

impl NewsletterTextContent {
    pub const MAX_LEN: usize = 1024 * 1024;

    pub fn parse(value: String) -> Result<Self, String> {
        parse_body(value, "text content", Self::MAX_LEN).map(Self)
    }
}

impl AsRef<str> for NewsletterTextContent {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone)]
pub struct NewNewsletterIssue {
    pub title: NewsletterTitle,
    pub html_content: NewsletterHtmlContent,
    pub text_content: NewsletterTextContent,
}

impl NewNewsletterIssue {
    pub fn parse(
        title: String,
        html_content: String,
        text_content: String,
    ) -> Result<Self, String> {
        Ok(Self {
            title: NewsletterTitle::parse(title)?,
            html_content: NewsletterHtmlContent::parse(html_content)?,
            text_content: NewsletterTextContent::parse(text_content)?,
        })
    }
}

fn parse_body(value: String, field: &str, max_len: usize) -> Result<String, String> {
    if value.trim().is_empty() {
        return Err(format!("newsletter {field} is required"));
    }
    if value.len() > max_len {
        return Err(format!(
            "newsletter {field} must not exceed {max_len} bytes"
        ));
    }
    Ok(value)
}
