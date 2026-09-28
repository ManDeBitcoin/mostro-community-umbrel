use axum::{Json, extract::State};
use futures_util::{SinkExt, StreamExt};
use nostr::{Event, FromBech32, PublicKey, Timestamp};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{RwLock, watch};
use tokio::task::JoinHandle;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};

use crate::{AppState, config::Configuration};

pub const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub const MAX_WS_FRAME_SIZE: usize = 128 * 1024; // 128 KB limit per message

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum MonitorState {
    Unconfigured,
    Connecting,
    Syncing,
    Live,
    Degraded,
    Disconnected,
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
pub struct RelayStatus {
    pub url: String,
    pub state: MonitorState,
    pub last_error: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
pub struct OrderSummary {
    pub id: String, // uuid inside 'd' tag
    pub event_id: String,
    pub kind: String, // buy/sell
    pub status: String,
    pub fiat_code: String,
    pub fiat_amount_range: Vec<String>,
    pub amount_sats: u64,
    pub amount_sats_str: String, // Safe string representation for JavaScript clients
    pub payment_methods: Vec<String>,
    pub premium: i64,
    pub created_at: u64,
    pub expires_at: Option<u64>,
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
pub struct OrdersSnapshot {
    pub state: MonitorState,
    pub is_stale: bool,
    pub last_update: u64,
    pub source_npub: Option<String>,
    pub relays: Vec<RelayStatus>,
    pub orders: Vec<OrderSummary>,
}

pub struct OrdersCache {
    pub state: MonitorState,
    pub is_stale: bool,
    pub last_update: u64,
    pub npub: Option<String>,
    pub relay_statuses: HashMap<String, RelayStatus>,
    pub events: HashMap<String, Event>,      // keyed by uuid
    pub closed_orders: HashMap<String, u64>, // keyed by uuid -> closed_created_at
    pub generation: u64,
}

impl Default for OrdersCache {
    fn default() -> Self {
        Self::new()
    }
}

impl OrdersCache {
    pub fn new() -> Self {
        Self {
            state: MonitorState::Unconfigured,
            is_stale: false,
            last_update: 0,
            npub: None,
            relay_statuses: HashMap::new(),
            events: HashMap::new(),
            closed_orders: HashMap::new(),
            generation: 0,
        }
    }

    pub fn to_snapshot(&self) -> OrdersSnapshot {
        let now_secs = Timestamp::now().as_secs();
        let mut orders: Vec<OrderSummary> = self
            .events
            .values()
            .filter_map(|e| parse_order_to_summary(e, now_secs))
            .collect();
        // Sort newest first
        orders.sort_by(|a, b| b.created_at.cmp(&a.created_at));

        let mut relays: Vec<RelayStatus> = self.relay_statuses.values().cloned().collect();
        relays.sort_by(|a, b| a.url.cmp(&b.url));

        OrdersSnapshot {
            state: self.state,
            is_stale: self.is_stale,
            last_update: self.last_update,
            source_npub: self.npub.clone(),
            relays,
            orders,
        }
    }

    pub fn clear_for_new_config(&mut self, npub: Option<String>, relays: &[String], gen_id: u64) {
        self.generation = gen_id;
        self.npub = npub.clone();
        self.events.clear();
        self.closed_orders.clear();
        self.relay_statuses.clear();
        self.last_update = Timestamp::now().as_secs();

        if npub.is_none() || relays.is_empty() {
            self.state = MonitorState::Unconfigured;
            self.is_stale = false;
        } else {
            for r in relays {
                self.relay_statuses.insert(
                    r.clone(),
                    RelayStatus {
                        url: r.clone(),
                        state: MonitorState::Connecting,
                        last_error: None,
                    },
                );
            }
            self.state = MonitorState::Connecting;
            self.is_stale = true;
        }
    }

    pub fn compute_aggregate_state(&mut self) {
        if self.npub.is_none() || self.relay_statuses.is_empty() {
            self.state = MonitorState::Unconfigured;
            self.is_stale = false;
            return;
        }

        let mut any_live = false;
        let mut any_syncing = false;
        let mut any_connecting = false;
        let mut any_disconnected = false;

        for r in self.relay_statuses.values() {
            match r.state {
                MonitorState::Live => any_live = true,
                MonitorState::Syncing => any_syncing = true,
                MonitorState::Connecting => any_connecting = true,
                MonitorState::Disconnected => any_disconnected = true,
                MonitorState::Degraded => any_live = true,
                MonitorState::Unconfigured => {}
            }
        }

        if any_live {
            if any_disconnected {
                self.state = MonitorState::Degraded;
            } else {
                self.state = MonitorState::Live;
            }
            self.is_stale = false;
        } else if any_syncing {
            self.state = MonitorState::Syncing;
            self.is_stale = true;
        } else if any_connecting {
            self.state = MonitorState::Connecting;
            self.is_stale = true;
        } else {
            self.state = MonitorState::Disconnected;
            self.is_stale = true;
        }
    }

    pub fn update_relay_status(
        &mut self,
        url: &str,
        state: MonitorState,
        error: Option<String>,
        gen_id: u64,
    ) {
        if gen_id != self.generation {
            return;
        }
        if let Some(r) = self.relay_statuses.get_mut(url) {
            r.state = state;
            r.last_error = error;
        } else {
            self.relay_statuses.insert(
                url.to_string(),
                RelayStatus {
                    url: url.to_string(),
                    state,
                    last_error: error,
                },
            );
        }
        self.compute_aggregate_state();
    }

    pub fn try_insert_event(
        &mut self,
        event: Event,
        uuid: String,
        is_closed: bool,
        gen_id: u64,
    ) -> bool {
        if gen_id != self.generation {
            return false;
        }

        // Tombstone check: if order was previously closed, older replayed pending events are rejected
        if let Some(&closed_at) = self.closed_orders.get(&uuid)
            && !is_closed
            && event.created_at.as_secs() <= closed_at
        {
            return false;
        }

        // Replacement logic: higher created_at, or tie-break lexicographically smaller event.id
        let should_insert = if let Some(existing) = self.events.get(&uuid) {
            if event.created_at > existing.created_at {
                true
            } else if event.created_at == existing.created_at {
                event.id < existing.id
            } else {
                false
            }
        } else {
            true
        };

        if should_insert {
            if is_closed {
                self.closed_orders
                    .insert(uuid.clone(), event.created_at.as_secs());
            }

            if self.events.len() < 1000 || self.events.contains_key(&uuid) {
                self.events.insert(uuid, event);
                self.last_update = Timestamp::now().as_secs();
                return true;
            }
        }
        false
    }
}

pub type SharedOrders = Arc<RwLock<OrdersCache>>;

#[derive(Clone, Debug)]
pub struct MonitorTiming {
    pub connect_timeout: Duration,
    pub eose_timeout: Duration,
    pub ping_interval: Duration,
    pub ping_timeout: Duration,
    pub reconnect_initial: Duration,
    pub reconnect_max: Duration,
    pub max_future_drift_secs: u64,
}

impl Default for MonitorTiming {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_secs(5),
            eose_timeout: Duration::from_secs(5),
            ping_interval: Duration::from_secs(15),
            ping_timeout: Duration::from_secs(5),
            reconnect_initial: Duration::from_millis(500),
            reconnect_max: Duration::from_secs(5),
            max_future_drift_secs: 60,
        }
    }
}

impl MonitorTiming {
    pub fn test_timing() -> Self {
        Self {
            connect_timeout: Duration::from_millis(300),
            eose_timeout: Duration::from_millis(300),
            ping_interval: Duration::from_millis(200),
            ping_timeout: Duration::from_millis(150),
            reconnect_initial: Duration::from_millis(30),
            reconnect_max: Duration::from_millis(100),
            max_future_drift_secs: 60,
        }
    }
}

pub fn is_valid_uuid(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (i, &b) in bytes.iter().enumerate() {
        if i == 8 || i == 13 || i == 18 || i == 23 {
            if b != b'-' {
                return false;
            }
        } else if !b.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

pub fn is_valid_status(status: &str) -> bool {
    matches!(
        status,
        "pending"
            | "waiting-buyer-invoice"
            | "waiting_buyer_invoice"
            | "waiting-payment"
            | "waiting_payment"
            | "settled-hold-invoice"
            | "settled_hold_invoice"
            | "canceled"
            | "success"
            | "dispute"
            | "failed"
            | "expired"
            | "completed"
    )
}

pub fn is_closed_status(status: &str) -> bool {
    matches!(
        status,
        "canceled" | "success" | "completed" | "failed" | "expired"
    )
}

/// Parses and strictly validates a Nostr Kind 38383 order event against upstream protocol rules.
pub fn parse_and_validate_order_event(
    event: &Event,
    expected_pubkey: &PublicKey,
    now_secs: u64,
    max_future_drift_secs: u64,
) -> Result<(OrderSummary, bool), &'static str> {
    event.verify().map_err(|_| "Firma criptográfica inválida")?;

    if event.pubkey != *expected_pubkey {
        return Err("Autor del evento no corresponde a la identidad esperada");
    }

    if event.kind.as_u16() != 38383 {
        return Err("Kind de evento no es 38383");
    }

    if event.created_at.as_secs() > now_secs.saturating_add(max_future_drift_secs) {
        return Err("Timestamp del evento en el futuro fuera de tolerancia");
    }

    let mut id = None;
    let mut kind = None;
    let mut status = None;
    let mut fiat_code = None;
    let mut fiat_amount_range = Vec::new();
    let mut amount_sats: u64 = 0;
    let mut payment_methods = Vec::new();
    let mut premium: i64 = 0;
    let mut expires_at = None;
    let mut expiration_nip40 = None;
    let mut has_y_mostro = false;
    let mut has_z_order = false;

    for tag in event.tags.iter() {
        let s = tag.as_slice();
        if s.len() >= 2 {
            match s[0].as_str() {
                "y" if s[1] == "mostro" => has_y_mostro = true,
                "z" if s[1] == "order" => has_z_order = true,
                "d" => {
                    let uuid_candidate = &s[1];
                    if is_valid_uuid(uuid_candidate) {
                        id = Some(uuid_candidate.clone());
                    } else {
                        return Err("Tag d no contiene un UUID válido");
                    }
                }
                "k" => {
                    let k = s[1].to_lowercase();
                    if k == "buy" || k == "sell" {
                        kind = Some(k);
                    } else {
                        return Err("Tag k no es 'buy' ni 'sell'");
                    }
                }
                "s" => {
                    let st = s[1].to_lowercase();
                    if is_valid_status(&st) {
                        status = Some(st);
                    } else {
                        return Err("Tag s no contiene un estado de orden válido");
                    }
                }
                "f" => {
                    let f = s[1].to_uppercase();
                    if f.len() == 3 && f.bytes().all(|b| b.is_ascii_uppercase()) {
                        fiat_code = Some(f);
                    }
                }
                "fa" => {
                    fiat_amount_range = s[1..].iter().map(|item| item.to_string()).collect();
                }
                "amt" => {
                    if let Ok(parsed) = s[1].parse::<u64>() {
                        if parsed <= JS_MAX_SAFE_INTEGER {
                            amount_sats = parsed;
                        } else {
                            return Err("Monto de satoshis excede el límite seguro de precisión");
                        }
                    }
                }
                "pm" => {
                    payment_methods = s[1..].iter().map(|item| item.to_string()).collect();
                }
                "premium" => {
                    if let Ok(p) = s[1].parse::<i64>() {
                        premium = p;
                    }
                }
                "expires_at" => {
                    expires_at = s[1].parse::<u64>().ok();
                }
                "expiration" => {
                    expiration_nip40 = s[1].parse::<u64>().ok();
                }
                _ => {}
            }
        }
    }

    if !has_y_mostro || !has_z_order {
        return Err("Faltan tags obligatorios y=mostro o z=order");
    }

    let id = id.ok_or("Falta tag d con UUID")?;
    let kind = kind.ok_or("Falta tag k (buy/sell)")?;
    let status = status.ok_or("Falta tag s con estado")?;
    let fiat_code = fiat_code.unwrap_or_else(|| "EUR".to_string());

    // NIP-40 expiration check
    if let Some(exp) = expiration_nip40
        && exp <= now_secs
    {
        return Err("Evento expirado según NIP-40");
    }

    // Mostro internal expires_at check: pending offers expired in the past are not active
    if status == "pending"
        && let Some(exp) = expires_at
        && exp <= now_secs
    {
        return Err("Oferta expirada según expires_at");
    }

    let is_closed = is_closed_status(&status);

    Ok((
        OrderSummary {
            id,
            event_id: event.id.to_hex(),
            kind,
            status,
            fiat_code,
            fiat_amount_range,
            amount_sats,
            amount_sats_str: amount_sats.to_string(),
            payment_methods,
            premium,
            created_at: event.created_at.as_secs(),
            expires_at,
        },
        is_closed,
    ))
}

fn parse_order_to_summary(event: &Event, now_secs: u64) -> Option<OrderSummary> {
    let mut id: Option<String> = None;
    let mut kind: Option<String> = None;
    let mut status: Option<String> = None;
    let mut fiat_code: Option<String> = None;
    let mut fiat_amount_range = Vec::new();
    let mut amount_sats: u64 = 0;
    let mut payment_methods = Vec::new();
    let mut premium: i64 = 0;
    let mut expires_at: Option<u64> = None;
    let mut expiration_nip40: Option<u64> = None;

    for tag in event.tags.iter() {
        let s = tag.as_slice();
        if s.len() >= 2 {
            match s[0].as_str() {
                "d" => id = Some(s[1].clone()),
                "k" => kind = Some(s[1].clone()),
                "s" => status = Some(s[1].clone()),
                "f" => fiat_code = Some(s[1].clone()),
                "fa" => fiat_amount_range = s[1..].iter().map(|item| item.to_string()).collect(),
                "amt" => amount_sats = s[1].parse().unwrap_or(0),
                "pm" => payment_methods = s[1..].iter().map(|item| item.to_string()).collect(),
                "premium" => premium = s[1].parse().unwrap_or(0),
                "expires_at" => expires_at = s[1].parse().ok(),
                "expiration" => expiration_nip40 = s[1].parse().ok(),
                _ => {}
            }
        }
    }

    let status = status?;
    if let Some(exp) = expiration_nip40
        && exp <= now_secs
    {
        return None;
    }
    if status == "pending"
        && let Some(exp) = expires_at
        && exp <= now_secs
    {
        return None;
    }

    Some(OrderSummary {
        id: id?,
        event_id: event.id.to_hex(),
        kind: kind?,
        status,
        fiat_code: fiat_code.unwrap_or_else(|| "EUR".to_string()),
        fiat_amount_range,
        amount_sats,
        amount_sats_str: amount_sats.to_string(),
        payment_methods,
        premium,
        created_at: event.created_at.as_secs(),
        expires_at,
    })
}

#[derive(Clone, Debug)]
pub struct MonitorCommand {
    pub config: Configuration,
    pub npub: Option<String>,
}

async fn run_relay_worker(
    relay_url: String,
    pubkey: PublicKey,
    cache: SharedOrders,
    generation: u64,
    timing: MonitorTiming,
) {
    let mut reconnect_delay = timing.reconnect_initial;

    loop {
        {
            let mut w = cache.write().await;
            w.update_relay_status(&relay_url, MonitorState::Connecting, None, generation);
        }

        let connect_fut = connect_async(&relay_url);
        let ws_res = tokio::time::timeout(timing.connect_timeout, connect_fut).await;

        let mut ws_stream = match ws_res {
            Ok(Ok((ws, _))) => ws,
            Ok(Err(e)) => {
                {
                    let mut w = cache.write().await;
                    w.update_relay_status(
                        &relay_url,
                        MonitorState::Disconnected,
                        Some(format!("Fallo de conexión: {e}")),
                        generation,
                    );
                }
                tokio::time::sleep(reconnect_delay).await;
                reconnect_delay = (reconnect_delay * 2).min(timing.reconnect_max);
                continue;
            }
            Err(_) => {
                {
                    let mut w = cache.write().await;
                    w.update_relay_status(
                        &relay_url,
                        MonitorState::Disconnected,
                        Some("Timeout en conexión a relay".into()),
                        generation,
                    );
                }
                tokio::time::sleep(reconnect_delay).await;
                reconnect_delay = (reconnect_delay * 2).min(timing.reconnect_max);
                continue;
            }
        };

        // Reset reconnect delay on successful connection
        reconnect_delay = timing.reconnect_initial;

        {
            let mut w = cache.write().await;
            w.update_relay_status(&relay_url, MonitorState::Syncing, None, generation);
        }

        // Send REQ filter with hex author
        let req_msg = format!(
            "[\"REQ\", \"mostro_monitor\", {{\"kinds\": [38383], \"authors\": [\"{}\"]}}]",
            pubkey.to_hex()
        );

        if ws_stream.send(Message::Text(req_msg.into())).await.is_err() {
            let mut w = cache.write().await;
            w.update_relay_status(
                &relay_url,
                MonitorState::Disconnected,
                Some("Fallo al enviar suscripción REQ".into()),
                generation,
            );
            tokio::time::sleep(reconnect_delay).await;
            continue;
        }

        let mut ping_interval = tokio::time::interval(timing.ping_interval);
        ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        let mut eose_received = false;
        let mut eose_deadline = Box::pin(tokio::time::sleep(timing.eose_timeout));

        loop {
            tokio::select! {
                _ = ping_interval.tick() => {
                    let ping_payload = vec![1, 2, 3, 4];
                    if ws_stream.send(Message::Ping(ping_payload.into())).await.is_err() {
                        break;
                    }
                }
                _ = &mut eose_deadline, if !eose_received => {
                    // EOSE timed out; mark live to avoid hanging sync forever
                    eose_received = true;
                    let mut w = cache.write().await;
                    w.update_relay_status(&relay_url, MonitorState::Live, None, generation);
                }
                msg_opt = ws_stream.next() => {
                    match msg_opt {
                        Some(Ok(Message::Text(text))) => {
                            if text.len() > MAX_WS_FRAME_SIZE {
                                continue;
                            }
                            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text)
                                && let Some(arr) = value.as_array()
                            {
                                if arr.len() >= 3 && arr[0] == "EVENT" && arr[1] == "mostro_monitor" {
                                    if let Ok(event) = serde_json::from_value::<Event>(arr[2].clone()) {
                                        let now = Timestamp::now().as_secs();
                                        if let Ok((summary, is_closed)) = parse_and_validate_order_event(
                                            &event,
                                            &pubkey,
                                            now,
                                            timing.max_future_drift_secs,
                                        ) {
                                            let mut w = cache.write().await;
                                            w.try_insert_event(event, summary.id, is_closed, generation);
                                        }
                                    }
                                } else if arr.len() >= 2 && arr[0] == "EOSE" && arr[1] == "mostro_monitor" {
                                    eose_received = true;
                                    let mut w = cache.write().await;
                                    w.update_relay_status(&relay_url, MonitorState::Live, None, generation);
                                }
                            }
                        }
                        Some(Ok(Message::Ping(p))) => {
                            let _ = ws_stream.send(Message::Pong(p)).await;
                        }
                        Some(Ok(Message::Pong(_))) => {}
                        Some(Ok(Message::Close(_))) | None => {
                            break;
                        }
                        Some(Err(_)) => {
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }

        // Clean close attempt
        let _ = ws_stream
            .send(Message::Text("[\"CLOSE\", \"mostro_monitor\"]".into()))
            .await;
        let _ = ws_stream.close(None).await;

        {
            let mut w = cache.write().await;
            w.update_relay_status(
                &relay_url,
                MonitorState::Disconnected,
                Some("Conexión finalizada o interrumpida".into()),
                generation,
            );
        }

        tokio::time::sleep(reconnect_delay).await;
        reconnect_delay = (reconnect_delay * 2).min(timing.reconnect_max);
    }
}

pub async fn monitor_worker(
    cache: SharedOrders,
    mut config_rx: watch::Receiver<MonitorCommand>,
    timing: MonitorTiming,
) {
    let mut current_generation: u64 = 0;
    let mut relay_handles: Vec<JoinHandle<()>> = Vec::new();
    let mut last_npub: Option<String> = None;
    let mut last_relays: Vec<String> = Vec::new();

    loop {
        let cmd = config_rx.borrow_and_update().clone();
        let npub_changed = cmd.npub != last_npub;
        let relays_changed = cmd.config.nostr.relays != last_relays;

        if npub_changed || relays_changed || current_generation == 0 {
            for h in relay_handles.drain(..) {
                h.abort();
            }

            current_generation = current_generation.wrapping_add(1);
            last_npub = cmd.npub.clone();
            last_relays = cmd.config.nostr.relays.clone();

            {
                let mut w = cache.write().await;
                w.clear_for_new_config(
                    cmd.npub.clone(),
                    &cmd.config.nostr.relays,
                    current_generation,
                );
            }

            if let (Some(npub_str), false) = (&cmd.npub, cmd.config.nostr.relays.is_empty())
                && let Ok(pubkey) = PublicKey::from_bech32(npub_str)
            {
                for relay_url in cmd.config.nostr.relays.clone() {
                    let h = tokio::spawn(run_relay_worker(
                        relay_url,
                        pubkey,
                        cache.clone(),
                        current_generation,
                        timing.clone(),
                    ));
                    relay_handles.push(h);
                }
            }
        }

        if config_rx.changed().await.is_err() {
            break;
        }
    }

    for h in relay_handles {
        h.abort();
    }
}

pub async fn get_orders_handler(State(state): State<AppState>) -> Json<OrdersSnapshot> {
    let r = state.orders.read().await;
    Json(r.to_snapshot())
}
