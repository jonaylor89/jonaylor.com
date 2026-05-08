mod dashboard;
mod dead_letters;
mod logout;
mod newsletter_detail;
mod newsletters;
mod password;
mod stats;
mod subscribers;

pub use dashboard::{admin_dashboard, get_username};
pub use dead_letters::{list_dead_letters, retry_dead_letter};
pub use logout::log_out;
pub use newsletter_detail::{get_newsletter, list_newsletters, preview_newsletter};
pub use newsletters::{newsletters_form, publish_newsletter};
pub use password::{change_password, change_password_form};
pub use stats::admin_stats;
pub use subscribers::{delete_subscriber, list_subscribers};
