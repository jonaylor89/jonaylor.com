macro_rules! prefixed_id_type {
    ($name:ident, $prefix:literal) => {
        #[derive(Debug, Clone, PartialEq, Eq, Hash)]
        pub struct $name(String);

        impl $name {
            pub const PREFIX: &'static str = $prefix;

            pub fn generate() -> Self {
                Self(format!("{}{}", Self::PREFIX, uuid::Uuid::new_v4().simple()))
            }

            pub fn parse(value: String) -> Result<Self, String> {
                let Some(suffix) = value.strip_prefix(Self::PREFIX) else {
                    return Err(format!(
                        "{} must start with {}",
                        stringify!($name),
                        Self::PREFIX
                    ));
                };
                if suffix.len() != 32 || !suffix.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err(format!(
                        "{} must end with a 32-character lowercase UUID hex string",
                        stringify!($name)
                    ));
                }
                Ok(Self(value))
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                self.0.fmt(f)
            }
        }
    };
}

prefixed_id_type!(ApiClientId, "clt_");
prefixed_id_type!(VaultThreadId, "thr_");
prefixed_id_type!(VaultEventId, "evt_");
prefixed_id_type!(VaultShareId, "shr_");
prefixed_id_type!(VaultHandoffId, "hnd_");
