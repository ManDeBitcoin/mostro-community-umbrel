use futures_util::{SinkExt, StreamExt};
use mostro_community_api::{
    config::{BondApply, Community, Configuration, Market, Nostr, Safety},
    orders::{
        MonitorCommand, MonitorState, MonitorTiming, OrdersCache, SharedOrders, is_valid_uuid,
        parse_and_validate_order_event,
    },
};
use nostr::{EventBuilder, Keys, SecretKey, Tag, Timestamp, ToBech32, event::tag::TagKind};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::{RwLock, mpsc, watch};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::protocol::Message;

fn valid_config(relays: Vec<String>) -> Configuration {
    Configuration {
        community: Community {
            name: "Test Community".into(),
            about: "Testing orders monitor".into(),
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
    JoinHandle<()>,
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
                        msg = ws.next() => {
                            match msg {
                                Some(Ok(Message::Text(t))) => {
                                    let _ = req_tx.send(t.to_string()).await;
                                }
                                Some(Ok(Message::Ping(p))) => {
                                    let _ = ws.send(Message::Pong(p)).await;
                                }
                                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                                _ => {}
                            }
                        }
                        out = resp_rx.recv() => {
                            if let Some(text) = out {
                                if ws.send(Message::Text(text.into())).await.is_err() {
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

fn build_order_event(
    keys: &Keys,
    uuid: &str,
    kind: &str,
    status: &str,
    created_at_secs: u64,
    expiration_secs: Option<u64>,
    expires_at_secs: Option<u64>,
) -> nostr::Event {
    let mut tags = vec![
        Tag::custom(TagKind::Custom("y".into()), vec!["mostro"]),
        Tag::custom(TagKind::Custom("z".into()), vec!["order"]),
        Tag::identifier(uuid),
        Tag::custom(TagKind::Custom("k".into()), vec![kind]),
        Tag::custom(TagKind::Custom("s".into()), vec![status]),
        Tag::custom(TagKind::Custom("f".into()), vec!["EUR"]),
        Tag::custom(TagKind::Custom("fa".into()), vec!["50.00"]),
        Tag::custom(TagKind::Custom("amt".into()), vec!["50000"]),
        Tag::custom(TagKind::Custom("pm".into()), vec!["sepa"]),
        Tag::custom(TagKind::Custom("premium".into()), vec!["0"]),
    ];

    if let Some(exp) = expiration_secs {
        tags.push(Tag::custom(
            TagKind::Custom("expiration".into()),
            vec![exp.to_string()],
        ));
    }
    if let Some(eat) = expires_at_secs {
        tags.push(Tag::custom(
            TagKind::Custom("expires_at".into()),
            vec![eat.to_string()],
        ));
    }

    EventBuilder::new(nostr::Kind::Custom(38383), "")
        .tags(tags)
        .custom_created_at(Timestamp::from(created_at_secs))
        .sign_with_keys(keys)
        .unwrap()
}

#[tokio::test]
async fn test_orders_parser_validations() {
    let keys = Keys::new(SecretKey::from_slice(&[1; 32]).unwrap());
    let other_keys = Keys::new(SecretKey::from_slice(&[2; 32]).unwrap());
    let now = Timestamp::now().as_secs();

    // 1. UUID validation helper
    assert!(is_valid_uuid("550e8400-e29b-41d4-a716-446655440000"));
    assert!(!is_valid_uuid("invalid-uuid"));
    assert!(!is_valid_uuid(""));
    assert!(!is_valid_uuid("550e8400-e29b-41d4-a716-44665544000Z"));

    // 2. Valid event parses cleanly
    let uuid = "550e8400-e29b-41d4-a716-446655440000";
    let valid_event = build_order_event(&keys, uuid, "sell", "pending", now, None, None);
    let (summary, is_closed) =
        parse_and_validate_order_event(&valid_event, &keys.public_key(), now, 60).unwrap();
    assert_eq!(summary.id, uuid);
    assert_eq!(summary.kind, "sell");
    assert_eq!(summary.status, "pending");
    assert_eq!(summary.amount_sats, 50000);
    assert_eq!(summary.amount_sats_str, "50000");
    assert!(!is_closed);

    // 3. Invalid signature
    let other_signed = build_order_event(&other_keys, uuid, "sell", "pending", now, None, None);
    let mut tampered = valid_event.clone();
    tampered.sig = other_signed.sig;
    assert!(parse_and_validate_order_event(&tampered, &keys.public_key(), now, 60).is_err());

    // 4. Wrong author
    assert!(
        parse_and_validate_order_event(&valid_event, &other_keys.public_key(), now, 60).is_err()
    );

    // 5. Wrong kind
    let wrong_kind_event = EventBuilder::new(nostr::Kind::Custom(12345), "")
        .tags(vec![
            Tag::custom(TagKind::Custom("y".into()), vec!["mostro"]),
            Tag::custom(TagKind::Custom("z".into()), vec!["order"]),
            Tag::identifier(uuid),
        ])
        .sign_with_keys(&keys)
        .unwrap();
    assert!(
        parse_and_validate_order_event(&wrong_kind_event, &keys.public_key(), now, 60).is_err()
    );

    // 6. Future timestamp beyond drift
    let future_event = build_order_event(&keys, uuid, "sell", "pending", now + 120, None, None);
    assert!(parse_and_validate_order_event(&future_event, &keys.public_key(), now, 60).is_err());

    // 7. Expired by NIP-40
    let expired_event = build_order_event(
        &keys,
        uuid,
        "sell",
        "pending",
        now - 100,
        Some(now - 10),
        None,
    );
    assert!(parse_and_validate_order_event(&expired_event, &keys.public_key(), now, 60).is_err());

    // 8. Expired pending offer by expires_at
    let expired_offer = build_order_event(
        &keys,
        uuid,
        "sell",
        "pending",
        now - 100,
        None,
        Some(now - 10),
    );
    assert!(parse_and_validate_order_event(&expired_offer, &keys.public_key(), now, 60).is_err());

    // 9. Closed status correctly identified
    let canceled_event = build_order_event(&keys, uuid, "sell", "canceled", now, None, None);
    let (_, is_closed_canceled) =
        parse_and_validate_order_event(&canceled_event, &keys.public_key(), now, 60).unwrap();
    assert!(is_closed_canceled);
}

#[tokio::test]
async fn test_monitor_worker_subscribes_and_syncs_with_relay() {
    let keys = Keys::new(SecretKey::from_slice(&[42; 32]).unwrap());
    let npub = keys.public_key().to_bech32().unwrap();
    let (relay_url, mut req_rx, resp_tx, relay_handle) = spawn_mock_relay().await;

    let cache: SharedOrders = Arc::new(RwLock::new(OrdersCache::new()));
    let config = valid_config(vec![relay_url.clone()]);
    let (config_tx, config_rx) = watch::channel(MonitorCommand {
        config,
        npub: Some(npub.clone()),
    });

    let timing = MonitorTiming::test_timing();
    let worker_handle = tokio::spawn(mostro_community_api::orders::monitor_worker(
        cache.clone(),
        config_rx,
        timing,
    ));

    // Server should receive subscription REQ with hex author
    let req_msg = tokio::time::timeout(std::time::Duration::from_millis(500), req_rx.recv())
        .await
        .expect("Timeout esperando REQ del cliente")
        .expect("Canal cerrado");

    assert!(req_msg.contains("\"REQ\""));
    assert!(req_msg.contains("\"mostro_monitor\""));
    assert!(req_msg.contains(&keys.public_key().to_hex()));

    // Verify state before EOSE: is_stale should be true
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    {
        let r = cache.read().await;
        assert_eq!(r.state, MonitorState::Syncing);
        assert!(r.is_stale);
    }

    // Send an order event from mock relay
    let uuid = "550e8400-e29b-41d4-a716-446655440000";
    let now = Timestamp::now().as_secs();
    let order_event = build_order_event(&keys, uuid, "buy", "pending", now, None, None);
    let event_json = serde_json::to_string(&order_event).unwrap();
    let relay_event_msg = format!("[\"EVENT\", \"mostro_monitor\", {}]", event_json);
    resp_tx.send(relay_event_msg).await.unwrap();

    // Send EOSE
    let eose_msg = "[\"EOSE\", \"mostro_monitor\"]".to_string();
    resp_tx.send(eose_msg).await.unwrap();

    // Wait for worker to process EOSE and transition to Live
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    {
        let r = cache.read().await;
        assert_eq!(r.state, MonitorState::Live);
        assert!(!r.is_stale);
        let snapshot = r.to_snapshot();
        assert_eq!(snapshot.orders.len(), 1);
        assert_eq!(snapshot.orders[0].id, uuid);
        assert_eq!(snapshot.orders[0].amount_sats, 50000);
        assert_eq!(snapshot.orders[0].amount_sats_str, "50000");
    }

    // Cleanup
    drop(config_tx);
    worker_handle.abort();
    relay_handle.abort();
}

#[tokio::test]
async fn test_monitor_replacement_tiebreak_and_tombstones() {
    let keys = Keys::new(SecretKey::from_slice(&[7; 32]).unwrap());
    let npub = keys.public_key().to_bech32().unwrap();
    let (relay_url, _req_rx, resp_tx, relay_handle) = spawn_mock_relay().await;

    let cache: SharedOrders = Arc::new(RwLock::new(OrdersCache::new()));
    let config = valid_config(vec![relay_url.clone()]);
    let (config_tx, config_rx) = watch::channel(MonitorCommand {
        config,
        npub: Some(npub),
    });

    let timing = MonitorTiming::test_timing();
    let worker_handle = tokio::spawn(mostro_community_api::orders::monitor_worker(
        cache.clone(),
        config_rx,
        timing,
    ));

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let uuid = "11111111-2222-3333-4444-555555555555";
    let t1 = 1700000000;

    // 1. Initial pending order
    let ev1 = build_order_event(&keys, uuid, "sell", "pending", t1, None, None);
    resp_tx
        .send(format!(
            "[\"EVENT\", \"mostro_monitor\", {}]",
            serde_json::to_string(&ev1).unwrap()
        ))
        .await
        .unwrap();

    // 2. Newer canceled order at t1 + 50
    let ev2 = build_order_event(&keys, uuid, "sell", "canceled", t1 + 50, None, None);
    resp_tx
        .send(format!(
            "[\"EVENT\", \"mostro_monitor\", {}]",
            serde_json::to_string(&ev2).unwrap()
        ))
        .await
        .unwrap();

    // Send EOSE
    resp_tx
        .send("[\"EOSE\", \"mostro_monitor\"]".into())
        .await
        .unwrap();

    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    {
        let r = cache.read().await;
        let snap = r.to_snapshot();
        assert_eq!(snap.orders[0].status, "canceled");
    }

    // 3. Replay attack: An older pending event at t1 + 20 arrives after order was canceled at t1 + 50
    let ev_replay = build_order_event(&keys, uuid, "sell", "pending", t1 + 20, None, None);
    resp_tx
        .send(format!(
            "[\"EVENT\", \"mostro_monitor\", {}]",
            serde_json::to_string(&ev_replay).unwrap()
        ))
        .await
        .unwrap();

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    {
        let r = cache.read().await;
        let snap = r.to_snapshot();
        // Tombstone prevented resurrection: still canceled!
        assert_eq!(snap.orders[0].status, "canceled");
    }

    drop(config_tx);
    worker_handle.abort();
    relay_handle.abort();
}

#[tokio::test]
async fn test_monitor_disconnect_preserves_snapshot_with_stale() {
    let keys = Keys::new(SecretKey::from_slice(&[8; 32]).unwrap());
    let npub = keys.public_key().to_bech32().unwrap();
    let (relay_url, _req_rx, resp_tx, relay_handle) = spawn_mock_relay().await;

    let cache: SharedOrders = Arc::new(RwLock::new(OrdersCache::new()));
    let config = valid_config(vec![relay_url.clone()]);
    let (config_tx, config_rx) = watch::channel(MonitorCommand {
        config,
        npub: Some(npub),
    });

    let timing = MonitorTiming::test_timing();
    let worker_handle = tokio::spawn(mostro_community_api::orders::monitor_worker(
        cache.clone(),
        config_rx,
        timing,
    ));

    let uuid = "99999999-8888-7777-6666-555555555555";
    let now = Timestamp::now().as_secs();
    let ev = build_order_event(&keys, uuid, "buy", "pending", now, None, None);
    resp_tx
        .send(format!(
            "[\"EVENT\", \"mostro_monitor\", {}]",
            serde_json::to_string(&ev).unwrap()
        ))
        .await
        .unwrap();
    resp_tx
        .send("[\"EOSE\", \"mostro_monitor\"]".into())
        .await
        .unwrap();

    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    {
        let r = cache.read().await;
        assert_eq!(r.state, MonitorState::Live);
        assert!(!r.is_stale);
        assert_eq!(r.to_snapshot().orders.len(), 1);
    }

    // Now kill relay (simulating disconnection)
    relay_handle.abort();
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;

    {
        let r = cache.read().await;
        // State should be disconnected / reconnecting, but is_stale is true and snapshot is retained!
        assert!(r.is_stale);
        let snap = r.to_snapshot();
        assert_eq!(
            snap.orders.len(),
            1,
            "Snapshot de órdenes debe conservarse tras desconexión"
        );
        assert_eq!(snap.orders[0].id, uuid);
    }

    drop(config_tx);
    worker_handle.abort();
}

#[tokio::test]
async fn test_monitor_multirelay_failover_and_degraded_state() {
    let keys = Keys::new(SecretKey::from_slice(&[9; 32]).unwrap());
    let npub = keys.public_key().to_bech32().unwrap();

    // Relay 1 is completely offline (port closed)
    let offline_url = "ws://127.0.0.1:49999".to_string();
    // Relay 2 is healthy
    let (relay_url_2, _req_rx2, resp_tx2, relay_handle2) = spawn_mock_relay().await;

    let cache: SharedOrders = Arc::new(RwLock::new(OrdersCache::new()));
    let config = valid_config(vec![offline_url, relay_url_2]);
    let (config_tx, config_rx) = watch::channel(MonitorCommand {
        config,
        npub: Some(npub),
    });

    let timing = MonitorTiming::test_timing();
    let worker_handle = tokio::spawn(mostro_community_api::orders::monitor_worker(
        cache.clone(),
        config_rx,
        timing,
    ));

    let uuid = "22222222-3333-4444-5555-666666666666";
    let now = Timestamp::now().as_secs();
    let ev = build_order_event(&keys, uuid, "sell", "pending", now, None, None);
    resp_tx2
        .send(format!(
            "[\"EVENT\", \"mostro_monitor\", {}]",
            serde_json::to_string(&ev).unwrap()
        ))
        .await
        .unwrap();
    resp_tx2
        .send("[\"EOSE\", \"mostro_monitor\"]".into())
        .await
        .unwrap();

    tokio::time::sleep(std::time::Duration::from_millis(350)).await;

    {
        let r = cache.read().await;
        // Since relay 1 failed and relay 2 is Live, aggregate state should be Degraded
        assert_eq!(r.state, MonitorState::Degraded);
        assert!(!r.is_stale);
        let snap = r.to_snapshot();
        assert_eq!(snap.orders.len(), 1);
        assert_eq!(snap.orders[0].id, uuid);
        assert_eq!(snap.relays.len(), 2);
    }

    drop(config_tx);
    worker_handle.abort();
    relay_handle2.abort();
}

#[tokio::test]
async fn test_monitor_config_change_clears_cache_and_latest_wins() {
    let keys_a = Keys::new(SecretKey::from_slice(&[10; 32]).unwrap());
    let keys_b = Keys::new(SecretKey::from_slice(&[11; 32]).unwrap());
    let npub_a = keys_a.public_key().to_bech32().unwrap();
    let npub_b = keys_b.public_key().to_bech32().unwrap();

    let (relay_url, _req_rx, resp_tx, relay_handle) = spawn_mock_relay().await;

    let cache: SharedOrders = Arc::new(RwLock::new(OrdersCache::new()));
    let config = valid_config(vec![relay_url.clone()]);
    let (config_tx, config_rx) = watch::channel(MonitorCommand {
        config: config.clone(),
        npub: Some(npub_a),
    });

    let timing = MonitorTiming::test_timing();
    let worker_handle = tokio::spawn(mostro_community_api::orders::monitor_worker(
        cache.clone(),
        config_rx,
        timing,
    ));

    // Send order for author A
    let uuid_a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    let now = Timestamp::now().as_secs();
    let ev_a = build_order_event(&keys_a, uuid_a, "buy", "pending", now, None, None);
    resp_tx
        .send(format!(
            "[\"EVENT\", \"mostro_monitor\", {}]",
            serde_json::to_string(&ev_a).unwrap()
        ))
        .await
        .unwrap();
    resp_tx
        .send("[\"EOSE\", \"mostro_monitor\"]".into())
        .await
        .unwrap();

    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    {
        let r = cache.read().await;
        assert_eq!(r.to_snapshot().orders.len(), 1);
    }

    // Now update config to author B
    config_tx
        .send(MonitorCommand {
            config: config.clone(),
            npub: Some(npub_b),
        })
        .unwrap();

    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    {
        let r = cache.read().await;
        // Author A orders should be gone from cache
        assert_eq!(r.to_snapshot().orders.len(), 0);
    }

    drop(config_tx);
    worker_handle.abort();
    relay_handle.abort();
}

#[tokio::test]
async fn test_monitor_unconfigured_state_when_missing_identity() {
    let cache: SharedOrders = Arc::new(RwLock::new(OrdersCache::new()));
    let config = valid_config(vec!["ws://127.0.0.1:8080".into()]);
    let (config_tx, config_rx) = watch::channel(MonitorCommand { config, npub: None });

    let timing = MonitorTiming::test_timing();
    let worker_handle = tokio::spawn(mostro_community_api::orders::monitor_worker(
        cache.clone(),
        config_rx,
        timing,
    ));

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    {
        let r = cache.read().await;
        assert_eq!(r.state, MonitorState::Unconfigured);
        assert!(!r.is_stale);
        assert_eq!(r.to_snapshot().orders.len(), 0);
    }

    drop(config_tx);
    worker_handle.abort();
}
