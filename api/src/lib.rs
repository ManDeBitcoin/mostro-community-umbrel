pub mod adapters;
pub mod backup;
pub mod config;
pub mod identity;
pub mod lnd;
pub mod preflight;
pub mod store;
pub mod tunnel;
use adapters::Integrations;
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    routing::{get, put},
};
use config::Configuration;
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use store::{Document, Store};
#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Mutex<Store>>,
    pub integrations: Integrations,
}
type Error = (StatusCode, Json<Value>);
fn error(status: StatusCode, message: &str) -> Error {
    (status, Json(json!({"error":message})))
}
pub fn router(state: AppState) -> Router {
    Router::new()
        .route(
            "/api/health",
            get(|| async { Json(json!({"status":"ok","version":"0.1.0","mode":"development"})) }),
        )
        .route("/api/dashboard", get(dashboard))
        .route("/api/community", get(community).merge(put(save_community)))
        .route(
            "/api/{*path}",
            get(|| async { error(StatusCode::NOT_FOUND, "Endpoint no disponible") }),
        )
        .layer(DefaultBodyLimit::max(64 * 1024))
        .with_state(state)
}
async fn dashboard(State(state): State<AppState>) -> Json<Value> {
    let (mostro, lightning) =
        tokio::join!(state.integrations.mostro(), state.integrations.lightning());
    Json(json!({"mostro":mostro,"lightning":lightning,
        "bitcoin":{"status":"unknown","detail":"Verificación directa de Bitcoin pendiente; el estado de LND no la sustituye"},
        "market_started":false}))
}
async fn community(State(state): State<AppState>) -> Result<Json<Document>, Error> {
    let store = state.store.lock().map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Almacenamiento no disponible",
        )
    })?;
    Ok(Json(store.document.clone()))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveRequest {
    revision: u64,
    config: Configuration,
}
async fn save_community(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<SaveRequest>,
) -> Result<Json<Document>, Error> {
    // Custom header + no CORS: browsers must pass same-origin preflight before mutation.
    if headers
        .get("x-requested-with")
        .and_then(|v| v.to_str().ok())
        != Some("mostro-community")
    {
        return Err(error(
            StatusCode::FORBIDDEN,
            "Falta protección de solicitud",
        ));
    }
    if let Some(origin) = headers.get("origin") {
        let host = headers
            .get("host")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let permitted = origin
            .to_str()
            .ok()
            .and_then(|s| url::Url::parse(s).ok())
            .is_some_and(|u| {
                ["http", "https"].contains(&u.scheme())
                    && u[url::Position::BeforeHost..url::Position::AfterPort] == *host
            });
        if !permitted {
            return Err(error(StatusCode::FORBIDDEN, "Origen no permitido"));
        }
    }
    request
        .config
        .validate()
        .map_err(|e| error(StatusCode::UNPROCESSABLE_ENTITY, e))?;
    let mut store = state.store.lock().map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Almacenamiento no disponible",
        )
    })?;
    if request.revision != store.document.revision {
        return Err(error(
            StatusCode::CONFLICT,
            "La configuración cambió; recarga antes de guardar",
        ));
    }
    store.save(request.config).map(Json).map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "No se pudo guardar la configuración",
        )
    })
}
