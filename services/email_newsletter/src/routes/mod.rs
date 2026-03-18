mod admin;
mod api;
mod health_check;
mod home;
mod login;
mod subscriptions;
mod subscriptions_confirm;
mod unsubscribe;

pub use admin::{
    admin_dashboard, admin_stats, change_password, change_password_form, delete_subscriber,
    get_newsletter, get_username, list_dead_letters, list_newsletters, list_subscribers, log_out,
    newsletters_form, preview_newsletter, publish_newsletter, retry_dead_letter,
};
pub use api::{api_publish_newsletter, api_subscribe};
pub use health_check::health_check;
pub use home::home;
pub use login::{login, login_form};
pub use subscriptions::{error_chain_fmt, subscribe};
pub use subscriptions_confirm::confirm;
pub use unsubscribe::{generate_unsubscribe_url, unsubscribe_get, unsubscribe_post};
