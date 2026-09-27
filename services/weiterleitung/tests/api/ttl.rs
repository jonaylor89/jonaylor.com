//! Alias TTL: expired recipients die at RCPT and the janitor removes the row.

use chrono::{Duration, Utc};

use crate::harness::{spawn_app, spawn_app_with_smtp};
use weiterleitung::alias::{
    AliasUpdate, delete_expired_aliases, get_alias, insert_alias, update_alias,
};
use weiterleitung::contact::find_contact_by_reverse_alias;
use weiterleitung::delivery::list_recent;
use weiterleitung::domain::EmailAddress;
use weiterleitung::mailbox::insert_mailbox;

#[tokio::test]
async fn expired_aliases_are_rejected_at_rcpt() {
    let app = spawn_app_with_smtp(|_| {}).await;
    let mailbox = insert_mailbox(
        &app.pool,
        &EmailAddress::parse("me@personal.example").unwrap(),
        true,
    )
    .await
    .unwrap();
    let alias_address = EmailAddress::parse("gone@example.com").unwrap();
    insert_alias(
        &app.pool,
        &alias_address,
        &mailbox.mailbox_id,
        None,
        Some(Utc::now() - Duration::hours(1)),
        None,
    )
    .await
    .unwrap();

    let mut session = app.smtp().await;
    session.command("EHLO tester.example").await;
    session.command("MAIL FROM:<stranger@shop.example>").await;
    let reply = session.command(&format!("RCPT TO:<{alias_address}>")).await;
    assert!(reply.starts_with("550"), "{reply}");
    assert!(reply.contains("expired"), "{reply}");
    session.quit().await;

    assert!(list_recent(&app.pool, 10).await.unwrap().is_empty());
}

#[tokio::test]
async fn an_alias_that_expires_later_still_takes_mail() {
    let app = spawn_app_with_smtp(|_| {}).await;
    let mailbox = insert_mailbox(
        &app.pool,
        &EmailAddress::parse("me@personal.example").unwrap(),
        true,
    )
    .await
    .unwrap();
    let alias_address = EmailAddress::parse("shop.1a2b@example.com").unwrap();
    insert_alias(
        &app.pool,
        &alias_address,
        &mailbox.mailbox_id,
        None,
        Some(Utc::now() + Duration::hours(1)),
        None,
    )
    .await
    .unwrap();

    let mut session = app.smtp().await;
    let reply = session
        .send_mail(
            "support@shop.example",
            &alias_address.to_string(),
            "From: support@shop.example\nSubject: Still here\n\nHello\n",
        )
        .await;
    assert!(reply.starts_with("250"), "{reply}");
    session.quit().await;

    let queued = list_recent(&app.pool, 10).await.unwrap();
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].direction, "forward");
    assert_eq!(queued[0].envelope_to, "me@personal.example");
}

#[tokio::test]
async fn replies_through_an_expired_alias_are_rejected_at_rcpt() {
    let app = spawn_app_with_smtp(|_| {}).await;
    let mailbox = insert_mailbox(
        &app.pool,
        &EmailAddress::parse("me@personal.example").unwrap(),
        true,
    )
    .await
    .unwrap();
    let alias_address = EmailAddress::parse("shop.1a2b@example.com").unwrap();
    let alias = insert_alias(
        &app.pool,
        &alias_address,
        &mailbox.mailbox_id,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    // One inbound mail creates the contact and its reverse alias, which then
    // shows up as the envelope sender of the queued forward.
    let mut session = app.smtp().await;
    let reply = session
        .send_mail(
            "support@shop.example",
            &alias_address.to_string(),
            "From: support@shop.example\nSubject: Hi\n\nHello\n",
        )
        .await;
    assert!(reply.starts_with("250"), "{reply}");

    let reverse_alias =
        EmailAddress::parse(&list_recent(&app.pool, 1).await.unwrap()[0].envelope_from).unwrap();
    let contact = find_contact_by_reverse_alias(&app.pool, &reverse_alias)
        .await
        .unwrap()
        .expect("The forward should have created a contact");
    assert_eq!(contact.contact.email, "support@shop.example");

    update_alias(
        &app.pool,
        &alias.alias_id,
        AliasUpdate {
            expires_at: Some(Utc::now() - Duration::minutes(5)),
            ..AliasUpdate::default()
        },
    )
    .await
    .unwrap();

    // The mailbox is still the only allowed sender, but the alias is gone.
    let mail = session.command("MAIL FROM:<me@personal.example>").await;
    assert!(mail.starts_with("250"), "{mail}");
    let reply = session.command(&format!("RCPT TO:<{reverse_alias}>")).await;
    assert!(reply.starts_with("550"), "{reply}");
    assert!(reply.contains("expired"), "{reply}");
    session.quit().await;
}

#[tokio::test]
async fn the_cleanup_deletes_expired_aliases() {
    let app = spawn_app().await;
    let mailbox = insert_mailbox(
        &app.pool,
        &EmailAddress::parse("me@personal.example").unwrap(),
        true,
    )
    .await
    .unwrap();
    let expired = insert_alias(
        &app.pool,
        &EmailAddress::parse("gone@example.com").unwrap(),
        &mailbox.mailbox_id,
        None,
        Some(Utc::now() - Duration::hours(1)),
        None,
    )
    .await
    .unwrap();
    let alive = insert_alias(
        &app.pool,
        &EmailAddress::parse("alive@example.com").unwrap(),
        &mailbox.mailbox_id,
        None,
        Some(Utc::now() + Duration::hours(1)),
        None,
    )
    .await
    .unwrap();

    let deleted = delete_expired_aliases(&app.pool).await.unwrap();
    assert_eq!(deleted, 1);

    assert!(
        get_alias(&app.pool, &expired.alias_id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        get_alias(&app.pool, &alive.alias_id)
            .await
            .unwrap()
            .is_some()
    );
}
