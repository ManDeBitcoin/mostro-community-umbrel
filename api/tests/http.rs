use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use mostro_community_api::{AppState, adapters::Integrations, router, store::Store};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;
fn setup() -> (tempfile::TempDir, axum::Router) {
    let dir = tempfile::tempdir().unwrap();
    let app = router(AppState {
        store: Arc::new(Mutex::new(Store::open(dir.path().into()).unwrap())),
        integrations: Integrations::default(),
    });
    (dir, app)
}
fn save(revision: u64, header: bool, origin: &str, config: serde_json::Value) -> Request<Body> {
    let mut builder = Request::builder()
        .method("PUT")
        .uri("/api/community")
        .header("content-type", "application/json")
        .header("host", "localhost:5173")
        .header("origin", origin);
    if header {
        builder = builder.header("x-requested-with", "mostro-community");
    }
    builder
        .body(Body::from(
            serde_json::json!({"revision":revision,"config":config}).to_string(),
        ))
        .unwrap()
}
fn config() -> serde_json::Value {
    serde_json::from_str(include_str!("fixtures/community.json")).unwrap()
}
#[tokio::test]
async fn mutation_requires_same_origin_custom_header_and_fresh_revision() {
    let (_dir, app) = setup();
    assert_eq!(
        app.clone()
            .oneshot(save(0, false, "http://localhost:5173", config()))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        app.clone()
            .oneshot(save(0, true, "https://evil.example", config()))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        app.clone()
            .oneshot(save(0, true, "http://localhost:5173", config()))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        app.clone()
            .oneshot(save(0, true, "http://localhost:5173", config()))
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        app.oneshot(save(1, true, "http://localhost:5173", config()))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
}
#[tokio::test]
async fn invalid_configuration_is_not_persisted() {
    let (dir, app) = setup();
    let mut invalid = config();
    invalid["market"]["min_trade_sats"] = 0.into();
    assert_eq!(
        app.oneshot(save(0, true, "http://localhost:5173", invalid))
            .await
            .unwrap()
            .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert!(!dir.path().join("community.json").exists());
}
#[tokio::test]
async fn secrets_and_unknown_fields_are_rejected() {
    let (dir, app) = setup();
    let mut invalid = config();
    invalid["nostr"]["nsec"] = "secret".into();
    assert_eq!(
        app.oneshot(save(0, true, "http://localhost:5173", invalid))
            .await
            .unwrap()
            .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert!(!dir.path().join("community.json").exists());
}
#[tokio::test]
async fn health_never_fabricates_connected_services() {
    let (_dir, app) = setup();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/dashboard")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let value: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(value["mostro"]["status"], "unconfigured");
    assert_eq!(value["lightning"]["status"], "unconfigured");
    assert_eq!(value["bitcoin"]["status"], "unknown");
    assert_eq!(value["market_started"], false);
}
