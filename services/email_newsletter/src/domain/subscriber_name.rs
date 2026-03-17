use unicode_segmentation::UnicodeSegmentation;

#[derive(Debug)]
pub struct SubscriberName(String);

impl SubscriberName {
    pub fn parse(s: Option<String>) -> Result<Option<SubscriberName>, String> {
        match s {
            None => Ok(None),
            Some(value) if value.trim().is_empty() => Ok(None),
            Some(value) => {
                let is_too_long = value.graphemes(true).count() > 256;

                let forbidden_characters = ['/', '(', ')', '"', '<', '>', '\\', '{', '}'];

                let contains_forbidden_charaters =
                    value.chars().any(|g| forbidden_characters.contains(&g));

                if is_too_long || contains_forbidden_charaters {
                    Err(format!("{} is not a valid subscriber name", value))
                } else {
                    Ok(Some(Self(value)))
                }
            }
        }
    }
}

impl AsRef<str> for SubscriberName {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use crate::domain::SubscriberName;
    use claim::{assert_err, assert_ok};

    #[test]
    fn a_256_grapheme_long_name_is_valid() {
        let name = Some("ё".repeat(256));
        assert_ok!(SubscriberName::parse(name));
    }

    #[test]
    fn a_name_longer_than_256_graphemes_is_rejected() {
        let name = Some("a".repeat(257));
        assert_err!(SubscriberName::parse(name));
    }

    #[test]
    fn whitespace_only_names_return_none() {
        let name = Some(" ".to_string());
        let result = SubscriberName::parse(name);
        assert!(result.is_ok());
        assert!(result.unwrap().is_none());
    }

    #[test]
    fn empty_string_returns_none() {
        let name = Some("".to_string());
        let result = SubscriberName::parse(name);
        assert!(result.is_ok());
        assert!(result.unwrap().is_none());
    }

    #[test]
    fn none_returns_none() {
        let result = SubscriberName::parse(None);
        assert!(result.is_ok());
        assert!(result.unwrap().is_none());
    }

    #[test]
    fn names_containing_an_invalid_character_are_rejected() {
        for name in &['/', '(', ')', '"', '<', '>', '\\', '{', '}'] {
            let name = Some(name.to_string());
            assert_err!(SubscriberName::parse(name));
        }
    }

    #[test]
    fn a_valid_name_is_parsed_successfully() {
        let name = Some("Ursula Le Guin".to_string());
        assert_ok!(SubscriberName::parse(name));
    }
}
