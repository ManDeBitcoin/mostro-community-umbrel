use crate::{
    adapters::Integrations,
    backup::{self, AutoBackupState},
    chat::{self, SharedChatCache},
    config::Configuration,
    connection, daemon, identity,
    notifications::{Notification, NotificationHub},
    orders::{self, SharedOrders},
    simulation,
    store::{Document, Store},
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{
        IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
    routing::{get, post, put},
};
use futures_util::stream::{self, Stream};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    convert::Infallible,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub type Error = (StatusCode, Json<Value>);

pub fn error(status: StatusCode, message: &str) -> Error {
    (status, Json(json!({"error": message})))
}

struct ClientBucket {
    tokens: f64,
    last_update: Instant,
}

pub struct RateLimiter {
    buckets: Mutex<HashMap<String, ClientBucket>>,
    pub max_tokens: f64,
    pub refill_rate: f64,
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self::new(120.0, 20.0) // 120 burst capacity, 20 tokens per second
    }
}

impl RateLimiter {
    pub fn new(max_tokens: f64, refill_rate: f64) -> Self {
        Self {
            buckets: Mutex::new(HashMap::new()),
            max_tokens,
            refill_rate,
        }
    }

    pub fn check(&self, key: &str, cost: f64) -> bool {
        let mut buckets = match self.buckets.lock() {
            Ok(b) => b,
            Err(_) => return true,
        };

        let now = Instant::now();
        if buckets.len() > 1000 {
            buckets.retain(|_, b| now.duration_since(b.last_update).as_secs() < 300);
        }

        let bucket = buckets
            .entry(key.to_string())
            .or_insert_with(|| ClientBucket {
                tokens: self.max_tokens,
                last_update: now,
            });

        let elapsed = now.duration_since(bucket.last_update).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * self.refill_rate).min(self.max_tokens);
        bucket.last_update = now;

        if bucket.tokens >= cost {
            bucket.tokens -= cost;
            true
        } else {
            false
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Mutex<Store>>,
    pub integrations: Integrations,
    pub orders: SharedOrders,
    pub chat: SharedChatCache,
    pub monitor_tx: tokio::sync::watch::Sender<orders::MonitorCommand>,
    pub notifications: Arc<NotificationHub>,
    pub backup_state: Arc<tokio::sync::RwLock<AutoBackupState>>,
    pub rate_limiter: Arc<RateLimiter>,
}

impl AppState {
    pub fn new(
        store: Arc<Mutex<Store>>,
        integrations: Integrations,
        orders: SharedOrders,
        chat: SharedChatCache,
        monitor_tx: tokio::sync::watch::Sender<orders::MonitorCommand>,
    ) -> Self {
        Self {
            store,
            integrations,
            orders,
            chat,
            monitor_tx,
            notifications: Arc::new(NotificationHub::default()),
            backup_state: Arc::new(tokio::sync::RwLock::new(AutoBackupState::default())),
            rate_limiter: Arc::new(RateLimiter::default()),
        }
    }
}

pub fn router(state: AppState) -> Router {
    let api_routes = Router::new()
        .route(
            "/api/health",
            get(|| async { Json(json!({"status":"ok","version":"0.1.0","mode":"development"})) }),
        )
        .route("/api/dashboard", get(dashboard))
        .route("/api/community", get(community).merge(put(save_community)))
        .route("/api/community/presets", get(community_presets_handler))
        .route("/api/identity/generate", post(identity_generate_handler))
        .route("/api/identity/import", post(identity_import_handler))
        .route("/api/connection", get(connection_info_handler))
        .route("/api/daemon/status", get(daemon_status_handler))
        .route(
            "/api/daemon/activate",
            put(daemon_activate_handler).post(daemon_activate_handler),
        )
        .route(
            "/api/daemon/start",
            put(daemon_activate_handler).post(daemon_activate_handler),
        )
        .route(
            "/api/daemon/deactivate",
            put(daemon_deactivate_handler).post(daemon_deactivate_handler),
        )
        .route(
            "/api/daemon/stop",
            put(daemon_deactivate_handler).post(daemon_deactivate_handler),
        )
        .route(
            "/api/simulation/scenarios",
            get(simulation_scenarios_handler),
        )
        .route("/api/simulation/run", post(simulation_run_handler))
        .route("/api/orders", get(orders::get_orders_handler))
        .route("/api/chat/{order_id}", get(chat::get_chat_handler))
        .route("/api/notifications", get(notifications_list_handler))
        .route("/api/backup/status", get(backup_status_handler))
        .route("/api/backup/trigger", post(backup_trigger_handler))
        .route("/api/lnd/channels", get(lnd_channels_handler))
        .layer(middleware::from_fn(timeout_middleware));

    let sse_routes = Router::new().route("/api/notifications/sse", get(notifications_sse_handler));

    let fallback_route = Router::new().route(
        "/api/{*path}",
        get(|| async { error(StatusCode::NOT_FOUND, "Endpoint no disponible") }),
    );

    Router::new()
        .merge(api_routes)
        .merge(sse_routes)
        .merge(fallback_route)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            rate_limit_middleware,
        ))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .with_state(state)
}

async fn timeout_middleware(request: axum::extract::Request, next: Next) -> Response {
    match tokio::time::timeout(Duration::from_secs(30), next.run(request)).await {
        Ok(response) => response,
        Err(_) => (
            StatusCode::GATEWAY_TIMEOUT,
            Json(json!({"error": "Tiempo de espera agotado"})),
        )
            .into_response(),
    }
}

async fn rate_limit_middleware(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: axum::extract::Request,
    next: Next,
) -> Result<Response, Response> {
    let client_key = headers
        .get("x-forwarded-for")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("127.0.0.1");

    if !state.rate_limiter.check(client_key, 1.0) {
        let mut response = (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({"error": "Demasiadas solicitudes. Límite de tasa excedido."})),
        )
            .into_response();
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, "5".parse().unwrap());
        return Err(response);
    }

    Ok(next.run(request).await)
}

pub fn verify_protection(headers: &HeaderMap) -> Result<(), Error> {
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

async fn community_presets_handler() -> Json<Vec<crate::config::RegionalPreset>> {
    Json(crate::config::get_regional_presets())
}

#[derive(Deserialize, Default)]
struct GenerateIdentityRequest {
    overwrite: Option<bool>,
}

async fn identity_generate_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
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

    let overwrite = if !body.is_empty() {
        let req: GenerateIdentityRequest = serde_json::from_slice(&body).unwrap_or_default();
        req.overwrite.unwrap_or(false)
    } else {
        false
    };

    let (nsec, npub) = identity::generate_with_overwrite(&root, overwrite)
        .map_err(|e| error(StatusCode::BAD_REQUEST, e))?;

    let config_opt = state
        .store
        .lock()
        .ok()
        .and_then(|s| s.document.config.clone());
    if let Some(config) = config_opt {
        let _ = state.monitor_tx.send(orders::MonitorCommand {
            config,
            npub: Some(npub.clone()),
        });
    }

    state
        .notifications
        .publish(Notification::system_alert(
            "Identidad Mostro generada",
            &format!("Nueva clave pública inicializada: {npub}"),
            "info",
            None,
        ))
        .await;

    Ok(Json(json!({
        "status": "ok",
        "nsec": nsec,
        "npub": npub
    })))
}

#[derive(Deserialize)]
struct ImportIdentityRequest {
    nsec: String,
    overwrite: Option<bool>,
}

async fn identity_import_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ImportIdentityRequest>,
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

    let overwrite = payload.overwrite.unwrap_or(false);
    let npub = identity::import_nsec_with_overwrite(&root, &payload.nsec, overwrite)
        .map_err(|e| error(StatusCode::BAD_REQUEST, e))?;

    let config_opt = state
        .store
        .lock()
        .ok()
        .and_then(|s| s.document.config.clone());
    if let Some(config) = config_opt {
        let _ = state.monitor_tx.send(orders::MonitorCommand {
            config,
            npub: Some(npub.clone()),
        });
    }

    state
        .notifications
        .publish(Notification::system_alert(
            "Identidad Mostro importada",
            &format!("Clave pública vinculada: {npub}"),
            "info",
            None,
        ))
        .await;

    Ok(Json(json!({
        "status": "ok",
        "npub": npub
    })))
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

async fn daemon_activate_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
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

    let payload: Option<ActivateDaemonRequest> = if body.is_empty() {
        None
    } else {
        Some(serde_json::from_slice(&body).map_err(|e| {
            error(
                StatusCode::BAD_REQUEST,
                &format!("Cuerpo de solicitud inválido: {e}"),
            )
        })?)
    };

    let default_origin = format!(
        "https://{}:{}",
        std::env::var("APP_LIGHTNING_NODE_IP").unwrap_or_else(|_| "10.21.21.9".into()),
        std::env::var("APP_LIGHTNING_NODE_GRPC_PORT").unwrap_or_else(|_| "10009".into())
    );
    let lnd_origin = payload
        .and_then(|p| p.lnd_grpc_origin)
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

    simulation::run_simulation(config, None, scenario, trade_sats)
        .map(Json)
        .map_err(|e| error(StatusCode::BAD_REQUEST, e))
}

async fn dashboard(State(state): State<AppState>) -> Json<Value> {
    let (mut mostro, lightning) =
        tokio::join!(state.integrations.mostro(), state.integrations.lightning());
    let (is_active, active_rev) = {
        let store = state.store.lock();
        if let Ok(store) = store {
            let active_dir = store.root().join("active");
            let has_settings = active_dir.join("settings.toml").is_file();
            let rev = std::fs::read(active_dir.join("status.json"))
                .ok()
                .and_then(|b| serde_json::from_slice::<daemon::ActiveStatus>(&b).ok())
                .map(|s| s.revision);
            (has_settings, rev)
        } else {
            (false, None)
        }
    };
    if state.integrations.mostro_rpc.is_none() && is_active {
        mostro = json!({
            "status": "unknown",
            "detail": "Configuración guardada; ejecución y versión del daemon sin verificar",
            "configured_revision": active_rev
        });
    }
    Json(json!({"mostro":mostro,"lightning":lightning,
        "bitcoin":{"status":"unknown","detail":"Verificación directa de Bitcoin pendiente; el estado de LND no la sustituye"},
        "configuration_active":is_active,
        "market_started":false}))
}

#[derive(Deserialize, Default)]
pub struct LndChannelsQuery {
    pub mock: Option<bool>,
}

async fn lnd_channels_handler(
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<LndChannelsQuery>,
) -> Json<Value> {
    let force_mock = query.mock.unwrap_or(false);
    Json(state.integrations.channels(force_mock).await)
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

        let active_dir = root.join("active");
        if active_dir.join("settings.toml").is_file() {
            let origin = std::fs::read(active_dir.join("status.json"))
                .ok()
                .and_then(|b| serde_json::from_slice::<daemon::ActiveStatus>(&b).ok())
                .map(|s| s.lnd_grpc_origin)
                .unwrap_or_else(|| {
                    format!(
                        "https://{}:{}",
                        std::env::var("APP_LIGHTNING_NODE_IP")
                            .unwrap_or_else(|_| "10.21.21.9".into()),
                        std::env::var("APP_LIGHTNING_NODE_GRPC_PORT")
                            .unwrap_or_else(|_| "10009".into())
                    )
                });
            let _ = daemon::activate(&root, &origin);
        }
    }

    result
}

async fn notifications_list_handler(State(state): State<AppState>) -> Json<Vec<Notification>> {
    let recent = state.notifications.get_recent(50).await;
    Json(recent)
}

async fn notifications_sse_handler(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = state.notifications.subscribe();

    let stream = stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(notif) => {
                    let json = serde_json::to_string(&notif).unwrap_or_default();
                    let event = Event::default().event("notification").data(json);
                    return Some((Ok(event), rx));
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    return None;
                }
            }
        }
    });

    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    )
}

async fn backup_status_handler(State(state): State<AppState>) -> Json<AutoBackupState> {
    let st = state.backup_state.read().await;
    Json(st.clone())
}

#[derive(Deserialize)]
pub struct BackupTriggerRequest {
    pub passphrase: Option<String>,
}

async fn backup_trigger_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Option<Json<BackupTriggerRequest>>,
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

    let passphrase_str = payload
        .and_then(|p| p.0.passphrase)
        .or_else(|| std::env::var("BACKUP_PASSPHRASE").ok())
        .ok_or_else(|| {
            error(
                StatusCode::BAD_REQUEST,
                "Se requiere frase de cifrado (en cuerpo o variable BACKUP_PASSPHRASE)",
            )
        })?;

    let target_dir = PathBuf::from(
        std::env::var("BACKUP_OFFSITE_DIR").unwrap_or_else(|_| "/data/backup".into()),
    );
    let target_dir = if !target_dir.exists() {
        if backup::ensure_private_dir(&target_dir).is_err() {
            root.join("backups")
        } else {
            target_dir
        }
    } else {
        target_dir
    };

    let summary = backup::run_auto_backup_cycle(
        &root,
        &target_dir,
        7,
        age::secrecy::SecretString::from(passphrase_str),
    )
    .map_err(|e| error(StatusCode::BAD_REQUEST, e))?;

    let backups = backup::list_backups(&target_dir);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    {
        let mut st = state.backup_state.write().await;
        st.last_run_timestamp = Some(now);
        st.last_run_success = Some(true);
        st.last_error = None;
        st.last_backup_path = Some(summary.path.display().to_string());
        st.backups = backups;
    }

    state
        .notifications
        .publish(Notification::backup_alert(
            "Backup manual completado",
            &format!("Respaldo guardado en {}", summary.path.display()),
            true,
            Some(json!({
                "path": summary.path.display().to_string(),
                "revision": summary.revision,
                "npub": summary.npub
            })),
        ))
        .await;

    Ok(Json(json!({
        "status": "ok",
        "path": summary.path.display().to_string(),
        "revision": summary.revision,
        "npub": summary.npub
    })))
}
