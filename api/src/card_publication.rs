//! Publication of the community card on the node's relays.
//!
//! The card (`connection::CommunityCard`) leaves the panel out of band, as a
//! QR, a link or pasted JSON. With the operator's switch on, the panel also
//! publishes it as an addressable Nostr event signed by the node, so a client
//! app picks up the payment methods and the contact data by itself:
//!
//! | | |
//! |---|---|
//! | kind | 30078 (NIP-78 application data) |
//! | author | the node |
//! | `d` | `mostro-community-card` |
//! | content | the v1 card as compact JSON, with its own signature |
//!
//! mostrod publishes its exchange rates under the same kind with
//! `d = mostro-rates`: another address, which nothing here reads or writes.
//!
//! The event carries no `expiration` tag and says nothing about the node
//! being alive. Liveness is the daemon's kind 38385 event and nothing else,
//! which is why this is the only event the panel signs with the node key.
//!
//! `created_at` is the date the card last changed. The signed event is kept on
//! disk and sent again as it is, at start and every few hours, so a restart or
//! a re-send never moves that date. A relay that takes the event answers with
//! an `OK` message; only that counts as published.
//!
//! Turning the switch off withdraws the card: the panel stops sending it and
//! asks the relays that may hold a copy to delete it (NIP-09, kind 5). That is
//! a request. A relay may ignore it, and an app that already read the card
//! keeps it.

use crate::{
    connection::{self, CardUnavailable, CommunityCard},
    identity,
    notifications::{Notification, NotificationHub},
    orders::MAX_WS_FRAME_SIZE,
    store::Store,
};
use futures_util::{SinkExt, StreamExt, future::join_all};
use nostr::{Event, EventBuilder, Keys, Kind, PublicKey, Tag, Timestamp};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Write,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    net::TcpStream,
    sync::{Notify, RwLock},
    time::Instant,
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async, tungstenite::protocol::Message,
};

/// NIP-78 application data, the kind mostrod uses for `mostro-rates`.
pub const CARD_EVENT_KIND: u16 = 30078;
/// The `d` tag that addresses the card among the node's kind 30078 events.
pub const CARD_EVENT_D_TAG: &str = "mostro-community-card";
/// NIP-09 deletion request.
pub const DELETION_EVENT_KIND: u16 = 5;

/// The signed event and where it went, inside `CONFIG_DIR`. Public data only.
const RECORD_FILE: &str = "card-publication.json";
/// What a relay says is shown to the operator: keep it short.
const MAX_DETAIL_CHARS: usize = 200;
/// The worker never spins, whatever its timing says.
const MIN_WAIT: Duration = Duration::from_millis(50);

/// `30078:<pubkey>:mostro-community-card`: the address of a node's card event.
pub fn card_coordinate(pubkey_hex: &str) -> String {
    format!("{CARD_EVENT_KIND}:{pubkey_hex}:{CARD_EVENT_D_TAG}")
}

/// The event that carries `card`: its only tag is `d` and its content is the
/// card exactly as the panel hands it out, signature included.
pub fn build_card_event(
    keys: &Keys,
    card: &CommunityCard,
    created_at: u64,
) -> Result<Event, String> {
    let content = serde_json::to_string(card).map_err(|e| e.to_string())?;
    EventBuilder::new(Kind::from(CARD_EVENT_KIND), content)
        .tag(Tag::identifier(CARD_EVENT_D_TAG))
        .custom_created_at(Timestamp::from(created_at))
        .sign_with_keys(keys)
        .map_err(|e| e.to_string())
}

/// The request to delete the card event of `keys`: every revision at its
/// address (`a`) and the last one by id (`e`), for relays that only follow
/// one of the two. It names no other address.
pub fn build_card_deletion(
    keys: &Keys,
    card_event: &Event,
    created_at: u64,
) -> Result<Event, String> {
    let tags = [
        vec![
            "a".to_string(),
            card_coordinate(&keys.public_key().to_hex()),
        ],
        vec!["e".to_string(), card_event.id.to_hex()],
        vec!["k".to_string(), CARD_EVENT_KIND.to_string()],
    ]
    .into_iter()
    .map(Tag::parse)
    .collect::<Result<Vec<Tag>, _>>()
    .map_err(|e| e.to_string())?;
    EventBuilder::new(Kind::from(DELETION_EVENT_KIND), "")
        .tags(tags)
        .custom_created_at(Timestamp::from(created_at))
        .sign_with_keys(keys)
        .map_err(|e| e.to_string())
}

/// The card inside `event`, when the event is `node`'s card event and the
/// card is `node`'s own. These are the checks a client makes before it trusts
/// one: kind, author, `d`, the event signature, the card's `pubkey` and the
/// card's own signature.
pub fn verified_card(event: &Event, node: &PublicKey) -> Option<CommunityCard> {
    if event.pubkey != *node || !is_card_event(event) {
        return None;
    }
    let card: CommunityCard = serde_json::from_str(&event.content).ok()?;
    (card.version == 1
        && card.pubkey.eq_ignore_ascii_case(&node.to_hex())
        && connection::verify_community_card(&card))
    .then_some(card)
}

/// Whether `event` is a card event at all: the kind, the address and a
/// signature that holds, whoever the author is.
fn is_card_event(event: &Event) -> bool {
    event.kind.as_u16() == CARD_EVENT_KIND && has_card_address(event) && event.verify().is_ok()
}

fn has_card_address(event: &Event) -> bool {
    event.tags.iter().any(|tag| {
        let tag = tag.as_slice();
        tag.first().map(String::as_str) == Some("d")
            && tag.get(1).map(String::as_str) == Some(CARD_EVENT_D_TAG)
    })
}

/// Whether `event` is a deletion request for its author's card address and
/// for no other address.
fn is_card_deletion(event: &Event) -> bool {
    let coordinate = card_coordinate(&event.pubkey.to_hex());
    let addresses: Vec<&str> = event
        .tags
        .iter()
        .map(|tag| tag.as_slice())
        .filter(|tag| tag.first().map(String::as_str) == Some("a"))
        .filter_map(|tag| tag.get(1).map(String::as_str))
        .collect();
    event.kind.as_u16() == DELETION_EVENT_KIND
        && addresses == [coordinate.as_str()]
        && event.verify().is_ok()
}

#[derive(Clone, Debug)]
pub struct PublisherTiming {
    pub connect_timeout: Duration,
    /// How long a relay has to answer `OK` once the event is sent.
    pub ok_timeout: Duration,
    /// How often the event in force is sent again to a relay that has it.
    pub republish_interval: Duration,
    /// Wait before a relay that did not take the event is tried again. It
    /// doubles after each failed pass, up to `republish_interval`.
    pub retry_initial: Duration,
    /// How long a relay that has not taken the deletion request is asked again.
    pub withdrawal_retry: Duration,
}

impl Default for PublisherTiming {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_secs(10),
            ok_timeout: Duration::from_secs(10),
            republish_interval: Duration::from_secs(6 * 3600),
            retry_initial: Duration::from_secs(60),
            withdrawal_retry: Duration::from_secs(7 * 24 * 3600),
        }
    }
}

impl PublisherTiming {
    pub fn test_timing() -> Self {
        Self {
            connect_timeout: Duration::from_millis(500),
            ok_timeout: Duration::from_millis(300),
            republish_interval: Duration::from_secs(3600),
            retry_initial: Duration::from_millis(100),
            withdrawal_retry: Duration::from_secs(3600),
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RelayOutcome {
    /// The relay answered `OK` with `true`.
    Accepted,
    /// The relay answered `OK` with `false`.
    Rejected,
    /// The event was sent and no `OK` came back in time.
    NoAnswer,
    /// No connection: the event was not sent.
    Unreachable,
    /// Not asked yet.
    Pending,
}

/// What one relay did with the event it was last sent.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RelayReport {
    pub url: String,
    pub outcome: RelayOutcome,
    /// The relay's own words, or the connection error.
    pub detail: Option<String>,
    pub at: u64,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PublicationState {
    /// The switch is off and there is nothing of this panel to withdraw.
    #[default]
    Off,
    /// The switch is on and there is no card to publish: see `reason`.
    Blocked,
    /// Every relay of the configuration accepted the card event.
    Published,
    /// Some relays accepted it.
    Partial,
    /// No relay accepted it: the card is not published.
    Failed,
    /// The switch is off and the deletion request has not been accepted yet
    /// by every relay that may hold the card.
    Withdrawing,
    /// The switch is off and every such relay accepted the deletion request.
    Withdrawn,
    /// The switch is off and the panel gave up asking the relays listed.
    WithdrawalIncomplete,
}

/// What the worker last did, for the panel.
#[derive(Clone, Debug, Default, Serialize)]
pub struct PublicationStatus {
    /// The switch as the worker last read it.
    #[serde(skip)]
    pub enabled: bool,
    pub state: PublicationState,
    /// Why nothing is published while the switch is on, as a stable code.
    pub reason: Option<&'static str>,
    pub reason_text: Option<String>,
    /// Id of the card event in force.
    pub event_id: Option<String>,
    /// `created_at` of that event: when the card last changed.
    pub card_changed_at: Option<u64>,
    /// When the deletion request was signed.
    pub withdrawn_at: Option<u64>,
    /// One entry per relay the current event, card or deletion, was sent to.
    pub relays: Vec<RelayReport>,
    /// Relays that left the configuration and may still hold an earlier
    /// revision of the card. A withdrawal reaches them too.
    pub former_relays: Vec<String>,
    pub last_attempt_at: Option<u64>,
    pub next_attempt_at: Option<u64>,
    /// How often the card is sent again while nothing changes.
    pub resend_every_secs: u64,
}

/// [`PublicationStatus`] with the switch as it is saved now.
#[derive(Clone, Debug, Serialize)]
pub struct PublicationView {
    pub enabled: bool,
    /// The worker has not caught up with the last change yet.
    pub working: bool,
    #[serde(flatten)]
    pub status: PublicationStatus,
}

struct Shared {
    status: RwLock<PublicationStatus>,
    wake: Notify,
    /// Passes asked for, and the last of them the worker finished.
    requested: AtomicU64,
    served: AtomicU64,
}

/// The handle the HTTP side keeps: it reads the status and asks for a pass.
#[derive(Clone)]
pub struct CardPublication {
    shared: Arc<Shared>,
}

impl Default for CardPublication {
    fn default() -> Self {
        Self {
            shared: Arc::new(Shared {
                status: RwLock::new(PublicationStatus::default()),
                wake: Notify::new(),
                // The pass at start is owed from the beginning.
                requested: AtomicU64::new(1),
                served: AtomicU64::new(0),
            }),
        }
    }
}

impl CardPublication {
    /// Asks the worker to look again now: the card, the identity or the
    /// switch may have changed.
    pub fn request(&self) {
        self.shared.requested.fetch_add(1, Ordering::SeqCst);
        self.shared.wake.notify_one();
    }

    pub async fn status(&self) -> PublicationStatus {
        self.shared.status.read().await.clone()
    }

    /// The status next to the switch as saved: until the worker has read
    /// that value, what it reports is about the previous one.
    pub async fn view(&self, enabled: bool) -> PublicationView {
        // The counters first: a pass that ends in between leaves a status
        // newer than this answer admits, never an older one called current.
        let pending = self.shared.served.load(Ordering::SeqCst)
            < self.shared.requested.load(Ordering::SeqCst);
        let status = self.status().await;
        PublicationView {
            enabled,
            working: pending || status.enabled != enabled,
            status,
        }
    }
}

/// What is kept between runs.
#[derive(Default, Serialize, Deserialize)]
struct Record {
    /// The card event in force, sent again as it is while the card stays.
    #[serde(default)]
    event: Option<Event>,
    /// The deletion request of the last withdrawal. A relay that took it
    /// refuses card events up to its date, so the next one is dated after.
    #[serde(default)]
    deletion: Option<Event>,
    /// Relays a card event was sent to and that did not refuse it: the ones
    /// that may hold a copy, and so the ones a withdrawal has to reach.
    #[serde(default)]
    holders: BTreeSet<String>,
}

struct Sent {
    event_id: String,
    when: Instant,
    report: RelayReport,
}

/// What there is to publish while the switch is on.
struct ToPublish {
    relays: Vec<String>,
    card: Result<(CommunityCard, Keys), CardUnavailable>,
}

/// The lock of the store was poisoned by a panic elsewhere.
struct StoreUnreadable;

/// The date of a new card event: now, and after whatever it replaces. A
/// replaceable event only replaces an older one, and a relay that took a
/// deletion request refuses card events up to its date.
fn next_created_at(now: u64, floor: Option<u64>) -> u64 {
    floor.map_or(now, |floor| now.max(floor.saturating_add(1)))
}

pub struct CardPublisher {
    store: Arc<Mutex<Store>>,
    root: PathBuf,
    handle: CardPublication,
    notifications: Option<Arc<NotificationHub>>,
    timing: PublisherTiming,
    record: Record,
    /// Last result per relay for the event being distributed now.
    sent: BTreeMap<String, Sent>,
    /// Scheduled passes in a row that left a relay without the event.
    failed_passes: u32,
    /// The previous pass left a relay without this same event.
    failing: bool,
    /// What the last alert was about, so the same failure is told once.
    alerted: Option<String>,
    /// Why the last withdrawal could not be asked for, while the switch stays off.
    withdrawal_note: Option<(&'static str, String)>,
    /// The pass under way was asked for, not one the worker scheduled.
    on_request: bool,
}

impl CardPublisher {
    pub fn new(
        store: Arc<Mutex<Store>>,
        handle: CardPublication,
        notifications: Option<Arc<NotificationHub>>,
        timing: PublisherTiming,
    ) -> Self {
        let root = store
            .lock()
            .map(|store| store.root().to_path_buf())
            .unwrap_or_default();
        let record = std::fs::read(root.join(RECORD_FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            store,
            root,
            handle,
            notifications,
            timing,
            record,
            sent: BTreeMap::new(),
            failed_passes: 0,
            failing: false,
            alerted: None,
            withdrawal_note: None,
            on_request: false,
        }
    }

    /// Publishes at start, whenever [`CardPublication::request`] is called
    /// and when the next re-send or retry is due.
    pub async fn run(mut self) {
        loop {
            let wait = self.run_once().await;
            let shared = self.handle.shared.clone();
            self.on_request = tokio::select! {
                _ = shared.wake.notified() => true,
                _ = tokio::time::sleep(wait.max(MIN_WAIT)) => false,
            };
        }
    }

    /// One pass. Returns how long until the next one is due.
    pub async fn run_once(&mut self) -> Duration {
        let owed = self.handle.shared.requested.load(Ordering::SeqCst);
        let now = Timestamp::now().as_secs();
        let wait = match self.read_store() {
            Ok(Some(wanted)) => self.publish(wanted.relays, wanted.card, now).await,
            // The switch is off.
            Ok(None) => self.withdraw(now).await,
            // What is on screen stays.
            Err(StoreUnreadable) => self.timing.retry_initial,
        };
        {
            let mut status = self.handle.shared.status.write().await;
            status.last_attempt_at = Some(now);
            status.next_attempt_at = Some(now.saturating_add(wait.as_secs()));
            status.resend_every_secs = self.timing.republish_interval.as_secs();
        }
        self.handle.shared.served.store(owed, Ordering::SeqCst);
        wait
    }

    fn read_store(&self) -> Result<Option<ToPublish>, StoreUnreadable> {
        let store = self.store.lock().map_err(|_| StoreUnreadable)?;
        if !store.document.publish_card {
            return Ok(None);
        }
        Ok(Some(ToPublish {
            relays: store
                .document
                .config
                .as_ref()
                .map(|config| config.nostr.relays.clone())
                .unwrap_or_default(),
            card: connection::issue_card_with_keys(&self.root, &store),
        }))
    }

    async fn publish(
        &mut self,
        relays: Vec<String>,
        card: Result<(CommunityCard, Keys), CardUnavailable>,
        now: u64,
    ) -> Duration {
        self.withdrawal_note = None;
        let (card, keys) = match card {
            Ok(issued) => issued,
            Err(reason) => {
                // No card, no event: nothing is sent and nothing is claimed.
                self.sent.clear();
                self.failing = false;
                self.alerted = None;
                self.set_status(PublicationStatus {
                    enabled: true,
                    state: PublicationState::Blocked,
                    reason: Some(reason.code()),
                    reason_text: Some(reason.text().to_string()),
                    ..PublicationStatus::default()
                })
                .await;
                return if reason == CardUnavailable::IdentityUnreadable {
                    // Permissions are fixed outside the panel: nothing will ask for a pass.
                    self.next_retry()
                } else {
                    // A save or a new identity asks for the next pass.
                    self.failed_passes = 0;
                    self.timing.republish_interval
                };
            }
        };
        let (event, orphaned) = match self.event_in_force(&card, &keys, now) {
            Ok(in_force) => in_force,
            Err(problem) => {
                self.set_status(PublicationStatus {
                    enabled: true,
                    state: PublicationState::Failed,
                    reason: Some("storage"),
                    reason_text: Some(format!(
                        "No se pudo guardar el evento de la tarjeta en el disco ({problem}). No se ha enviado nada; el panel lo vuelve a intentar."
                    )),
                    ..PublicationStatus::default()
                })
                .await;
                return self.next_retry();
            }
        };
        if !orphaned.is_empty()
            && let Some(hub) = &self.notifications
        {
            hub.publish(Notification::card_alert(
                "La tarjeta de la identidad anterior sigue en los relays",
                &format!(
                    "La firmó la clave que el nodo tenía antes y solo esa clave puede pedir su borrado. Puede seguir en: {}.",
                    orphaned.join(", ")
                ),
                Some(serde_json::json!({ "relays": orphaned })),
            ))
            .await;
        }

        let id = event.id.to_hex();
        self.sent.retain(|url, _| relays.contains(url));
        let due: Vec<String> = relays
            .iter()
            .filter(|url| self.is_due(url, &id))
            .cloned()
            .collect();
        let frame = serde_json::json!(["EVENT", event]).to_string();
        let answers = join_all(
            due.iter()
                .map(|url| send_to_relay(url, &frame, &id, &self.timing)),
        )
        .await;
        let mut holders = self.record.holders.clone();
        for (url, (outcome, detail)) in due.into_iter().zip(answers) {
            // Sent and not refused: the relay may hold it, answer or not.
            if matches!(outcome, RelayOutcome::Accepted | RelayOutcome::NoAnswer) {
                holders.insert(url.clone());
            }
            self.remember(url, &id, outcome, detail, now);
        }
        if holders != self.record.holders {
            self.record.holders = holders;
            // Losing this only costs a withdrawal one relay: not worth failing the pass.
            let _ = self.persist(&self.record);
        }

        let total = relays.len();
        let former_relays = self
            .record
            .holders
            .iter()
            .filter(|url| !relays.contains(url))
            .cloned()
            .collect();
        let relays = self.reports(&relays);
        let accepted = relays
            .iter()
            .filter(|report| report.outcome == RelayOutcome::Accepted)
            .count();
        let state = if accepted == total && accepted > 0 {
            PublicationState::Published
        } else if accepted > 0 {
            PublicationState::Partial
        } else {
            PublicationState::Failed
        };
        self.alert_failures(&id, state, &relays).await;
        self.set_status(PublicationStatus {
            enabled: true,
            state,
            event_id: Some(id),
            card_changed_at: Some(event.created_at.as_secs()),
            relays,
            former_relays,
            ..PublicationStatus::default()
        })
        .await;

        if state == PublicationState::Published {
            self.failed_passes = 0;
            self.failing = false;
            self.until_next_resend()
        } else {
            self.failing = true;
            self.next_retry()
        }
    }

    /// The stored event while it still carries this card for this key;
    /// otherwise a new one, dated now and after anything it replaces. With
    /// it, the relays left holding a card that another key signed.
    fn event_in_force(
        &mut self,
        card: &CommunityCard,
        keys: &Keys,
        now: u64,
    ) -> Result<(Event, Vec<String>), String> {
        let node = keys.public_key();
        if let Some(event) = &self.record.event
            && verified_card(event, &node)
                .is_some_and(|stored| connection::same_card_content(&stored, card))
        {
            return Ok((event.clone(), Vec::new()));
        }
        let previous: Vec<&Event> = [&self.record.event, &self.record.deletion]
            .into_iter()
            .flatten()
            .collect();
        let floor = previous
            .iter()
            .filter(|previous| previous.pubkey == node)
            .map(|previous| previous.created_at.as_secs())
            .max();
        let event = build_card_event(keys, card, next_created_at(now, floor))?;
        // What another key signed, this one can neither replace nor withdraw.
        let foreign = previous.iter().any(|previous| previous.pubkey != node);
        let (holders, orphaned) = if foreign {
            (
                BTreeSet::new(),
                self.record.holders.iter().cloned().collect(),
            )
        } else {
            (self.record.holders.clone(), Vec::new())
        };
        let next = Record {
            event: Some(event.clone()),
            deletion: None,
            holders,
        };
        // On disk before it reaches a relay, and in force only once it is on
        // disk: what a relay holds must be what the next start sends again.
        self.persist(&next)?;
        self.record = next;
        self.sent.clear();
        self.failed_passes = 0;
        self.failing = false;
        Ok((event, orphaned))
    }

    async fn withdraw(&mut self, now: u64) -> Duration {
        let mut signed_now = false;
        if let Some(event) = self.record.event.clone() {
            // The first pass with the switch off: what was published is withdrawn.
            let mut next = Record {
                event: None,
                deletion: None,
                holders: self.record.holders.clone(),
            };
            let mut note = None;
            if !is_card_event(&event) {
                // Not a card event: nothing here asks for the deletion of anything else.
                next.holders.clear();
            } else if !next.holders.is_empty() {
                // Not dated before the event it withdraws.
                let created_at = now.max(event.created_at.as_secs().saturating_add(1));
                match identity::load_identity_keys(&self.root) {
                    Ok(Some(keys)) if keys.public_key() == event.pubkey => {
                        match build_card_deletion(&keys, &event, created_at) {
                            Ok(deletion) => {
                                next.deletion = Some(deletion);
                                signed_now = true;
                            }
                            Err(problem) => {
                                return self
                                    .withdrawal_waits(
                                        "storage",
                                        format!("No se pudo firmar la petición de borrado ({problem}). El panel lo vuelve a intentar."),
                                        now,
                                    )
                                    .await;
                            }
                        }
                    }
                    // Only the key that signed the card can ask for its deletion.
                    Ok(_) => {
                        note = Some((
                            "identity_changed",
                            format!(
                                "La tarjeta publicada la firmó una clave que este nodo ya no tiene: el panel no puede pedir a los relays que la borren. Puede seguir en: {}.",
                                next.holders.iter().cloned().collect::<Vec<_>>().join(", ")
                            ),
                        ));
                        next.holders.clear();
                    }
                    // The key is there and cannot be read now. The card stays
                    // on record until its deletion can be signed.
                    Err(_) => {
                        return self
                            .withdrawal_waits(
                                "identity_unreadable",
                                "No se pudo leer la clave del nodo para firmar la petición de borrado. Revisa los permisos de la carpeta de identidad; el panel lo vuelve a intentar.".to_string(),
                                now,
                            )
                            .await;
                    }
                }
            }
            if let Err(problem) = self.persist(&next) {
                return self
                    .withdrawal_waits(
                        "storage",
                        format!("No se pudo guardar la petición de borrado en el disco ({problem}). El panel lo vuelve a intentar."),
                        now,
                    )
                    .await;
            }
            self.record = next;
            self.withdrawal_note = note;
            self.sent.clear();
            self.failed_passes = 0;
            self.failing = false;
            self.alerted = None;
        }

        let Some(deletion) = self.record.deletion.clone().filter(is_card_deletion) else {
            let note = self.withdrawal_note.clone();
            self.set_status(PublicationStatus {
                reason: note.as_ref().map(|(code, _)| *code),
                reason_text: note.map(|(_, text)| text),
                ..PublicationStatus::default()
            })
            .await;
            return self.timing.republish_interval;
        };
        let withdrawn_at = Some(deletion.created_at.as_secs());
        let gave_up = !signed_now
            && now.saturating_sub(deletion.created_at.as_secs())
                >= self.timing.withdrawal_retry.as_secs();
        if self.record.holders.is_empty() || gave_up {
            let state = if self.record.holders.is_empty() {
                PublicationState::Withdrawn
            } else {
                PublicationState::WithdrawalIncomplete
            };
            let relays = self.withdrawal_reports(now);
            self.set_status(PublicationStatus {
                state,
                withdrawn_at,
                relays,
                ..PublicationStatus::default()
            })
            .await;
            return self.timing.republish_interval;
        }

        let id = deletion.id.to_hex();
        let targets: Vec<String> = self.record.holders.iter().cloned().collect();
        let frame = serde_json::json!(["EVENT", deletion]).to_string();
        let answers = join_all(
            targets
                .iter()
                .map(|url| send_to_relay(url, &frame, &id, &self.timing)),
        )
        .await;
        for (url, (outcome, detail)) in targets.into_iter().zip(answers) {
            if outcome == RelayOutcome::Accepted {
                self.record.holders.remove(&url);
            }
            self.remember(url, &id, outcome, detail, now);
        }
        // If this is lost, a relay that already took the request is asked again.
        let _ = self.persist(&self.record);

        let done = self.record.holders.is_empty();
        let relays = self.withdrawal_reports(now);
        self.set_status(PublicationStatus {
            state: if done {
                PublicationState::Withdrawn
            } else {
                PublicationState::Withdrawing
            },
            withdrawn_at,
            relays,
            ..PublicationStatus::default()
        })
        .await;
        if done {
            self.failed_passes = 0;
            self.timing.republish_interval
        } else {
            self.next_retry()
        }
    }

    /// The card is still on record because its deletion could not be signed
    /// or saved yet: says so and comes back.
    async fn withdrawal_waits(&mut self, code: &'static str, text: String, now: u64) -> Duration {
        // No relay has been asked anything yet: what `sent` holds is about the card.
        let relays = self
            .record
            .holders
            .iter()
            .map(|url| RelayReport {
                url: url.clone(),
                outcome: RelayOutcome::Pending,
                detail: None,
                at: now,
            })
            .collect();
        self.set_status(PublicationStatus {
            state: PublicationState::Withdrawing,
            reason: Some(code),
            reason_text: Some(text),
            relays,
            ..PublicationStatus::default()
        })
        .await;
        self.next_retry()
    }

    /// A relay is sent the event when it does not have this one yet, or when
    /// it is time to send it again.
    fn is_due(&self, url: &str, event_id: &str) -> bool {
        match self.sent.get(url) {
            Some(sent)
                if sent.event_id == event_id && sent.report.outcome == RelayOutcome::Accepted =>
            {
                sent.when.elapsed() >= self.timing.republish_interval
            }
            _ => true,
        }
    }

    fn remember(
        &mut self,
        url: String,
        event_id: &str,
        outcome: RelayOutcome,
        detail: Option<String>,
        now: u64,
    ) {
        let report = RelayReport {
            url: url.clone(),
            outcome,
            detail,
            at: now,
        };
        self.sent.insert(
            url,
            Sent {
                event_id: event_id.to_string(),
                when: Instant::now(),
                report,
            },
        );
    }

    fn reports(&self, relays: &[String]) -> Vec<RelayReport> {
        relays
            .iter()
            .filter_map(|url| self.sent.get(url).map(|sent| sent.report.clone()))
            .collect()
    }

    /// What each relay answered to the deletion request, and the relays still
    /// owed it that have not been asked since the last start.
    fn withdrawal_reports(&self, now: u64) -> Vec<RelayReport> {
        let waiting = self
            .record
            .holders
            .iter()
            .filter(|url| !self.sent.contains_key(*url))
            .map(|url| RelayReport {
                url: url.clone(),
                outcome: RelayOutcome::Pending,
                detail: None,
                at: now,
            });
        self.sent
            .values()
            .map(|sent| sent.report.clone())
            .chain(waiting)
            .collect()
    }

    fn until_next_resend(&self) -> Duration {
        self.sent
            .values()
            .map(|sent| {
                self.timing
                    .republish_interval
                    .saturating_sub(sent.when.elapsed())
            })
            .min()
            .unwrap_or(self.timing.republish_interval)
    }

    fn next_retry(&mut self) -> Duration {
        let wait = self
            .timing
            .retry_initial
            .saturating_mul(1u32 << self.failed_passes.min(16))
            .min(
                self.timing
                    .republish_interval
                    .max(self.timing.retry_initial),
            );
        // A pass the operator asked for does not push the scheduled ones apart.
        if !self.on_request {
            self.failed_passes = self.failed_passes.saturating_add(1);
        }
        wait
    }

    /// One alert per failure, not one per attempt, and only once a second
    /// pass has failed too: a relay that misses a single attempt is not news.
    async fn alert_failures(
        &mut self,
        event_id: &str,
        state: PublicationState,
        relays: &[RelayReport],
    ) {
        if state == PublicationState::Published {
            self.alerted = None;
            return;
        }
        let failing: Vec<&RelayReport> = relays
            .iter()
            .filter(|report| report.outcome != RelayOutcome::Accepted)
            .collect();
        let subject = format!(
            "{event_id}:{}",
            failing
                .iter()
                .map(|report| report.url.as_str())
                .collect::<Vec<_>>()
                .join(",")
        );
        if !self.failing || self.alerted.as_deref() == Some(subject.as_str()) {
            return;
        }
        let Some(hub) = &self.notifications else {
            return;
        };
        let listed = failing
            .iter()
            .map(|report| match &report.detail {
                Some(detail) => format!("{} ({detail})", report.url),
                None => report.url.clone(),
            })
            .collect::<Vec<_>>()
            .join("; ");
        let (title, message) = if state == PublicationState::Failed {
            (
                "La tarjeta de la comunidad no está publicada",
                format!("Ningún relay la aceptó: {listed}. El panel lo vuelve a intentar."),
            )
        } else {
            (
                "Algunos relays no aceptaron la tarjeta",
                format!("No la aceptaron: {listed}. El panel lo vuelve a intentar."),
            )
        };
        hub.publish(Notification::card_alert(
            title,
            &message,
            Some(serde_json::json!({
                "event_id": event_id,
                "relays": failing.iter().map(|report| &report.url).collect::<Vec<_>>(),
            })),
        ))
        .await;
        self.alerted = Some(subject);
    }

    async fn set_status(&self, status: PublicationStatus) {
        *self.handle.shared.status.write().await = status;
    }

    /// Replaces the record on disk atomically, private like the rest of
    /// `CONFIG_DIR`.
    fn persist(&self, record: &Record) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(record).map_err(|e| e.to_string())?;
        let mut file = tempfile::NamedTempFile::new_in(&self.root).map_err(|e| e.to_string())?;
        file.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .and_then(|()| file.write_all(&bytes))
            .and_then(|()| file.as_file().sync_all())
            .map_err(|e| e.to_string())?;
        file.persist(self.root.join(RECORD_FILE))
            .map_err(|e| e.to_string())?;
        std::fs::File::open(&self.root)
            .and_then(|directory| directory.sync_all())
            .map_err(|e| e.to_string())
    }
}

type RelaySocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Sends one event over a connection of its own and waits for the relay's
/// `OK`. Nothing is read from the relay beyond that answer.
async fn send_to_relay(
    url: &str,
    frame: &str,
    event_id: &str,
    timing: &PublisherTiming,
) -> (RelayOutcome, Option<String>) {
    let mut socket = match tokio::time::timeout(timing.connect_timeout, connect_async(url)).await {
        Ok(Ok((socket, _))) => socket,
        Ok(Err(error)) => {
            return (
                RelayOutcome::Unreachable,
                Some(clip(&format!("Fallo de conexión: {error}"))),
            );
        }
        Err(_) => {
            return (
                RelayOutcome::Unreachable,
                Some("Sin conexión dentro del plazo".into()),
            );
        }
    };
    if socket
        .send(Message::Text(frame.to_owned().into()))
        .await
        .is_err()
    {
        return (
            RelayOutcome::Unreachable,
            Some("La conexión se cerró antes de enviar el evento".into()),
        );
    }
    let mut hint = None;
    let answer = tokio::time::timeout(
        timing.ok_timeout,
        wait_for_ok(&mut socket, event_id, &mut hint),
    )
    .await;
    let _ = tokio::time::timeout(timing.connect_timeout, socket.close(None)).await;
    match answer {
        Ok(Some(result)) => result,
        Ok(None) => (
            RelayOutcome::NoAnswer,
            hint.or_else(|| Some("El relay cerró la conexión sin responder".into())),
        ),
        Err(_) => (
            RelayOutcome::NoAnswer,
            hint.or_else(|| Some("El relay no respondió dentro del plazo".into())),
        ),
    }
}

/// Reads until the `OK` for `event_id`. `None` when the relay hangs up first;
/// `hint` keeps what it said meanwhile.
async fn wait_for_ok(
    socket: &mut RelaySocket,
    event_id: &str,
    hint: &mut Option<String>,
) -> Option<(RelayOutcome, Option<String>)> {
    while let Some(message) = socket.next().await {
        match message {
            Ok(Message::Text(text)) => {
                if text.len() > MAX_WS_FRAME_SIZE {
                    continue;
                }
                let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                match items.first().and_then(Value::as_str) {
                    Some("OK") if items.get(1).and_then(Value::as_str) == Some(event_id) => {
                        let said = items
                            .get(3)
                            .and_then(Value::as_str)
                            .map(clip)
                            .filter(|said| !said.is_empty());
                        let outcome = if items.get(2).and_then(Value::as_bool) == Some(true) {
                            RelayOutcome::Accepted
                        } else {
                            RelayOutcome::Rejected
                        };
                        return Some((outcome, said));
                    }
                    Some("NOTICE") => {
                        *hint = items.get(1).and_then(Value::as_str).map(clip);
                    }
                    Some("AUTH") => {
                        *hint = Some(
                            "El relay pide autenticación (NIP-42), que el panel no hace".into(),
                        );
                    }
                    _ => {}
                }
            }
            Ok(Message::Ping(payload)) => {
                let _ = socket.send(Message::Pong(payload)).await;
            }
            Ok(Message::Close(_)) | Err(_) => break,
            _ => {}
        }
    }
    None
}

/// A relay's words on one line and within a length fit for the panel.
fn clip(text: &str) -> String {
    let printable: String = text
        .chars()
        .filter(|c| !c.is_control() || c.is_whitespace())
        .collect();
    let clean = printable.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.chars().count() > MAX_DETAIL_CHARS {
        let mut cut: String = clean.chars().take(MAX_DETAIL_CHARS).collect();
        cut.push('…');
        cut
    } else {
        clean
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_relay_message_is_shown_on_one_short_line() {
        assert_eq!(
            clip("  blocked:\n not\tallowed \u{7}"),
            "blocked: not allowed"
        );
        let long = clip(&"x".repeat(500));
        assert_eq!(long.chars().count(), MAX_DETAIL_CHARS + 1);
        assert!(long.ends_with('…'));
    }

    #[test]
    fn the_retry_wait_doubles_up_to_the_resend_interval() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(Store::open(dir.path().into()).unwrap()));
        let mut publisher = CardPublisher::new(
            store,
            CardPublication::default(),
            None,
            PublisherTiming {
                retry_initial: Duration::from_secs(60),
                republish_interval: Duration::from_secs(300),
                ..PublisherTiming::default()
            },
        );
        let waits: Vec<u64> = (0..5).map(|_| publisher.next_retry().as_secs()).collect();
        assert_eq!(waits, [60, 120, 240, 300, 300]);
        // Passes the operator asks for do not stretch the wait any further.
        publisher.failed_passes = 0;
        publisher.on_request = true;
        let waits: Vec<u64> = (0..3).map(|_| publisher.next_retry().as_secs()).collect();
        assert_eq!(waits, [60, 60, 60]);
    }

    #[test]
    fn a_new_event_is_dated_now_and_after_what_it_replaces() {
        assert_eq!(next_created_at(1_000, None), 1_000);
        assert_eq!(next_created_at(1_000, Some(400)), 1_000);
        // Two changes within the same second.
        assert_eq!(next_created_at(1_000, Some(1_000)), 1_001);
        // A clock that went back, or a deletion dated a second ahead.
        assert_eq!(next_created_at(1_000, Some(1_250)), 1_251);
        assert_eq!(next_created_at(1_000, Some(u64::MAX)), u64::MAX);
    }
}
