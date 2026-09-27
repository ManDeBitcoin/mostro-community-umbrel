//! Read-only preparation report. It never starts Mostro or reads privileged LND credentials.
use crate::{adapters::Integrations, identity, store::Document};
use serde_json::{Value, json};
use std::{fs, path::Path};

fn capacity(lightning: &Value) -> &'static str {
    let channels = lightning["num_active_channels"].as_u64();
    match channels {
        Some(0) => "no_active_channels",
        Some(_) if lightning["liquidity"]["status"] == "available" => {
            let local = lightning["liquidity"]["local_balance_sats"]
                .as_str()
                .and_then(|value| value.parse::<u64>().ok());
            let remote = lightning["liquidity"]["remote_balance_sats"]
                .as_str()
                .and_then(|value| value.parse::<u64>().ok());
            match (local, remote) {
                (Some(0), _) => "no_local_liquidity",
                (_, Some(0)) => "no_remote_liquidity",
                (Some(_), Some(_)) => "balances_observed",
                _ => "unknown",
            }
        }
        _ => "unknown",
    }
}

pub async fn report(root: &Path, integrations: &Integrations) -> Value {
    let (draft, revision) = match fs::read(root.join("community.json")) {
        Ok(bytes) => match serde_json::from_slice::<Document>(&bytes) {
            Ok(document) => match document.config {
                Some(config) if config.validate().is_ok() => ("valid", Some(document.revision)),
                Some(_) => ("invalid", None),
                None => ("missing", None),
            },
            Err(_) => ("invalid", None),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => ("missing", None),
        Err(_) => ("unavailable", None),
    };
    let (identity, npub) = match identity::inspect(root) {
        Ok(Some(npub)) => ("imported", Some(npub)),
        Ok(None) => ("missing", None),
        Err(_) => ("invalid", None),
    };
    let lightning = integrations.lightning().await;
    let lightning_status = lightning["status"].as_str().unwrap_or("unknown");
    let capacity = capacity(&lightning);
    json!({
        "draft":{"status":draft,"revision":revision},
        "identity":{"status":identity,"npub":npub},
        "lightning":{
            "status":lightning_status,
            "network":lightning["network"],
            "synced_to_chain":lightning["synced_to_chain"],
            "synced_to_graph":lightning["synced_to_graph"],
            "num_active_channels":lightning["num_active_channels"],
            "liquidity_status":lightning["liquidity"]["status"],
            "capacity":capacity
        },
        "mostro":{"status":"not_installed","market_started":false},
        "can_start_market":false,
        "detail":"Aún faltan integración financiera de Mostro, backup y prueba de ciclo completo en regtest"
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::Configuration, store::Store};
    use nostr::{Keys, SecretKey, ToBech32};
    #[test]
    fn recognizes_missing_channels_and_directional_liquidity() {
        assert_eq!(
            capacity(&json!({"num_active_channels":0})),
            "no_active_channels"
        );
        assert_eq!(
            capacity(
                &json!({"num_active_channels":1,"liquidity":{"status":"available","local_balance_sats":"0","remote_balance_sats":"10"}})
            ),
            "no_local_liquidity"
        );
        assert_eq!(
            capacity(
                &json!({"num_active_channels":1,"liquidity":{"status":"available","local_balance_sats":"10","remote_balance_sats":"0"}})
            ),
            "no_remote_liquidity"
        );
        assert_eq!(
            capacity(
                &json!({"num_active_channels":1,"liquidity":{"status":"available","local_balance_sats":"10","remote_balance_sats":"10"}})
            ),
            "balances_observed"
        );
        assert_eq!(capacity(&json!({})), "unknown");
    }
    #[tokio::test]
    async fn reports_existing_public_identity_and_draft_without_secret() {
        let root = tempfile::tempdir().unwrap();
        let mut store = Store::open(root.path().to_path_buf()).unwrap();
        let config: Configuration =
            serde_json::from_str(include_str!("../tests/fixtures/community.json")).unwrap();
        store.save(config).unwrap();
        let keys = Keys::new(SecretKey::from_slice(&[3; 32]).unwrap());
        let secret = keys.secret_key().to_bech32().unwrap();
        let public = keys.public_key().to_bech32().unwrap();
        identity::import(root.path(), &secret, &public).unwrap();
        let report = report(root.path(), &Integrations::default()).await;
        assert_eq!(report["draft"]["status"], "valid");
        assert_eq!(report["identity"]["npub"], public);
        assert_eq!(report["lightning"]["status"], "unconfigured");
        assert_eq!(report["can_start_market"], false);
        assert!(!report.to_string().contains(&secret));
    }
}
