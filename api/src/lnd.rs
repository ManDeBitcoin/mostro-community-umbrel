//! Read-only LND probes: never return raw upstream responses or credentials.
use reqwest::{Client, header::HeaderValue};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
use zeroize::Zeroizing;

type ProbeError = Box<dyn std::error::Error + Send + Sync>;
fn base_url(address: &str) -> Result<url::Url, ProbeError> {
    let url = url::Url::parse(address)?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("LND requires an HTTPS origin without credentials".into());
    }
    Ok(url)
}
fn unavailable_liquidity() -> Value {
    json!({"status":"unavailable", "local_balance_sats":null,"remote_balance_sats":null,
        "detail":"No se pudo consultar el saldo de los canales"})
}
fn sats(value: &Value) -> Option<String> {
    // Protobuf encodes uint64 as decimal strings. Preserve precision in JavaScript.
    if let Some(text) = value.as_str() {
        if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        text.parse::<u64>().ok().map(|n| n.to_string())
    } else {
        value.as_u64().map(|n| n.to_string())
    }
}
fn liquidity(response: &Value) -> Value {
    match (
        sats(&response["local_balance"]["sat"]),
        sats(&response["remote_balance"]["sat"]),
    ) {
        (Some(local), Some(remote)) => json!({"status":"available", "local_balance_sats":local,
            "remote_balance_sats":remote,"detail":"Saldo agregado de canales abiertos; no garantiza capacidad de pago ni de recepción"}),
        _ => unavailable_liquidity(),
    }
}
fn summary(response: &Value, balance: Value) -> Result<Value, ProbeError> {
    let synced = response["synced_to_chain"]
        .as_bool()
        .ok_or("missing sync state")?;
    let graph = response["synced_to_graph"].as_bool();
    let healthy = synced && graph == Some(true);
    let network = response["chains"]
        .as_array()
        .and_then(|chains| chains.iter().find(|chain| chain["chain"] == "bitcoin"))
        .and_then(|chain| chain["network"].as_str());
    Ok(json!({"status":if healthy {"online"} else {"warning"},
        "detail":if !synced {"LND está sincronizando la cadena"} else if graph == Some(false) {"LND está sincronizando el grafo Lightning"} else if graph.is_none() {"LND responde; sincronización del grafo desconocida"} else {"LND conectado y sincronizado; consultas de solo lectura"},
        "alias":response["alias"].as_str(),"version":response["version"].as_str(),
        "synced_to_chain":synced,"synced_to_graph":graph,"network":network,
        "num_active_channels":response["num_active_channels"].as_u64(),
        "num_pending_channels":response["num_pending_channels"].as_u64(),
        "num_inactive_channels":response["num_inactive_channels"].as_u64(),
        "block_height":response["block_height"].as_u64(),"liquidity":balance}))
}
async fn get(
    client: &Client,
    base: &url::Url,
    credential: &HeaderValue,
    path: &str,
) -> Result<Value, ProbeError> {
    let mut response = client
        .get(base.join(path)?)
        .header("Grpc-Metadata-macaroon", credential.clone())
        .send()
        .await?
        .error_for_status()?;
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if body.len() + chunk.len() > 256 * 1024 {
            return Err("LND response too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(serde_json::from_slice(&body)?)
}
async fn build_client(
    address: &str,
    connect_host: Option<&str>,
    cert: &Path,
    macaroon: &Path,
) -> Result<(Client, url::Url, HeaderValue), ProbeError> {
    let url = base_url(address)?;
    let cert = reqwest::Certificate::from_pem(&tokio::fs::read(cert).await?)?;
    let bytes = Zeroizing::new(tokio::fs::read(macaroon).await?);
    if bytes.is_empty() || bytes.len() > 64 * 1024 {
        return Err("invalid credential file".into());
    }
    let hex = Zeroizing::new(bytes.iter().map(|b| format!("{b:02x}")).collect::<String>());
    let mut credential = HeaderValue::from_str(&hex)?;
    credential.set_sensitive(true);
    let mut builder = Client::builder();
    if let Some(connect_host) = connect_host {
        let origin_host = url.host_str().ok_or("LND URL has no host")?;
        let address = tokio::net::lookup_host(connect_host)
            .await?
            .next()
            .ok_or("LND relay not found")?;
        builder = builder.resolve(origin_host, address);
    }
    let client = builder
        .tls_built_in_root_certs(false)
        .add_root_certificate(cert)
        .https_only(true)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(3))
        .build()?;
    Ok((client, url, credential))
}

async fn probe(
    address: &str,
    connect_host: Option<&str>,
    cert: &Path,
    macaroon: &Path,
) -> Result<Value, ProbeError> {
    let (client, url, credential) = build_client(address, connect_host, cert, macaroon).await?;
    let info = get(&client, &url, &credential, "/v1/getinfo").await?;
    // Balance failure must not misrepresent an otherwise responding LND as offline.
    let balance = get(&client, &url, &credential, "/v1/balance/channels")
        .await
        .map(|value| liquidity(&value))
        .unwrap_or_else(|_| unavailable_liquidity());
    summary(&info, balance)
}

pub fn mock_channels_report() -> Value {
    json!({
        "status": "online",
        "detail": "Canales simulados para pruebas y demostración de liquidez (modo mock)",
        "total_capacity_sats": "2000000",
        "total_local_balance_sats": "850000",
        "total_remote_balance_sats": "1150000",
        "num_active_channels": 2,
        "num_inactive_channels": 0,
        "is_mock": true,
        "inbound_sufficient": true,
        "channels": [
            {
                "channel_point": "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b:0",
                "remote_pubkey": "03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f",
                "capacity_sats": "1000000",
                "local_balance_sats": "250000",
                "remote_balance_sats": "750000",
                "active": true,
                "private": false
            },
            {
                "channel_point": "8f2195f3b7c89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda12a:1",
                "remote_pubkey": "02ad3973f3d303d65b64770195738b15e7bf2cf6078b3f8ebcd971167b405528b3",
                "capacity_sats": "1000000",
                "local_balance_sats": "600000",
                "remote_balance_sats": "400000",
                "active": true,
                "private": false
            }
        ]
    })
}

fn parse_channels_json(response: &Value) -> Result<Value, ProbeError> {
    let empty_vec = Vec::new();
    let channels_arr = response["channels"].as_array().unwrap_or(&empty_vec);
    let mut total_capacity: u128 = 0;
    let mut total_local: u128 = 0;
    let mut total_remote: u128 = 0;
    let mut active_count: u64 = 0;
    let mut inactive_count: u64 = 0;
    let mut parsed_channels = Vec::new();

    for c in channels_arr {
        let active = c["active"].as_bool().unwrap_or(false);
        if active {
            active_count += 1;
        } else {
            inactive_count += 1;
        }

        let cap_str = sats(&c["capacity"]).unwrap_or_else(|| "0".to_string());
        let loc_str = sats(&c["local_balance"]).unwrap_or_else(|| "0".to_string());
        let rem_str = sats(&c["remote_balance"]).unwrap_or_else(|| "0".to_string());

        let cap_val = cap_str.parse::<u128>().unwrap_or(0);
        let loc_val = loc_str.parse::<u128>().unwrap_or(0);
        let rem_val = rem_str.parse::<u128>().unwrap_or(0);

        total_capacity = total_capacity.saturating_add(cap_val);
        total_local = total_local.saturating_add(loc_val);
        total_remote = total_remote.saturating_add(rem_val);

        parsed_channels.push(json!({
            "channel_point": c["channel_point"].as_str().unwrap_or(""),
            "remote_pubkey": c["remote_pubkey"].as_str().unwrap_or(""),
            "capacity_sats": cap_str,
            "local_balance_sats": loc_str,
            "remote_balance_sats": rem_str,
            "active": active,
            "private": c["private"].as_bool().unwrap_or(false)
        }));
    }

    Ok(json!({
        "status": "online",
        "detail": "Canales LND consultados exitosamente (solo lectura)",
        "total_capacity_sats": total_capacity.to_string(),
        "total_local_balance_sats": total_local.to_string(),
        "total_remote_balance_sats": total_remote.to_string(),
        "num_active_channels": active_count,
        "num_inactive_channels": inactive_count,
        "is_mock": false,
        "inbound_sufficient": total_remote > 0,
        "channels": parsed_channels
    }))
}

async fn probe_channels(
    address: &str,
    connect_host: Option<&str>,
    cert: &Path,
    macaroon: &Path,
) -> Result<Value, ProbeError> {
    let (client, url, credential) = build_client(address, connect_host, cert, macaroon).await?;
    let channels_raw = get(&client, &url, &credential, "/v1/channels").await?;
    parse_channels_json(&channels_raw)
}

pub async fn channels(
    address: Option<&str>,
    connect_host: Option<&str>,
    cert: Option<&Path>,
    macaroon: Option<&Path>,
) -> Value {
    let (Some(address), Some(cert), Some(macaroon)) = (address, cert, macaroon) else {
        return json!({
            "status": "unconfigured",
            "detail": "Falta configurar la conexión de lectura a LND",
            "total_capacity_sats": "0",
            "total_local_balance_sats": "0",
            "total_remote_balance_sats": "0",
            "num_active_channels": 0,
            "num_inactive_channels": 0,
            "is_mock": false,
            "inbound_sufficient": false,
            "channels": []
        });
    };

    match tokio::time::timeout(
        Duration::from_secs(7),
        probe_channels(address, connect_host, cert, macaroon),
    )
    .await
    {
        Ok(Ok(value)) => value,
        _ => json!({
            "status": "offline",
            "detail": "No se pudo verificar canales LND: revisa conexión, certificado y permisos",
            "total_capacity_sats": "0",
            "total_local_balance_sats": "0",
            "total_remote_balance_sats": "0",
            "num_active_channels": 0,
            "num_inactive_channels": 0,
            "is_mock": false,
            "inbound_sufficient": false,
            "channels": []
        }),
    }
}

pub async fn status(
    address: Option<&str>,
    connect_host: Option<&str>,
    cert: Option<&Path>,
    macaroon: Option<&Path>,
) -> Value {
    let (Some(address), Some(cert), Some(macaroon)) = (address, cert, macaroon) else {
        return json!({"status":"unconfigured","detail":"Falta configurar la conexión de lectura a LND"});
    };
    match tokio::time::timeout(
        Duration::from_secs(7),
        probe(address, connect_host, cert, macaroon),
    )
    .await
    {
        Ok(Ok(value)) => value,
        _ => {
            json!({"status":"offline","detail":"No se pudo verificar LND: revisa conexión, certificado y permisos"})
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_https_origins_without_embedded_secrets() {
        for address in [
            "http://localhost:8080",
            "https://user:secret@localhost",
            "https://localhost/path",
            "https://localhost/?token=secret",
            "https://localhost/#secret",
        ] {
            assert!(base_url(address).is_err());
        }
        assert!(base_url("https://127.0.0.1:8080").is_ok());
    }
    #[test]
    fn sync_and_missing_data_are_honest_and_whitelisted() {
        let info = json!({"synced_to_chain":true,"synced_to_graph":false,"identity_pubkey":"private-node-metadata","uris":["private-address"]});
        let status = summary(&info, unavailable_liquidity()).unwrap();
        assert_eq!(status["status"], "warning");
        assert!(status["network"].is_null());
        assert!(status["num_active_channels"].is_null());
        assert!(!status.to_string().contains("private"));
        assert!(summary(&json!({}), unavailable_liquidity()).is_err());
    }
    #[test]
    fn balances_preserve_precision_and_do_not_invent_zero() {
        let value = liquidity(
            &json!({"local_balance":{"sat":"9007199254740993"},"remote_balance":{"sat":"0"}}),
        );
        assert_eq!(value["local_balance_sats"], "9007199254740993");
        assert_eq!(value["remote_balance_sats"], "0");
        for bad in [
            json!({}),
            json!({"local_balance":{"sat":"-1"},"remote_balance":{"sat":"2"}}),
        ] {
            assert_eq!(liquidity(&bad)["status"], "unavailable");
            assert!(liquidity(&bad)["local_balance_sats"].is_null());
        }
    }
    #[test]
    fn mock_channels_report_structure_and_balances() {
        let rep = mock_channels_report();
        assert_eq!(rep["status"], "online");
        assert_eq!(rep["is_mock"], true);
        assert_eq!(rep["total_capacity_sats"], "2000000");
        assert_eq!(rep["total_local_balance_sats"], "850000");
        assert_eq!(rep["total_remote_balance_sats"], "1150000");
        assert_eq!(rep["num_active_channels"], 2);
        assert_eq!(rep["inbound_sufficient"], true);
        let channels = rep["channels"].as_array().unwrap();
        assert_eq!(channels.len(), 2);
    }
    #[test]
    fn parse_channels_json_calculates_totals_and_handles_flags() {
        let raw = json!({
            "channels": [
                {
                    "active": true,
                    "remote_pubkey": "peer1",
                    "channel_point": "txid1:0",
                    "capacity": "500000",
                    "local_balance": "200000",
                    "remote_balance": "300000",
                    "private": false
                },
                {
                    "active": false,
                    "remote_pubkey": "peer2",
                    "channel_point": "txid2:1",
                    "capacity": "1000000",
                    "local_balance": "400000",
                    "remote_balance": "600000",
                    "private": true
                }
            ]
        });
        let rep = parse_channels_json(&raw).unwrap();
        assert_eq!(rep["status"], "online");
        assert_eq!(rep["total_capacity_sats"], "1500000");
        assert_eq!(rep["total_local_balance_sats"], "600000");
        assert_eq!(rep["total_remote_balance_sats"], "900000");
        assert_eq!(rep["num_active_channels"], 1);
        assert_eq!(rep["num_inactive_channels"], 1);
        assert_eq!(rep["inbound_sufficient"], true);
    }
}
