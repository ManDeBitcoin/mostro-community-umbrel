use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use mostro_community_api::{
    AppState,
    adapters::Integrations,
    chat::{
        self, ChatCache, build_test_gift_wrap_event, build_test_nip04_event, build_test_nip44_event,
    },
    config::{BondApply, Community, Configuration, Market, Nostr, Safety},
    identity,
    orders::{MonitorCommand, MonitorTiming, OrdersCache},
    router,
    store::Store,
};
use nostr::{EventBuilder, Keys, Kind, SecretKey, Tag, ToBech32};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tokio::sync::{RwLock, mpsc, watch};
use tokio_tungstenite::tungstenite::protocol::Message;
use tower::ServiceExt;

fn fixture_keys(byte: u8) -> Keys {
    Keys::new(SecretKey::from_slice(&[byte; 32]).unwrap())
}

fn valid_config(relays: Vec<String>) -> Configuration {
    Configuration {
        community: Community {
            name: "Test Community".into(),
            about: "Testing chat".into(),
            website: "https://community.test".into(),
            contact: "https://contact.test".into(),
            language: "es".into(),
        },
        market: Market {
            fiat_currencies: vec!["EUR".into()],
            min_trade_sats: 1000,
            max_trade_sats: 100000,
            fee_bps: 50,
            dev_fee_bps: 0,
            max_routing_fee_bps: 10,
        },
        safety: Safety {
            bond_enabled: false,
            bond_bps: 0,
            base_bond_sats: 0,
            bond_apply_to: BondApply::Both,
            automatic_timeout_slash: false,
            pow: 0,
            pow_first_contact: 0,
        },
        nostr: Nostr { relays },
        payment_methods: vec![],
    }
}

async fn spawn_mock_relay() -> (
    String,
    mpsc::Receiver<String>,
    mpsc::Sender<String>,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();
    let url = format!("ws://{}", addr);
    let (req_tx, req_rx) = mpsc::channel::<String>(100);
    let (resp_tx, mut resp_rx) = mpsc::channel::<String>(100);

    let handle = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let req_tx = req_tx.clone();
            if let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await {
                loop {
                    tokio::select! {
                        msg = futures_util::StreamExt::next(&mut ws) => {
                            match msg {
                                Some(Ok(Message::Text(t))) => {
                                    let _ = req_tx.send(t.to_string()).await;
                                }
                                Some(Ok(Message::Ping(p))) => {
                                    let _ = futures_util::SinkExt::send(&mut ws, Message::Pong(p)).await;
                                }
                                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                                _ => {}
                            }
                        }
                        out = resp_rx.recv() => {
                            if let Some(text) = out {
                                if futures_util::SinkExt::send(&mut ws, Message::Text(text.into())).await.is_err() {
                                    break;
                                }
                            } else {
                                break;
                            }
                        }
                    }
                }
            }
        }
    });

    (url, req_rx, resp_tx, handle)
}

#[tokio::test]
async fn test_kind4_nip04_valid_decryption_and_cache() {
    let root = tempfile::tempdir().unwrap();
    let community_keys = fixture_keys(1);
    let comm_nsec = community_keys.secret_key().to_bech32().unwrap();
    let comm_npub = community_keys.public_key().to_bech32().unwrap();

    identity::import(root.path(), &comm_nsec, &comm_npub).unwrap();
    let loaded_keys = identity::load_identity_keys(root.path())
        .unwrap()
        .expect("Clave privada debe cargarse");

    let trader_keys = fixture_keys(2);
    let order_id = "11111111-2222-3333-4444-555555555555";

    let message_json = serde_json::json!({
        "order_id": order_id,
        "action": "dispute",
        "content": "No he recibido el pago en mi cuenta bancaria"
    })
    .to_string();

    let event = build_test_nip04_event(
        &trader_keys,
        &community_keys.public_key(),
        &message_json,
        Some(order_id),
    );

    let mut cache = ChatCache::new();
    let processed = chat::process_event(&event, &loaded_keys, &mut cache)
        .await
        .unwrap();

    assert!(processed.is_some());
    let msg = processed.unwrap();
    assert_eq!(msg.order_id, order_id);
    assert_eq!(msg.kind, 4);
    assert_eq!(msg.action.as_deref(), Some("dispute"));
    assert_eq!(msg.content, "No he recibido el pago en mi cuenta bancaria");
    assert!(!msg.is_from_me);
    assert_eq!(msg.sender, trader_keys.public_key().to_bech32().unwrap());

    // Verify cache content
    let history = cache.to_history(order_id);
    assert_eq!(history.count, 1);
    assert_eq!(history.messages[0].id, event.id.to_hex());
}

#[tokio::test]
async fn test_kind4_nip04_sent_by_community() {
    let community_keys = fixture_keys(1);
    let trader_keys = fixture_keys(2);
    let order_id = "22222222-3333-4444-5555-666666666666";

    let payload = serde_json::json!({
        "order_id": order_id,
        "action": "adm-message",
        "text": "Estimado usuario, el mediador ha sido asignado al caso."
    })
    .to_string();

    let event = build_test_nip04_event(
        &community_keys,
        &trader_keys.public_key(),
        &payload,
        Some(order_id),
    );

    let mut cache = ChatCache::new();
    let processed = chat::process_event(&event, &community_keys, &mut cache)
        .await
        .unwrap();

    assert!(processed.is_some());
    let msg = processed.unwrap();
    assert!(msg.is_from_me);
    assert_eq!(msg.action.as_deref(), Some("adm-message"));
    assert_eq!(
        msg.content,
        "Estimado usuario, el mediador ha sido asignado al caso."
    );
}

#[tokio::test]
async fn test_kind1059_gift_wrap_decryption() {
    let community_keys = fixture_keys(1);
    let trader_keys = fixture_keys(3);
    let order_id = "33333333-4444-5555-6666-777777777777";

    let payload = serde_json::json!({
        "order_id": order_id,
        "action": "chat",
        "content": "Adjunto justificante de transferencia SEPA"
    })
    .to_string();

    let event = build_test_gift_wrap_event(
        &trader_keys,
        &community_keys.public_key(),
        &payload,
        Some(order_id),
    )
    .await;

    let mut cache = ChatCache::new();
    let processed = chat::process_event(&event, &community_keys, &mut cache)
        .await
        .unwrap();

    assert!(processed.is_some());
    let msg = processed.unwrap();
    assert_eq!(msg.order_id, order_id);
    assert_eq!(msg.kind, 1059);
    assert_eq!(msg.action.as_deref(), Some("chat"));
    assert_eq!(msg.content, "Adjunto justificante de transferencia SEPA");
    assert!(!msg.is_from_me);
}

#[tokio::test]
async fn test_kind4_nip44_decryption() {
    let community_keys = fixture_keys(1);
    let trader_keys = fixture_keys(4);
    let order_id = "44444444-5555-6666-7777-888888888888";

    let payload = serde_json::json!({
        "order_id": order_id,
        "action": "dispute",
        "content": "Mensaje cifrado con NIP-44 V2 directo"
    })
    .to_string();

    let event = build_test_nip44_event(
        &trader_keys,
        &community_keys.public_key(),
        &payload,
        Some(order_id),
    );

    let mut cache = ChatCache::new();
    let processed = chat::process_event(&event, &community_keys, &mut cache)
        .await
        .unwrap();

    assert!(processed.is_some());
    let msg = processed.unwrap();
    assert_eq!(msg.order_id, order_id);
    assert_eq!(msg.content, "Mensaje cifrado con NIP-44 V2 directo");
}

#[tokio::test]
async fn test_invalid_events_are_rejected() {
    let community_keys = fixture_keys(1);
    let trader_keys = fixture_keys(2);
    let other_party = fixture_keys(9);
    let order_id = "55555555-6666-7777-8888-999999999999";

    let mut cache = ChatCache::new();

    // 1. Event directed to someone else (not community)
    let wrong_recipient_event = build_test_nip04_event(
        &trader_keys,
        &other_party.public_key(),
        "Hola",
        Some(order_id),
    );
    let res = chat::process_event(&wrong_recipient_event, &community_keys, &mut cache).await;
    assert_eq!(res.unwrap(), None);

    // 2. Corrupted ciphertext (invalid IV format or bad base64)
    let bad_cipher_event = EventBuilder::new(Kind::EncryptedDirectMessage, "bad-corrupted-cipher")
        .tags(vec![
            Tag::public_key(community_keys.public_key()),
            Tag::identifier(order_id),
        ])
        .sign_with_keys(&trader_keys)
        .unwrap();
    let res = chat::process_event(&bad_cipher_event, &community_keys, &mut cache).await;
    assert!(
        res.is_err(),
        "Descifrado con ciphertext inválido debe fallar"
    );

    // 3. Event without order_id
    let no_order_event = build_test_nip04_event(
        &trader_keys,
        &community_keys.public_key(),
        "Mensaje general sin referencia de orden",
        None,
    );
    let res = chat::process_event(&no_order_event, &community_keys, &mut cache).await;
    assert_eq!(res.unwrap(), None);

    // 4. Duplicate event (deduplication check)
    let valid_event = build_test_nip04_event(
        &trader_keys,
        &community_keys.public_key(),
        &serde_json::json!({"order_id": order_id, "text": "Mensaje único"}).to_string(),
        Some(order_id),
    );
    let res1 = chat::process_event(&valid_event, &community_keys, &mut cache)
        .await
        .unwrap();
    assert!(res1.is_some());
    assert_eq!(cache.to_history(order_id).count, 1);

    // Insert same event again -> cache returns false, count remains 1
    assert!(!cache.insert(res1.unwrap()));
    assert_eq!(cache.to_history(order_id).count, 1);
}

#[tokio::test]
async fn test_chat_cache_ordering_and_limits() {
    let mut cache = ChatCache::new();
    let order_id = "66666666-7777-8888-9999-000000000000";

    // Insert out of chronological order
    let msg1 = chat::ChatMessage {
        id: "msg1".into(),
        order_id: order_id.into(),
        sender: "npub1".into(),
        recipient: Some("npub2".into()),
        created_at: 1000,
        kind: 4,
        action: None,
        content: "Primero en tiempo".into(),
        is_from_me: false,
    };
    let msg2 = chat::ChatMessage {
        id: "msg2".into(),
        order_id: order_id.into(),
        sender: "npub2".into(),
        recipient: Some("npub1".into()),
        created_at: 1050,
        kind: 4,
        action: None,
        content: "Segundo en tiempo".into(),
        is_from_me: true,
    };
    let msg3 = chat::ChatMessage {
        id: "msg3".into(),
        order_id: order_id.into(),
        sender: "npub1".into(),
        recipient: Some("npub2".into()),
        created_at: 950,
        kind: 4,
        action: None,
        content: "El más antiguo".into(),
        is_from_me: false,
    };

    cache.insert(msg1);
    cache.insert(msg2);
    cache.insert(msg3);

    let history = cache.to_history(order_id);
    assert_eq!(history.count, 3);
    assert_eq!(history.messages[0].id, "msg3");
    assert_eq!(history.messages[1].id, "msg1");
    assert_eq!(history.messages[2].id, "msg2");
}

#[tokio::test]
async fn test_http_chat_endpoint_contract() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let comm_keys = fixture_keys(1);
    identity::import(
        root,
        &comm_keys.secret_key().to_bech32().unwrap(),
        &comm_keys.public_key().to_bech32().unwrap(),
    )
    .unwrap();

    let initial_config: Configuration =
        serde_json::from_str(include_str!("fixtures/community.json")).unwrap();
    let (tx, _rx) = watch::channel(MonitorCommand {
        config: initial_config,
        npub: None,
    });

    let chat_cache = Arc::new(RwLock::new(ChatCache::new()));
    let order_id = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";

    // Preload one message in cache
    {
        let mut w = chat_cache.write().await;
        w.insert(chat::ChatMessage {
            id: "event-123".into(),
            order_id: order_id.into(),
            sender: "npub-trader".into(),
            recipient: Some("npub-comm".into()),
            created_at: 1700000000,
            kind: 4,
            action: Some("dispute".into()),
            content: "Pago no recibido".into(),
            is_from_me: false,
        });
    }

    let app = router(AppState {
        store: Arc::new(Mutex::new(Store::open(root.into()).unwrap())),
        integrations: Integrations::default(),
        orders: Arc::new(RwLock::new(OrdersCache::new())),
        chat: chat_cache,
        monitor_tx: tx,
    });

    // 1. Missing protection header -> 403 Forbidden
    let req = Request::builder()
        .method("GET")
        .uri(format!("/api/chat/{order_id}"))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);

    // 2. Invalid UUID format -> 400 Bad Request
    let req = Request::builder()
        .method("GET")
        .uri("/api/chat/not-a-valid-uuid")
        .header("x-requested-with", "mostro-community")
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    // 3. Valid UUID with no messages -> 200 OK with empty count
    let other_uuid = "00000000-0000-0000-0000-000000000000";
    let req = Request::builder()
        .method("GET")
        .uri(format!("/api/chat/{other_uuid}"))
        .header("x-requested-with", "mostro-community")
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body_bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let history: chat::ChatHistory = serde_json::from_slice(&body_bytes).unwrap();
    assert_eq!(history.order_id, other_uuid);
    assert_eq!(history.count, 0);
    assert!(history.messages.is_empty());

    // 4. Valid UUID with message -> 200 OK with history
    let req = Request::builder()
        .method("GET")
        .uri(format!("/api/chat/{order_id}"))
        .header("x-requested-with", "mostro-community")
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body_bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let history: chat::ChatHistory = serde_json::from_slice(&body_bytes).unwrap();
    assert_eq!(history.order_id, order_id);
    assert_eq!(history.count, 1);
    assert_eq!(history.messages[0].content, "Pago no recibido");
    assert_eq!(history.messages[0].action.as_deref(), Some("dispute"));

    // 5. Ensure nsec or secrets are NEVER in response
    let json_text = String::from_utf8(body_bytes.to_vec()).unwrap();
    assert!(!json_text.contains("nsec"));
    assert!(!json_text.contains("secret"));
}

#[tokio::test]
async fn test_chat_worker_with_mock_relay() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let comm_keys = fixture_keys(1);
    let trader_keys = fixture_keys(2);

    identity::import(
        root,
        &comm_keys.secret_key().to_bech32().unwrap(),
        &comm_keys.public_key().to_bech32().unwrap(),
    )
    .unwrap();

    let (relay_url, mut req_rx, resp_tx, relay_handle) = spawn_mock_relay().await;
    let chat_cache: chat::SharedChatCache = Arc::new(RwLock::new(ChatCache::new()));

    let config = valid_config(vec![relay_url]);
    let (config_tx, config_rx) = watch::channel(MonitorCommand {
        config,
        npub: Some(comm_keys.public_key().to_bech32().unwrap()),
    });

    let timing = MonitorTiming::test_timing();
    let worker_handle = tokio::spawn(chat::chat_worker(
        chat_cache.clone(),
        root.to_path_buf(),
        config_rx,
        timing,
    ));

    // Verify worker connected and sent REQ
    let req1 = req_rx.recv().await.expect("Subscription 1");
    assert!(req1.contains("REQ"));

    let order_id = "88888888-9999-aaaa-bbbb-cccccccccccc";
    let payload = serde_json::json!({
        "order_id": order_id,
        "action": "dispute",
        "text": "Comprobante falso presentado por comprador"
    })
    .to_string();

    let event = build_test_nip04_event(
        &trader_keys,
        &comm_keys.public_key(),
        &payload,
        Some(order_id),
    );

    // Send EVENT from mock relay to chat worker
    let event_json = serde_json::to_string(&event).unwrap();
    resp_tx
        .send(format!("[\"EVENT\", \"mostro_chat_recv\", {}]", event_json))
        .await
        .unwrap();

    // Give worker time to process and decrypt
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;

    {
        let r = chat_cache.read().await;
        let history = r.to_history(order_id);
        assert_eq!(
            history.count, 1,
            "El mensaje de disputa debe ser recibido y descifrado por el chat_worker"
        );
        assert_eq!(history.messages[0].id, event.id.to_hex());
        assert_eq!(
            history.messages[0].content,
            "Comprobante falso presentado por comprador"
        );
    }

    drop(config_tx);
    worker_handle.abort();
    relay_handle.abort();
}
