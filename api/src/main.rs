use mostro_community_api::{AppState, adapters::Integrations, router, store::Store};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !args.is_empty() {
        if args == ["import-identity"] {
            return mostro_community_api::identity::import_interactive()
                .map_err(|message| message.into());
        }
        if args == ["export-backup"] {
            let root = PathBuf::from(
                std::env::var("CONFIG_DIR").unwrap_or_else(|_| "./var/config".into()),
            );
            return mostro_community_api::backup::export_interactive(&root)
                .map_err(|message| message.into());
        }
        if args.len() == 2 && args[0] == "verify-backup" {
            return mostro_community_api::backup::verify_interactive(&PathBuf::from(&args[1]))
                .map_err(|message| message.into());
        }
        if args.len() == 3 && args[0] == "restore-backup" {
            return mostro_community_api::backup::restore_interactive(
                &PathBuf::from(&args[1]),
                &PathBuf::from(&args[2]),
            )
            .map_err(|message| message.into());
        }
        if args == ["lnd-tunnel"] {
            return mostro_community_api::tunnel::serve().await;
        }
        if args == ["check-mostro"] {
            let root = PathBuf::from(
                std::env::var("CONFIG_DIR").unwrap_or_else(|_| "./var/config".into()),
            );
            let report =
                mostro_community_api::preflight::report(&root, &Integrations::from_env()).await;
            println!("{}", serde_json::to_string_pretty(&report)?);
            return Ok(());
        }
        if args.len() == 2 && args[0] == "stage-mostro-settings" {
            let root = PathBuf::from(
                std::env::var("CONFIG_DIR").unwrap_or_else(|_| "./var/config".into()),
            );
            let staged = mostro_community_api::staging::stage(&root, &args[1])?;
            println!("{}", serde_json::to_string_pretty(&staged)?);
            return Ok(());
        }
        if args == ["connection-info"] {
            let root = PathBuf::from(
                std::env::var("CONFIG_DIR").unwrap_or_else(|_| "./var/config".into()),
            );
            let store = Store::open(root.clone())?;
            let info = mostro_community_api::connection::get_connection_info(&root, &store);
            println!("{}", serde_json::to_string_pretty(&info)?);
            return Ok(());
        }
        if args == ["check-lnd"] {
            let status = Integrations::from_env().lightning().await;
            println!("{}", serde_json::to_string_pretty(&status)?);
            return if matches!(status["status"].as_str(), Some("online" | "warning")) {
                Ok(())
            } else {
                Err("No se pudo verificar LND".into())
            };
        }
        if args == ["daemon-status"] {
            let root = PathBuf::from(
                std::env::var("CONFIG_DIR").unwrap_or_else(|_| "./var/config".into()),
            );
            let report =
                mostro_community_api::daemon::report(&root, &Integrations::from_env()).await;
            println!("{}", serde_json::to_string_pretty(&report)?);
            return Ok(());
        }
        if args.len() == 2 && args[0] == "activate-daemon" {
            let root = PathBuf::from(
                std::env::var("CONFIG_DIR").unwrap_or_else(|_| "./var/config".into()),
            );
            let activated = mostro_community_api::daemon::activate(&root, &args[1])?;
            println!("{}", serde_json::to_string_pretty(&activated)?);
            return Ok(());
        }
        if args == ["deactivate-daemon"] {
            let root = PathBuf::from(
                std::env::var("CONFIG_DIR").unwrap_or_else(|_| "./var/config".into()),
            );
            mostro_community_api::daemon::deactivate(&root)?;
            println!("Configuración activa de Mostro desactivada.");
            return Ok(());
        }
        return Err(
            "Uso: mostro-community-api [import-identity|export-backup|verify-backup <archivo>|restore-backup <archivo> <directorio-nuevo>|stage-mostro-settings <origen-gRPC-LND>|activate-daemon <origen-gRPC-LND>|deactivate-daemon|daemon-status|connection-info|check-lnd|check-mostro|lnd-tunnel]".into(),
        );
    }
    let bind = std::env::var("API_BIND").unwrap_or_else(|_| "127.0.0.1:3001".into());
    let root = PathBuf::from(std::env::var("CONFIG_DIR").unwrap_or_else(|_| "./var/config".into()));
    let state = AppState {
        store: Arc::new(Mutex::new(Store::open(root)?)),
        integrations: Integrations::from_env(),
    };
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    eprintln!("Community API listening on {bind}");
    let app = if let Some(directory) = std::env::var_os("STATIC_DIR") {
        use axum::http::{HeaderValue, header};
        use tower_http::{
            services::{ServeDir, ServeFile},
            set_header::SetResponseHeaderLayer,
        };
        let directory = PathBuf::from(directory);
        router(state)
            .fallback_service(ServeDir::new(&directory).not_found_service(ServeFile::new(directory.join("index.html"))))
            .layer(SetResponseHeaderLayer::if_not_present(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")))
            .layer(SetResponseHeaderLayer::if_not_present(header::CACHE_CONTROL, HeaderValue::from_static("no-store")))
            .layer(SetResponseHeaderLayer::if_not_present(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'")))
    } else {
        router(state)
    };
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
