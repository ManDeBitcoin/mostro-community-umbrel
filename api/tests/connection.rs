use mostro_community_api::{
    config::Configuration,
    connection::{
        CommunityCard, ConnectionInfo, card_canonical_string, card_deep_link, get_community_card,
        get_connection_info, verify_community_card,
    },
    identity,
    store::Store,
};
use nostr::{Keys, SecretKey, ToBech32};
use sha2::{Digest, Sha256};

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
    assert_eq!(info.card_uri, None);
    assert_eq!(info.qr_card_svg, None);
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
    assert_eq!(parsed_card.pubkey, public_hex);
    assert_eq!(parsed_card.fee_bps, 60);
    assert_eq!(parsed_card.bond_percent, 3);
    assert!(verify_community_card(&parsed_card));

    // The deep link carries the same signed card as unpadded base64url JSON.
    let card_uri = info
        .card_uri
        .as_deref()
        .expect("card_uri should be present");
    let payload = card_uri
        .strip_prefix("mostro://community/")
        .expect("deep link scheme");
    assert!(
        payload
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    );
    assert_eq!(decode_base64url(payload), json_uri.as_bytes());
    assert!(
        info.qr_card_svg
            .as_deref()
            .is_some_and(|svg| svg.contains("<svg"))
    );

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

fn decode_base64url(input: &str) -> Vec<u8> {
    let value = |c: u8| -> u32 {
        match c {
            b'A'..=b'Z' => u32::from(c - b'A'),
            b'a'..=b'z' => u32::from(c - b'a') + 26,
            b'0'..=b'9' => u32::from(c - b'0') + 52,
            b'-' => 62,
            b'_' => 63,
            _ => panic!("not base64url"),
        }
    };
    let mut out = Vec::new();
    for chunk in input.as_bytes().chunks(4) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |acc, (i, c)| acc | (value(*c) << (18 - 6 * i)));
        for i in 0..chunk.len() - 1 {
            out.push((n >> (16 - 8 * i)) as u8);
        }
    }
    out
}

fn store_with_fixture(dir: &std::path::Path, relays: &[&str]) -> Store {
    let mut store = Store::open(dir.into()).unwrap();
    let mut config: Configuration =
        serde_json::from_str(include_str!("fixtures/community.json")).unwrap();
    config.nostr.relays = relays.iter().map(|r| r.to_string()).collect();
    store.save(config).unwrap();
    store
}

fn import_identity(dir: &std::path::Path, seed: u8) -> Keys {
    let keys = Keys::new(SecretKey::from_slice(&[seed; 32]).unwrap());
    let secret = keys.secret_key().to_bech32().unwrap();
    let public = keys.public_key().to_bech32().unwrap();
    identity::import(dir, &secret, &public).unwrap();
    keys
}

#[test]
fn community_card_is_not_served_without_identity() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_with_fixture(dir.path(), &["wss://relay.example.com"]);
    // The app's deserializer requires string pubkey and signature, so a card
    // that cannot be signed is not produced at all.
    assert_eq!(get_community_card(dir.path(), &store), None);
    assert_eq!(get_connection_info(dir.path(), &store).card, None);
}

#[test]
fn community_card_is_not_served_without_configuration() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().into()).unwrap();
    import_identity(dir.path(), 9);
    assert_eq!(get_community_card(dir.path(), &store), None);
    let info = get_connection_info(dir.path(), &store);
    assert_eq!(info.status, "ready");
    assert_eq!(info.card, None);
    assert_eq!(info.card_uri, None);
}

#[test]
fn community_card_with_identity_is_signed_and_verifiable() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_with_fixture(
        dir.path(),
        &["wss://relay.mostro.network", "wss://nostr.mom"],
    );
    let keys = import_identity(dir.path(), 42);
    let secret = keys.secret_key().to_bech32().unwrap();

    let card: CommunityCard = get_community_card(dir.path(), &store).expect("signed card");

    assert_eq!(card.pubkey, keys.public_key().to_hex());
    assert_eq!(card.pubkey.len(), 64);
    assert_eq!(
        card.relays,
        ["wss://relay.mostro.network", "wss://nostr.mom"]
    );
    assert_eq!(card.currency, "EUR");
    assert_eq!(card.fee_bps, 60);
    assert_eq!(card.bond_percent, 3); // 300 bps → 3 %
    assert_eq!(card.signature.len(), 128);
    assert!(card.signature.chars().all(|c| c.is_ascii_hexdigit()));
    assert!(verify_community_card(&card));

    // Every field the app deserializes is present with the type it expects:
    // strings for pubkey/signature, never null.
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

    let json = serde_json::to_string(&card).unwrap();
    assert!(!json.contains(&secret));
    assert!(!json.contains("nsec"));
}

/// Contract with the client app: the signature covers exactly this string
/// (`canonical_digest` in the app's `rust/src/api/community.rs`). If this test
/// has to change, every deployed app stops verifying cards from this node.
#[test]
fn community_card_canonical_string_matches_the_app_verifier() {
    let card = CommunityCard {
        version: 1,
        name: "  Bitcoin Medellín ".into(),
        pubkey: "A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90".into(),
        relays: vec![
            "wss://relay.mostro.network/".into(),
            " wss://nos.lol".into(),
        ],
        currency: "cop".into(),
        payment_methods: vec!["Nequi".into(), "Bancolombia".into()],
        fee_bps: 60,
        bond_percent: 3,
        website: " https://example.com ".into(),
        contact: String::new(),
        signature: String::new(),
    };
    let canonical = card_canonical_string(&card);
    assert_eq!(
        canonical,
        "v=1&name=Bitcoin Medellín\
         &pubkey=a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90\
         &relays=wss://nos.lol,wss://relay.mostro.network\
         &currency=COP&payment_methods=Nequi,Bancolombia\
         &fee_bps=60&bond_percent=3&website=https://example.com&contact="
    );
    // Digest pinned with an independent SHA-256 of the same bytes.
    let digest = Sha256::digest(canonical.as_bytes());
    assert_eq!(
        digest
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>(),
        "01496e8a7567a56c49d1ed26c06152311862282282a5ec8c9865a6b6a94a4534"
    );
}

#[test]
fn community_card_relays_are_normalised_before_signing() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_with_fixture(
        dir.path(),
        &["wss://relay.mostro.network/", "wss://nos.lol"],
    );
    import_identity(dir.path(), 5);
    let card = get_community_card(dir.path(), &store).expect("signed card");
    // The app strips the trailing slash before verifying; the card must
    // already carry the relay in that form or the signature would not match.
    assert_eq!(card.relays, ["wss://relay.mostro.network", "wss://nos.lol"]);
    assert!(verify_community_card(&card));

    // Relay order is not part of the signature; any other change is.
    let mut reordered = card.clone();
    reordered.relays.reverse();
    assert!(verify_community_card(&reordered));
    let mut tampered = card.clone();
    tampered.relays.push("wss://evil.example".into());
    assert!(!verify_community_card(&tampered));
    let mut tampered = card.clone();
    tampered.fee_bps += 1;
    assert!(!verify_community_card(&tampered));
    let mut unsigned = card.clone();
    unsigned.signature.clear();
    assert!(!verify_community_card(&unsigned));
}

#[test]
fn community_card_deep_link_round_trips() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_with_fixture(dir.path(), &["wss://relay.mostro.network"]);
    import_identity(dir.path(), 6);
    let card = get_community_card(dir.path(), &store).expect("signed card");
    let link = card_deep_link(&card).expect("deep link");
    let payload = link.strip_prefix("mostro://community/").unwrap();
    assert!(!payload.contains('='), "base64url must be unpadded");
    let decoded: CommunityCard = serde_json::from_slice(&decode_base64url(payload)).unwrap();
    assert_eq!(decoded, card);
    assert!(verify_community_card(&decoded));
}

/// The v1 canonical string is not escaped, so separators inside a value would
/// let one signature validate a card the operator never configured.
#[test]
fn community_card_is_withheld_when_the_signed_string_would_be_ambiguous() {
    let base: Configuration =
        serde_json::from_str(include_str!("fixtures/community.json")).unwrap();
    assert!(!base.card_is_ambiguous());
    assert!(base.validate_for_save().is_ok());

    let mutations: [fn(&mut Configuration); 5] = [
        |c| c.community.name = "Bitcoin & Lightning".into(),
        |c| c.community.website = "https://site.example/?a=1&contact=https://evil.example".into(),
        |c| c.community.contact = "https://t.me/x?a=1&b=2".into(),
        |c| c.payment_methods[0].label = "Nequi, Daviplata".into(),
        |c| c.nostr.relays = vec!["wss://relay.example.com/?a=1&b=2".into()],
    ];
    for mutate in mutations {
        let mut config = base.clone();
        mutate(&mut config);
        assert!(config.card_is_ambiguous());
        // Still a loadable draft, but it cannot be saved again as it is...
        assert!(config.validate().is_ok());
        assert!(config.validate_for_save().is_err());
        // ...and no card is signed for it.
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().into()).unwrap();
        store.save(config).unwrap();
        import_identity(dir.path(), 8);
        assert_eq!(get_community_card(dir.path(), &store), None);
        assert_eq!(get_connection_info(dir.path(), &store).card_uri, None);
    }

    // An inactive payment method is not part of the card.
    let mut config = base.clone();
    config.payment_methods[0].label = "Nequi, Daviplata".into();
    config.payment_methods[0].active = false;
    assert!(!config.card_is_ambiguous());
}
