//! Information for connecting Mostro App and Nostr clients to this community node.
//! Only public data (npub, hex pubkey, relays, nprofile) is returned.
//! Secret keys, macaroons, and financial state are strictly excluded.

use crate::{identity, store::Store};
use nostr::{PublicKey, RelayUrl, ToBech32, nips::nip19::Nip19Profile};
use qrcode::{QrCode, render::svg};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConnectionInfo {
    pub status: &'static str,
    pub npub: Option<String>,
    pub pubkey_hex: Option<String>,
    pub relays: Vec<String>,
    pub nprofile: Option<String>,
    pub nostr_uri: Option<String>,
    pub qr_svg: Option<String>,
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

    ConnectionInfo {
        status: "ready",
        npub,
        pubkey_hex,
        relays: configured_relays,
        nprofile,
        nostr_uri,
        qr_svg,
        app_download_url: "https://mostro.network",
        instructions: "Usa la clave pública (npub o hex) o escanea el nprofile en Mostro App para conectarte a este nodo.",
    }
}
