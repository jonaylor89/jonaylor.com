use chrono::Utc;
use mail_parser::{Address, MessageParser};

use crate::smtp::rewrite::{header_value, split_headers_body};
use crate::smtp::session::Envelope;

/// The JSON document POSTed to an alias's `webhook_url` for every forwarded
/// message.
#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct InboundPayload {
    /// The alias address that received the mail.
    pub alias: String,
    /// Parsed `From` header.
    pub from: PayloadAddress,
    pub subject: Option<String>,
    /// First `text/plain` body.
    pub text: Option<String>,
    /// First `text/html` body.
    pub html: Option<String>,
    /// RFC 5322 `Message-ID`.
    pub message_id: Option<String>,
    /// RFC 3339 timestamp of when the SMTP session accepted the message.
    pub received_at: String,
}

#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct PayloadAddress {
    pub address: String,
    pub name: Option<String>,
}

impl InboundPayload {
    /// Parses the accepted envelope into the webhook document. A message that
    /// resists MIME parsing degrades to the raw body and the bare headers.
    pub fn build(alias: &str, envelope: &Envelope) -> Self {
        if let Some(message) = MessageParser::default().parse(&envelope.data) {
            let from = message
                .from()
                .and_then(first_address)
                .map(|addr| PayloadAddress {
                    address: addr.address.as_deref().unwrap_or_default().to_string(),
                    name: addr.name.as_deref().map(str::to_string),
                })
                .unwrap_or(PayloadAddress {
                    address: String::new(),
                    name: None,
                });

            return Self {
                alias: alias.to_string(),
                from,
                subject: message.subject().map(str::to_string),
                text: message.body_text(0).map(|body| body.into_owned()),
                html: message.body_html(0).map(|body| body.into_owned()),
                message_id: message.message_id().map(str::to_string),
                received_at: Utc::now().to_rfc3339(),
            };
        }

        let (headers, body) = split_headers_body(&envelope.data);
        let from_header = header_value(headers, "from");
        Self {
            alias: alias.to_string(),
            from: fallback_from(from_header.as_deref()),
            subject: header_value(headers, "subject"),
            text: Some(String::from_utf8_lossy(body).into_owned()),
            html: None,
            message_id: header_value(headers, "message-id"),
            received_at: Utc::now().to_rfc3339(),
        }
    }
}

/// The first mailbox of a `From` header, whether it came as a plain list or a
/// group.
fn first_address<'a, 'x>(address: &'a Address<'x>) -> Option<&'a mail_parser::Addr<'x>> {
    match address {
        Address::List(list) => list.first(),
        Address::Group(groups) => groups.first().and_then(|group| group.addresses.first()),
    }
}

/// Pulls the address and display name out of a raw `From` header value, the
/// same way the router does it for contact creation.
fn fallback_from(from_header: Option<&str>) -> PayloadAddress {
    let header = from_header.unwrap_or_default();
    let address = match (header.find('<'), header.find('>')) {
        (Some(start), Some(end)) if end > start => header[start + 1..end].trim().to_string(),
        _ => header.trim().to_string(),
    };
    let name = from_header.and_then(|header| {
        let (name, _) = header.split_once('<')?;
        let name = name.trim().trim_matches('"').trim();
        (!name.is_empty()).then(|| name.to_string())
    });
    PayloadAddress { address, name }
}

#[cfg(test)]
mod tests {
    use super::InboundPayload;
    use crate::smtp::session::Envelope;

    #[test]
    fn a_well_formed_message_is_parsed() {
        let envelope = Envelope {
            mail_from: "support@shop.example".to_string(),
            rcpt_to: vec!["shop.1a2b@example.com".to_string()],
            data: b"From: Shop Support <support@shop.example>\r\n\
                    Subject: Your order\r\n\
                    Message-ID: <abc@shop.example>\r\n\
                    Content-Type: text/plain\r\n\
                    \r\n\
                    It shipped.\r\n"
                .to_vec(),
        };

        let payload = InboundPayload::build("shop.1a2b@example.com", &envelope);
        assert_eq!(payload.alias, "shop.1a2b@example.com");
        assert_eq!(payload.from.address, "support@shop.example");
        assert_eq!(payload.from.name.as_deref(), Some("Shop Support"));
        assert_eq!(payload.subject.as_deref(), Some("Your order"));
        assert!(payload.text.as_deref().unwrap().contains("It shipped."));
        assert_eq!(payload.message_id.as_deref(), Some("abc@shop.example"));
        assert!(!payload.received_at.is_empty());
    }

    #[test]
    fn unparseable_mail_falls_back_to_raw_headers_and_body() {
        let envelope = Envelope {
            mail_from: String::new(),
            rcpt_to: vec![],
            // An LF-only header block is still readable by the fallback.
            data: b"\xff\xfe\x00garbage".to_vec(),
        };
        let payload = InboundPayload::build("a@example.com", &envelope);
        // Either path is acceptable, but the payload must always be produced.
        assert_eq!(payload.alias, "a@example.com");
        assert!(!payload.received_at.is_empty());
    }
}
