use mostro_community_api::{
    config::Configuration,
    connection::{
        CommunityCard, ConnectionInfo, get_community_card, get_connection_info,
        verify_community_card,
    },
    identity,
    store::Store,
};
use nostr::{Keys, SecretKey, ToBech32};

#[test]
fn reports_missing_identity_safely() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().into()).unwrap();
    let info = get_connection_info(dir.path(), &store);
    assert_eq!(info.status, "missing_identity");
    assert_eq!(info.npub, None);
    assert_eq!(info.pubkey_hex, None);
    assert_eq!(info.nprofile, None);
    assert_eq!(info.nostr_uri, None);
    assert_eq!(info.qr_svg, None);
    assert_eq!(info.qr_json_svg, None);
    assert_eq!(info.json_uri, None);
    assert_eq!(info.card, None);
    assert!(info.relays.is_empty());
}

#[test]
fn generates_nprofile_and_uri_with_relays_without_exposing_secret() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().into()).unwrap();
    let mut config: Configuration =
        serde_json::from_str(include_str!("fixtures/community.json")).unwrap();
    config.nostr.relays = vec![
        "wss://relay.mostro.network".to_string(),
        "wss://relay.damus.io".to_string(),
    ];
    store.save(config).unwrap();

    let keys = Keys::new(SecretKey::from_slice(&[7; 32]).unwrap());
    let secret = keys.secret_key().to_bech32().unwrap();
    let public = keys.public_key().to_bech32().unwrap();
    let public_hex = keys.public_key().to_hex();
    identity::import(dir.path(), &secret, &public).unwrap();

    let info: ConnectionInfo = get_connection_info(dir.path(), &store);
    assert_eq!(info.status, "ready");
    assert_eq!(info.npub.as_deref(), Some(public.as_str()));
    assert_eq!(info.pubkey_hex.as_deref(), Some(public_hex.as_str()));
    assert_eq!(info.relays.len(), 2);

    let nprofile = info
        .nprofile
        .as_deref()
        .expect("nprofile should be present");
    assert!(nprofile.starts_with("nprofile1"));

    let nostr_uri = info
        .nostr_uri
        .as_deref()
        .expect("nostr_uri should be present");
    assert_eq!(nostr_uri, format!("mostro://community/{}", nprofile));

    let qr_svg = info.qr_svg.as_deref().expect("qr_svg should be present");
    assert!(qr_svg.contains("<svg"));
    assert!(qr_svg.contains("</svg>"));

    // Verify json_uri is standard CommunityCard JSON and qr_json_svg is generated
    let json_uri = info
        .json_uri
        .as_deref()
        .expect("json_uri should be present");
    let parsed_card: CommunityCard = serde_json::from_str(json_uri).expect("valid card json");
    assert_eq!(parsed_card.version, 1);
    assert_eq!(parsed_card.pubkey.as_deref(), Some(public_hex.as_str()));
    assert_eq!(parsed_card.fee_bps, 60);
    assert_eq!(parsed_card.bond_percent, 3);
    assert!(verify_community_card(&parsed_card));

    let qr_json_svg = info
        .qr_json_svg
        .as_deref()
        .expect("qr_json_svg should be present");
    assert!(qr_json_svg.contains("<svg"));
    assert!(qr_json_svg.contains("</svg>"));

    // Verify secret is NEVER serialized or present in debug string
    let serialized = serde_json::to_string(&info).unwrap();
    assert!(!serialized.contains(&secret));
    assert!(!format!("{:?}", info).contains(&secret));
}

// ── CommunityCard tests ───────────────────────────────────────────────────────

#[test]
fn community_card_without_identity_returns_unsigned() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().into()).unwrap();
    let config: Configuration =
        serde_json::from_str(include_str!("fixtures/community.json")).unwrap();
    store.save(config).unwrap();

    let card: CommunityCard = get_community_card(dir.path(), &store);

    // No identity → no pubkey, no signature
    assert_eq!(card.version, 1);
    assert!(
        card.pubkey.is_none(),
        "pubkey must be None without identity"
    );
    assert!(
        card.signature.is_none(),
        "signature must be None without identity"
    );

    // Data fields populated from store
    assert_eq!(card.name, "Comunidad de prueba");
    assert_eq!(card.currency, "EUR");
    assert_eq!(card.fee_bps, 60);
    assert_eq!(card.bond_percent, 3); // 300 bps → 3 %
    assert!(!card.payment_methods.is_empty());
    assert!(!verify_community_card(&card));

    // Secret must never leak
    let json = serde_json::to_string(&card).unwrap();
    assert!(!json.contains("nsec"));
}

#[test]
fn community_card_with_identity_is_signed_and_verifiable() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().into()).unwrap();
    let mut config: Configuration =
        serde_json::from_str(include_str!("fixtures/community.json")).unwrap();
    config.nostr.relays = vec![
        "wss://relay.mostro.network".to_string(),
        "wss://nostr.mom".to_string(),
    ];
    store.save(config).unwrap();

    let keys = Keys::new(SecretKey::from_slice(&[42; 32]).unwrap());
    let secret = keys.secret_key().to_bech32().unwrap();
    let public = keys.public_key().to_bech32().unwrap();
    identity::import(dir.path(), &secret, &public).unwrap();

    let card: CommunityCard = get_community_card(dir.path(), &store);

    // Pubkey present and matches imported key (64 hex lowercase)
    let card_pubkey = card.pubkey.as_deref().expect("pubkey must be present");
    assert_eq!(card_pubkey, keys.public_key().to_hex());
    assert_eq!(card_pubkey.len(), 64);

    // Relays present
    assert_eq!(card.relays.len(), 2);
    assert_eq!(card.relays[0], "wss://relay.mostro.network");
    assert_eq!(card.relays[1], "wss://nostr.mom");

    // Currency and fee
    assert_eq!(card.currency, "EUR");
    assert_eq!(card.fee_bps, 60);
    assert_eq!(card.bond_percent, 3);

    // Signature present and 128 hex chars (64-byte Schnorr sig)
    let sig_hex = card
        .signature
        .as_deref()
        .expect("signature must be present");
    assert_eq!(
        sig_hex.len(),
        128,
        "Schnorr signature must be 64 bytes = 128 hex chars"
    );
    assert!(sig_hex.chars().all(|c| c.is_ascii_hexdigit()));

    // Verify the signature cryptographically with verify_community_card
    assert!(
        verify_community_card(&card),
        "Schnorr signature must verify against the card's public key"
    );

    // Serialized format matches the standard schema
    let val: serde_json::Value = serde_json::to_value(&card).unwrap();
    assert_eq!(val["version"], 1);
    assert!(val["name"].is_string());
    assert_eq!(val["pubkey"].as_str().unwrap().len(), 64);
    assert!(val["relays"].is_array());
    assert_eq!(val["currency"], "EUR");
    assert!(val["payment_methods"].is_array());
    assert_eq!(val["fee_bps"], 60);
    assert_eq!(val["bond_percent"], 3);
    assert!(val["website"].is_string());
    assert!(val["contact"].is_string());
    assert_eq!(val["signature"].as_str().unwrap().len(), 128);

    // Secret must never appear in the serialised card
    let json = serde_json::to_string(&card).unwrap();
    assert!(!json.contains(&secret));
}
