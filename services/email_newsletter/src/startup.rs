use axum::routing::{delete, get, post};
use axum::{Router, middleware, serve::Serve};
use secrecy::ExposeSecret;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::Duration;
use tokio::net::TcpListener;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;
use tower_sessions::cookie::Key;
use tower_sessions::service::PrivateCookie;
use tower_sessions::{Expiry, SessionManagerLayer};
use tower_sessions_redis_store::{
    RedisStore,
    fred::{
        interfaces::ClientLike,
        prelude::{Config, Pool},
    },
};

use crate::authentication::AuthenticatedUser;
use crate::configuration::{DatabaseSettings, Settings};
use crate::email_client::EmailClient;
use crate::routes::{
    admin_dashboard, admin_stats, api_publish_newsletter, api_subscribe, change_password,
    change_password_form, confirm, delete_subscriber, get_newsletter, health_check, home,
    list_dead_letters, list_newsletters, list_subscribers, log_out, login, login_form,
    newsletters_form, preview_newsletter, publish_newsletter, retry_dead_letter, subscribe,
    unsubscribe_get, unsubscribe_post,
};

pub struct Application {
    port: u16,
    server: Serve<TcpListener, Router, Router>,
}

impl Application {
    pub async fn build(configuration: Settings) -> Result<Self, anyhow::Error> {
        let connection_pool = get_connection_pool(&configuration.database);
        let email_client = configuration.email_client.client();
        let redis_config = Config::from_url(configuration.redis_uri.expose_secret().as_str())?;
        // Use a smaller pool size to avoid connection issues
        let pool_size = if cfg!(test) { 1 } else { 6 };
        let redis_pool = Pool::new(redis_config, None, None, None, pool_size)?;

        // Connect to Redis with a timeout
        let connect_future = async {
            let _handles = redis_pool.connect();
            redis_pool.wait_for_connect().await
        };

        tokio::time::timeout(std::time::Duration::from_secs(5), connect_future)
            .await
            .map_err(|_| anyhow::anyhow!("Redis connection timeout"))??;

        let redis_store = RedisStore::new(redis_pool.clone());
        let key = Key::derive_from(
            configuration
                .application
                .hmac_secret
                .expose_secret()
                .as_bytes(),
        );
        let session_layer = SessionManagerLayer::new(redis_store)
            .with_private(key)
            .with_expiry(Expiry::OnInactivity(Duration::seconds(60 * 60 * 24 * 30)));

        let address = format!(
            "{}:{}",
            configuration.application.host, configuration.application.port
        );

        let listener = TcpListener::bind(address).await?;

        let port = listener.local_addr().unwrap().port();

        let state = AppState {
            db_pool: connection_pool.clone(),
            email_client: email_client.clone(),
            base_url: ApplicationBaseUrl(configuration.application.base_url.clone()),
            hmac_secret: configuration
                .application
                .hmac_secret
                .expose_secret()
                .clone(),
            api_bearer_token: configuration
                .application
                .api_bearer_token
                .expose_secret()
                .clone(),
        };

        let server = run(listener, state, session_layer)?;

        Ok(Self { port, server })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub async fn run_until_stopped(self) -> Result<(), std::io::Error> {
        self.server.await.map_err(std::io::Error::other)
    }

    pub async fn run_with_graceful_shutdown(
        self,
        shutdown_signal: impl std::future::Future<Output = ()> + Send + 'static,
    ) -> Result<(), std::io::Error> {
        self.server
            .with_graceful_shutdown(shutdown_signal)
            .await
            .map_err(std::io::Error::other)
    }
}

#[derive(Clone)]
pub struct ApplicationBaseUrl(pub String);

#[derive(Clone)]
pub struct AppState {
    pub db_pool: PgPool,
    pub email_client: EmailClient,
    pub base_url: ApplicationBaseUrl,
    pub hmac_secret: String,
    pub api_bearer_token: String,
}

impl axum::extract::FromRef<AppState> for PgPool {
    fn from_ref(state: &AppState) -> Self {
        state.db_pool.clone()
    }
}

impl axum::extract::FromRef<AppState> for EmailClient {
    fn from_ref(state: &AppState) -> Self {
        state.email_client.clone()
    }
}

impl axum::extract::FromRef<AppState> for ApplicationBaseUrl {
    fn from_ref(state: &AppState) -> Self {
        state.base_url.clone()
    }
}

fn build_router(
    session_layer: SessionManagerLayer<RedisStore<Pool>, PrivateCookie>,
) -> Router<AppState> {
    let admin_routes = Router::<AppState>::new()
        .route("/dashboard", get(admin_dashboard))
        .route(
            "/newsletters",
            get(newsletters_form).post(publish_newsletter),
        )
        .route("/newsletters/list", get(list_newsletters))
        .route("/newsletters/preview", post(preview_newsletter))
        .route("/newsletters/{issue_id}", get(get_newsletter))
        .route("/subscribers", get(list_subscribers))
        .route("/subscribers/{subscriber_id}", delete(delete_subscriber))
        .route("/stats", get(admin_stats))
        .route("/dead-letters", get(list_dead_letters))
        .route(
            "/dead-letters/{newsletter_issue_id}/{subscriber_email}",
            post(retry_dead_letter),
        )
        .route("/password", get(change_password_form).post(change_password))
        .route("/logout", post(log_out))
        .route_layer(middleware::from_extractor::<AuthenticatedUser>());

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list([
            "https://jonaylor.com".parse().unwrap(),
            "https://www.jonaylor.com".parse().unwrap(),
            "http://localhost:4321".parse().unwrap(),
        ]))
        .allow_methods([http::Method::POST, http::Method::OPTIONS])
        .allow_headers([http::header::CONTENT_TYPE]);

    Router::<AppState>::new()
        .route("/", get(home))
        .route("/health_check", get(health_check))
        .route("/subscriptions", post(subscribe))
        .route("/subscriptions/confirm", get(confirm))
        .route(
            "/subscriptions/unsubscribe",
            get(unsubscribe_get).post(unsubscribe_post),
        )
        .route("/login", get(login_form).post(login))
        .route("/api/newsletters", post(api_publish_newsletter))
        .route("/api/subscriptions", post(api_subscribe))
        .nest("/admin", admin_routes)
        .layer(session_layer)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
}

fn run(
    listener: TcpListener,
    state: AppState,
    session_layer: SessionManagerLayer<RedisStore<Pool>, PrivateCookie>,
) -> Result<axum::serve::Serve<TcpListener, Router, Router>, anyhow::Error> {
    let app: Router = build_router(session_layer).with_state::<()>(state);
    let server = axum::serve(listener, app);

    Ok(server)
}

pub fn get_connection_pool(configuration: &DatabaseSettings) -> PgPool {
    PgPoolOptions::new()
        .acquire_timeout(std::time::Duration::from_secs(2))
        .connect_lazy_with(configuration.with_db())
}
