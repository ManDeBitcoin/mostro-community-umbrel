//! The community card as a Nostr event (`card_publication`).
//!
//! Every relay here is a mock on 127.0.0.1, bound inside the port range kept
//! for local test relays. Nothing in this file reaches a real relay: the
//! configurations under test list the mock relays and nothing else.

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use mostro_community_api::{
    AppState,
    adapters::Integrations,
    card_publication::{
        CARD_EVENT_D_TAG, CARD_EVENT_KIND, CardPublication, CardPublisher, DELETION_EVENT_KIND,
        PublicationState, PublisherTiming, RelayOutcome, build_card_deletion, build_card_event,
        card_coordinate, verified_card,
    },
    config::Configuration,
    connection::{CommunityCard, get_community_card, same_card_content, verify_community_card},
    identity,
    notifications::NotificationHub,
    router,
    store::Store,
};
use nostr::{Event, Keys, SecretKey, ToBech32};
use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU16, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{net::TcpListener, task::JoinHandle};
use tokio_tungstenite::tungstenite::protocol::Message;
use tower::ServiceExt;

/// Local test relays live in 39600–39899 on the loopback interface.
static NEXT_PORT: AtomicU16 = AtomicU16::new(39_600);

async fn bind_local() -> TcpListener {
    loop {
        let port = NEXT_PORT.fetch_add(1, Ordering::SeqCst);
        assert!(
            port < 39_900,
            "no free port left in the range of local test relays"
        );
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)).await {
            return listener;
        }
    }
}

/// What a mock relay does with an event it is sent.
#[derive(Clone, Copy)]
enum Answer {
    Accept,
    Reject(&'static str),
    /// Keeps the connection open and never answers.
    Silent,
    /// Answers `OK`, but for an event that is not the one it was sent.
    AcceptAnother,
    /// Says something else and never answers `OK`.
    Notice(&'static str),
    /// Asks for NIP-42 authentication and never answers `OK`.
    Auth,
    /// Closes the connection without a word.
    Hangup,
}

struct MockRelay {
    url: String,
    /// Every event received, in order.
    events: Arc<Mutex<Vec<Event>>>,
    connections: Arc<AtomicUsize>,
    answer: Arc<Mutex<Answer>>,
    handle: JoinHandle<()>,
}

impl MockRelay {
    async fn spawn(answer: Answer) -> Self {
        let listener = bind_local().await;
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let events = Arc::new(Mutex::new(Vec::new()));
        let connections = Arc::new(AtomicUsize::new(0));
        let answer = Arc::new(Mutex::new(answer));
        let handle = tokio::spawn({
            let (events, connections, answer) =
                (events.clone(), connections.clone(), answer.clone());
            async move {
                while let Ok((stream, _)) = listener.accept().await {
                    connections.fetch_add(1, Ordering::SeqCst);
                    let (events, answer) = (events.clone(), answer.clone());
                    tokio::spawn(async move {
                        let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else {
                            return;
                        };
                        while let Some(Ok(message)) = ws.next().await {
                            let Message::Text(text) = message else {
                                continue;
                            };
                            let Ok(frame) = serde_json::from_str::<serde_json::Value>(&text) else {
                                continue;
                            };
                            if frame[0] != "EVENT" {
                                continue;
                            }
                            let event: Event = serde_json::from_value(frame[1].clone())
                                .expect("a well formed event");
                            let id = event.id.to_hex();
                            events.lock().unwrap().push(event);
                            // Copied out: the lock is not held while the relay talks.
                            let answer = *answer.lock().unwrap();
                            let reply = match answer {
                                Answer::Accept => serde_json::json!(["OK", id, true, ""]),
                                Answer::Reject(why) => serde_json::json!(["OK", id, false, why]),
                                Answer::Silent => continue,
                                Answer::AcceptAnother => {
                                    serde_json::json!(["OK", "0".repeat(64), true, ""])
                                }
                                Answer::Notice(text) => serde_json::json!(["NOTICE", text]),
                                Answer::Auth => serde_json::json!(["AUTH", "desafío"]),
                                Answer::Hangup => {
                                    let _ = ws.close(None).await;
                                    break;
                                }
                            };
                            let _ = ws.send(Message::Text(reply.to_string().into())).await;
                        }
                    });
                }
            }
        });
        Self {
            url,
            events,
            connections,
            answer,
            handle,
        }
    }

    fn received(&self) -> Vec<Event> {
        self.events.lock().unwrap().clone()
    }

    fn set_answer(&self, answer: Answer) {
        *self.answer.lock().unwrap() = answer;
    }
}

impl Drop for MockRelay {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

/// The address of a local port nobody listens on.
async fn dead_relay_url() -> String {
    let listener = bind_local().await;
    format!("ws://{}", listener.local_addr().unwrap())
}

fn fixture_config(relays: &[&str]) -> Configuration {
    let mut config: Configuration =
        serde_json::from_str(include_str!("fixtures/community.json")).unwrap();
    config.nostr.relays = relays.iter().map(|relay| relay.to_string()).collect();
    config
}

fn import_identity(dir: &Path, seed: u8) -> Keys {
    // Synthetic test keys only.
    let keys = Keys::new(SecretKey::from_slice(&[seed; 32]).unwrap());
    let secret = keys.secret_key().to_bech32().unwrap();
    let public = keys.public_key().to_bech32().unwrap();
    identity::import(dir, &secret, &public).unwrap();
    keys
}

/// A node with saved rules, an identity and the switch as given.
struct Node {
    dir: tempfile::TempDir,
    store: Arc<Mutex<Store>>,
    keys: Keys,
    handle: CardPublication,
    hub: Arc<NotificationHub>,
}

impl Node {
    fn new(relays: &[&str], publish: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().into()).unwrap();
        store.save(fixture_config(relays)).unwrap();
        if publish {
            store.set_publish_card(true).unwrap();
        }
        let keys = import_identity(dir.path(), 21);
        Self {
            dir,
            store: Arc::new(Mutex::new(store)),
            keys,
            handle: CardPublication::default(),
            // Never the webhook of the environment the tests run in.
            hub: Arc::new(NotificationHub::with_webhook(50, None)),
        }
    }

    /// A publisher over this node's directory, as a fresh start of the API.
    fn publisher(&self, timing: PublisherTiming) -> CardPublisher {
        CardPublisher::new(
            self.store.clone(),
            self.handle.clone(),
            Some(self.hub.clone()),
            timing,
        )
    }

    fn set_switch(&self, on: bool) {
        self.store.lock().unwrap().set_publish_card(on).unwrap();
    }

    fn save(&self, change: impl FnOnce(&mut Configuration)) {
        let mut store = self.store.lock().unwrap();
        let mut config = store.document.config.clone().unwrap();
        change(&mut config);
        store.save(config).unwrap();
    }

    fn card(&self) -> CommunityCard {
        get_community_card(self.dir.path(), &self.store.lock().unwrap()).expect("a card")
    }
}

/// Sends again on every pass, so a test can look at each re-send.
fn resend_always() -> PublisherTiming {
    PublisherTiming {
        republish_interval: Duration::ZERO,
        ..PublisherTiming::test_timing()
    }
}

fn tags_of(event: &Event) -> Vec<Vec<String>> {
    event
        .tags
        .iter()
        .map(|tag| tag.as_slice().to_vec())
        .collect()
}

#[tokio::test]
async fn the_card_event_has_the_agreed_shape_and_both_signatures_hold() {
    let relay = MockRelay::spawn(Answer::Accept).await;
    let node = Node::new(&[&relay.url], true);
    let mut publisher = node.publisher(PublisherTiming::test_timing());

    publisher.run_once().await;

    let received = relay.received();
    assert_eq!(received.len(), 1);
    let event = &received[0];
    assert_eq!(event.kind.as_u16(), CARD_EVENT_KIND);
    assert_eq!(event.kind.as_u16(), 30078);
    assert_eq!(event.pubkey, node.keys.public_key());
    // The address and nothing else: no expiration, nothing about liveness.
    assert_eq!(tags_of(event), [["d", "mostro-community-card"]]);
    assert_eq!(CARD_EVENT_D_TAG, "mostro-community-card");
    assert!(event.verify().is_ok());

    // The content is the card as the panel hands it out: compact JSON, signed.
    let card: CommunityCard = serde_json::from_str(&event.content).unwrap();
    assert_eq!(serde_json::to_string(&card).unwrap(), event.content);
    assert!(!event.content.contains('\n') && !event.content.contains(": "));
    assert_eq!(card.version, 1);
    assert_eq!(card.pubkey, event.pubkey.to_hex());
    assert_eq!(card.signature.len(), 128);
    assert!(verify_community_card(&card));
    assert!(same_card_content(&card, &node.card()));
    assert_eq!(card.relays, std::slice::from_ref(&relay.url));
    assert_eq!(card.payment_methods, ["Transferencia"]);

    // What a client checks before it trusts the event.
    assert_eq!(
        verified_card(event, &node.keys.public_key()).as_ref(),
        Some(&card)
    );
    let stranger = Keys::new(SecretKey::from_slice(&[22; 32]).unwrap());
    assert_eq!(verified_card(event, &stranger.public_key()), None);

    let status = node.handle.status().await;
    assert_eq!(status.state, PublicationState::Published);
    assert_eq!(status.event_id.as_deref(), Some(event.id.to_hex().as_str()));
    assert_eq!(status.card_changed_at, Some(event.created_at.as_secs()));
    assert_eq!(status.relays.len(), 1);
    assert_eq!(status.relays[0].url, relay.url);
    assert_eq!(status.relays[0].outcome, RelayOutcome::Accepted);
    assert_eq!(status.reason, None);
    let view = node.handle.view(true).await;
    assert!(view.enabled && !view.working);

    // The secret key goes nowhere: not to the relay, not to the record on disk.
    let secret = node.keys.secret_key().to_bech32().unwrap();
    let secret_hex = node.keys.secret_key().to_secret_hex();
    let on_disk = std::fs::read_to_string(node.dir.path().join("card-publication.json")).unwrap();
    for text in [serde_json::to_string(event).unwrap(), on_disk] {
        assert!(!text.contains(&secret) && !text.contains(&secret_hex));
    }
}

#[tokio::test]
async fn nothing_is_published_while_the_switch_is_off() {
    let relay = MockRelay::spawn(Answer::Accept).await;
    // Rules and identity are there: only the operator's switch is missing.
    let node = Node::new(&[&relay.url], false);
    assert!(!node.store.lock().unwrap().document.publish_card);
    let mut publisher = node.publisher(resend_always());

    publisher.run_once().await;
    publisher.run_once().await;

    assert_eq!(relay.connections.load(Ordering::SeqCst), 0);
    assert!(relay.received().is_empty());
    let status = node.handle.status().await;
    assert_eq!(status.state, PublicationState::Off);
    assert_eq!(status.event_id, None);
    assert!(status.relays.is_empty());
    assert!(!node.handle.view(false).await.working);
    // Nothing was signed either.
    assert!(!node.dir.path().join("card-publication.json").exists());
}

#[tokio::test]
async fn nothing_is_published_when_the_card_cannot_be_issued() {
    let relay = MockRelay::spawn(Answer::Accept).await;

    // The switch is on, and the node has no identity.
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().into()).unwrap();
    store.save(fixture_config(&[&relay.url])).unwrap();
    store.set_publish_card(true).unwrap();
    let without_identity = (dir, store, "no_identity");

    // A draft from before the check, with a separator the signature cannot escape.
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().into()).unwrap();
    let mut config = fixture_config(&[&relay.url]);
    config.community.name = "Bitcoin & Lightning".into();
    assert!(config.card_is_ambiguous());
    store.save(config).unwrap();
    store.set_publish_card(true).unwrap();
    import_identity(dir.path(), 23);
    let ambiguous = (dir, store, "ambiguous");

    // The switch on in a file that holds no rules.
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().into()).unwrap();
    store.document.publish_card = true;
    import_identity(dir.path(), 24);
    let without_rules = (dir, store, "no_rules");

    for (dir, store, reason) in [without_identity, ambiguous, without_rules] {
        assert_eq!(get_community_card(dir.path(), &store), None);
        let handle = CardPublication::default();
        let hub = Arc::new(NotificationHub::with_webhook(50, None));
        let mut publisher = CardPublisher::new(
            Arc::new(Mutex::new(store)),
            handle.clone(),
            Some(hub.clone()),
            resend_always(),
        );
        publisher.run_once().await;
        publisher.run_once().await;

        let status = handle.status().await;
        assert_eq!(status.state, PublicationState::Blocked, "{reason}");
        assert_eq!(status.reason, Some(reason));
        // The panel is told why, in a sentence.
        assert!(status.reason_text.is_some_and(|text| text.len() > 20));
        assert_eq!(status.event_id, None);
        assert!(status.relays.is_empty());
        assert!(!dir.path().join("card-publication.json").exists());
    }
    assert_eq!(relay.connections.load(Ordering::SeqCst), 0);
    assert!(relay.received().is_empty());
}

#[tokio::test]
async fn an_unchanged_card_keeps_its_event_and_its_date() {
    let relay = MockRelay::spawn(Answer::Accept).await;
    let node = Node::new(&[&relay.url], true);

    // Before the re-send is due, a pass does not send the event again.
    let mut patient = node.publisher(PublisherTiming::test_timing());
    patient.run_once().await;
    patient.run_once().await;
    assert_eq!(relay.received().len(), 1);
    drop(patient);

    // When it is due, the same signed event goes out again...
    let mut publisher = node.publisher(resend_always());
    publisher.run_once().await;
    publisher.run_once().await;
    // ...also after a save that leaves the card as it was...
    node.save(|config| config.market.min_trade_sats = 200);
    publisher.run_once().await;
    // ...and after a restart, which reads it back from the disk.
    drop(publisher);
    tokio::time::sleep(Duration::from_millis(1100)).await;
    node.publisher(resend_always()).run_once().await;

    let received = relay.received();
    assert_eq!(received.len(), 5);
    let first = &received[0];
    for again in &received[1..] {
        // Same id, date, content and signature: byte for byte the same event.
        assert_eq!(again, first);
        assert_eq!(again.created_at, first.created_at);
        assert_eq!(again.sig, first.sig);
    }
    let status = node.handle.status().await;
    assert_eq!(status.state, PublicationState::Published);
    assert_eq!(status.card_changed_at, Some(first.created_at.as_secs()));
}

#[tokio::test]
async fn a_changed_card_gets_a_new_event_with_a_later_date() {
    let relay = MockRelay::spawn(Answer::Accept).await;
    let node = Node::new(&[&relay.url], true);
    let mut publisher = node.publisher(PublisherTiming::test_timing());
    publisher.run_once().await;

    // The operator adds a payment method, within the same second.
    node.save(|config| {
        config
            .payment_methods
            .push(mostro_community_api::config::PaymentMethod {
                id: "deuna".into(),
                label: "DeUna".into(),
                category: "Ecuador".into(),
                active: true,
            })
    });
    publisher.run_once().await;
    // And then the contact link.
    node.save(|config| config.community.contact = "https://t.me/comunidad".into());
    publisher.run_once().await;

    let received = relay.received();
    assert_eq!(received.len(), 3);
    for pair in received.windows(2) {
        assert_ne!(pair[1].id, pair[0].id);
        // Strictly later, or a relay would keep the older revision.
        assert!(pair[1].created_at > pair[0].created_at);
    }
    let cards: Vec<CommunityCard> = received
        .iter()
        .map(|event| verified_card(event, &node.keys.public_key()).expect("a valid card event"))
        .collect();
    assert_eq!(cards[0].payment_methods, ["Transferencia"]);
    assert_eq!(cards[1].payment_methods, ["Transferencia", "DeUna"]);
    assert_eq!(cards[2].contact, "https://t.me/comunidad");
    for event in &received {
        assert_eq!(tags_of(event), [["d", "mostro-community-card"]]);
    }
    let status = node.handle.status().await;
    assert_eq!(status.event_id, Some(received[2].id.to_hex()));
    assert_eq!(
        status.card_changed_at,
        Some(received[2].created_at.as_secs())
    );
}

#[tokio::test]
async fn a_relay_that_rejects_is_reported_and_nothing_is_claimed() {
    let refusing = MockRelay::spawn(Answer::Reject("blocked: solo miembros")).await;
    let node = Node::new(&[&refusing.url], true);
    let mut publisher = node.publisher(PublisherTiming::test_timing());

    publisher.run_once().await;

    let status = node.handle.status().await;
    assert_eq!(status.state, PublicationState::Failed);
    assert_eq!(status.relays.len(), 1);
    assert_eq!(status.relays[0].outcome, RelayOutcome::Rejected);
    assert_eq!(
        status.relays[0].detail.as_deref(),
        Some("blocked: solo miembros")
    );
    // One missed attempt is not an alert yet; the second one is, once.
    assert_eq!(node.hub.count().await, 0);
    publisher.run_once().await;
    publisher.run_once().await;
    let alerts = node.hub.get_recent(10).await;
    assert_eq!(alerts.len(), 1);
    assert_eq!(alerts[0].category, "card");
    assert_eq!(alerts[0].level, "warning");
    assert_eq!(
        alerts[0].title,
        "La tarjeta de la comunidad no está publicada"
    );
    assert!(alerts[0].message.contains(&refusing.url));
    assert!(alerts[0].message.contains("blocked: solo miembros"));
    // Every pass tried again, with the same event.
    let attempts = refusing.received();
    assert_eq!(attempts.len(), 3);
    assert!(attempts.iter().all(|event| event == &attempts[0]));

    // Once the relay takes it, the card is published.
    refusing.set_answer(Answer::Accept);
    publisher.run_once().await;
    let status = node.handle.status().await;
    assert_eq!(status.state, PublicationState::Published);
    assert_eq!(status.relays[0].outcome, RelayOutcome::Accepted);
    assert_eq!(node.hub.count().await, 1);
}

#[tokio::test]
async fn each_relay_is_reported_on_its_own() {
    let accepting = MockRelay::spawn(Answer::Accept).await;
    let refusing = MockRelay::spawn(Answer::Reject("rate-limited: despacio")).await;
    let silent = MockRelay::spawn(Answer::Silent).await;
    let confused = MockRelay::spawn(Answer::AcceptAnother).await;
    let dead = dead_relay_url().await;
    let node = Node::new(
        &[
            &accepting.url,
            &refusing.url,
            &silent.url,
            &confused.url,
            &dead,
        ],
        true,
    );
    let mut publisher = node.publisher(PublisherTiming::test_timing());

    publisher.run_once().await;

    let status = node.handle.status().await;
    // One relay has it: published there, and not on the others.
    assert_eq!(status.state, PublicationState::Partial);
    let outcome = |url: &str| {
        status
            .relays
            .iter()
            .find(|report| report.url == url)
            .map(|report| report.outcome)
    };
    assert_eq!(outcome(&accepting.url), Some(RelayOutcome::Accepted));
    assert_eq!(outcome(&refusing.url), Some(RelayOutcome::Rejected));
    assert_eq!(outcome(&silent.url), Some(RelayOutcome::NoAnswer));
    // An `OK` for some other event says nothing about this one.
    assert_eq!(outcome(&confused.url), Some(RelayOutcome::NoAnswer));
    assert_eq!(outcome(&dead), Some(RelayOutcome::Unreachable));
    assert!(
        status
            .relays
            .iter()
            .filter(|report| report.outcome != RelayOutcome::Accepted)
            .all(|report| report.detail.is_some())
    );

    // The next pass leaves the relay that has the event alone.
    publisher.run_once().await;
    assert_eq!(accepting.received().len(), 1);
    assert_eq!(refusing.received().len(), 2);
    let alerts = node.hub.get_recent(10).await;
    assert_eq!(alerts.len(), 1);
    assert_eq!(alerts[0].title, "Algunos relays no aceptaron la tarjeta");
    assert!(!alerts[0].message.contains(&accepting.url));
}

#[tokio::test]
async fn turning_the_switch_off_asks_the_relays_to_delete_the_card() {
    let relay = MockRelay::spawn(Answer::Accept).await;
    let node = Node::new(&[&relay.url], true);
    let mut publisher = node.publisher(resend_always());
    publisher.run_once().await;
    let card_event = relay.received()[0].clone();

    node.set_switch(false);
    publisher.run_once().await;

    let received = relay.received();
    assert_eq!(received.len(), 2);
    let deletion = &received[1];
    assert_eq!(deletion.kind.as_u16(), DELETION_EVENT_KIND);
    assert_eq!(deletion.kind.as_u16(), 5);
    assert_eq!(deletion.pubkey, node.keys.public_key());
    assert!(deletion.verify().is_ok());
    assert!(deletion.created_at > card_event.created_at);
    // The card's address and its last revision. No other event of the node.
    let node_hex = node.keys.public_key().to_hex();
    assert_eq!(
        tags_of(deletion),
        [
            vec![
                "a".to_string(),
                format!("30078:{node_hex}:mostro-community-card")
            ],
            vec!["e".to_string(), card_event.id.to_hex()],
            vec!["k".to_string(), "30078".to_string()],
        ]
    );
    assert_eq!(
        card_coordinate(&node_hex),
        format!("30078:{node_hex}:mostro-community-card")
    );
    assert!(!serde_json::to_string(deletion).unwrap().contains("rates"));

    let status = node.handle.status().await;
    assert_eq!(status.state, PublicationState::Withdrawn);
    assert_eq!(status.withdrawn_at, Some(deletion.created_at.as_secs()));
    assert_eq!(status.event_id, None);

    // Off means off: no card and no further deletion, also after a restart.
    publisher.run_once().await;
    drop(publisher);
    let mut publisher = node.publisher(resend_always());
    publisher.run_once().await;
    assert_eq!(relay.received().len(), 2);
    assert_eq!(
        node.handle.status().await.state,
        PublicationState::Withdrawn
    );

    // Back on: a new event, dated after the deletion a relay may have applied.
    node.set_switch(true);
    publisher.run_once().await;
    let received = relay.received();
    assert_eq!(received.len(), 3);
    let again = &received[2];
    assert_eq!(again.kind.as_u16(), CARD_EVENT_KIND);
    assert_ne!(again.id, card_event.id);
    assert!(again.created_at > deletion.created_at);
    assert!(verified_card(again, &node.keys.public_key()).is_some());
    assert_eq!(
        node.handle.status().await.state,
        PublicationState::Published
    );
}

#[tokio::test]
async fn a_deletion_a_relay_did_not_take_is_asked_again() {
    let relay = MockRelay::spawn(Answer::Accept).await;
    let node = Node::new(&[&relay.url], true);
    let mut publisher = node.publisher(resend_always());
    publisher.run_once().await;

    relay.set_answer(Answer::Reject("error: ahora no"));
    node.set_switch(false);
    publisher.run_once().await;
    let status = node.handle.status().await;
    assert_eq!(status.state, PublicationState::Withdrawing);
    assert_eq!(status.relays.len(), 1);
    assert_eq!(status.relays[0].outcome, RelayOutcome::Rejected);
    assert_eq!(status.relays[0].detail.as_deref(), Some("error: ahora no"));

    relay.set_answer(Answer::Accept);
    publisher.run_once().await;
    assert_eq!(
        node.handle.status().await.state,
        PublicationState::Withdrawn
    );
    let received = relay.received();
    assert_eq!(received.len(), 3);
    // The same request both times.
    assert_eq!(received[1], received[2]);
    assert_eq!(received[1].kind.as_u16(), DELETION_EVENT_KIND);
}

#[tokio::test]
async fn a_card_no_relay_was_handed_needs_no_deletion() {
    let refusing = MockRelay::spawn(Answer::Reject("blocked: no")).await;
    let node = Node::new(&[&refusing.url], true);
    let mut publisher = node.publisher(resend_always());
    publisher.run_once().await;
    assert_eq!(node.handle.status().await.state, PublicationState::Failed);

    node.set_switch(false);
    publisher.run_once().await;

    assert_eq!(refusing.received().len(), 1);
    assert_eq!(refusing.received()[0].kind.as_u16(), CARD_EVENT_KIND);
    assert_eq!(node.handle.status().await.state, PublicationState::Off);
}

#[tokio::test]
async fn the_worker_sends_the_same_event_again_every_interval() {
    let relay = MockRelay::spawn(Answer::Accept).await;
    let node = Node::new(&[&relay.url], true);
    let worker = tokio::spawn(
        node.publisher(PublisherTiming {
            republish_interval: Duration::from_millis(150),
            ..PublisherTiming::test_timing()
        })
        .run(),
    );

    tokio::time::sleep(Duration::from_millis(900)).await;
    worker.abort();

    let received = relay.received();
    assert!(received.len() >= 3, "{} copies", received.len());
    assert!(received.len() <= 8, "{} copies", received.len());
    assert!(received.iter().all(|event| event == &received[0]));
}

#[tokio::test]
async fn what_a_relay_says_instead_of_ok_is_kept_as_the_reason() {
    let noticing = MockRelay::spawn(Answer::Notice("restricted: paga primero")).await;
    let asking = MockRelay::spawn(Answer::Auth).await;
    let closing = MockRelay::spawn(Answer::Hangup).await;
    let node = Node::new(&[&noticing.url, &asking.url, &closing.url], true);

    node.publisher(PublisherTiming::test_timing())
        .run_once()
        .await;

    let status = node.handle.status().await;
    assert_eq!(status.state, PublicationState::Failed);
    let report = |url: &str| {
        status
            .relays
            .iter()
            .find(|report| report.url == url)
            .cloned()
            .expect("a report for every relay")
    };
    // None of them said `OK`: none of them has the card as far as the panel knows.
    for url in [&noticing.url, &asking.url, &closing.url] {
        assert_eq!(report(url).outcome, RelayOutcome::NoAnswer);
    }
    assert_eq!(
        report(&noticing.url).detail.as_deref(),
        Some("restricted: paga primero")
    );
    assert!(report(&asking.url).detail.unwrap().contains("NIP-42"));
    assert!(
        report(&closing.url)
            .detail
            .unwrap()
            .contains("cerró la conexión")
    );
}

#[tokio::test]
async fn an_event_that_cannot_be_saved_is_not_sent() {
    let relay = MockRelay::spawn(Answer::Accept).await;
    let node = Node::new(&[&relay.url], true);
    // Something in the way of the record: a rename onto a directory fails for any user.
    let record = node.dir.path().join("card-publication.json");
    std::fs::create_dir(&record).unwrap();
    let mut publisher = node.publisher(resend_always());

    publisher.run_once().await;
    publisher.run_once().await;

    // What a relay holds must be what the next start sends again, so
    // without the record nothing leaves.
    assert_eq!(relay.connections.load(Ordering::SeqCst), 0);
    let status = node.handle.status().await;
    assert_eq!(status.state, PublicationState::Failed);
    assert_eq!(status.reason, Some("storage"));
    assert!(
        status
            .reason_text
            .unwrap()
            .contains("No se ha enviado nada")
    );
    assert_eq!(status.event_id, None);

    std::fs::remove_dir(&record).unwrap();
    publisher.run_once().await;
    assert_eq!(
        node.handle.status().await.state,
        PublicationState::Published
    );
    // And a restart finds that very event on disk.
    drop(publisher);
    node.publisher(resend_always()).run_once().await;
    let received = relay.received();
    assert_eq!(received.len(), 2);
    assert_eq!(received[0], received[1]);
}

#[tokio::test]
async fn a_withdrawal_reaches_a_relay_that_left_the_configuration() {
    let kept = MockRelay::spawn(Answer::Accept).await;
    let dropped = MockRelay::spawn(Answer::Accept).await;
    let node = Node::new(&[&kept.url, &dropped.url], true);
    let mut publisher = node.publisher(PublisherTiming::test_timing());
    publisher.run_once().await;
    assert!(node.handle.status().await.former_relays.is_empty());

    // The operator removes a relay. The card changes with it.
    node.save(|config| config.nostr.relays = vec![kept.url.clone()]);
    publisher.run_once().await;
    let status = node.handle.status().await;
    assert_eq!(status.state, PublicationState::Published);
    assert_eq!(status.relays.len(), 1);
    // The removed relay still has the earlier revision, and the panel says so.
    assert_eq!(status.former_relays, std::slice::from_ref(&dropped.url));
    assert_eq!(kept.received().len(), 2);
    assert_eq!(dropped.received().len(), 1);

    node.set_switch(false);
    publisher.run_once().await;
    assert_eq!(
        node.handle.status().await.state,
        PublicationState::Withdrawn
    );
    for relay in [&kept, &dropped] {
        let last = relay.received().pop().unwrap();
        assert_eq!(last.kind.as_u16(), DELETION_EVENT_KIND);
        assert_eq!(
            tags_of(&last)[0],
            [
                "a".to_string(),
                card_coordinate(&node.keys.public_key().to_hex())
            ]
        );
    }
    assert_eq!(kept.received().pop(), dropped.received().pop());
}

#[tokio::test]
async fn a_withdrawal_goes_on_after_a_restart_and_stops_after_its_window() {
    let relay = MockRelay::spawn(Answer::Accept).await;
    let node = Node::new(&[&relay.url], true);
    let mut publisher = node.publisher(resend_always());
    publisher.run_once().await;
    relay.set_answer(Answer::Reject("error: ahora no"));
    node.set_switch(false);
    publisher.run_once().await;
    assert_eq!(
        node.handle.status().await.state,
        PublicationState::Withdrawing
    );
    drop(publisher);

    // After a restart the relay is still owed the request, and says so before it is asked.
    relay.set_answer(Answer::Accept);
    let mut restarted = node.publisher(resend_always());
    restarted.run_once().await;
    assert_eq!(
        node.handle.status().await.state,
        PublicationState::Withdrawn
    );
    let received = relay.received();
    assert_eq!(received.len(), 3);
    assert_eq!(received[1], received[2]);

    // A relay that never takes it is not asked for ever.
    let stubborn = MockRelay::spawn(Answer::Accept).await;
    let node = Node::new(&[&stubborn.url], true);
    let mut publisher = node.publisher(PublisherTiming {
        withdrawal_retry: Duration::ZERO,
        ..resend_always()
    });
    publisher.run_once().await;
    stubborn.set_answer(Answer::Reject("blocked: no borro nada"));
    node.set_switch(false);
    // The request is always sent once.
    publisher.run_once().await;
    assert_eq!(stubborn.received().len(), 2);
    assert_eq!(
        node.handle.status().await.state,
        PublicationState::Withdrawing
    );
    publisher.run_once().await;
    publisher.run_once().await;
    assert_eq!(stubborn.received().len(), 2);
    let status = node.handle.status().await;
    assert_eq!(status.state, PublicationState::WithdrawalIncomplete);
    // The panel names the relay that may still have the card, and what it answered.
    assert_eq!(status.relays.len(), 1);
    assert_eq!(status.relays[0].url, stubborn.url);
    assert_eq!(status.relays[0].outcome, RelayOutcome::Rejected);
}

#[cfg(unix)]
#[tokio::test]
async fn a_key_that_cannot_be_read_delays_the_withdrawal_instead_of_losing_it() {
    use std::os::unix::fs::PermissionsExt;
    let relay = MockRelay::spawn(Answer::Accept).await;
    let node = Node::new(&[&relay.url], true);
    let mut publisher = node.publisher(resend_always());
    publisher.run_once().await;
    let card_event = relay.received()[0].clone();

    // The identity folder loses its private mode: the key is there and is not read.
    let identity_dir = node.dir.path().join("identity");
    std::fs::set_permissions(&identity_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    node.set_switch(false);
    publisher.run_once().await;
    publisher.run_once().await;

    assert_eq!(relay.received().len(), 1);
    let status = node.handle.status().await;
    assert_eq!(status.state, PublicationState::Withdrawing);
    assert_eq!(status.reason, Some("identity_unreadable"));
    assert_eq!(status.relays.len(), 1);
    // Nothing was asked of the relay yet: its answer to the card is not shown as one to the deletion.
    assert_eq!(status.relays[0].outcome, RelayOutcome::Pending);

    // Fixed, also across a restart: the card that was published is withdrawn.
    std::fs::set_permissions(&identity_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    drop(publisher);
    node.publisher(resend_always()).run_once().await;
    let received = relay.received();
    assert_eq!(received.len(), 2);
    assert_eq!(received[1].kind.as_u16(), DELETION_EVENT_KIND);
    assert_eq!(
        tags_of(&received[1])[1],
        ["e".to_string(), card_event.id.to_hex()]
    );
    assert_eq!(
        node.handle.status().await.state,
        PublicationState::Withdrawn
    );
}

#[tokio::test]
async fn the_card_of_a_replaced_identity_is_told_not_silently_forgotten() {
    let relay = MockRelay::spawn(Answer::Accept).await;
    let node = Node::new(&[&relay.url], true);
    let mut publisher = node.publisher(resend_always());
    publisher.run_once().await;
    let old_event = relay.received()[0].clone();

    // The node gets another key. Only the old one could withdraw what it signed.
    let new_keys = Keys::new(SecretKey::from_slice(&[31; 32]).unwrap());
    identity::import_nsec_with_overwrite(
        node.dir.path(),
        &new_keys.secret_key().to_bech32().unwrap(),
        true,
    )
    .unwrap();
    publisher.run_once().await;

    let received = relay.received();
    assert_eq!(received.len(), 2);
    let new_event = &received[1];
    assert_eq!(new_event.pubkey, new_keys.public_key());
    assert_ne!(new_event.pubkey, old_event.pubkey);
    assert!(verified_card(new_event, &new_keys.public_key()).is_some());
    assert_eq!(
        node.handle.status().await.state,
        PublicationState::Published
    );
    let alerts = node.hub.get_recent(10).await;
    assert_eq!(alerts.len(), 1);
    assert_eq!(
        alerts[0].title,
        "La tarjeta de la identidad anterior sigue en los relays"
    );
    assert!(alerts[0].message.contains(&relay.url));

    // A later withdrawal is about the new key's card and nothing else.
    node.set_switch(false);
    publisher.run_once().await;
    let deletion = relay.received().pop().unwrap();
    assert_eq!(deletion.pubkey, new_keys.public_key());
    assert_eq!(
        tags_of(&deletion),
        [
            vec![
                "a".to_string(),
                card_coordinate(&new_keys.public_key().to_hex())
            ],
            vec!["e".to_string(), new_event.id.to_hex()],
            vec!["k".to_string(), "30078".to_string()],
        ]
    );

    // And when the key is gone at the time of the withdrawal, the panel says it cannot ask.
    let relay = MockRelay::spawn(Answer::Accept).await;
    let node = Node::new(&[&relay.url], true);
    let mut publisher = node.publisher(resend_always());
    publisher.run_once().await;
    identity::import_nsec_with_overwrite(
        node.dir.path(),
        &new_keys.secret_key().to_bech32().unwrap(),
        true,
    )
    .unwrap();
    node.set_switch(false);
    publisher.run_once().await;
    publisher.run_once().await;
    assert_eq!(relay.received().len(), 1);
    let status = node.handle.status().await;
    assert_eq!(status.state, PublicationState::Off);
    assert_eq!(status.reason, Some("identity_changed"));
    assert!(status.reason_text.unwrap().contains(&relay.url));
}

/// The record is a file. Whatever is found in it, the only event the panel
/// ever asks a relay to delete is a card event.
#[tokio::test]
async fn a_record_that_holds_another_event_of_the_node_gets_no_deletion() {
    let relay = MockRelay::spawn(Answer::Accept).await;
    let node = Node::new(&[&relay.url], false);
    // The node's own, validly signed events: its info event and its rates.
    let info = nostr::EventBuilder::new(nostr::Kind::from(38385u16), "")
        .tag(nostr::Tag::identifier(node.keys.public_key().to_hex()))
        .sign_with_keys(&node.keys)
        .unwrap();
    let rates = nostr::EventBuilder::new(nostr::Kind::from(30078u16), "{}")
        .tag(nostr::Tag::identifier("mostro-rates"))
        .sign_with_keys(&node.keys)
        .unwrap();
    for planted in [info, rates] {
        std::fs::write(
            node.dir.path().join("card-publication.json"),
            serde_json::json!({"event": planted, "deletion": null, "holders": [relay.url]})
                .to_string(),
        )
        .unwrap();
        let mut publisher = node.publisher(resend_always());
        publisher.run_once().await;
        publisher.run_once().await;
        assert_eq!(node.handle.status().await.state, PublicationState::Off);
    }
    assert_eq!(relay.connections.load(Ordering::SeqCst), 0);
    assert!(relay.received().is_empty());

    // With the switch on it is not sent again either: the card event is signed anew.
    node.set_switch(true);
    node.publisher(resend_always()).run_once().await;
    let received = relay.received();
    assert_eq!(received.len(), 1);
    assert!(verified_card(&received[0], &node.keys.public_key()).is_some());
}

// ── Through the HTTP API ──────────────────────────────────────────────────────

fn app_for(node: &Node) -> axum::Router {
    let (tx, _rx) = tokio::sync::watch::channel(mostro_community_api::orders::MonitorCommand {
        config: fixture_config(&["ws://127.0.0.1:39599"]),
        npub: None,
    });
    let mut state = AppState::new(
        node.store.clone(),
        Integrations::default(),
        Arc::new(tokio::sync::RwLock::new(
            mostro_community_api::orders::OrdersCache::new(),
        )),
        Arc::new(tokio::sync::RwLock::new(
            mostro_community_api::chat::ChatCache::new(),
        )),
        tx,
    );
    state.notifications = node.hub.clone();
    state.card_publication = node.handle.clone();
    router(state)
}

fn request(
    method: &str,
    uri: &str,
    protected: bool,
    body: Option<serde_json::Value>,
) -> Request<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .header("host", "localhost:5173")
        .header("origin", "http://localhost:5173");
    if protected {
        builder = builder.header("x-requested-with", "mostro-community");
    }
    builder
        .body(body.map_or_else(Body::empty, |value| Body::from(value.to_string())))
        .unwrap()
}

async fn json_of(response: axum::response::Response) -> serde_json::Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

const SWITCH: &str = "/api/community/card/publication";

#[tokio::test]
async fn the_switch_is_off_by_default_and_saved_apart_from_the_rules() {
    let node = Node::new(&["ws://127.0.0.1:39599"], false);
    let app = app_for(&node);
    let saved = || {
        serde_json::from_slice::<serde_json::Value>(
            &std::fs::read(node.dir.path().join("community.json")).unwrap(),
        )
        .unwrap()
    };

    let status = json_of(
        app.clone()
            .oneshot(request("GET", SWITCH, false, None))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(status["enabled"], false);
    assert_eq!(status["state"], "off");
    assert!(saved().get("publish_card").is_none());

    // It is a change: it needs the same protection as saving the rules.
    let on = serde_json::json!({"enabled": true});
    let refused = app
        .clone()
        .oneshot(request("PUT", SWITCH, false, Some(on.clone())))
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    assert!(saved().get("publish_card").is_none());
    let unknown = app
        .clone()
        .oneshot(request(
            "PUT",
            SWITCH,
            true,
            Some(serde_json::json!({"enabled": true, "relays": ["wss://otro.example"]})),
        ))
        .await
        .unwrap();
    assert_eq!(unknown.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let accepted = app
        .clone()
        .oneshot(request("PUT", SWITCH, true, Some(on)))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::OK);
    let status = json_of(accepted).await;
    assert_eq!(status["enabled"], true);
    // No worker runs in this test: the change is still to be acted on.
    assert_eq!(status["working"], true);
    assert_eq!(saved()["publish_card"], true);
    // The rules did not move, and no copy of a "previous revision" was made.
    assert_eq!(saved()["revision"], 1);
    let previous = node.dir.path().join("community.previous.json");
    assert!(!previous.exists());

    // Saving the rules keeps the switch.
    let config: serde_json::Value =
        serde_json::to_value(fixture_config(&["ws://127.0.0.1:39599"])).unwrap();
    let resaved = app
        .clone()
        .oneshot(request(
            "PUT",
            "/api/community",
            true,
            Some(serde_json::json!({"revision": 1, "config": config})),
        ))
        .await
        .unwrap();
    assert_eq!(resaved.status(), StatusCode::OK);
    assert_eq!(saved()["revision"], 2);
    assert_eq!(saved()["publish_card"], true);
    let previous_revision = std::fs::read(&previous).unwrap();

    let off = app
        .clone()
        .oneshot(request(
            "PUT",
            SWITCH,
            true,
            Some(serde_json::json!({"enabled": false})),
        ))
        .await
        .unwrap();
    assert_eq!(json_of(off).await["enabled"], false);
    assert!(saved().get("publish_card").is_none());
    assert_eq!(saved()["revision"], 2);
    // The copy of revision 1 is still the copy of revision 1.
    assert_eq!(std::fs::read(&previous).unwrap(), previous_revision);
    // A file written with the switch on opens again.
    node.set_switch(true);
    let reopened = Store::open(node.dir.path().into()).unwrap();
    assert!(reopened.document.publish_card);
}

#[tokio::test]
async fn the_switch_needs_saved_rules() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Mutex::new(Store::open(dir.path().into()).unwrap()));
    let (tx, _rx) = tokio::sync::watch::channel(mostro_community_api::orders::MonitorCommand {
        config: fixture_config(&["ws://127.0.0.1:39599"]),
        npub: None,
    });
    let app = router(AppState::new(
        store,
        Integrations::default(),
        Arc::new(tokio::sync::RwLock::new(
            mostro_community_api::orders::OrdersCache::new(),
        )),
        Arc::new(tokio::sync::RwLock::new(
            mostro_community_api::chat::ChatCache::new(),
        )),
        tx,
    ));
    let refused = app
        .oneshot(request(
            "PUT",
            SWITCH,
            true,
            Some(serde_json::json!({"enabled": true})),
        ))
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::CONFLICT);
    assert!(!dir.path().join("community.json").exists());
}

#[tokio::test]
async fn the_api_publishes_when_the_switch_is_turned_on_and_after_each_save() {
    let relay = MockRelay::spawn(Answer::Accept).await;
    let node = Node::new(&[&relay.url], false);
    let app = app_for(&node);
    let worker = tokio::spawn(node.publisher(PublisherTiming::test_timing()).run());

    async fn settled(app: &axum::Router) -> serde_json::Value {
        for _ in 0..200 {
            let status = json_of(
                app.clone()
                    .oneshot(request("GET", SWITCH, false, None))
                    .await
                    .unwrap(),
            )
            .await;
            if status["working"] == false {
                return status;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the publisher never caught up");
    }

    // At start, with the switch off, nothing goes out.
    assert_eq!(settled(&app).await["state"], "off");
    assert!(relay.received().is_empty());

    let on = app
        .clone()
        .oneshot(request(
            "PUT",
            SWITCH,
            true,
            Some(serde_json::json!({"enabled": true})),
        ))
        .await
        .unwrap();
    assert_eq!(on.status(), StatusCode::OK);
    let status = settled(&app).await;
    assert_eq!(status["state"], "published");
    assert_eq!(status["relays"][0]["outcome"], "accepted");
    assert_eq!(status["relays"][0]["url"], relay.url);
    assert_eq!(relay.received().len(), 1);
    let first = relay.received()[0].clone();
    assert_eq!(status["event_id"], first.id.to_hex());
    assert_eq!(status["card_changed_at"], first.created_at.as_secs());
    assert_eq!(status["resend_every_secs"], 3600);

    // A save that changes the card publishes the new one without being asked.
    let mut config = fixture_config(&[&relay.url]);
    config.community.website = "https://comunidad.example".into();
    let saved = app
        .clone()
        .oneshot(request(
            "PUT",
            "/api/community",
            true,
            Some(serde_json::json!({"revision": 1, "config": config})),
        ))
        .await
        .unwrap();
    assert_eq!(saved.status(), StatusCode::OK);
    let status = settled(&app).await;
    assert_eq!(status["state"], "published");
    let received = relay.received();
    assert_eq!(received.len(), 2);
    assert!(received[1].created_at > first.created_at);
    assert_eq!(
        verified_card(&received[1], &node.keys.public_key())
            .unwrap()
            .website,
        "https://comunidad.example"
    );
    // The secret key is in none of it.
    let body = serde_json::to_string(&status).unwrap();
    assert!(!body.contains("nsec1"));
    assert!(!body.contains(&node.keys.secret_key().to_secret_hex()));

    worker.abort();
}

// ── Test vector of the integration guide ──────────────────────────────────────

#[derive(serde::Deserialize)]
struct Vector {
    card_event: Event,
    deletion_event: Event,
}

/// `docs/INTEGRACION-APPS.md` prints this event for app developers. It was
/// signed with a synthetic key; the panel must still read it and build it.
#[test]
fn the_vector_of_the_guide_is_what_the_panel_emits() {
    let vector: Vector =
        serde_json::from_str(include_str!("fixtures/community-card-event.json")).unwrap();
    let keys = Keys::new(SecretKey::from_slice(&[0x11; 32]).unwrap());
    let node = keys.public_key();
    let event = &vector.card_event;

    assert_eq!(event.kind.as_u16(), 30078);
    assert_eq!(event.pubkey, node);
    assert_eq!(tags_of(event), [["d", "mostro-community-card"]]);
    assert!(event.verify().is_ok());
    let card = verified_card(event, &node).expect("the card of the vector");
    assert_eq!(card.pubkey, node.to_hex());
    assert_eq!(card.payment_methods, ["Transferencia bancaria", "Efectivo"]);

    // The same card at the same date is the same event id: the content is
    // serialised today exactly as when the vector was made.
    let rebuilt = build_card_event(&keys, &card, event.created_at.as_secs()).unwrap();
    assert_eq!(rebuilt.id, event.id);
    assert_eq!(rebuilt.content, event.content);

    // Each check a client makes rejects the event it is there for.
    let tamper = |change: &dyn Fn(&mut serde_json::Value)| -> Option<Event> {
        let mut json = serde_json::to_value(event).unwrap();
        change(&mut json);
        serde_json::from_value(json).ok()
    };
    let other_content = tamper(&|json| json["content"] = "{}".into());
    assert!(other_content.is_none_or(|event| verified_card(&event, &node).is_none()));
    let rates = Keys::new(SecretKey::from_slice(&[0x11; 32]).unwrap());
    let same_content_other_address =
        nostr::EventBuilder::new(nostr::Kind::from(30078u16), event.content.clone())
            .tag(nostr::Tag::identifier("mostro-rates"))
            .sign_with_keys(&rates)
            .unwrap();
    assert_eq!(verified_card(&same_content_other_address, &node), None);
    let other_kind = nostr::EventBuilder::new(nostr::Kind::from(38385u16), event.content.clone())
        .tag(nostr::Tag::identifier("mostro-community-card"))
        .sign_with_keys(&keys)
        .unwrap();
    assert_eq!(verified_card(&other_kind, &node), None);
    // The node's card inside somebody else's event.
    let stranger = Keys::new(SecretKey::from_slice(&[0x12; 32]).unwrap());
    let relayed = nostr::EventBuilder::new(nostr::Kind::from(30078u16), event.content.clone())
        .tag(nostr::Tag::identifier("mostro-community-card"))
        .sign_with_keys(&stranger)
        .unwrap();
    assert_eq!(verified_card(&relayed, &node), None);
    assert_eq!(verified_card(&relayed, &stranger.public_key()), None);
    // A card altered after it was signed, inside an event the node did sign.
    let mut altered = card.clone();
    altered.payment_methods.push("Western Union".into());
    let around_altered =
        build_card_event(&keys, &altered, event.created_at.as_secs() + 60).unwrap();
    assert!(around_altered.verify().is_ok());
    assert_eq!(verified_card(&around_altered, &node), None);

    // The deletion request of the same vector names that address and that id.
    let deletion = &vector.deletion_event;
    assert_eq!(deletion.kind.as_u16(), 5);
    assert_eq!(deletion.pubkey, node);
    assert!(deletion.verify().is_ok());
    let rebuilt = build_card_deletion(&keys, event, deletion.created_at.as_secs()).unwrap();
    assert_eq!(rebuilt.id, deletion.id);
    assert_eq!(tags_of(&rebuilt), tags_of(deletion));
}
