use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::response::IntoResponse;

const CACHE_FOREVER: &str = "public, max-age=31536000, immutable";

pub async fn favicon_ico() -> impl IntoResponse {
    (
        [
            (CONTENT_TYPE, "image/x-icon"),
            (CACHE_CONTROL, CACHE_FOREVER),
        ],
        include_bytes!("../../assets/site/favicon.ico").as_slice(),
    )
}

pub async fn favicon_svg() -> impl IntoResponse {
    (
        [
            (CONTENT_TYPE, "image/svg+xml"),
            (CACHE_CONTROL, CACHE_FOREVER),
        ],
        include_str!("../../assets/site/favicon.svg"),
    )
}

pub async fn apple_touch_icon() -> impl IntoResponse {
    (
        [(CONTENT_TYPE, "image/png"), (CACHE_CONTROL, CACHE_FOREVER)],
        include_bytes!("../../assets/site/apple-touch-icon.png").as_slice(),
    )
}

pub async fn og_image() -> impl IntoResponse {
    (
        [(CONTENT_TYPE, "image/jpeg"), (CACHE_CONTROL, CACHE_FOREVER)],
        include_bytes!("../../assets/site/og-image.jpg").as_slice(),
    )
}

pub async fn robots_txt() -> impl IntoResponse {
    (
        [(CONTENT_TYPE, "text/plain; charset=utf-8")],
        "User-agent: *\nDisallow: /\n",
    )
}
