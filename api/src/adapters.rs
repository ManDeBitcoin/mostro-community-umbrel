use serde_json::{Value, json};
use std::{path::PathBuf, time::Duration};
use tonic::transport::Endpoint;
pub mod rpc {
    tonic::include_proto!("mostro.admin.v1");
}

#[derive(Clone, Default)]
pub struct Integrations {
    pub mostro_rpc: Option<String>,
    pub lnd_rest: Option<String>,
    pub lnd_cert: Option<PathBuf>,
    pub lnd_macaroon: Option<PathBuf>,
}
impl Integrations {
    pub fn from_env() -> Self {
        Self {
            mostro_rpc: std::env::var("MOSTRO_RPC_URL").ok(),
            lnd_rest: std::env::var("LND_REST_URL").ok(),
            lnd_cert: std::env::var_os("LND_TLS_CERT").map(Into::into),
            lnd_macaroon: std::env::var_os("LND_READONLY_MACAROON").map(Into::into),
        }
    }
    pub async fn mostro(&self) -> Value {
        let Some(address) = &self.mostro_rpc else {
            return json!({"status":"unconfigured","detail":"Mostro no está conectado"});
        };
        async fn probe(address: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
            let endpoint = Endpoint::from_shared(address.to_owned())?
                .connect_timeout(Duration::from_secs(3))
                .timeout(Duration::from_secs(3));
            let mut client =
                rpc::admin_service_client::AdminServiceClient::new(endpoint.connect().await?);
            Ok(client
                .get_version(rpc::GetVersionRequest {})
                .await?
                .into_inner()
                .version)
        }
        match tokio::time::timeout(Duration::from_secs(5), probe(address)).await {
            Ok(Ok(version)) => {
                json!({"status":"online","detail":"RPC responde; no verifica el mercado ni sus relays", "version":version})
            }
            _ => json!({"status":"offline","detail":"No se pudo consultar Mostro RPC"}),
        }
    }
    pub async fn lightning(&self) -> Value {
        let (Some(address), Some(cert), Some(macaroon)) =
            (&self.lnd_rest, &self.lnd_cert, &self.lnd_macaroon)
        else {
            return json!({"status":"unconfigured","detail":"Falta configurar la conexión de lectura a LND"});
        };
        async fn probe(
            address: &str,
            cert: &PathBuf,
            macaroon: &PathBuf,
        ) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
            let url = url::Url::parse(address)?;
            if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
                return Err("LND requires HTTPS".into());
            }
            let cert = reqwest::Certificate::from_pem(&tokio::fs::read(cert).await?)?;
            let bytes = tokio::fs::read(macaroon).await?;
            let credential: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            let client = reqwest::Client::builder()
                .add_root_certificate(cert)
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(3))
                .build()?;
            let response: Value = client
                .get(url.join("/v1/getinfo")?)
                .header("Grpc-Metadata-macaroon", credential)
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            let synced = response["synced_to_chain"]
                .as_bool()
                .ok_or("missing sync state")?;
            // Whitelist: upstream responses and credentials never pass straight through to UI.
            Ok(json!({"status":if synced {"online"} else {"warning"},
                "detail":if synced {"LND sincronizado"} else {"LND está sincronizando"},
                "alias":response["alias"].as_str(), "synced_to_chain":synced,
                "num_active_channels":response["num_active_channels"].as_u64(),
                "block_height":response["block_height"].as_u64()}))
        }
        match tokio::time::timeout(Duration::from_secs(5), probe(address, cert, macaroon)).await {
            Ok(Ok(value)) => value,
            _ => {
                json!({"status":"offline","detail":"No se pudo verificar LND: revisa conexión, certificado y permisos"})
            }
        }
    }
}
