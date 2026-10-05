//! Information for connecting Mostro App and Nostr clients to this community node.
//! Only public data (npub, hex pubkey, relays, nprofile) is returned.
//! Secret keys, macaroons, and financial state are strictly excluded.

use crate::{identity, store::Store};
use nostr::{PublicKey, RelayUrl, ToBech32, nips::nip19::Nip19Profile};
use qrcode::{QrCode, render::svg};
use serde::{Deserialize, Serialize};
use std::path::Path;

// ── Community Card (JSON v1 shared with the BitMaxis Mostro App) ───────────────

/// Community card, schema version 1.
///
/// This is a convention between this Manager and the client apps that read it
/// (see `docs/INTEGRACION-APPS.md`); it is not part of the Mostro protocol.
/// The node's kind 38385 info event stays authoritative for fees, limits and
/// bond policy: the card only bootstraps a client (pubkey, relays, currency,
/// payment methods) and lets it check that the node operator issued it.
///
/// The consumer contract is the app's deserializer and verifier
/// (`rust/src/api/community.rs`): `pubkey` and `signature` are always strings
/// and the signature covers [`card_canonical_string`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CommunityCard {
    /// Schema version — always 1 for this implementation.
    pub version: u32,
    /// Human-readable community name.
    pub name: String,
    /// Node public key as 64-char lowercase hex.
    pub pubkey: String,
    /// Nostr relay URLs the node uses, normalised (no trailing slash).
    pub relays: Vec<String>,
    /// ISO-4217 primary trading currency (e.g. "COP", "USD").
    pub currency: String,
    /// Accepted payment method labels (free-form strings shown by the app).
    pub payment_methods: Vec<String>,
    /// Total Mostro fee of a trade in basis points (60 = 0.6 %). The daemon
    /// charges half of it to the buyer and half to the seller.
    pub fee_bps: u16,
    /// Anti-abuse bond as an integer percent, 0 when the bond is disabled.
    /// Advisory: the exact policy is in the node's info event.
    pub bond_percent: u8,
    /// Operator website URL (empty string if not set).
    pub website: String,
    /// Operator contact URL (empty string if not set).
    pub contact: String,
    /// BIP-340 Schnorr signature (128 hex chars) by `pubkey` over the SHA-256
    /// of [`card_canonical_string`].
    pub signature: String,
}

/// Relay URL as the app stores it before verifying: trimmed, no trailing slash.
fn normalize_relay(relay: &str) -> String {
    relay.trim().trim_end_matches('/').to_string()
}

/// Canonical signing string of a v1 card. It must stay byte-identical to
/// `canonical_digest` in the app, which is the verifier:
///
/// `v=<version>&name=<name>&pubkey=<hex>&relays=<sorted, comma-joined>`
/// `&currency=<UPPER>&payment_methods=<comma-joined, card order>`
/// `&fee_bps=<n>&bond_percent=<n>&website=<url|empty>&contact=<url|empty>`
///
/// Fields are not escaped, so a v1 card is unambiguous only while names do not
/// contain `&` and labels do not contain `,`. A future version must fix that
/// on both sides at once; changing this string alone breaks every client.
pub fn card_canonical_string(card: &CommunityCard) -> String {
    let mut relays: Vec<String> = card.relays.iter().map(|r| normalize_relay(r)).collect();
    relays.sort();
    format!(
        "v={}&name={}&pubkey={}&relays={}&currency={}&payment_methods={}&fee_bps={}&bond_percent={}&website={}&contact={}",
        card.version,
        card.name.trim(),
        card.pubkey.trim().to_lowercase(),
        relays.join(","),
        card.currency.trim().to_uppercase(),
        card.payment_methods.join(","),
        card.fee_bps,
        card.bond_percent,
        card.website.trim(),
        card.contact.trim(),
    )
}

fn card_digest(card: &CommunityCard) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(card_canonical_string(card).as_bytes()).into()
}

/// Build the signed [`CommunityCard`] of this node.
///
/// Returns `None` until the node has an identity and a saved configuration:
/// a card without pubkey or signature cannot be parsed by the app, so it is
/// not served at all. It is also withheld while the configuration contains
/// separators that would make the signed string ambiguous.
pub fn get_community_card(root: &Path, store: &Store) -> Option<CommunityCard> {
    let config = store.document.config.as_ref()?;
    // A draft saved before this check existed may hold values that make the
    // unescaped canonical string ambiguous. Such a card is not signed.
    if config.card_is_ambiguous() {
        return None;
    }
    let keys = identity::load_identity_keys(root).ok()??;

    // bond_percent: bond_bps (basis points) → integer percent, rounded.
    let bond_percent = if config.safety.bond_enabled {
        ((config.safety.bond_bps as u32 + 50) / 100) as u8
    } else {
        0
    };

    let mut card = CommunityCard {
        version: 1,
        name: config.community.name.trim().to_string(),
        pubkey: keys.public_key().to_hex(),
        relays: config
            .nostr
            .relays
            .iter()
            .map(|r| normalize_relay(r))
            .collect(),
        // Primary fiat currency: first in the validated list.
        currency: config.market.fiat_currencies.first()?.clone(),
        // Only active payment methods.
        payment_methods: config
            .payment_methods
            .iter()
            .filter(|p| p.active)
            .map(|p| p.label.clone())
            .collect(),
        fee_bps: config.market.fee_bps,
        bond_percent,
        website: config.community.website.trim().to_string(),
        contact: config.community.contact.trim().to_string(),
        signature: String::new(),
    };
    card.signature = sign_community_card(&keys, &card);
    Some(card)
}

/// BIP-340 Schnorr signature over the SHA-256 of the canonical string.
fn sign_community_card(keys: &nostr::Keys, card: &CommunityCard) -> String {
    use nostr::secp256k1::{Message, SECP256K1};

    let msg = Message::from_digest(card_digest(card));
    let sig = SECP256K1.sign_schnorr(&msg, &keys.secret_key().keypair(SECP256K1));
    format!("{sig}")
}

/// Cryptographically verify the Schnorr signature of a [`CommunityCard`].
pub fn verify_community_card(card: &CommunityCard) -> bool {
    use nostr::secp256k1::{Message, SECP256K1, XOnlyPublicKey, schnorr::Signature};
    use std::str::FromStr;

    let Ok(sig) = Signature::from_str(card.signature.trim()) else {
        return false;
    };
    let Ok(xonly) = XOnlyPublicKey::from_str(card.pubkey.trim()) else {
        return false;
    };
    let msg = Message::from_digest(card_digest(card));
    SECP256K1.verify_schnorr(&sig, &msg, &xonly).is_ok()
}

/// Deep link carrying the whole signed card: `mostro://community/<base64url>`,
/// unpadded, as the app's `parse_community_payload` decodes it.
pub fn card_deep_link(card: &CommunityCard) -> Option<String> {
    let json = serde_json::to_vec(card).ok()?;
    Some(format!("mostro://community/{}", base64url_no_pad(&json)))
}

fn base64url_no_pad(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..=chunk.len() {
            out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
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
    /// `mostro://community/<base64url JSON>`: the signed card as a deep link.
    pub card_uri: Option<String>,
    pub qr_card_svg: Option<String>,
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
            card_uri: None,
            qr_card_svg: None,
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
    let json_uri = card.as_ref().and_then(|c| serde_json::to_string(c).ok());
    let card_uri = card.as_ref().and_then(card_deep_link);

    let render_qr = |payload: &String| {
        QrCode::new(payload.as_bytes())
            .ok()
            .map(|code| code.render::<svg::Color>().build())
    };
    let qr_json_svg = json_uri.as_ref().and_then(render_qr);
    let qr_card_svg = card_uri.as_ref().and_then(render_qr);

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
        card_uri,
        qr_card_svg,
        card,
        app_download_url: "https://mostro.network",
        instructions: "Escanea la tarjeta firmada de la comunidad o usa la clave pública (npub o hex) con los relays indicados. Comisiones, límites y garantía se leen del evento de información del nodo.",
    }
}
