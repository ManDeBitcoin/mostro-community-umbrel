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
async fn probe(
    address: &str,
    connect_host: Option<&str>,
    cert: &Path,
    macaroon: &Path,
) -> Result<Value, ProbeError> {
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
        // Resolve the private-network relay while retaining the original TLS host name.
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
    let info = get(&client, &url, &credential, "/v1/getinfo").await?;
    // Balance failure must not misrepresent an otherwise responding LND as offline.
    let balance = get(&client, &url, &credential, "/v1/balance/channels")
        .await
        .map(|value| liquidity(&value))
        .unwrap_or_else(|_| unavailable_liquidity());
    summary(&info, balance)
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
}
