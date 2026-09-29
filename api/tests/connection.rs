use mostro_community_api::{
    config::Configuration,
    connection::{ConnectionInfo, get_connection_info},
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

    // Verify secret is NEVER serialized or present in debug string
    let serialized = serde_json::to_string(&info).unwrap();
    assert!(!serialized.contains(&secret));
    assert!(!format!("{:?}", info).contains(&secret));
}
