//! Local, pre-market backup. Ciphertext is never returned by the HTTP API.
use age::{
    Decryptor, Encryptor,
    secrecy::{ExposeSecret, SecretString},
};
use nostr::{FromBech32, Keys, SecretKey, ToBech32};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, DirBuilder, File},
    io::{self, IsTerminal, Read, Write},
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;

use crate::{identity, store::Document};

const MAX_PLAINTEXT: u64 = 1024 * 1024;
const MAX_CIPHERTEXT: u64 = 2 * 1024 * 1024;

#[derive(Serialize)]
struct BackupWrite<'a> {
    format: &'static str,
    npub: &'a str,
    nsec: &'a str,
    document: &'a Document,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BackupRead<'a> {
    format: String,
    npub: &'a str,
    nsec: &'a str,
    document: Document,
}

pub struct Summary {
    pub npub: String,
    pub revision: u64,
    pub path: PathBuf,
}

fn read_document(root: &Path) -> Result<Document, &'static str> {
    let path = root.join("community.json");
    let metadata = fs::symlink_metadata(&path).map_err(|_| "Falta el borrador guardado")?;
    if !metadata.is_file() || metadata.len() > MAX_PLAINTEXT {
        return Err("El borrador no es un archivo regular o excede el límite de backup");
    }
    let bytes = fs::read(path).map_err(|_| "No se pudo leer el borrador")?;
    let document: Document =
        serde_json::from_slice(&bytes).map_err(|_| "Borrador guardado inválido")?;
    let config = document
        .config
        .as_ref()
        .ok_or("Borrador sin configuración")?;
    config.validate().map_err(|_| "Borrador inválido")?;
    Ok(document)
}

fn private_backup_dir(root: &Path) -> Result<PathBuf, &'static str> {
    let path = root.join("backups");
    match DirBuilder::new().mode(0o700).create(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err("No se pudo crear el directorio de backups"),
    }
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| "Directorio de backups no disponible")?;
    if !metadata.is_dir() || metadata.permissions().mode() & 0o077 != 0 {
        return Err("El directorio de backups debe ser privado (0700)");
    }
    Ok(path)
}

fn decode_backup(path: &Path, passphrase: SecretString) -> Result<(String, u64), &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "Backup no disponible")?;
    if !metadata.is_file() || metadata.len() > MAX_CIPHERTEXT {
        return Err("Archivo de backup inválido o demasiado grande");
    }
    let file = File::open(path).map_err(|_| "No se pudo abrir el backup")?;
    let decryptor = Decryptor::new(file).map_err(|_| "Backup age inválido")?;
    let identity = age::scrypt::Identity::new(passphrase);
    let mut reader = decryptor
        .decrypt(std::iter::once(&identity as &dyn age::Identity))
        .map_err(|_| "No se pudo descifrar el backup")?;
    let mut plaintext = Zeroizing::new(Vec::new());
    reader
        .by_ref()
        .take(MAX_PLAINTEXT + 1)
        .read_to_end(&mut plaintext)
        .map_err(|_| "No se pudo leer el backup descifrado")?;
    if plaintext.len() as u64 > MAX_PLAINTEXT {
        return Err("Contenido de backup demasiado grande");
    }
    let envelope: BackupRead<'_> =
        serde_json::from_slice(&plaintext).map_err(|_| "Contenido de backup inválido")?;
    if envelope.format != "mostro-community-pre-market-v1" {
        return Err("Formato de backup no compatible");
    }
    let secret =
        SecretKey::from_bech32(envelope.nsec).map_err(|_| "Identidad de backup inválida")?;
    let npub = Keys::new(secret)
        .public_key()
        .to_bech32()
        .map_err(|_| "Identidad de backup inválida")?;
    if npub != envelope.npub {
        return Err("La identidad del backup no corresponde al npub");
    }
    let config = envelope
        .document
        .config
        .as_ref()
        .ok_or("Backup sin borrador")?;
    config
        .validate()
        .map_err(|_| "Borrador de backup inválido")?;
    Ok((npub, envelope.document.revision))
}

pub fn export(root: &Path, passphrase: SecretString) -> Result<Summary, &'static str> {
    if passphrase.expose_secret().len() < 16 {
        return Err("La frase de cifrado debe tener al menos 16 caracteres");
    }
    let document = read_document(root)?;
    let nsec = identity::read_private(root)?.ok_or("Falta la identidad importada")?;
    let secret = SecretKey::from_bech32(nsec.trim()).map_err(|_| "Identidad inválida")?;
    let npub = Keys::new(secret)
        .public_key()
        .to_bech32()
        .map_err(|_| "Identidad inválida")?;
    let archive = BackupWrite {
        format: "mostro-community-pre-market-v1",
        npub: &npub,
        nsec: nsec.trim(),
        document: &document,
    };
    let plaintext =
        Zeroizing::new(serde_json::to_vec(&archive).map_err(|_| "No se pudo preparar el backup")?);
    if plaintext.len() as u64 > MAX_PLAINTEXT {
        return Err("Contenido de backup demasiado grande");
    }
    let directory = private_backup_dir(root)?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(&directory).map_err(|_| "No se pudo crear el backup")?;
    temporary
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| "No se pudieron restringir los permisos del backup")?;
    let mut writer = Encryptor::with_user_passphrase(passphrase.clone())
        .wrap_output(temporary.as_file_mut())
        .map_err(|_| "No se pudo iniciar el cifrado")?;
    writer
        .write_all(&plaintext)
        .map_err(|_| "No se pudo cifrar el backup")?;
    writer
        .finish()
        .map_err(|_| "No se pudo cerrar el cifrado")?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| "No se pudo sincronizar el backup")?;
    let (verified_npub, verified_revision) = decode_backup(temporary.path(), passphrase)?;
    if verified_npub != npub || verified_revision != document.revision {
        return Err("El backup cifrado no superó la verificación");
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Reloj del sistema inválido")?
        .as_secs();
    let path = directory.join(format!(
        "pre-market-rev{}-{timestamp}.age",
        document.revision
    ));
    temporary
        .persist_noclobber(&path)
        .map_err(|_| "Ya existe un backup con ese nombre")?;
    File::open(&directory)
        .and_then(|file| file.sync_all())
        .map_err(|_| "Backup guardado; no se pudo sincronizar el directorio")?;
    Ok(Summary {
        npub,
        revision: document.revision,
        path,
    })
}

pub fn verify(path: &Path, passphrase: SecretString) -> Result<Summary, &'static str> {
    let (npub, revision) = decode_backup(path, passphrase)?;
    Ok(Summary {
        npub,
        revision,
        path: path.to_path_buf(),
    })
}

pub fn export_interactive(root: &Path) -> Result<(), &'static str> {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err("El backup requiere una terminal interactiva local (-it)");
    }
    let mut first = Zeroizing::new(
        rpassword::prompt_password("Frase de cifrado (entrada oculta): ")
            .map_err(|_| "No se pudo leer la frase")?,
    );
    let second = Zeroizing::new(
        rpassword::prompt_password("Repite la frase: ").map_err(|_| "No se pudo leer la frase")?,
    );
    if first.len() < 16 || first != second {
        return Err("Las frases deben coincidir y tener al menos 16 caracteres");
    }
    let summary = export(root, SecretString::from(std::mem::take(&mut *first)))?;
    println!(
        "Backup cifrado y verificado: {} (revisión {}, {}). Copia el archivo fuera del servidor.",
        summary.path.display(),
        summary.revision,
        summary.npub
    );
    Ok(())
}

pub fn verify_interactive(path: &Path) -> Result<(), &'static str> {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err("La verificación requiere una terminal interactiva local (-it)");
    }
    let passphrase = rpassword::prompt_password("Frase del backup (entrada oculta): ")
        .map_err(|_| "No se pudo leer la frase")?;
    let summary = verify(path, SecretString::from(passphrase))?;
    println!(
        "Backup válido: revisión {}, {}. No se restauraron archivos.",
        summary.revision, summary.npub
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::Configuration, store::Store};
    use nostr::ToBech32;

    #[test]
    fn encrypted_backup_round_trip_and_wrong_password() {
        let root = tempfile::tempdir().unwrap();
        let mut store = Store::open(root.path().to_path_buf()).unwrap();
        let config: Configuration =
            serde_json::from_str(include_str!("../tests/fixtures/community.json")).unwrap();
        store.save(config).unwrap();
        let keys = Keys::new(SecretKey::from_slice(&[7; 32]).unwrap());
        let nsec = keys.secret_key().to_bech32().unwrap();
        let npub = keys.public_key().to_bech32().unwrap();
        identity::import(root.path(), &nsec, &npub).unwrap();
        let exported = export(
            root.path(),
            SecretString::from("test-passphrase-not-for-use".to_owned()),
        )
        .unwrap();
        assert_eq!(exported.npub, npub);
        assert_eq!(exported.revision, 1);
        let ciphertext = fs::read(&exported.path).unwrap();
        assert!(
            !ciphertext
                .windows(nsec.len())
                .any(|part| part == nsec.as_bytes())
        );
        assert_eq!(
            fs::metadata(&exported.path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(root.path().join("backups"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert!(
            verify(
                &exported.path,
                SecretString::from("wrong-password".to_owned())
            )
            .is_err()
        );
        let verified = verify(
            &exported.path,
            SecretString::from("test-passphrase-not-for-use".to_owned()),
        )
        .unwrap();
        assert_eq!(verified.npub, npub);
        assert_eq!(verified.revision, 1);
        let mut tampered = ciphertext;
        let last = tampered.last_mut().unwrap();
        *last ^= 1;
        let tampered_path = root.path().join("tampered.age");
        fs::write(&tampered_path, tampered).unwrap();
        assert!(
            verify(
                &tampered_path,
                SecretString::from("test-passphrase-not-for-use".to_owned())
            )
            .is_err()
        );
    }
}
