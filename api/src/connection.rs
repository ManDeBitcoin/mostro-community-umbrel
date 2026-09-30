//! Information for connecting Mostro App and Nostr clients to this community node.
//! Only public data (npub, hex pubkey, relays, nprofile) is returned.
//! Secret keys, macaroons, and financial state are strictly excluded.

use crate::{identity, store::Store};
use nostr::{PublicKey, RelayUrl, ToBech32, nips::nip19::Nip19Profile};
use qrcode::{QrCode, render::svg};
use serde::{Deserialize, Serialize};
use std::path::Path;

// ── Community Card (Mostro App standard JSON) ──────────────────────────────────

/// Standard JSON v1 emitted by this node for Mostro App connections.
///
/// All fields map 1-to-1 to the Mostro App community card specification:
/// <https://github.com/MostroP2P/mostro>
///
/// The `signature` is a Schnorr signature over the SHA-256 of the
/// canonical payload (UTF-8 JSON with all fields **except** `signature`,
/// keys lexicographically sorted, no trailing whitespace).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CommunityCard {
    /// Schema version — always 1 for this implementation.
    pub version: u32,
    /// Human-readable community name.
    pub name: String,
    /// Node public key as 64-char lowercase hex.
    pub pubkey: Option<String>,
    /// Nostr relay URLs the node listens on.
    pub relays: Vec<String>,
    /// ISO-4217 primary trading currency (e.g. "COP", "USD").
    pub currency: String,
    /// Accepted payment method labels (free-form strings shown in Mostro App).
    pub payment_methods: Vec<String>,
    /// Operator fee in basis points (1 bps = 0.01 %).
    pub fee_bps: u16,
    /// Bond/guarantee percentage required from traders (integer percent).
    pub bond_percent: u8,
    /// Operator website URL (empty string if not set).
    pub website: String,
    /// Operator contact URL or nostr address (empty string if not set).
    pub contact: String,
    /// Schnorr signature (128-char lowercase hex) over the canonical payload,
    /// or `null` when the node identity has not been provisioned yet.
    pub signature: Option<String>,
}

/// Canonical JSON bytes used as the Schnorr signing payload.
///
/// All fields of `CommunityCard` **except** `signature` are included,
/// serialised with keys in lexicographic order (as `serde_json` emits struct
/// fields in declaration order — we rely on that order here).
fn card_canonical_payload(card: &CommunityCard) -> Vec<u8> {
    // Build a deterministic subset: exclude `signature`.
    let payload = serde_json::json!({
        "bond_percent": card.bond_percent,
        "contact":      card.contact,
        "currency":     card.currency,
        "fee_bps":      card.fee_bps,
        "name":         card.name,
        "payment_methods": card.payment_methods,
        "pubkey":       card.pubkey,
        "relays":       card.relays,
        "version":      card.version,
        "website":      card.website,
    });
    // Compact JSON, no trailing newline — deterministic across platforms.
    serde_json::to_vec(&payload).expect("infallible: Value is always serialisable")
}

/// Build a [`CommunityCard`] from the current store state and sign it with
/// the node's Nostr identity key (Schnorr / BIP-340).
///
/// Returns the card with `signature = None` when the identity has not been
/// provisioned yet (safe to serve — clients must reject unsigned cards if
/// they require verified communities).
pub fn get_community_card(root: &Path, store: &Store) -> CommunityCard {
    let config = store.document.config.as_ref();

    let name = config.map(|c| c.community.name.clone()).unwrap_or_default();

    let relays: Vec<String> = config.map(|c| c.nostr.relays.clone()).unwrap_or_default();

    // Primary fiat currency: first in the list, or empty.
    let currency = config
        .and_then(|c| c.market.fiat_currencies.first().cloned())
        .unwrap_or_default();

    // Payment method labels (only active ones).
    let payment_methods: Vec<String> = config
        .map(|c| {
            c.payment_methods
                .iter()
                .filter(|p| p.active)
                .map(|p| p.label.clone())
                .collect()
        })
        .unwrap_or_default();

    let fee_bps = config.map(|c| c.market.fee_bps).unwrap_or(0);

    // bond_percent: convert bond_bps (basis points) → integer percent (rounded).
    let bond_percent = config
        .map(|c| {
            if c.safety.bond_enabled {
                ((c.safety.bond_bps as u32 + 50) / 100) as u8
            } else {
                0
            }
        })
        .unwrap_or(0);

    let website = config
        .map(|c| c.community.website.clone())
        .unwrap_or_default();

    let contact = config
        .map(|c| c.community.contact.clone())
        .unwrap_or_default();

    // Resolve pubkey hex from the stored identity key.
    let pubkey_hex: Option<String> = identity::inspect_public_key(root)
        .ok()
        .flatten()
        .map(|pk| pk.to_hex());

    let mut card = CommunityCard {
        version: 1,
        name,
        pubkey: pubkey_hex,
        relays,
        currency,
        payment_methods,
        fee_bps,
        bond_percent,
        website,
        contact,
        signature: None,
    };

    // Sign with the identity key if available.
    card.signature = sign_community_card(root, &card);

    card
}

/// Produce a Schnorr signature (BIP-340) over the canonical card payload.
///
/// Returns `None` when the identity key is not available or signing fails.
fn sign_community_card(root: &Path, card: &CommunityCard) -> Option<String> {
    use nostr::Keys;
    use nostr::secp256k1::{Message, SECP256K1};
    use sha2::{Digest, Sha256};

    let keys: Keys = identity::load_identity_keys(root).ok()??;
    let payload = card_canonical_payload(card);

    // SHA-256 of the canonical payload, then Schnorr-sign it.
    let hash: [u8; 32] = Sha256::digest(&payload).into();
    let msg = Message::from_digest(hash);
    let sig = SECP256K1.sign_schnorr(&msg, &keys.secret_key().keypair(SECP256K1));

    Some(format!("{sig}"))
}

/// Cryptographically verify the Schnorr signature of a [`CommunityCard`].
pub fn verify_community_card(card: &CommunityCard) -> bool {
    use nostr::secp256k1::{Message, SECP256K1, XOnlyPublicKey, schnorr::Signature};
    use sha2::{Digest, Sha256};
    use std::str::FromStr;

    let Some(ref sig_hex) = card.signature else {
        return false;
    };
    let Some(ref pubkey_hex) = card.pubkey else {
        return false;
    };

    let Ok(sig) = Signature::from_str(sig_hex) else {
        return false;
    };
    let Ok(xonly) = XOnlyPublicKey::from_str(pubkey_hex) else {
        return false;
    };

    let payload = card_canonical_payload(card);
    let hash: [u8; 32] = Sha256::digest(&payload).into();
    let msg = Message::from_digest(hash);

    SECP256K1.verify_schnorr(&sig, &msg, &xonly).is_ok()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConnectionInfo {
    pub status: &'static str,
    pub npub: Option<String>,
    pub pubkey_hex: Option<String>,
    pub relays: Vec<String>,
    pub nprofile: Option<String>,
    pub nostr_uri: Option<String>,
    pub qr_svg: Option<String>,
    pub qr_json_svg: Option<String>,
    pub json_uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub card: Option<CommunityCard>,
    pub app_download_url: &'static str,
    pub instructions: &'static str,
}

pub fn get_connection_info(root: &Path, store: &Store) -> ConnectionInfo {
    let pubkey: Option<PublicKey> = identity::inspect_public_key(root).unwrap_or_default();

    let configured_relays: Vec<String> = store
        .document
        .config
        .as_ref()
        .map(|c| c.nostr.relays.clone())
        .unwrap_or_default();

    let Some(pubkey) = pubkey else {
        return ConnectionInfo {
            status: "missing_identity",
            npub: None,
            pubkey_hex: None,
            relays: configured_relays,
            nprofile: None,
            nostr_uri: None,
            qr_svg: None,
            qr_json_svg: None,
            json_uri: None,
            card: None,
            app_download_url: "https://mostro.network",
            instructions: "Importa primero la clave de identidad Nostr de la comunidad.",
        };
    };

    let npub = pubkey.to_bech32().ok();
    let pubkey_hex = Some(pubkey.to_hex());

    let valid_relays: Vec<RelayUrl> = configured_relays
        .iter()
        .filter_map(|r| RelayUrl::parse(r).ok())
        .collect();

    let nprofile = if !valid_relays.is_empty() {
        let profile = Nip19Profile::new(pubkey, valid_relays);
        profile.to_bech32().ok()
    } else {
        let profile = Nip19Profile::new(pubkey, Vec::<RelayUrl>::new());
        profile.to_bech32().ok()
    };

    let nostr_uri = if let Some(ref prof) = nprofile {
        Some(format!("mostro://community/{}", prof))
    } else {
        npub.as_ref().map(|np| format!("mostro://community/{}", np))
    };

    let qr_svg = nostr_uri.as_ref().and_then(|uri| {
        QrCode::new(uri.as_bytes())
            .ok()
            .map(|code| code.render::<svg::Color>().build())
    });

    let card = get_community_card(root, store);
    let json_uri = serde_json::to_string(&card).ok();

    let qr_json_svg = json_uri.as_ref().and_then(|uri| {
        QrCode::new(uri.as_bytes())
            .ok()
            .map(|code| code.render::<svg::Color>().build())
    });

    ConnectionInfo {
        status: "ready",
        npub,
        pubkey_hex,
        relays: configured_relays,
        nprofile,
        nostr_uri,
        qr_svg,
        qr_json_svg,
        json_uri,
        card: Some(card),
        app_download_url: "https://mostro.network",
        instructions: "Usa la clave pública (npub o hex) o escanea el nprofile en Mostro App para conectarte a este nodo.",
    }
}
