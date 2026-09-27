//! A fixed-destination TCP relay between the private Manager network and Umbrel's LND network.
//! TLS passes through unchanged; the tunnel never sees credentials in application code.
use std::sync::Arc;
use std::{net::SocketAddr, time::Duration};
use tokio::{
    io::copy_bidirectional,
    net::{TcpListener, TcpStream},
    sync::Semaphore,
};

async fn forward(mut inbound: TcpStream, target: SocketAddr) {
    let Ok(Ok(mut outbound)) =
        tokio::time::timeout(Duration::from_secs(3), TcpStream::connect(target)).await
    else {
        return;
    };
    let _ = tokio::time::timeout(
        Duration::from_secs(30),
        copy_bidirectional(&mut inbound, &mut outbound),
    )
    .await;
}

pub async fn serve() -> Result<(), Box<dyn std::error::Error>> {
    let target: SocketAddr = std::env::var("LND_TUNNEL_TARGET")?.parse()?;
    if target.ip().is_unspecified() || target.ip().is_loopback() {
        return Err("LND_TUNNEL_TARGET must be a fixed non-loopback IP address".into());
    }
    let bind: SocketAddr = std::env::var("LND_TUNNEL_BIND")
        .unwrap_or_else(|_| "0.0.0.0:8080".into())
        .parse()?;
    let listener = TcpListener::bind(bind).await?;
    let slots = Arc::new(Semaphore::new(32));
    loop {
        let (inbound, _) = listener.accept().await?;
        let Ok(permit) = Arc::clone(&slots).try_acquire_owned() else {
            continue;
        };
        tokio::spawn(async move {
            let _permit = permit;
            forward(inbound, target).await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    #[tokio::test]
    async fn forwards_bytes_both_directions_to_fixed_target() {
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_addr = target.local_addr().unwrap();
        let relay = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let relay_addr = relay.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (stream, _) = relay.accept().await.unwrap();
            forward(stream, target_addr).await;
        });
        let peer = tokio::spawn(async move {
            let (mut stream, _) = target.accept().await.unwrap();
            let mut request = [0; 4];
            stream.read_exact(&mut request).await.unwrap();
            assert_eq!(&request, b"ping");
            stream.write_all(b"pong").await.unwrap();
        });
        let mut client = TcpStream::connect(relay_addr).await.unwrap();
        client.write_all(b"ping").await.unwrap();
        let mut response = [0; 4];
        client.read_exact(&mut response).await.unwrap();
        assert_eq!(&response, b"pong");
        drop(client);
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
        peer.await.unwrap();
    }
}
