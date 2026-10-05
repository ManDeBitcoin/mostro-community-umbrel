use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::{RwLock, broadcast};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Notification {
    pub id: String,
    pub level: String,
    pub category: String,
    pub title: String,
    pub message: String,
    pub timestamp: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl Notification {
    pub fn new(
        level: impl Into<String>,
        category: impl Into<String>,
        title: impl Into<String>,
        message: impl Into<String>,
        details: Option<serde_json::Value>,
    ) -> Self {
        let cat = category.into();
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let id = format!("{cat}-{timestamp}-{}", fastrand());
        Self {
            id,
            level: level.into(),
            category: cat,
            title: title.into(),
            message: message.into(),
            timestamp,
            details,
        }
    }

    pub fn relay_alert(
        title: &str,
        message: &str,
        level: &str,
        details: Option<serde_json::Value>,
    ) -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        Self {
            id: format!("relay-{timestamp}-{}", fastrand()),
            level: level.to_string(),
            category: "relay".to_string(),
            title: title.to_string(),
            message: message.to_string(),
            timestamp,
            details,
        }
    }

    /// The daemon announces a dispute by its own id (kind 38386). That event
    /// never names the order, so neither does this alert.
    pub fn dispute_alert(message: &str, details: Option<serde_json::Value>) -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        Self {
            id: format!("dispute-{timestamp}-{}", fastrand()),
            level: "warning".to_string(),
            category: "dispute".to_string(),
            title: "Disputa abierta".to_string(),
            message: message.to_string(),
            timestamp,
            details,
        }
    }

    pub fn backup_alert(
        title: &str,
        message: &str,
        success: bool,
        details: Option<serde_json::Value>,
    ) -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let level = if success { "info" } else { "error" };
        Self {
            id: format!("backup-{timestamp}-{}", fastrand()),
            level: level.to_string(),
            category: "backup".to_string(),
            title: title.to_string(),
            message: message.to_string(),
            timestamp,
            details,
        }
    }

    /// The community card could not be published on the relays. A warning:
    /// the market works the same without it.
    pub fn card_alert(title: &str, message: &str, details: Option<serde_json::Value>) -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        Self {
            id: format!("card-{timestamp}-{}", fastrand()),
            level: "warning".to_string(),
            category: "card".to_string(),
            title: title.to_string(),
            message: message.to_string(),
            timestamp,
            details,
        }
    }

    pub fn system_alert(
        title: &str,
        message: &str,
        level: &str,
        details: Option<serde_json::Value>,
    ) -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        Self {
            id: format!("system-{timestamp}-{}", fastrand()),
            level: level.to_string(),
            category: "system".to_string(),
            title: title.to_string(),
            message: message.to_string(),
            timestamp,
            details,
        }
    }
}

fn fastrand() -> u32 {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    ((now ^ (now >> 16)) & 0xFFFF_FFFF) as u32
}

pub struct NotificationHub {
    recent: Arc<RwLock<VecDeque<Notification>>>,
    capacity: usize,
    tx: broadcast::Sender<Notification>,
    webhook_url: Option<String>,
}

impl Default for NotificationHub {
    fn default() -> Self {
        Self::new(50)
    }
}

impl NotificationHub {
    pub fn new(capacity: usize) -> Self {
        Self::with_webhook(
            capacity,
            std::env::var("WEBHOOK_URL")
                .ok()
                .filter(|s| !s.trim().is_empty()),
        )
    }

    pub fn with_webhook(capacity: usize, webhook_url: Option<String>) -> Self {
        let (tx, _rx) = broadcast::channel(100.max(capacity));
        Self {
            recent: Arc::new(RwLock::new(VecDeque::with_capacity(capacity))),
            capacity,
            tx,
            webhook_url,
        }
    }

    pub async fn publish(&self, notification: Notification) {
        {
            let mut recent = self.recent.write().await;
            if recent.len() >= self.capacity {
                recent.pop_front();
            }
            recent.push_back(notification.clone());
        }

        // Broadcast to active SSE / live subscribers (ignore error if no active receivers)
        let _ = self.tx.send(notification.clone());

        // Internal webhook trigger if configured
        if let Some(ref url) = self.webhook_url {
            let url = url.clone();
            let payload = notification.clone();
            tokio::spawn(async move {
                if let Ok(client) = reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(3))
                    .build()
                {
                    let _ = client
                        .post(&url)
                        .header("content-type", "application/json")
                        .json(&payload)
                        .send()
                        .await;
                }
            });
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Notification> {
        self.tx.subscribe()
    }

    pub async fn get_recent(&self, limit: usize) -> Vec<Notification> {
        let recent = self.recent.read().await;
        recent.iter().rev().take(limit).cloned().collect()
    }

    pub async fn count(&self) -> usize {
        self.recent.read().await.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_notification_hub_publish_and_recent() {
        let hub = NotificationHub::new(5);
        let mut rx = hub.subscribe();

        hub.publish(Notification::new(
            "info",
            "system",
            "Inicio",
            "Servidor iniciado",
            None,
        ))
        .await;

        let received = rx.recv().await.unwrap();
        assert_eq!(received.title, "Inicio");
        assert_eq!(received.category, "system");

        let recent = hub.get_recent(10).await;
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].title, "Inicio");
    }

    #[tokio::test]
    async fn test_notification_capacity_ring_buffer() {
        let hub = NotificationHub::new(3);

        for i in 1..=5 {
            hub.publish(Notification::new(
                "info",
                "test",
                format!("Notif {i}"),
                format!("Mensaje {i}"),
                None,
            ))
            .await;
        }

        let recent = hub.get_recent(10).await;
        assert_eq!(recent.len(), 3);
        // Ordered newest first
        assert_eq!(recent[0].title, "Notif 5");
        assert_eq!(recent[1].title, "Notif 4");
        assert_eq!(recent[2].title, "Notif 3");
    }

    #[test]
    fn test_helper_constructors() {
        let relay_notif =
            Notification::relay_alert("Relay Down", "ws://relay falló", "error", None);
        assert_eq!(relay_notif.category, "relay");
        assert_eq!(relay_notif.level, "error");

        let dispute_notif =
            Notification::dispute_alert("El nodo anuncia la disputa uuid-123", None);
        assert_eq!(dispute_notif.title, "Disputa abierta");
        assert_eq!(dispute_notif.category, "dispute");
        assert_eq!(dispute_notif.level, "warning");

        let backup_notif = Notification::backup_alert("Backup OK", "Guardado", true, None);
        assert_eq!(backup_notif.category, "backup");
        assert_eq!(backup_notif.level, "info");
    }
}
