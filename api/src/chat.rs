//! Protocol-message timeline for the mediation console (Mostro transport v2).
//!
//! mostrod v0.19.x speaks a single wire transport: signed kind 14 events whose
//! content is NIP-44 v2 ciphertext between a user's trade key and the node
//! key. Holding the node identity, this module reads exactly that traffic:
//! what users ask the daemon and what the daemon answers.
//!
//! It cannot read the buyer↔seller chat nor the solver↔party dispute chat.
//! Those are encrypted between keys the node never holds, so the console shows
//! the protocol history of an order, not the conversation between the parties.
//!
//! Anyone can publish a kind 14 event addressed to the node, so nothing sent
//! by a user is trusted on its own: a thread exists only once the daemon has
//! answered about that order, and a user message is marked as acknowledged
//! only when the daemon addressed that same key about it.
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use futures_util::{SinkExt, StreamExt};
use nostr::{
    Event, EventBuilder, FromBech32, Keys, Kind, PublicKey, Tag, Timestamp, ToBech32, nips::nip44,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::PathBuf,
    sync::Arc,
};
use tokio::sync::{RwLock, watch};
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};

use crate::{
    AppState, Error, error, identity,
    orders::{MAX_WS_FRAME_SIZE, MonitorCommand, MonitorTiming, is_valid_uuid},
    verify_protection,
};

/// The only kind mostrod v0.19.x publishes and subscribes to for messages.
pub const PROTOCOL_MESSAGE_KIND: u16 = 14;
/// Top-level keys of a mostro-core 0.16 `Message`.
pub const MESSAGE_VARIANTS: [&str; 6] = ["order", "dispute", "cant-do", "rate", "dm", "restore"];

const MAX_ORDERS: usize = 1000;
const MAX_NODE_MESSAGES_PER_ORDER: usize = 500;
const MAX_USER_MESSAGES_PER_ORDER: usize = 300;
const MAX_ORPHANS: usize = 2000;
const MAX_ORPHANS_PER_SENDER: usize = 50;
/// Refusals kept per order. They are the only node messages a stranger can
/// provoke at will, so they never compete with the real history for room.
const MAX_REFUSALS_PER_ORDER: usize = 20;
/// Admin messages that name a dispute whose order is not known yet.
const MAX_PENDING_DISPUTE_MESSAGES: usize = 200;
/// Requests a solver sends to the daemon. When the solver uses the node key
/// these are signed by the node and addressed to the node, exactly like the
/// daemon's answers to them, so the action is what tells them apart.
const ADMIN_REQUEST_ACTIONS: [&str; 4] = [
    "admin-take-dispute",
    "admin-settle",
    "admin-cancel",
    "admin-add-solver",
];
/// A user message cannot predate the daemon's first message about its order
/// by more than this: the daemon itself drops requests older than 10 s.
const USER_BACKDATE_MARGIN_SECS: u64 = 60;
const MAX_PLAINTEXT_BYTES: usize = 64 * 1024;
const MAX_FUTURE_DRIFT_SECS: u64 = 60;
/// Daemon messages carry a NIP-40 expiration of `dm_days` (30 in the template).
const HISTORY_WINDOW_SECS: u64 = 30 * 86_400;
const HISTORY_LIMIT_PER_FILTER: usize = 2000;

/// Who authored a protocol message, as far as the node key can tell.
pub const ROLE_DAEMON: &str = "daemon";
pub const ROLE_USER: &str = "user";
/// A solver's request (`admin-take-dispute`, `admin-settle`, ...) signed with
/// the node key and addressed to the node. The daemon's answers to it are
/// [`ROLE_DAEMON`].
pub const ROLE_ADMIN: &str = "admin";

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
pub struct ChatMessage {
    pub id: String,
    pub order_id: String,
    pub sender: String,
    pub recipient: Option<String>,
    pub created_at: u64,
    pub kind: u16,
    pub action: Option<String>,
    /// Sanitised summary. Never the raw plaintext: invoices are shortened and
    /// signatures and identity proofs are left out.
    pub content: String,
    /// Signed by the node key (the daemon, or an admin using the node key).
    pub is_from_me: bool,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub variant: String,
    #[serde(default)]
    pub dispute_id: Option<String>,
    /// For user messages: the daemon addressed this same key about this order.
    #[serde(default)]
    pub acknowledged: bool,
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
pub struct ChatHistory {
    pub order_id: String,
    pub messages: Vec<ChatMessage>,
    pub count: usize,
    #[serde(default)]
    pub dispute_id: Option<String>,
}

/// Link between a public dispute (kind 38386 carries only the dispute id) and
/// its order, learned from the daemon's own messages.
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
pub struct DisputeLink {
    pub dispute_id: String,
    pub order_id: String,
}

/// A decoded protocol message, before it is attributed to an order.
#[derive(Clone, Debug, PartialEq)]
pub struct ProtocolMessage {
    pub variant: String,
    pub action: String,
    pub id: Option<String>,
    pub payload: Value,
}

#[derive(Clone, Debug, Default)]
struct OrderThread {
    messages: Vec<ChatMessage>,
    /// Hex pubkeys the daemon addressed about this order (cant-do excluded).
    participants: HashSet<String>,
    dispute_id: Option<String>,
    last_activity: u64,
}

#[derive(Clone, Debug)]
struct Orphan {
    message: ChatMessage,
    sender_hex: String,
}

/// A message that names only a dispute, waiting for the daemon message that
/// reveals which order the dispute belongs to.
#[derive(Clone, Debug)]
struct PendingDisputeMessage {
    dispute_id: String,
    message: ChatMessage,
    sender_hex: String,
}

fn is_refusal(message: &ChatMessage) -> bool {
    message.variant == "cant-do" || message.action.as_deref() == Some("cant-do")
}

#[derive(Clone, Debug, Default)]
pub struct ChatCache {
    threads: HashMap<String, OrderThread>,
    /// User messages that arrived before any daemon message for their order.
    orphans: VecDeque<Orphan>,
    pending_dispute_messages: VecDeque<PendingDisputeMessage>,
    order_by_dispute: HashMap<String, String>,
}

impl ChatCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn order_count(&self) -> usize {
        self.threads.len()
    }

    pub fn orphan_count(&self) -> usize {
        self.orphans.len()
    }

    /// Stores a message signed by the node key.
    ///
    /// `opens_thread` is false for refusals: a `cant-do` echoes whatever order
    /// id the requester wrote, so letting it open a thread would let anyone
    /// create threads for arbitrary ids and push the real ones out.
    /// `addressed_to` is the hex pubkey the daemon wrote to, when the message
    /// proves that key takes part in the order.
    pub fn insert_node_message(
        &mut self,
        message: ChatMessage,
        addressed_to: Option<String>,
        opens_thread: bool,
    ) -> bool {
        match self.threads.get(&message.order_id) {
            Some(thread) if thread.messages.iter().any(|m| m.id == message.id) => return false,
            Some(_) => {}
            None if !opens_thread => return false,
            None => {
                if self.threads.len() >= MAX_ORDERS {
                    self.evict_one_thread();
                }
            }
        }
        let order_id = message.order_id.clone();
        if let Some(dispute_id) = message.dispute_id.clone() {
            self.order_by_dispute.insert(dispute_id, order_id.clone());
        }
        let thread = self.threads.entry(order_id.clone()).or_default();
        if let Some(dispute_id) = &message.dispute_id {
            thread.dispute_id = Some(dispute_id.clone());
        }
        if let Some(pubkey) = addressed_to {
            thread.participants.insert(pubkey);
        }
        thread.last_activity = thread.last_activity.max(message.created_at);
        if is_refusal(&message) {
            // Refusals have their own small allowance: a flood of them only
            // replaces older refusals, never the history of the trade.
            let refusals = thread.messages.iter().filter(|m| is_refusal(m)).count();
            if refusals >= MAX_REFUSALS_PER_ORDER
                && let Some(oldest) = thread.messages.iter().position(is_refusal)
            {
                thread.messages.remove(oldest);
            }
        } else {
            let node_messages = thread
                .messages
                .iter()
                .filter(|m| m.is_from_me && !is_refusal(m))
                .count();
            if node_messages >= MAX_NODE_MESSAGES_PER_ORDER
                && let Some(oldest) = thread
                    .messages
                    .iter()
                    .position(|m| m.is_from_me && !is_refusal(m))
            {
                thread.messages.remove(oldest);
            }
        }
        let linked_dispute = message.dispute_id.clone();
        thread.messages.push(message);
        sort_timeline(&mut thread.messages);
        self.adopt_orphans(&order_id);
        if let Some(dispute_id) = linked_dispute {
            self.adopt_pending_dispute_messages(&dispute_id, &order_id);
        }
        true
    }

    /// Parks a message that names a dispute whose order is still unknown.
    /// Relays deliver history in no particular order, so the admin's request
    /// can arrive before the daemon message that links dispute and order.
    pub fn park_dispute_message(
        &mut self,
        dispute_id: String,
        message: ChatMessage,
        sender_hex: String,
    ) -> bool {
        if self
            .pending_dispute_messages
            .iter()
            .any(|pending| pending.message.id == message.id)
        {
            return false;
        }
        if self.pending_dispute_messages.len() >= MAX_PENDING_DISPUTE_MESSAGES {
            // Anyone can send such a message; one signed by the node key is
            // the last to make room.
            match self
                .pending_dispute_messages
                .iter()
                .position(|pending| !pending.message.is_from_me)
            {
                Some(index) => {
                    self.pending_dispute_messages.remove(index);
                }
                None => {
                    self.pending_dispute_messages.pop_front();
                }
            }
        }
        self.pending_dispute_messages
            .push_back(PendingDisputeMessage {
                dispute_id,
                message,
                sender_hex,
            });
        true
    }

    fn adopt_pending_dispute_messages(&mut self, dispute_id: &str, order_id: &str) {
        if !self
            .pending_dispute_messages
            .iter()
            .any(|pending| pending.dispute_id == dispute_id)
        {
            return;
        }
        let (adopted, rest): (Vec<PendingDisputeMessage>, Vec<PendingDisputeMessage>) = self
            .pending_dispute_messages
            .drain(..)
            .partition(|pending| pending.dispute_id == dispute_id);
        self.pending_dispute_messages = rest.into();
        for pending in adopted {
            let mut message = pending.message;
            message.order_id = order_id.to_string();
            if message.is_from_me {
                self.insert_node_message(message, None, false);
            } else {
                self.insert_user_message(message, pending.sender_hex);
            }
        }
    }

    /// Stores a message sent by a user. Without a thread it waits as an orphan:
    /// a third party must not be able to open threads for arbitrary order ids.
    pub fn insert_user_message(&mut self, message: ChatMessage, sender_hex: String) -> bool {
        if let Some(thread) = self.threads.get(&message.order_id) {
            if thread.messages.iter().any(|m| m.id == message.id) {
                return false;
            }
            self.push_user_message(message);
            return true;
        }
        if self.orphans.iter().any(|o| o.message.id == message.id) {
            return false;
        }
        // One key cannot fill the waiting room on its own.
        let from_sender = self
            .orphans
            .iter()
            .filter(|o| o.sender_hex == sender_hex)
            .count();
        if from_sender >= MAX_ORPHANS_PER_SENDER
            && let Some(oldest) = self.orphans.iter().position(|o| o.sender_hex == sender_hex)
        {
            self.orphans.remove(oldest);
        }
        if self.orphans.len() >= MAX_ORPHANS {
            self.orphans.pop_front();
        }
        self.orphans.push_back(Orphan {
            message,
            sender_hex,
        });
        true
    }

    fn push_user_message(&mut self, message: ChatMessage) {
        let Some(thread) = self.threads.get_mut(&message.order_id) else {
            return;
        };
        let user_messages = thread.messages.iter().filter(|m| !m.is_from_me).count();
        if user_messages >= MAX_USER_MESSAGES_PER_ORDER {
            // Drop junk first: the oldest message from a key the daemon never
            // answered. Only then the oldest user message.
            let participants = &thread.participants;
            let victim = thread
                .messages
                .iter()
                .position(|m| !m.is_from_me && !sender_is_participant(participants, &m.sender))
                .or_else(|| thread.messages.iter().position(|m| !m.is_from_me));
            if let Some(index) = victim {
                thread.messages.remove(index);
            }
        }
        thread.messages.push(message);
        sort_timeline(&mut thread.messages);
    }

    fn adopt_orphans(&mut self, order_id: &str) {
        if !self.orphans.iter().any(|o| o.message.order_id == order_id) {
            return;
        }
        let (adopted, rest): (Vec<Orphan>, Vec<Orphan>) = self
            .orphans
            .drain(..)
            .partition(|o| o.message.order_id == order_id);
        self.orphans = rest.into();
        for orphan in adopted {
            self.push_user_message(orphan.message);
        }
    }

    /// Makes room for a new thread. Threads linked to a dispute are the ones
    /// the operator needs, so they leave last; among the rest, the stalest.
    fn evict_one_thread(&mut self) {
        let victim = self
            .threads
            .iter()
            .min_by_key(|(_, thread)| (thread.dispute_id.is_some(), thread.last_activity))
            .map(|(id, _)| id.clone());
        if let Some(id) = victim {
            self.threads.remove(&id);
            self.order_by_dispute.retain(|_, order| *order != id);
        }
    }

    pub fn get_messages(&self, order_id: &str) -> Vec<ChatMessage> {
        let Some(thread) = self.threads.get(order_id) else {
            return Vec::new();
        };
        // The daemon only acts on requests at most 10 s old, and every order
        // starts with a daemon message. A user message dated before that was
        // never part of the trade: it is a backdated event from someone trying
        // to plant history.
        let earliest_user = thread
            .messages
            .iter()
            .filter(|m| m.is_from_me)
            .map(|m| m.created_at)
            .min()
            .map(|first| first.saturating_sub(USER_BACKDATE_MARGIN_SECS));
        thread
            .messages
            .iter()
            .filter(|m| m.is_from_me || earliest_user.is_some_and(|floor| m.created_at >= floor))
            .cloned()
            .map(|mut message| {
                message.acknowledged = message.is_from_me
                    || sender_is_participant(&thread.participants, &message.sender);
                message
            })
            .collect()
    }

    pub fn to_history(&self, order_id: &str) -> ChatHistory {
        let messages = self.get_messages(order_id);
        ChatHistory {
            order_id: order_id.to_string(),
            count: messages.len(),
            dispute_id: self
                .threads
                .get(order_id)
                .and_then(|thread| thread.dispute_id.clone()),
            messages,
        }
    }

    pub fn order_for_dispute(&self, dispute_id: &str) -> Option<String> {
        self.order_by_dispute.get(dispute_id).cloned()
    }

    pub fn dispute_links(&self) -> Vec<DisputeLink> {
        let mut links: Vec<DisputeLink> = self
            .order_by_dispute
            .iter()
            .map(|(dispute_id, order_id)| DisputeLink {
                dispute_id: dispute_id.clone(),
                order_id: order_id.clone(),
            })
            .collect();
        links.sort_by(|a, b| a.dispute_id.cmp(&b.dispute_id));
        links
    }

    pub fn clear(&mut self) {
        *self = Self::default();
    }
}

fn sender_is_participant(participants: &HashSet<String>, sender_npub: &str) -> bool {
    PublicKey::from_bech32(sender_npub).is_ok_and(|pk| participants.contains(&pk.to_hex()))
}

pub type SharedChatCache = Arc<RwLock<ChatCache>>;

/// Decrypt NIP-44 ciphertext.
pub fn decrypt_nip44(
    my_secret_key: &nostr::SecretKey,
    counterparty_pubkey: &PublicKey,
    ciphertext: &str,
) -> Result<String, String> {
    nip44::decrypt(my_secret_key, counterparty_pubkey, ciphertext)
        .map_err(|e| format!("Error al descifrar NIP-44: {e}"))
}

/// Helper to extract recipient public key from the first 'p' tag.
pub fn extract_recipient_from_p_tag<'a, I>(tags: I) -> Option<PublicKey>
where
    I: IntoIterator<Item = &'a Tag>,
{
    for tag in tags {
        let s = tag.as_slice();
        if s.len() >= 2 && s[0] == "p" {
            return PublicKey::from_hex(&s[1]).ok();
        }
    }
    None
}

fn is_action_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 48
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Parses the plaintext of a protocol-v2 message: the JSON tuple
/// `[message, trade_signature | null, identity_proof | null]` whose first
/// element is `{"<variant>": {"version", "action", "id"?, "payload"?, ...}}`.
pub fn parse_protocol_plaintext(plaintext: &str) -> Result<ProtocolMessage, &'static str> {
    if plaintext.len() > MAX_PLAINTEXT_BYTES {
        return Err("Mensaje demasiado grande");
    }
    let tuple: Value = serde_json::from_str(plaintext).map_err(|_| "Mensaje no es JSON")?;
    let elements = tuple.as_array().ok_or("Mensaje no es una tupla")?;
    if elements.len() != 3 {
        return Err("La tupla del protocolo v2 tiene tres elementos");
    }
    let wrapper = elements[0].as_object().ok_or("Falta el mensaje")?;
    if wrapper.len() != 1 {
        return Err("El mensaje debe tener una sola variante");
    }
    let (variant, inner) = wrapper.iter().next().ok_or("Falta el mensaje")?;
    if !MESSAGE_VARIANTS.contains(&variant.as_str()) {
        return Err("Variante de mensaje desconocida");
    }
    let inner = inner.as_object().ok_or("Mensaje sin contenido")?;
    if !inner.get("version").is_some_and(Value::is_u64) {
        return Err("Falta la versión del protocolo");
    }
    let action = inner
        .get("action")
        .and_then(Value::as_str)
        .filter(|a| is_action_name(a))
        .ok_or("Falta la acción")?;
    let id = match inner.get("id") {
        None | Some(Value::Null) => None,
        Some(Value::String(id)) if is_valid_uuid(id) => Some(id.clone()),
        Some(_) => return Err("Identificador inválido"),
    };
    Ok(ProtocolMessage {
        variant: variant.clone(),
        action: action.to_string(),
        id,
        payload: inner.get("payload").cloned().unwrap_or(Value::Null),
    })
}

/// Order and dispute a message refers to. Admin messages of the `dispute`
/// variant carry the dispute id in `id`; every other message carries the order.
pub fn attribute_message(
    message: &ProtocolMessage,
    cache: &ChatCache,
) -> (Option<String>, Option<String>) {
    let payload_dispute = message.payload.get("dispute").and_then(Value::as_array);
    let dispute_from_payload = payload_dispute
        .and_then(|d| d.first())
        .and_then(Value::as_str)
        .filter(|id| is_valid_uuid(id))
        .map(str::to_string);

    if message.variant == "dispute" && message.action.starts_with("admin-") {
        let dispute_id = message.id.clone().or(dispute_from_payload);
        let order_from_payload = payload_dispute
            .and_then(|d| d.get(1))
            .and_then(|info| info.get("id"))
            .and_then(Value::as_str)
            .filter(|id| is_valid_uuid(id))
            .map(str::to_string);
        let order_id = order_from_payload.or_else(|| {
            dispute_id
                .as_deref()
                .and_then(|id| cache.order_for_dispute(id))
        });
        return (order_id, dispute_id);
    }
    (message.id.clone(), dispute_from_payload)
}

fn shorten(value: &str, keep: usize) -> String {
    let mut out: String = value.chars().take(keep).collect();
    if value.chars().count() > keep {
        out.push('…');
    }
    out
}

fn summarize_order(order: &Value) -> String {
    let text = |key: &str| order.get(key).and_then(Value::as_str);
    let number = |key: &str| order.get(key).and_then(Value::as_i64);
    let mut parts = Vec::new();
    if let Some(kind) = text("kind") {
        parts.push(match kind {
            "buy" => "compra".to_string(),
            "sell" => "venta".to_string(),
            other => shorten(other, 16),
        });
    }
    if let Some(status) = text("status") {
        parts.push(format!("estado {}", shorten(status, 32)));
    }
    let code = text("fiat_code").map(|c| shorten(c, 8)).unwrap_or_default();
    match (number("min_amount"), number("max_amount")) {
        (Some(min), Some(max)) => parts.push(format!("{min}–{max} {code}")),
        _ => {
            if let Some(fiat) = number("fiat_amount") {
                parts.push(format!("{fiat} {code}"));
            }
        }
    }
    match number("amount") {
        Some(0) => parts.push("a precio de mercado".to_string()),
        Some(sats) => parts.push(format!("{sats} sats")),
        None => {}
    }
    if let Some(premium) = number("premium").filter(|p| *p != 0) {
        parts.push(format!("prima {premium:+} %"));
    }
    if let Some(method) = text("payment_method") {
        parts.push(shorten(method, 60));
    }
    parts.join(" · ")
}

/// Human summary of a payload. Built from known fields only so that nothing a
/// sender writes is echoed verbatim, except the text of a direct message.
pub fn summarize_payload(payload: &Value) -> String {
    let Some(object) = payload.as_object() else {
        return String::new();
    };
    let Some((key, value)) = object.iter().next() else {
        return String::new();
    };
    match key.as_str() {
        "order" => summarize_order(value),
        "payment_request" => {
            let parts = value.as_array().map(Vec::as_slice).unwrap_or_default();
            let mut out = Vec::new();
            if let Some(order) = parts.first().filter(|o| o.is_object()) {
                out.push(summarize_order(order));
            }
            if let Some(invoice) = parts.get(1).and_then(Value::as_str) {
                out.push(format!("factura Lightning {}", shorten(invoice, 14)));
            }
            if let Some(amount) = parts.get(2).and_then(Value::as_i64) {
                out.push(format!("{amount} sats"));
            }
            out.join(" · ")
        }
        "cant_do" => match value.as_str() {
            Some(reason) => format!("motivo: {}", shorten(reason, 48)),
            None => "sin motivo".to_string(),
        },
        "dispute" => {
            let parts = value.as_array().map(Vec::as_slice).unwrap_or_default();
            let id = parts.first().and_then(Value::as_str).unwrap_or("");
            let mut out = format!("disputa {}", shorten(id, 36));
            if let Some(status) = parts
                .get(1)
                .and_then(|info| info.get("status"))
                .and_then(Value::as_str)
            {
                out.push_str(&format!(" · orden en estado {}", shorten(status, 32)));
            }
            out
        }
        "peer" => {
            let pubkey = value.get("pubkey").and_then(Value::as_str).unwrap_or("");
            let mut out = if pubkey.is_empty() {
                "contraparte".to_string()
            } else {
                format!("contraparte {}", shorten(pubkey, 12))
            };
            if let Some(reputation) = value.get("reputation").filter(|r| r.is_object()) {
                let rating = reputation
                    .get("rating")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                let reviews = reputation
                    .get("reviews")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                out.push_str(&format!(
                    " · reputación {rating:.1} en {reviews} valoraciones"
                ));
            }
            out
        }
        "rating_user" => match value.as_u64() {
            Some(rating) => format!("valoración {rating}"),
            None => "valoración".to_string(),
        },
        "amount" => match value.as_i64() {
            Some(amount) => format!("{amount} sats"),
            None => String::new(),
        },
        "text_message" => value.as_str().map(|t| shorten(t, 500)).unwrap_or_default(),
        // A solver's decision about the anti-abuse bonds, sent with
        // `admin-settle` or `admin-cancel`.
        "bond_resolution" => {
            let slash = |side: &str| value.get(side).and_then(Value::as_bool).unwrap_or(false);
            match (slash("slash_seller"), slash("slash_buyer")) {
                (true, true) => "ejecuta las garantías de ambas partes",
                (true, false) => "ejecuta la garantía del vendedor",
                (false, true) => "ejecuta la garantía del comprador",
                (false, false) => "sin ejecutar garantías",
            }
            .to_string()
        }
        // The daemon asks the winner of a slashed bond for an invoice.
        "bond_payout_request" => {
            match value
                .get("order")
                .and_then(|order| order.get("amount"))
                .and_then(Value::as_i64)
            {
                Some(sats) => format!("garantía ejecutada: {sats} sats a reclamar con una factura"),
                None => "garantía ejecutada: parte a reclamar con una factura".to_string(),
            }
        }
        "payment_failed" => {
            let number = |key: &str| value.get(key).and_then(Value::as_u64).unwrap_or(0);
            format!(
                "pago al comprador fallido: {} intentos, uno cada {} s",
                number("payment_attempts"),
                number("payment_retries_interval")
            )
        }
        other => format!("datos: {}", shorten(other, 32)),
    }
}

/// Where a daemon message sits in the flow of a trade. Only used to order the
/// messages the daemon sends within one second, which relays deliver in no
/// particular order: the bond comes before the order it guards, the escrow
/// before the payout, a resolution before what it triggers.
fn daemon_flow_rank(action: Option<&str>) -> u8 {
    match action.unwrap_or_default() {
        "pay-bond-invoice" => 0,
        "new-order" => 10,
        "add-invoice" | "waiting-buyer-invoice" => 30,
        "pay-invoice" | "waiting-seller-to-pay" => 40,
        "buyer-took-order" | "hold-invoice-payment-accepted" => 50,
        "fiat-sent-ok" => 60,
        "dispute-initiated-by-you" | "dispute-initiated-by-peer" => 70,
        "admin-took-dispute" => 80,
        "cooperative-cancel-initiated-by-you" | "cooperative-cancel-initiated-by-peer" => 90,
        "canceled"
        | "cooperative-cancel-accepted"
        | "released"
        | "hold-invoice-payment-settled"
        | "hold-invoice-payment-canceled"
        | "admin-settled"
        | "admin-canceled" => 100,
        "purchase-completed" | "bond-slashed" => 110,
        "rate" | "add-bond-invoice" => 120,
        "rate-received" | "bond-invoice-accepted" => 130,
        "bond-payout-completed" => 140,
        _ => u8::MAX,
    }
}

/// Orders a thread by time. Nostr timestamps have one-second resolution and
/// the daemon usually answers within the same second, so ties are common and
/// relays deliver them in no particular order. Within a second a request (a
/// user or a solver) goes before the daemon's messages, those follow the flow
/// of a trade, and the event id settles the rest, so the timeline is the same
/// on every load.
fn sort_timeline(messages: &mut [ChatMessage]) {
    let key = |m: &ChatMessage| {
        let from_daemon = m.role == ROLE_DAEMON;
        let rank = if from_daemon {
            daemon_flow_rank(m.action.as_deref())
        } else {
            0
        };
        (m.created_at, from_daemon, rank)
    };
    messages.sort_by(|a, b| key(a).cmp(&key(b)).then_with(|| a.id.cmp(&b.id)));
}

/// Summary of a whole message. Same rules as [`summarize_payload`], plus the
/// cases where the action changes what the payload means.
pub fn summarize_message(action: &str, payload: &Value) -> String {
    // In `pay-bond-invoice` the embedded order is a carrier: its `amount` is
    // the bond, not the trade, and its status is a neutral `pending`.
    if action == "pay-bond-invoice"
        && let Some(parts) = payload.get("payment_request").and_then(Value::as_array)
    {
        let mut out = vec![match parts
            .first()
            .and_then(|order| order.get("amount"))
            .and_then(Value::as_i64)
        {
            Some(sats) => format!("garantía de {sats} sats"),
            None => "garantía".to_string(),
        }];
        if let Some(invoice) = parts.get(1).and_then(Value::as_str) {
            out.push(format!("factura Lightning {}", shorten(invoice, 14)));
        }
        return out.join(" · ");
    }
    // The messages that follow a slashed bond carry an order too, and again
    // its `amount` is not the trade: it is the slashed bond or the share owed
    // to the counterparty.
    let carried_sats = payload
        .get("order")
        .and_then(|order| order.get("amount"))
        .and_then(Value::as_i64);
    let label = match action {
        "bond-slashed" => Some("garantía ejecutada"),
        "bond-invoice-accepted" => Some("factura de cobro de la garantía aceptada"),
        "bond-payout-completed" => Some("parte de la garantía pagada"),
        _ => None,
    };
    if let Some(label) = label {
        return match carried_sats {
            Some(sats) => format!("{label}: {sats} sats"),
            None => label.to_string(),
        };
    }
    summarize_payload(payload)
}

/// Process a kind 14 event and store it when it belongs to an order thread.
///
/// Returns `Ok(None)` for events that are not for this node, are not valid
/// protocol messages or cannot be attributed to an order.
pub fn process_event(
    event: &Event,
    keys: &Keys,
    cache: &mut ChatCache,
) -> Result<Option<ChatMessage>, String> {
    if event.kind.as_u16() != PROTOCOL_MESSAGE_KIND {
        return Ok(None);
    }
    event
        .verify()
        .map_err(|e| format!("Firma criptográfica inválida: {e}"))?;
    let now = Timestamp::now().as_secs();
    if event.created_at.as_secs() > now.saturating_add(MAX_FUTURE_DRIFT_SECS) {
        return Ok(None);
    }

    let node = keys.public_key();
    let recipient = extract_recipient_from_p_tag(event.tags.iter());
    let is_from_node = event.pubkey == node;
    let counterparty = if is_from_node {
        recipient.ok_or_else(|| "Mensaje del nodo sin tag 'p'".to_string())?
    } else if recipient == Some(node) {
        event.pubkey
    } else {
        return Ok(None);
    };

    let plaintext = decrypt_nip44(keys.secret_key(), &counterparty, &event.content)?;
    let Ok(message) = parse_protocol_plaintext(&plaintext) else {
        return Ok(None);
    };
    let (order_id, dispute_id) = attribute_message(&message, cache);
    if order_id.is_none() && dispute_id.is_none() {
        return Ok(None);
    }

    // A node-signed message addressed to the node is either a solver's request
    // made with the node key or the daemon's answer to it.
    let role = match (is_from_node, recipient == Some(node)) {
        (true, true) if ADMIN_REQUEST_ACTIONS.contains(&message.action.as_str()) => ROLE_ADMIN,
        (true, _) => ROLE_DAEMON,
        (false, _) => ROLE_USER,
    };
    let chat_message = ChatMessage {
        id: event.id.to_hex(),
        order_id: order_id.clone().unwrap_or_default(),
        sender: event
            .pubkey
            .to_bech32()
            .unwrap_or_else(|_| event.pubkey.to_hex()),
        recipient: recipient.map(|r| r.to_bech32().unwrap_or_else(|_| r.to_hex())),
        created_at: event.created_at.as_secs(),
        kind: PROTOCOL_MESSAGE_KIND,
        action: Some(message.action.clone()),
        content: summarize_message(&message.action, &message.payload),
        is_from_me: is_from_node,
        role: role.to_string(),
        variant: message.variant.clone(),
        dispute_id,
        acknowledged: is_from_node,
    };

    if order_id.is_none() {
        // Only the dispute is named: wait for the message that reveals its order.
        let Some(dispute_id) = chat_message.dispute_id.clone() else {
            return Ok(None);
        };
        let parked =
            cache.park_dispute_message(dispute_id, chat_message.clone(), event.pubkey.to_hex());
        return Ok(parked.then_some(chat_message));
    }

    let stored = if is_from_node {
        // A refusal proves nothing about the key it is sent to, and it names
        // whatever order id the requester chose.
        let refusal = is_refusal(&chat_message);
        let addressed_to = (recipient != Some(node) && !refusal).then(|| counterparty.to_hex());
        cache.insert_node_message(chat_message.clone(), addressed_to, !refusal)
    } else {
        cache.insert_user_message(chat_message.clone(), event.pubkey.to_hex())
    };
    Ok(stored.then_some(chat_message))
}

/// Asynchronous relay worker that connects to configured relays and subscribes to protocol messages.
pub async fn chat_worker(
    cache: SharedChatCache,
    root: PathBuf,
    mut config_rx: watch::Receiver<MonitorCommand>,
    timing: MonitorTiming,
) {
    let mut current_generation: u64 = 0;
    let mut relay_handles: Vec<tokio::task::JoinHandle<()>> = Vec::new();
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
            if npub_changed {
                cache.write().await.clear();
            }
            last_npub = cmd.npub.clone();
            last_relays = cmd.config.nostr.relays.clone();

            if let (Some(npub_str), false) = (&cmd.npub, cmd.config.nostr.relays.is_empty())
                && let Ok(pubkey) = PublicKey::from_bech32(npub_str)
            {
                for relay_url in cmd.config.nostr.relays.clone() {
                    let h = tokio::spawn(run_chat_relay_worker(
                        relay_url,
                        pubkey,
                        root.clone(),
                        cache.clone(),
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

async fn run_chat_relay_worker(
    relay_url: String,
    pubkey: PublicKey,
    root: PathBuf,
    cache: SharedChatCache,
    timing: MonitorTiming,
) {
    let mut reconnect_delay = timing.reconnect_initial;

    loop {
        // The identity is read once per connection, never per event.
        let keys = match identity::load_identity_keys(&root) {
            Ok(Some(keys)) if keys.public_key() == pubkey => keys,
            _ => {
                tokio::time::sleep(timing.reconnect_max).await;
                continue;
            }
        };

        let connect_fut = connect_async(&relay_url);
        let ws_res = tokio::time::timeout(timing.connect_timeout, connect_fut).await;

        let mut ws_stream = match ws_res {
            Ok(Ok((ws, _))) => ws,
            _ => {
                tokio::time::sleep(reconnect_delay).await;
                reconnect_delay = (reconnect_delay * 2).min(timing.reconnect_max);
                continue;
            }
        };

        reconnect_delay = timing.reconnect_initial;

        // Protocol v2 only: kind 14 addressed to the node and kind 14 sent by it.
        let since = Timestamp::now()
            .as_secs()
            .saturating_sub(HISTORY_WINDOW_SECS);
        let node_hex = pubkey.to_hex();
        let req_recv = serde_json::json!(["REQ", "mostro_chat_recv", {
            "kinds": [PROTOCOL_MESSAGE_KIND],
            "#p": [node_hex],
            "since": since,
            "limit": HISTORY_LIMIT_PER_FILTER,
        }])
        .to_string();
        let req_sent = serde_json::json!(["REQ", "mostro_chat_sent", {
            "kinds": [PROTOCOL_MESSAGE_KIND],
            "authors": [node_hex],
            "since": since,
            "limit": HISTORY_LIMIT_PER_FILTER,
        }])
        .to_string();

        let _ = ws_stream.send(Message::Text(req_recv.into())).await;
        let _ = ws_stream.send(Message::Text(req_sent.into())).await;

        let mut ping_interval = tokio::time::interval(timing.ping_interval);
        ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                _ = ping_interval.tick() => {
                    if ws_stream.send(Message::Ping(vec![1, 2].into())).await.is_err() {
                        break;
                    }
                }
                msg_opt = ws_stream.next() => {
                    match msg_opt {
                        Some(Ok(Message::Text(text))) => {
                            if text.len() > MAX_WS_FRAME_SIZE {
                                continue;
                            }
                            if let Ok(value) = serde_json::from_str::<Value>(&text)
                                && let Some(arr) = value.as_array()
                                && arr.len() >= 3
                                && arr[0] == "EVENT"
                                && let Ok(event) = serde_json::from_value::<Event>(arr[2].clone())
                            {
                                let mut w = cache.write().await;
                                let _ = process_event(&event, &keys, &mut w);
                            }
                        }
                        Some(Ok(Message::Ping(p))) => {
                            let _ = ws_stream.send(Message::Pong(p)).await;
                        }
                        Some(Ok(Message::Pong(_))) => {}
                        Some(Ok(Message::Close(_))) | None | Some(Err(_)) => {
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }

        let _ = ws_stream
            .send(Message::Text("[\"CLOSE\", \"mostro_chat_recv\"]".into()))
            .await;
        let _ = ws_stream
            .send(Message::Text("[\"CLOSE\", \"mostro_chat_sent\"]".into()))
            .await;
        let _ = ws_stream.close(None).await;

        tokio::time::sleep(reconnect_delay).await;
        reconnect_delay = (reconnect_delay * 2).min(timing.reconnect_max);
    }
}

/// HTTP endpoint `GET /api/chat/:order_id`
pub async fn get_chat_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(order_id): Path<String>,
) -> Result<Json<ChatHistory>, Error> {
    verify_protection(&headers)?;

    if !is_valid_uuid(&order_id) {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Identificador de orden inválido",
        ));
    }

    let cache = state.chat.read().await;
    Ok(Json(cache.to_history(&order_id)))
}

/// A dispute announced by the daemon, with its order when the node's own
/// messages revealed it.
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
pub struct DisputeView {
    #[serde(flatten)]
    pub dispute: crate::orders::DisputeSummary,
    pub order_id: Option<String>,
    pub is_open: bool,
}

/// HTTP endpoint `GET /api/disputes`
pub async fn get_disputes_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<DisputeView>>, Error> {
    verify_protection(&headers)?;
    let disputes = state.orders.read().await.to_snapshot().disputes;
    let chat = state.chat.read().await;
    Ok(Json(
        disputes
            .into_iter()
            .map(|dispute| DisputeView {
                order_id: chat.order_for_dispute(&dispute.id),
                is_open: crate::orders::is_open_dispute_status(&dispute.status),
                dispute,
            })
            .collect(),
    ))
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/// Builds a signed kind 14 event the way mostro-core's `wrap_message_nip44`
/// does: authored by `sender_keys`, `p`-tagged to the receiver, content
/// NIP-44 v2 encrypted between both keys.
pub fn build_test_kind14_event(
    sender_keys: &Keys,
    recipient_pubkey: &PublicKey,
    plaintext: &str,
    created_at_secs: Option<u64>,
) -> Event {
    let ciphertext = nip44::encrypt(
        sender_keys.secret_key(),
        recipient_pubkey,
        plaintext,
        nip44::Version::V2,
    )
    .unwrap();
    // An admin using the node key writes to the node itself, so the `p` tag
    // can equal the author.
    let mut builder = EventBuilder::new(Kind::Custom(PROTOCOL_MESSAGE_KIND), ciphertext)
        .tags(vec![Tag::public_key(*recipient_pubkey)])
        .allow_self_tagging();
    if let Some(secs) = created_at_secs {
        builder = builder.custom_created_at(Timestamp::from(secs));
    }
    builder.sign_with_keys(sender_keys).unwrap()
}
