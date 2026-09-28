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
    let initial_config: mostro_community_api::config::Configuration =
        serde_json::from_str(include_str!("fixtures/community.json")).unwrap();
    let (tx, _rx) = tokio::sync::watch::channel(mostro_community_api::orders::MonitorCommand {
        config: initial_config,
        npub: None,
    });
    let app = router(AppState {
        store: Arc::new(Mutex::new(Store::open(dir.path().into()).unwrap())),
        integrations: Integrations::default(),
        orders: Arc::new(tokio::sync::RwLock::new(
            mostro_community_api::orders::OrdersCache::new(),
        )),
        chat: Arc::new(tokio::sync::RwLock::new(
            mostro_community_api::chat::ChatCache::new(),
        )),
        monitor_tx: tx,
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

#[tokio::test]
async fn imported_identity_is_not_exposed_over_http() {
    use nostr::{Keys, SecretKey, ToBech32};
    let (dir, app) = setup();
    let keys = Keys::new(SecretKey::from_slice(&[3; 32]).unwrap());
    let secret = keys.secret_key().to_bech32().unwrap();
    let public = keys.public_key().to_bech32().unwrap();
    mostro_community_api::identity::import(dir.path(), &secret, &public).unwrap();
    for path in [
        "/api/community",
        "/api/dashboard",
        "/api/connection",
        "/api/identity",
        "/api/identity/mostro.nsec",
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        if path.starts_with("/api/identity") {
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
        }
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert!(!String::from_utf8_lossy(&body).contains(&secret));
    }
}

#[tokio::test]
async fn daemon_endpoints_enforce_protection_and_report_state() {
    let (_dir, app) = setup();

    // GET daemon status requires no CSRF header and succeeds
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/daemon/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["state"], "unconfigured");

    // PUT daemon activate fails without custom header
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/daemon/activate")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    // PUT daemon deactivate fails without custom header
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/daemon/deactivate")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

fn sim_request(
    header: bool,
    origin: Option<&str>,
    body: Option<serde_json::Value>,
) -> Request<Body> {
    let mut builder = Request::builder()
        .method("POST")
        .uri("/api/simulation/run")
        .header("content-type", "application/json")
        .header("host", "localhost:5173");
    if header {
        builder = builder.header("x-requested-with", "mostro-community");
    }
    if let Some(o) = origin {
        builder = builder.header("origin", o);
    }
    let body_bytes = match body {
        Some(v) => Body::from(v.to_string()),
        None => Body::empty(),
    };
    builder.body(body_bytes).unwrap()
}

#[tokio::test]
async fn simulation_contract_enforces_protection_headers() {
    let (_dir, app) = setup();

    // 1. Missing x-requested-with -> 403
    let res = app
        .clone()
        .oneshot(sim_request(false, Some("http://localhost:5173"), None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // 2. Disallowed origin -> 403
    let res = app
        .clone()
        .oneshot(sim_request(true, Some("https://attacker.example"), None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn simulation_contract_requires_configured_community() {
    let (_dir, app) = setup();

    // Unconfigured store -> 400 Bad Request
    let res = app
        .oneshot(sim_request(true, Some("http://localhost:5173"), None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let body: serde_json::Value =
        serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(
        body["error"],
        "Falta configurar la comunidad antes de simular"
    );
}

#[tokio::test]
async fn simulation_contract_accepts_defaults_with_valid_config() {
    let (_dir, app) = setup();

    // Configure community first
    let save_res = app
        .clone()
        .oneshot(save(0, true, "http://localhost:5173", config()))
        .await
        .unwrap();
    assert_eq!(save_res.status(), StatusCode::OK);

    // Empty body -> 200 OK, defaults to happy_path
    let res = app
        .clone()
        .oneshot(sim_request(true, Some("http://localhost:5173"), None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value =
        serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["scenario"], "happy_path");
    assert_eq!(body["simulation_mode"], "synthetic_dry_run");
    assert!(body["disclaimer"].as_str().unwrap().contains("sintética"));
    assert_eq!(body["is_success"], true);

    // Empty JSON object -> 200 OK, defaults to happy_path
    let res = app
        .oneshot(sim_request(
            true,
            Some("http://localhost:5173"),
            Some(serde_json::json!({})),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value =
        serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["scenario"], "happy_path");
}

#[tokio::test]
async fn simulation_contract_rejects_unknown_scenarios_and_fields() {
    let (_dir, app) = setup();
    app.clone()
        .oneshot(save(0, true, "http://localhost:5173", config()))
        .await
        .unwrap();

    // Unknown scenario enum variant -> 400 Bad Request (NOT silently defaulted to happy_path!)
    let res = app
        .clone()
        .oneshot(sim_request(
            true,
            Some("http://localhost:5173"),
            Some(serde_json::json!({"scenario": "non_existent_scenario"})),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);

    // Numeric scenario type mismatch -> 400 Bad Request
    let res = app
        .clone()
        .oneshot(sim_request(
            true,
            Some("http://localhost:5173"),
            Some(serde_json::json!({"scenario": 999})),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);

    // Unknown extra field -> 400 Bad Request (deny_unknown_fields)
    let res = app
        .oneshot(sim_request(
            true,
            Some("http://localhost:5173"),
            Some(serde_json::json!({
                "scenario": "happy_path",
                "malicious_extra": "rejected"
            })),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn simulation_contract_rejects_invalid_trade_amounts() {
    let (_dir, app) = setup();
    app.clone()
        .oneshot(save(0, true, "http://localhost:5173", config()))
        .await
        .unwrap();

    // Zero trade sats -> 400 Bad Request
    let res = app
        .clone()
        .oneshot(sim_request(
            true,
            Some("http://localhost:5173"),
            Some(serde_json::json!({"trade_sats": 0})),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);

    // Negative trade sats -> 400 Bad Request
    let res = app
        .clone()
        .oneshot(sim_request(
            true,
            Some("http://localhost:5173"),
            Some(serde_json::json!({"trade_sats": -100})),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);

    // Decimal trade sats -> 400 Bad Request
    let res = app
        .clone()
        .oneshot(sim_request(
            true,
            Some("http://localhost:5173"),
            Some(serde_json::json!({"trade_sats": 50000.5})),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);

    // String trade sats -> 400 Bad Request
    let res = app
        .clone()
        .oneshot(sim_request(
            true,
            Some("http://localhost:5173"),
            Some(serde_json::json!({"trade_sats": "fifty_thousand"})),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);

    // Below minimum (min_trade_sats is 100 in fixtures/community.json) -> 400
    let res = app
        .clone()
        .oneshot(sim_request(
            true,
            Some("http://localhost:5173"),
            Some(serde_json::json!({"trade_sats": 50})),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);

    // Above maximum (max_trade_sats is 50000 in fixtures/community.json) -> 400
    let res = app
        .oneshot(sim_request(
            true,
            Some("http://localhost:5173"),
            Some(serde_json::json!({"trade_sats": 100_000})),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn simulation_scenarios_contract_returns_metadata() {
    let (_dir, app) = setup();
    let res = app
        .oneshot(
            Request::builder()
                .uri("/api/simulation/scenarios")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value =
        serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert!(body.is_array());
    assert_eq!(body.as_array().unwrap().len(), 4);
    assert_eq!(body[0]["id"], "happy_path");
    assert_eq!(body[0]["is_default"], true);
}

#[tokio::test]
async fn orders_endpoint_reports_snapshot_without_secrets() {
    let (_dir, app) = setup();
    let res = app
        .oneshot(
            Request::builder()
                .uri("/api/orders")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let body_str = String::from_utf8_lossy(&bytes);
    assert!(!body_str.contains("nsec"));
    assert!(!body_str.contains("private"));
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(body.is_object());
    assert!(body["state"].is_string());
    assert!(body["is_stale"].is_boolean());
    assert!(body["orders"].is_array());
    assert!(body["relays"].is_array());
}
