use mostro_community_api::{AppState, adapters::Integrations, router, store::Store};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let bind = std::env::var("API_BIND").unwrap_or_else(|_| "127.0.0.1:3001".into());
    let root = PathBuf::from(std::env::var("CONFIG_DIR").unwrap_or_else(|_| "./var/config".into()));
    let state = AppState {
        store: Arc::new(Mutex::new(Store::open(root)?)),
        integrations: Integrations::from_env(),
    };
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    eprintln!("Community API listening on {bind}");
    let app = if let Some(directory) = std::env::var_os("STATIC_DIR") {
        use axum::http::{HeaderValue, header};
        use tower_http::{
            services::{ServeDir, ServeFile},
            set_header::SetResponseHeaderLayer,
        };
        let directory = PathBuf::from(directory);
        router(state)
            .fallback_service(ServeDir::new(&directory).not_found_service(ServeFile::new(directory.join("index.html"))))
            .layer(SetResponseHeaderLayer::if_not_present(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")))
            .layer(SetResponseHeaderLayer::if_not_present(header::CACHE_CONTROL, HeaderValue::from_static("no-store")))
            .layer(SetResponseHeaderLayer::if_not_present(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'")))
    } else {
        router(state)
    };
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
