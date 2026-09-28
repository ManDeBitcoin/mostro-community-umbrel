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
    pub lnd_connect_host: Option<String>,
    pub lnd_cert: Option<PathBuf>,
    pub lnd_macaroon: Option<PathBuf>,
}
impl Integrations {
    pub fn from_env() -> Self {
        Self {
            mostro_rpc: std::env::var("MOSTRO_RPC_URL").ok(),
            lnd_rest: std::env::var("LND_REST_URL").ok(),
            lnd_connect_host: std::env::var("LND_CONNECT_HOST").ok(),
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
        crate::lnd::status(
            self.lnd_rest.as_deref(),
            self.lnd_connect_host.as_deref(),
            self.lnd_cert.as_deref(),
            self.lnd_macaroon.as_deref(),
        )
        .await
    }
    pub async fn channels(&self, force_mock: bool) -> Value {
        if force_mock
            || std::env::var("MOCK_LND_CHANNELS").as_deref() == Ok("1")
            || std::env::var("MOCK_LND_CHANNELS").as_deref() == Ok("true")
        {
            return crate::lnd::mock_channels_report();
        }
        crate::lnd::channels(
            self.lnd_rest.as_deref(),
            self.lnd_connect_host.as_deref(),
            self.lnd_cert.as_deref(),
            self.lnd_macaroon.as_deref(),
        )
        .await
    }
}
