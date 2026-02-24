mod admin;
mod api;
mod health_check;
mod home;
mod login;
mod subscriptions;
mod subscriptions_confirm;
mod unsubscribe;

pub use admin::{
    admin_dashboard, change_password, change_password_form, get_username, log_out,
    newsletters_form, publish_newsletter,
};
pub use api::api_publish_newsletter;
pub use health_check::health_check;
pub use home::home;
pub use login::{login, login_form};
pub use subscriptions::{error_chain_fmt, subscribe};
pub use subscriptions_confirm::confirm;
pub use unsubscribe::{generate_unsubscribe_url, unsubscribe_get, unsubscribe_post};
