use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::{Component, Path},
};
use url::Url;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Configuration {
    pub community: Community,
    pub market: Market,
    pub safety: Safety,
    pub nostr: Nostr,
    pub payment_methods: Vec<PaymentMethod>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Community {
    pub name: String,
    pub about: String,
    pub website: String,
    pub contact: String,
    pub language: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Market {
    pub fiat_currencies: Vec<String>,
    pub min_trade_sats: u64,
    pub max_trade_sats: u64,
    pub fee_bps: u16,
    pub dev_fee_bps: u16,
    pub max_routing_fee_bps: u16,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Safety {
    pub bond_enabled: bool,
    pub bond_bps: u16,
    pub base_bond_sats: u64,
    pub bond_apply_to: BondApply,
    pub automatic_timeout_slash: bool,
    pub pow: u8,
    pub pow_first_contact: u8,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BondApply {
    Make,
    Take,
    Both,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Nostr {
    pub relays: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PaymentMethod {
    pub id: String,
    pub label: String,
    pub category: String,
    pub active: bool,
}

fn valid_url(value: &str, schemes: &[&str]) -> bool {
    Url::parse(value).is_ok_and(|u| {
        schemes.contains(&u.scheme())
            && u.host_str().is_some()
            && u.username().is_empty()
            && u.password().is_none()
            && u.fragment().is_none()
    })
}
impl Configuration {
    pub fn validate(&self) -> Result<(), &'static str> {
        let c = &self.community;
        if c.name.trim().is_empty()
            || c.name.len() > 100
            || c.about.len() > 1000
            || c.language.trim().is_empty()
            || c.language.len() > 35
        {
            return Err("Nombre, descripción o idioma no válidos");
        }
        if [&c.website, &c.contact]
            .iter()
            .any(|v| v.len() > 2048 || (!v.is_empty() && !valid_url(v, &["https", "http"])))
        {
            return Err("Usa enlaces HTTP(S) sin credenciales");
        }
        let m = &self.market;
        if m.min_trade_sats == 0
            || m.min_trade_sats > m.max_trade_sats
            || m.max_trade_sats > 100_000_000
        {
            return Err("Límites inválidos: 1 ≤ mínimo ≤ máximo ≤ 100 millones de sats");
        }
        if m.fee_bps > 10_000 || m.dev_fee_bps > 10_000 || m.max_routing_fee_bps > 10_000 {
            return Err("Los porcentajes deben estar entre 0 y 100");
        }
        let mut currencies = HashSet::new();
        if m.fiat_currencies.is_empty()
            || m.fiat_currencies.len() > 30
            || m.fiat_currencies.iter().any(|v| {
                v.len() != 3 || !v.bytes().all(|b| b.is_ascii_uppercase()) || !currencies.insert(v)
            })
        {
            return Err("Selecciona códigos de moneda de tres letras, únicos y en mayúsculas");
        }
        let s = &self.safety;
        if s.bond_bps > 10_000
            || s.base_bond_sats > 100_000_000
            || s.pow > 32
            || s.pow_first_contact > 32
            || s.pow_first_contact < s.pow
        {
            return Err("Bond o dificultad PoW inválidos");
        }
        if s.bond_enabled && s.bond_bps == 0 && s.base_bond_sats == 0 {
            return Err("Un bond habilitado debe tener importe positivo");
        }
        let mut relays = HashSet::new();
        if self.nostr.relays.is_empty()
            || self.nostr.relays.len() > 10
            || self
                .nostr
                .relays
                .iter()
                .any(|v| v.len() > 2048 || !valid_url(v, &["ws", "wss"]) || !relays.insert(v))
        {
            return Err("Configura entre 1 y 10 relays WS(S) únicos, sin credenciales");
        }
        let mut ids = HashSet::new();
        if self.payment_methods.len() > 100
            || self.payment_methods.iter().any(|p| {
                p.id.is_empty()
                    || p.id.len() > 64
                    || !p
                        .id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                    || !ids.insert(&p.id)
                    || p.label.trim().is_empty()
                    || p.label.len() > 100
                    || p.category.len() > 100
            })
        {
            return Err("Catálogo de métodos inválido o con identificadores duplicados");
        }
        Ok(())
    }
}

/// Render an inert candidate from the pinned upstream template. The imported nsec
/// stays in its own file; Mostro will receive it via MOSTRO_NSEC_PRIVKEY only when
/// a separate, tested daemon launcher exists. RPC remains disabled here.
pub fn render_settings(
    config: &Configuration,
    lnd_host: &str,
    cert: &str,
    macaroon: &str,
) -> Result<String, String> {
    config.validate().map_err(str::to_owned)?;
    let host = Url::parse(lnd_host).map_err(|_| "Host LND inválido")?;
    if host.scheme() != "https"
        || host.host_str().is_none()
        || !host.username().is_empty()
        || host.password().is_some()
        || host.path() != "/"
        || host.query().is_some()
        || host.fragment().is_some()
    {
        return Err("Host LND debe ser un origen HTTPS sin credenciales".into());
    }
    if [cert, macaroon].iter().any(|value| {
        let path = Path::new(value);
        !path.is_absolute()
            || path
                .components()
                .any(|part| matches!(part, Component::ParentDir))
    }) {
        return Err("Las rutas de credenciales LND deben ser absolutas".into());
    }
    let mut doc: toml::Value =
        toml::from_str(include_str!("../../config/upstream/settings.v0.18.8.toml"))
            .map_err(|_| "Plantilla inválida")?;
    doc["lightning"]["lnd_grpc_host"] = lnd_host.into();
    doc["lightning"]["lnd_cert_file"] = cert.into();
    doc["lightning"]["lnd_macaroon_file"] = macaroon.into();
    doc["nostr"]["nsec_privkey"] = "".into();
    doc["nostr"]["relays"] =
        toml::Value::try_from(&config.nostr.relays).map_err(|_| "Relays inválidos")?;
    for (key, value) in [
        ("name", &config.community.name),
        ("about", &config.community.about),
        ("website", &config.community.website),
    ] {
        doc["mostro"]
            .as_table_mut()
            .unwrap()
            .insert(key.into(), value.as_str().into());
    }
    for (key, value) in [
        ("fee", config.market.fee_bps),
        ("dev_fee_percentage", config.market.dev_fee_bps),
        ("max_routing_fee", config.market.max_routing_fee_bps),
    ] {
        doc["mostro"][key] = (f64::from(value) / 10_000.0).into();
    }
    doc["mostro"]["min_payment_amount"] = (config.market.min_trade_sats as i64).into();
    doc["mostro"]["max_order_amount"] = (config.market.max_trade_sats as i64).into();
    doc["mostro"]["fiat_currencies_accepted"] =
        toml::Value::try_from(&config.market.fiat_currencies).map_err(|_| "Monedas inválidas")?;
    doc["mostro"]["pow"] = i64::from(config.safety.pow).into();
    doc["mostro"].as_table_mut().unwrap().insert(
        "pow_first_contact".into(),
        i64::from(config.safety.pow_first_contact).into(),
    );
    doc["rpc"]["enabled"] = false.into();
    doc["rpc"]["listen_address"] = "127.0.0.1".into();
    doc["rpc"].as_table_mut().unwrap().remove("auth_token");
    let bond = toml::toml! {
        enabled = (config.safety.bond_enabled)
        amount_pct = (f64::from(config.safety.bond_bps) / 10_000.0)
        base_amount_sats = (config.safety.base_bond_sats as i64)
        apply_to = (match config.safety.bond_apply_to { BondApply::Make => "make", BondApply::Take => "take", BondApply::Both => "both" })
        slash_on_waiting_timeout = (config.safety.automatic_timeout_slash)
        slash_node_share_pct = 0.5
        payout_invoice_window_seconds = 300
        payout_max_retries = 5
        payout_claim_window_days = 15
    };
    doc.as_table_mut()
        .unwrap()
        .insert("anti_abuse_bond".into(), bond.into());
    toml::to_string_pretty(&doc).map_err(|_| "No se pudo generar TOML".into())
}
