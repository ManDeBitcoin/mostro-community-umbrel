//! Encrypted chat and assisted mediation module (NIP-04 and NIP-44 / NIP-59).
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use futures_util::{SinkExt, StreamExt};
use nostr::{
    Event, EventBuilder, FromBech32, Keys, Kind, PublicKey, SecretKey, Tag, Timestamp, ToBech32,
    event::tag::TagKind,
    nips::{nip04, nip44, nip59},
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tokio::sync::{RwLock, watch};
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};

use crate::{
    AppState, Error, error, identity,
    orders::{MAX_WS_FRAME_SIZE, MonitorCommand, MonitorTiming, is_valid_uuid},
    verify_protection,
};

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
pub struct ChatMessage {
    pub id: String,
    pub order_id: String,
    pub sender: String,
    pub recipient: Option<String>,
    pub created_at: u64,
    pub kind: u16,
    pub action: Option<String>,
    pub content: String,
    pub is_from_me: bool,
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
pub struct ChatHistory {
    pub order_id: String,
    pub messages: Vec<ChatMessage>,
    pub count: usize,
}

#[derive(Clone, Debug)]
pub struct ChatCache {
    pub messages_by_order: HashMap<String, Vec<ChatMessage>>,
    pub seen_event_ids: HashMap<String, u64>,
    pub max_messages_per_order: usize,
    pub max_orders: usize,
}

impl Default for ChatCache {
    fn default() -> Self {
        Self::new()
    }
}

impl ChatCache {
    pub fn new() -> Self {
        Self {
            messages_by_order: HashMap::new(),
            seen_event_ids: HashMap::new(),
            max_messages_per_order: 500,
            max_orders: 1000,
        }
    }

    pub fn insert(&mut self, message: ChatMessage) -> bool {
        if self.seen_event_ids.contains_key(&message.id) {
            return false;
        }

        // Limit tracking of seen IDs to 20,000 entries
        if self.seen_event_ids.len() >= 20_000 {
            let oldest_cutoff = Timestamp::now().as_secs().saturating_sub(86400 * 7);
            self.seen_event_ids.retain(|_, ts| *ts > oldest_cutoff);
        }
        self.seen_event_ids
            .insert(message.id.clone(), message.created_at);

        if self.messages_by_order.len() >= self.max_orders
            && !self.messages_by_order.contains_key(&message.order_id)
        {
            // Cache full: reject new order entry
            return false;
        }

        let entry = self
            .messages_by_order
            .entry(message.order_id.clone())
            .or_default();

        if entry.len() >= self.max_messages_per_order {
            return false;
        }

        entry.push(message);
        entry.sort_by_key(|m| m.created_at);
        true
    }

    pub fn get_messages(&self, order_id: &str) -> Vec<ChatMessage> {
        self.messages_by_order
            .get(order_id)
            .cloned()
            .unwrap_or_default()
    }

    pub fn to_history(&self, order_id: &str) -> ChatHistory {
        let messages = self.get_messages(order_id);
        ChatHistory {
            order_id: order_id.to_string(),
            count: messages.len(),
            messages,
        }
    }

    pub fn clear(&mut self) {
        self.messages_by_order.clear();
        self.seen_event_ids.clear();
    }
}

pub type SharedChatCache = Arc<RwLock<ChatCache>>;

/// Decrypt NIP-04 ciphertext.
pub fn decrypt_nip04(
    my_secret_key: &SecretKey,
    counterparty_pubkey: &PublicKey,
    ciphertext: &str,
) -> Result<String, String> {
    nip04::decrypt(my_secret_key, counterparty_pubkey, ciphertext)
        .map_err(|e| format!("Error al descifrar NIP-04: {e}"))
}

/// Decrypt NIP-44 ciphertext.
pub fn decrypt_nip44(
    my_secret_key: &SecretKey,
    counterparty_pubkey: &PublicKey,
    ciphertext: &str,
) -> Result<String, String> {
    nip44::decrypt(my_secret_key, counterparty_pubkey, ciphertext)
        .map_err(|e| format!("Error al descifrar NIP-44: {e}"))
}

/// Decrypt NIP-59 Gift Wrap event (Kind 1059).
pub async fn decrypt_gift_wrap(
    keys: &Keys,
    event: &Event,
) -> Result<(PublicKey, String, Vec<Tag>, u64, String), String> {
    match nip59::extract_rumor(keys, event).await {
        Ok(unwrapped) => {
            let rumor_id = unwrapped
                .rumor
                .id
                .map(|i| i.to_hex())
                .unwrap_or_else(|| event.id.to_hex());
            Ok((
                unwrapped.sender,
                unwrapped.rumor.content,
                unwrapped.rumor.tags.to_vec(),
                unwrapped.rumor.created_at.as_secs(),
                rumor_id,
            ))
        }
        Err(e) => {
            // Direct NIP-44 fallback if not double-wrapped
            if let Ok(direct) = decrypt_nip44(keys.secret_key(), &event.pubkey, &event.content) {
                Ok((
                    event.pubkey,
                    direct,
                    event.tags.clone().to_vec(),
                    event.created_at.as_secs(),
                    event.id.to_hex(),
                ))
            } else {
                Err(format!("Error al extraer rumor NIP-59 / NIP-44: {e}"))
            }
        }
    }
}

/// Helper to extract recipient public key from the first 'p' tag.
pub fn extract_recipient_from_p_tag<'a, I>(tags: I) -> Option<PublicKey>
where
    I: IntoIterator<Item = &'a Tag>,
{
    for tag in tags {
        let s = tag.as_slice();
        if s.len() >= 2 && s[0] == "p" {
            if let Ok(pk) = PublicKey::from_hex(&s[1]) {
                return Some(pk);
            }
            if let Ok(pk) = PublicKey::from_bech32(&s[1]) {
                return Some(pk);
            }
        }
    }
    None
}

/// Extract order UUID from tags or JSON payload.
pub fn extract_order_id_from_json_or_tags<'a, I>(content: &str, tags: I) -> Option<String>
where
    I: IntoIterator<Item = &'a Tag>,
{
    // 1. Check JSON payload
    if let Ok(mut val) = serde_json::from_str::<serde_json::Value>(content) {
        if let Some(first) = val.as_array().and_then(|arr| arr.first()) {
            val = first.clone();
        }
        for parent_key in ["order", "dispute", "cant-do", "cant_do"] {
            if let Some(sub) = val.get(parent_key) {
                if let Some(id_str) = sub.get("id").and_then(|v| v.as_str())
                    && is_valid_uuid(id_str)
                {
                    return Some(id_str.to_string());
                }
                if let Some(id_str) = sub.get("order_id").and_then(|v| v.as_str())
                    && is_valid_uuid(id_str)
                {
                    return Some(id_str.to_string());
                }
            }
        }
        if let Some(id_str) = val.get("order_id").and_then(|v| v.as_str())
            && is_valid_uuid(id_str)
        {
            return Some(id_str.to_string());
        }
        if let Some(id_str) = val.get("orderId").and_then(|v| v.as_str())
            && is_valid_uuid(id_str)
        {
            return Some(id_str.to_string());
        }
        if let Some(content_obj) = val.get("content") {
            if let Some(id_str) = content_obj.get("order_id").and_then(|v| v.as_str())
                && is_valid_uuid(id_str)
            {
                return Some(id_str.to_string());
            }
            if let Some(id_str) = content_obj.get("id").and_then(|v| v.as_str())
                && is_valid_uuid(id_str)
            {
                return Some(id_str.to_string());
            }
        }
        if let Some(id_str) = val.get("id").and_then(|v| v.as_str())
            && is_valid_uuid(id_str)
        {
            return Some(id_str.to_string());
        }
    }

    // 2. Check tags
    for tag in tags {
        let s = tag.as_slice();
        if s.len() >= 2 {
            let key = s[0].as_str();
            if matches!(key, "d" | "order" | "order_id" | "order-id" | "e") && is_valid_uuid(&s[1])
            {
                return Some(s[1].clone());
            }
        }
    }

    // 3. Fallback: scan for any 36-char valid UUID substring in plain text
    if content.len() >= 36 {
        for i in 0..=content.len().saturating_sub(36) {
            if let Some(candidate) = content.get(i..i + 36)
                && is_valid_uuid(candidate)
            {
                return Some(candidate.to_string());
            }
        }
    }

    None
}

/// Extract action code if present in JSON payload.
pub fn extract_action(content: &str) -> Option<String> {
    if let Ok(mut val) = serde_json::from_str::<serde_json::Value>(content) {
        if let Some(first) = val.as_array().and_then(|arr| arr.first()) {
            val = first.clone();
        }
        if let Some(act) = val.get("action").and_then(|v| v.as_str()) {
            return Some(act.to_string());
        }
        for parent_key in ["order", "dispute", "cant-do", "cant_do"] {
            if let Some(sub) = val.get(parent_key)
                && let Some(act) = sub.get("action").and_then(|v| v.as_str())
            {
                return Some(act.to_string());
            }
        }
    }
    None
}

/// Extract clean human-readable text content from JSON or raw text.
pub fn extract_display_content(content: &str) -> String {
    if let Ok(mut val) = serde_json::from_str::<serde_json::Value>(content) {
        if let Some(first) = val.as_array().and_then(|arr| arr.first()) {
            val = first.clone();
        }
        if let Some(text) = val.get("text").and_then(|v| v.as_str()) {
            return text.to_string();
        }
        if let Some(msg) = val.get("message").and_then(|v| v.as_str()) {
            return msg.to_string();
        }
        for parent_key in ["order", "dispute", "cant-do", "cant_do"] {
            if let Some(sub) = val.get(parent_key) {
                if let Some(text) = sub.get("text").and_then(|v| v.as_str()) {
                    return text.to_string();
                }
                if let Some(msg) = sub.get("message").and_then(|v| v.as_str()) {
                    return msg.to_string();
                }
                if let Some(content_val) = sub.get("content") {
                    if let Some(text) = content_val.as_str() {
                        return text.to_string();
                    }
                    if let Some(text) = content_val.get("text").and_then(|v| v.as_str()) {
                        return text.to_string();
                    }
                    if let Some(msg) = content_val.get("message").and_then(|v| v.as_str()) {
                        return msg.to_string();
                    }
                }
            }
        }
        if let Some(content_val) = val.get("content") {
            if let Some(text) = content_val.as_str() {
                return text.to_string();
            }
            if let Some(text) = content_val.get("text").and_then(|v| v.as_str()) {
                return text.to_string();
            }
            if let Some(msg) = content_val.get("message").and_then(|v| v.as_str()) {
                return msg.to_string();
            }
        }
    }
    content.to_string()
}

/// Process a Nostr event (Kind 4 or Kind 1059) and insert into cache if relevant.
pub async fn process_event(
    event: &Event,
    keys: &Keys,
    cache: &mut ChatCache,
) -> Result<Option<ChatMessage>, String> {
    event
        .verify()
        .map_err(|e| format!("Firma criptográfica inválida: {e}"))?;

    let my_pubkey = keys.public_key();
    let kind_num = event.kind.as_u16();

    if kind_num == 4 {
        let recipient = extract_recipient_from_p_tag(event.tags.iter());
        let is_from_me = event.pubkey == my_pubkey;

        let counterparty = if is_from_me {
            recipient.ok_or_else(|| "Mensaje propio Kind 4 sin tag 'p'".to_string())?
        } else if recipient == Some(my_pubkey) {
            event.pubkey
        } else {
            // Not addressed to or sent by this community identity
            return Ok(None);
        };

        // Attempt NIP-04 decryption first, fallback to NIP-44
        let decrypted_raw = match decrypt_nip04(keys.secret_key(), &counterparty, &event.content) {
            Ok(txt) => txt,
            Err(_) => decrypt_nip44(keys.secret_key(), &counterparty, &event.content)?,
        };

        let order_id = match extract_order_id_from_json_or_tags(&decrypted_raw, event.tags.iter()) {
            Some(id) => id,
            None => return Ok(None),
        };

        let action = extract_action(&decrypted_raw);
        let display_content = extract_display_content(&decrypted_raw);

        let sender_str = event
            .pubkey
            .to_bech32()
            .unwrap_or_else(|_| event.pubkey.to_hex());
        let recipient_str = recipient.map(|r| r.to_bech32().unwrap_or_else(|_| r.to_hex()));

        let msg = ChatMessage {
            id: event.id.to_hex(),
            order_id,
            sender: sender_str,
            recipient: recipient_str,
            created_at: event.created_at.as_secs(),
            kind: 4,
            action,
            content: display_content,
            is_from_me,
        };

        cache.insert(msg.clone());
        Ok(Some(msg))
    } else if kind_num == 14 {
        let recipient = extract_recipient_from_p_tag(event.tags.iter());
        let is_from_me = event.pubkey == my_pubkey;

        let counterparty = if is_from_me {
            recipient.ok_or_else(|| "Mensaje propio Kind 14 sin tag 'p'".to_string())?
        } else if recipient == Some(my_pubkey) {
            event.pubkey
        } else {
            // Not addressed to or sent by this community identity
            return Ok(None);
        };

        // Decrypt NIP-44 ciphertext
        let decrypted_raw = decrypt_nip44(keys.secret_key(), &counterparty, &event.content)?;

        let order_id = match extract_order_id_from_json_or_tags(&decrypted_raw, event.tags.iter()) {
            Some(id) => id,
            None => return Ok(None),
        };

        let action = extract_action(&decrypted_raw);
        let display_content = extract_display_content(&decrypted_raw);

        let sender_str = event
            .pubkey
            .to_bech32()
            .unwrap_or_else(|_| event.pubkey.to_hex());
        let recipient_str = recipient.map(|r| r.to_bech32().unwrap_or_else(|_| r.to_hex()));

        let msg = ChatMessage {
            id: event.id.to_hex(),
            order_id,
            sender: sender_str,
            recipient: recipient_str,
            created_at: event.created_at.as_secs(),
            kind: 14,
            action,
            content: display_content,
            is_from_me,
        };

        cache.insert(msg.clone());
        Ok(Some(msg))
    } else if kind_num == 1059 {
        let recipient = extract_recipient_from_p_tag(event.tags.iter());
        if recipient != Some(my_pubkey) {
            return Ok(None);
        }

        let (sender_pk, decrypted_raw, rumor_tags, created_at, msg_id) =
            decrypt_gift_wrap(keys, event).await?;

        let mut all_tags = event.tags.clone().to_vec();
        all_tags.extend(rumor_tags);

        let order_id = match extract_order_id_from_json_or_tags(&decrypted_raw, all_tags.iter()) {
            Some(id) => id,
            None => return Ok(None),
        };

        let action = extract_action(&decrypted_raw);
        let display_content = extract_display_content(&decrypted_raw);

        let is_from_me = sender_pk == my_pubkey;
        let sender_str = sender_pk.to_bech32().unwrap_or_else(|_| sender_pk.to_hex());
        let recipient_str = Some(my_pubkey.to_bech32().unwrap_or_else(|_| my_pubkey.to_hex()));

        let msg = ChatMessage {
            id: msg_id,
            order_id,
            sender: sender_str,
            recipient: recipient_str,
            created_at,
            kind: 1059,
            action,
            content: display_content,
            is_from_me,
        };

        cache.insert(msg.clone());
        Ok(Some(msg))
    } else {
        Ok(None)
    }
}

/// Asynchronous relay worker that connects to configured relays and subscribes to chat events.
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

        // Subscriptions:
        // 1. Kind 4, 14, 1059 addressed to community
        // 2. Kind 4, 14 sent by community
        let req_recv = format!(
            "[\"REQ\", \"mostro_chat_recv\", {{\"kinds\": [4, 14, 1059], \"#p\": [\"{}\"]}}]",
            pubkey.to_hex()
        );
        let req_sent = format!(
            "[\"REQ\", \"mostro_chat_sent\", {{\"kinds\": [4, 14], \"authors\": [\"{}\"]}}]",
            pubkey.to_hex()
        );

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
                            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text)
                                && let Some(arr) = value.as_array()
                                && arr.len() >= 3
                                && arr[0] == "EVENT"
                                && let Ok(event) = serde_json::from_value::<Event>(arr[2].clone())
                                && let Ok(Some(keys)) = identity::load_identity_keys(&root)
                            {
                                let mut w = cache.write().await;
                                let _ = process_event(&event, &keys, &mut w).await;
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

// ---------------------------------------------------------------------------
// Cryptographic Test Helpers
// ---------------------------------------------------------------------------

/// Helper to create a valid NIP-04 encrypted event for tests.
pub fn build_test_nip04_event(
    sender_keys: &Keys,
    recipient_pubkey: &PublicKey,
    content: &str,
    order_id_tag: Option<&str>,
) -> Event {
    let ciphertext = nip04::encrypt(sender_keys.secret_key(), recipient_pubkey, content).unwrap();
    let mut tags = vec![Tag::public_key(*recipient_pubkey)];
    if let Some(uuid) = order_id_tag {
        tags.push(Tag::identifier(uuid));
        tags.push(Tag::custom(TagKind::Custom("order".into()), vec![uuid]));
    }
    EventBuilder::new(Kind::EncryptedDirectMessage, ciphertext)
        .tags(tags)
        .sign_with_keys(sender_keys)
        .unwrap()
}

/// Helper to create a valid NIP-44 encrypted event for tests.
pub fn build_test_nip44_event(
    sender_keys: &Keys,
    recipient_pubkey: &PublicKey,
    content: &str,
    order_id_tag: Option<&str>,
) -> Event {
    let ciphertext = nip44::encrypt(
        sender_keys.secret_key(),
        recipient_pubkey,
        content,
        nip44::Version::V2,
    )
    .unwrap();
    let mut tags = vec![Tag::public_key(*recipient_pubkey)];
    if let Some(uuid) = order_id_tag {
        tags.push(Tag::identifier(uuid));
    }
    EventBuilder::new(Kind::EncryptedDirectMessage, ciphertext)
        .tags(tags)
        .sign_with_keys(sender_keys)
        .unwrap()
}

/// Helper to create a valid NIP-59 Gift Wrap event (Kind 1059) for tests.
pub async fn build_test_gift_wrap_event(
    sender_keys: &Keys,
    recipient_pubkey: &PublicKey,
    rumor_content: &str,
    order_id_tag: Option<&str>,
) -> Event {
    let mut tags = Vec::new();
    if let Some(uuid) = order_id_tag {
        tags.push(Tag::identifier(uuid));
    }
    let rumor = EventBuilder::new(Kind::ChatMessage, rumor_content)
        .tags(tags)
        .build(sender_keys.public_key());

    EventBuilder::gift_wrap(sender_keys, recipient_pubkey, rumor, [])
        .await
        .unwrap()
}

/// Helper to create a valid Kind 14 (protocol v2 Direct Message) encrypted event for tests.
pub fn build_test_kind14_event(
    sender_keys: &Keys,
    recipient_pubkey: &PublicKey,
    content: &str,
    order_id_tag: Option<&str>,
) -> Event {
    let ciphertext = nip44::encrypt(
        sender_keys.secret_key(),
        recipient_pubkey,
        content,
        nip44::Version::V2,
    )
    .unwrap();
    let mut tags = vec![Tag::public_key(*recipient_pubkey)];
    if let Some(uuid) = order_id_tag {
        tags.push(Tag::identifier(uuid));
    }
    EventBuilder::new(Kind::Custom(14), ciphertext)
        .tags(tags)
        .sign_with_keys(sender_keys)
        .unwrap()
}
