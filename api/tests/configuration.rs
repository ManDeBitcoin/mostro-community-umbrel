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
    // Since Mostro v0.19.0 protocol v1 is gone and the transport is always protocol v2
    assert!(doc["mostro"].get("transport").is_none());
    // The fixture has no website: an empty value is left out instead of
    // making mostrod warn about an invalid URL on every start.
    assert!(doc["mostro"].get("website").is_none());
    assert_eq!(doc["mostro"]["about"].as_str(), Some("Mercado local"));
    // Optional v0.19.2 key the Manager does not manage.
    assert!(doc["mostro"].get("serbero_pubkey").is_none());
    assert_eq!(
        doc["anti_abuse_bond"]["maker_bond_payment_timeout_seconds"].as_integer(),
        Some(900)
    );
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

/// The renderer embeds the v0.19.0 template (MIT). It is valid for the pinned
/// mostrod v0.19.2 as long as both templates describe the same settings: this
/// fails the day upstream adds, removes or changes a default, so the embedded
/// template cannot silently fall behind the daemon that is shipped.
#[test]
fn embedded_template_is_equivalent_to_the_pinned_upstream_release() {
    let embedded: toml::Value =
        toml::from_str(include_str!("../../config/upstream/settings.v0.19.0.toml")).unwrap();
    let pinned: toml::Value =
        toml::from_str(include_str!("../../config/upstream/settings.v0.19.2.toml")).unwrap();
    assert_eq!(embedded, pinned);

    // Same for the admin gRPC contract the API is compiled against.
    assert_eq!(
        include_str!("../../config/upstream/admin.v0.19.0.proto"),
        include_str!("../../config/upstream/admin.v0.19.2.proto")
    );

    // The pin recorded for packaging matches the constant the API reports.
    let versions: serde_json::Value =
        serde_json::from_str(include_str!("../../config/versions.json")).unwrap();
    assert_eq!(
        versions["mostro"]["version"],
        mostro_community_api::daemon::MOSTRO_VERSION
    );
    assert_eq!(
        versions["mostro"]["tag"],
        format!("v{}", mostro_community_api::daemon::MOSTRO_VERSION)
    );
}

#[test]
fn optional_metadata_is_rendered_only_when_present() {
    let mut c = config();
    c.community.website = "https://comunidad.example".into();
    c.community.about = "  ".into();
    let rendered = render_settings(
        &c,
        "https://lnd:10009",
        "/lnd/tls.cert",
        "/lnd/admin.macaroon",
    )
    .unwrap();
    let doc: toml::Value = toml::from_str(&rendered).unwrap();
    assert_eq!(
        doc["mostro"]["website"].as_str(),
        Some("https://comunidad.example")
    );
    assert!(doc["mostro"].get("about").is_none());
    assert_eq!(
        doc["mostro"]["name"].as_str(),
        Some(c.community.name.as_str())
    );
}

#[test]
fn saving_requires_a_dev_fee_mostrod_accepts() {
    let mut c = config();
    assert!(c.validate_for_save().is_ok());

    // mostrod refuses to start below 10 % of the node fee.
    c.market.dev_fee_bps = 999;
    assert!(c.validate().is_ok(), "stored drafts must still open");
    assert!(c.validate_for_save().is_err());
    // The renderer keeps such a draft loadable by raising it to the minimum.
    let rendered = render_settings(
        &c,
        "https://lnd:10009",
        "/lnd/tls.cert",
        "/lnd/admin.macaroon",
    )
    .unwrap();
    let doc: toml::Value = toml::from_str(&rendered).unwrap();
    assert_eq!(doc["mostro"]["dev_fee_percentage"].as_float(), Some(0.1));

    c.market.dev_fee_bps = 1_000;
    assert!(c.validate_for_save().is_ok());
    c.market.dev_fee_bps = 10_000;
    assert!(c.validate_for_save().is_ok());
    c.market.dev_fee_bps = 10_001;
    assert!(c.validate_for_save().is_err());
}

/// Every place that names the pinned mostrod release agrees with
/// `config/versions.json`. Files outside `api/` and `config/` are not part of
/// the Docker build context of the API stage, so they are checked only when
/// present (a normal checkout).
#[test]
fn every_pin_of_the_daemon_release_agrees() {
    let versions: serde_json::Value =
        serde_json::from_str(include_str!("../../config/versions.json")).unwrap();
    let version = versions["mostro"]["version"].as_str().unwrap();
    let amd64 = versions["mostro"]["linux_amd64_sha256"].as_str().unwrap();
    let arm64 = versions["mostro"]["linux_arm64_sha256"].as_str().unwrap();
    assert_eq!(amd64.len(), 64);
    assert_eq!(arm64.len(), 64);

    let notice = include_str!("../../config/upstream/NOTICE-mostrod.md");
    assert!(notice.contains(&format!("Version: {version}")));
    assert!(notice.contains(&format!("/tree/v{version}")));

    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let read = |relative: &str| std::fs::read_to_string(root.join(relative)).ok();
    for dockerfile in ["docker/Dockerfile.umbrel", "docker/Dockerfile.mostro"] {
        if let Some(text) = read(dockerfile) {
            assert!(
                text.contains(&format!("/releases/download/v{version}/")),
                "{dockerfile} downloads another release"
            );
            assert!(text.contains(amd64), "{dockerfile}: amd64 checksum");
            assert!(text.contains(arm64), "{dockerfile}: arm64 checksum");
        }
    }
    for script in [
        "scripts/container-smoke.sh",
        "scripts/verify-mostro-image.sh",
    ] {
        if let Some(text) = read(script) {
            assert!(
                text.contains(&format!("mostro p2p {version}")),
                "{script} expects another version"
            );
        }
    }
}
