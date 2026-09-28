use crate::config::Configuration;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
};
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Document {
    pub revision: u64,
    pub config: Option<Configuration>,
}
pub struct Store {
    pub root: PathBuf,
    pub document: Document,
}
impl Store {
    pub fn open(root: PathBuf) -> std::io::Result<Self> {
        fs::create_dir_all(&root)?;
        let document = match fs::read(root.join("community.json")) {
            Ok(bytes) => {
                serde_json::from_slice::<Document>(&bytes).map_err(std::io::Error::other)?
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Document::default(),
            Err(e) => return Err(e),
        };
        if let Some(config) = &document.config {
            config.validate().map_err(std::io::Error::other)?;
        }
        Ok(Self { root, document })
    }
    pub fn save(&mut self, config: Configuration) -> std::io::Result<Document> {
        config.validate().map_err(std::io::Error::other)?;
        let next = Document {
            revision: self
                .document
                .revision
                .checked_add(1)
                .ok_or_else(|| std::io::Error::other("revision overflow"))?,
            config: Some(config),
        };
        // One process owns this store. Lock held by API until replacement and directory fsync finish.
        let temp = self.root.join(".community.tmp");
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(&serde_json::to_vec_pretty(&next)?)?;
        file.sync_all()?;
        let target = self.root.join("community.json");
        if target.exists() {
            fs::copy(&target, self.root.join("community.previous.json"))?;
        }
        fs::rename(&temp, &target)?;
        // Update in-memory revision even if directory fsync fails after successful rename.
        self.document = next.clone();
        fs::File::open(&self.root)?.sync_all()?;
        Ok(next)
    }
    pub fn root(&self) -> &std::path::Path {
        &self.root
    }
}
