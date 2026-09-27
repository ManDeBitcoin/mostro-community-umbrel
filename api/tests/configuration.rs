use mostro_community_api::{
    config::{Configuration, render_settings},
    store::Store,
};
fn config() -> Configuration {
    serde_json::from_str(include_str!("fixtures/community.json")).unwrap()
}
#[test]
fn rejects_unsafe_and_ambiguous_settings() {
    let mut c = config();
    c.market.min_trade_sats = c.market.max_trade_sats + 1;
    assert!(c.validate().is_err());
    c = config();
    c.market.fee_bps = 10001;
    assert!(c.validate().is_err());
    c = config();
    c.market.fiat_currencies.clear();
    assert!(c.validate().is_err());
    c = config();
    c.market.fiat_currencies.push("EUR".into());
    assert!(c.validate().is_err());
    c = config();
    c.nostr.relays = vec!["wss://user:secret@example.com".into()];
    assert!(c.validate().is_err());
    c = config();
    c.community.website = "javascript:alert(1)".into();
    assert!(c.validate().is_err());
    c = config();
    c.payment_methods.push(c.payment_methods[0].clone());
    assert!(c.validate().is_err());
    c = config();
    c.safety.pow = 17;
    assert!(c.validate().is_err());
}
#[test]
fn renderer_escapes_text_and_maps_percentage_units() {
    let mut c = config();
    c.community.name = "A\"\n[rpc]\nenabled=false".into();
    let result = render_settings(
        &c,
        "https://lnd:10009",
        "/lnd/tls.cert",
        "/lnd/admin.macaroon",
    )
    .unwrap();
    let doc: toml::Value = toml::from_str(&result).unwrap();
    assert_eq!(
        doc["mostro"]["name"].as_str(),
        Some(c.community.name.as_str())
    );
    assert_eq!(doc["mostro"]["fee"].as_float(), Some(0.006));
    assert_eq!(doc["mostro"]["dev_fee_percentage"].as_float(), Some(0.3));
    assert_eq!(doc["anti_abuse_bond"]["amount_pct"].as_float(), Some(0.03));
    assert_eq!(
        doc["anti_abuse_bond"]["slash_on_waiting_timeout"].as_bool(),
        Some(false)
    );
    assert_eq!(doc["rpc"]["listen_address"].as_str(), Some("127.0.0.1"));
    assert_eq!(doc["rpc"]["enabled"].as_bool(), Some(false));
    assert_eq!(doc["nostr"]["nsec_privkey"].as_str(), Some(""));
    assert!(doc["rpc"].get("auth_token").is_none());
    assert_eq!(doc["lightning"]["allow_node_change"].as_bool(), Some(false));
    assert_eq!(
        doc["lightning"]["escrow_deadline_margin_blocks"].as_integer(),
        Some(24)
    );
    assert_eq!(doc["mostro"]["transport"].as_str(), Some("nip44"));
    assert_eq!(
        doc["mostro"]["fiat_currencies_accepted"][0].as_str(),
        Some("EUR")
    );
    assert!(!doc.as_table().unwrap().contains_key("payment_methods"));
    assert!(
        render_settings(
            &c,
            "http://lnd:10009",
            "/lnd/tls.cert",
            "/lnd/admin.macaroon"
        )
        .is_err()
    );
    assert!(
        render_settings(
            &c,
            "https://user:pass@lnd:10009",
            "/lnd/tls.cert",
            "/lnd/admin.macaroon"
        )
        .is_err()
    );
    assert!(
        render_settings(
            &c,
            "https://lnd:10009",
            "relative/tls.cert",
            "/lnd/admin.macaroon"
        )
        .is_err()
    );
}
#[test]
fn persistence_survives_restart_and_keeps_previous_revision() {
    let root = tempfile::tempdir().unwrap();
    let mut store = Store::open(root.path().into()).unwrap();
    assert_eq!(store.save(config()).unwrap().revision, 1);
    let mut c = config();
    c.community.name = "Otra comunidad".into();
    assert_eq!(store.save(c).unwrap().revision, 2);
    let reopened = Store::open(root.path().into()).unwrap();
    assert_eq!(
        reopened.document.config.unwrap().community.name,
        "Otra comunidad"
    );
    let previous: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.path().join("community.previous.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(previous["revision"], 1);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(root.path().join("community.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
#[test]
fn corrupt_persistence_fails_closed() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("community.json"), "not JSON").unwrap();
    assert!(Store::open(root.path().into()).is_err());
}
