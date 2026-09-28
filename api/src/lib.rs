pub mod adapters;
pub mod backup;
pub mod config;
pub mod connection;
pub mod daemon;
pub mod identity;
pub mod lnd;
pub mod orders;
pub mod preflight;
pub mod simulation;
pub mod staging;
pub mod store;
pub mod tunnel;
use adapters::Integrations;
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post, put},
};
use config::Configuration;
use orders::SharedOrders;
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use store::{Document, Store};
#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Mutex<Store>>,
    pub integrations: Integrations,
    pub orders: SharedOrders,
    pub monitor_tx: tokio::sync::watch::Sender<orders::MonitorCommand>,
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
        .route("/api/connection", get(connection_info_handler))
        .route("/api/daemon/status", get(daemon_status_handler))
        .route("/api/daemon/activate", put(daemon_activate_handler))
        .route("/api/daemon/deactivate", put(daemon_deactivate_handler))
        .route(
            "/api/simulation/scenarios",
            get(simulation_scenarios_handler),
        )
        .route("/api/simulation/run", post(simulation_run_handler))
        .route("/api/orders", get(orders::get_orders_handler))
        .route(
            "/api/{*path}",
            get(|| async { error(StatusCode::NOT_FOUND, "Endpoint no disponible") }),
        )
        .layer(DefaultBodyLimit::max(64 * 1024))
        .with_state(state)
}

async fn connection_info_handler(
    State(state): State<AppState>,
) -> Result<Json<connection::ConnectionInfo>, Error> {
    let store = state.store.lock().map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Almacenamiento no disponible",
        )
    })?;
    let root = store.root().to_path_buf();
    Ok(Json(connection::get_connection_info(&root, &store)))
}

#[derive(Deserialize)]
struct ActivateDaemonRequest {
    lnd_grpc_origin: Option<String>,
}

async fn daemon_status_handler(
    State(state): State<AppState>,
) -> Result<Json<daemon::DaemonReport>, Error> {
    let root = state
        .store
        .lock()
        .map_err(|_| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Almacenamiento no disponible",
            )
        })?
        .root()
        .to_path_buf();
    Ok(Json(daemon::report(&root, &state.integrations).await))
}

fn verify_protection(headers: &HeaderMap) -> Result<(), Error> {
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
    Ok(())
}

async fn daemon_activate_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Option<Json<ActivateDaemonRequest>>,
) -> Result<Json<daemon::ActivationResult>, Error> {
    verify_protection(&headers)?;
    let root = state
        .store
        .lock()
        .map_err(|_| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Almacenamiento no disponible",
            )
        })?
        .root()
        .to_path_buf();
    let default_origin = format!(
        "https://{}:{}",
        std::env::var("APP_LIGHTNING_NODE_IP").unwrap_or_else(|_| "10.21.21.9".into()),
        std::env::var("APP_LIGHTNING_NODE_GRPC_PORT").unwrap_or_else(|_| "10009".into())
    );
    let lnd_origin = payload
        .and_then(|p| p.0.lnd_grpc_origin)
        .unwrap_or(default_origin);

    daemon::activate(&root, &lnd_origin)
        .map(Json)
        .map_err(|e| error(StatusCode::BAD_REQUEST, e))
}

async fn daemon_deactivate_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, Error> {
    verify_protection(&headers)?;
    let root = state
        .store
        .lock()
        .map_err(|_| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Almacenamiento no disponible",
            )
        })?
        .root()
        .to_path_buf();
    daemon::deactivate(&root)
        .map(|()| Json(json!({"status": "deactivated"})))
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SimulationRunRequest {
    pub scenario: Option<simulation::SimulationScenario>,
    pub trade_sats: Option<u64>,
}

async fn simulation_scenarios_handler() -> Json<Value> {
    Json(json!([
        {
            "id": "happy_path",
            "label": "Intercambio Completo Exitoso (Happy Path)",
            "name": "Intercambio Completo Exitoso (Happy Path)",
            "description": "Modelo sintético de orden de venta, aceptación, bloqueo de fianza/garantía, transferencia fiat simulada y liberación de satoshis.",
            "is_default": true
        },
        {
            "id": "dispute_settled_for_buyer",
            "label": "Disputa Resuelta a Favor del Comprador",
            "name": "Disputa Resuelta a Favor del Comprador",
            "description": "Modelo sintético donde el mediador valida comprobante de pago legítimo y liquida la garantía al comprador.",
            "is_default": false
        },
        {
            "id": "dispute_refunded_to_seller",
            "label": "Disputa Resuelta con Devolución al Vendedor",
            "name": "Disputa Resuelta con Devolución al Vendedor",
            "description": "Modelo sintético donde el mediador confirma falta de pago fiat y devuelve los satoshis al vendedor.",
            "is_default": false
        },
        {
            "id": "seller_cancellation",
            "label": "Cancelación Previa por el Vendedor",
            "name": "Cancelación Previa por el Vendedor",
            "description": "Modelo sintético donde el vendedor cancela su orden antes de ser tomada, anulando la Hold Invoice sin penalizaciones.",
            "is_default": false
        }
    ]))
}

async fn simulation_run_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<simulation::SimulationReport>, Error> {
    verify_protection(&headers)?;

    let payload: Option<SimulationRunRequest> = if body.is_empty() {
        None
    } else {
        Some(serde_json::from_slice(&body).map_err(|e| {
            error(
                StatusCode::BAD_REQUEST,
                &format!("Cuerpo de solicitud inválido: {e}"),
            )
        })?)
    };

    let (scenario, trade_sats) = match payload {
        Some(p) => (
            p.scenario
                .unwrap_or(simulation::SimulationScenario::HappyPath),
            p.trade_sats,
        ),
        None => (simulation::SimulationScenario::HappyPath, None),
    };

    if let Some(0) = trade_sats {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Monto de intercambio debe ser mayor a cero",
        ));
    }

    let store = state.store.lock().map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Almacenamiento no disponible",
        )
    })?;

    let config = store.document.config.as_ref().ok_or_else(|| {
        error(
            StatusCode::BAD_REQUEST,
            "Falta configurar la comunidad antes de simular",
        )
    })?;

    // Synthetic dry-run: never reads mostro.nsec or macaroons
    simulation::run_simulation(config, None, scenario, trade_sats)
        .map(Json)
        .map_err(|e| error(StatusCode::BAD_REQUEST, e))
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
    verify_protection(&headers)?;
    request
        .config
        .validate()
        .map_err(|e| error(StatusCode::UNPROCESSABLE_ENTITY, e))?;
    let (result, root) = {
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
        let root = store.root.clone();
        let save_res = store.save(request.config.clone()).map(Json).map_err(|_| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "No se pudo guardar la configuración",
            )
        });
        (save_res, root)
    };

    if result.is_ok() {
        let npub = identity::read_public_key(&root).ok().flatten();
        let _ = state.monitor_tx.send(orders::MonitorCommand {
            config: request.config,
            npub,
        });
    }

    result
}
