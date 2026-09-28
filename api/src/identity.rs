//! Local-only identity provisioning. Secret material is never exposed by the HTTP API.
use nostr::{FromBech32, Keys, PublicKey, SecretKey, ToBech32};
use std::{
    fs::{self, DirBuilder, File},
    io::{self, IsTerminal, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
};
use zeroize::Zeroizing;

fn validated_keys(nsec: &str, expected_npub: &str) -> Result<Keys, &'static str> {
    let secret = SecretKey::from_bech32(nsec).map_err(|_| "Clave nsec inválida")?;
    let expected = PublicKey::from_bech32(expected_npub).map_err(|_| "Clave npub inválida")?;
    let keys = Keys::new(secret);
    if keys.public_key() != expected {
        return Err("La clave privada no corresponde al npub indicado");
    }
    Ok(keys)
}

/// Uses an atomic no-clobber persist: an existing identity is never replaced.
/// Parent directories must be controlled by the operator (CONFIG_DIR in Umbrel).
pub fn import(root: &Path, nsec: &str, expected_npub: &str) -> Result<String, &'static str> {
    let keys = validated_keys(nsec, expected_npub)?;
    let canonical = Zeroizing::new(
        keys.secret_key()
            .to_bech32()
            .map_err(|_| "Clave inválida")?,
    );
    let npub = keys
        .public_key()
        .to_bech32()
        .map_err(|_| "Clave pública inválida")?;
    let directory = root.join("identity");
    match DirBuilder::new().mode(0o700).create(&directory) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err("No se pudo crear el directorio de identidad"),
    }
    let metadata = fs::symlink_metadata(&directory).map_err(|_| "Directorio no disponible")?;
    if !metadata.is_dir() || metadata.permissions().mode() & 0o077 != 0 {
        return Err("El directorio de identidad debe ser privado (0700) y no un enlace");
    }
    let mut temporary = tempfile::NamedTempFile::new_in(&directory)
        .map_err(|_| "No se pudo preparar el archivo privado")?;
    // A new temporary file is owned by this process. Reject directories owned by another user.
    if temporary
        .as_file()
        .metadata()
        .map_err(|_| "Archivo no disponible")?
        .uid()
        != metadata.uid()
    {
        return Err("El directorio de identidad pertenece a otro usuario");
    }
    temporary
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| "No se pudieron restringir los permisos")?;
    temporary
        .write_all(canonical.as_bytes())
        .map_err(|_| "No se pudo escribir la identidad")?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| "No se pudo sincronizar la identidad")?;
    temporary
        .persist_noclobber(directory.join("mostro.nsec"))
        .map_err(|_| "No se guardó: ya existe una identidad o no se puede escribir")?;

    let mut temp_pub = tempfile::NamedTempFile::new_in(&directory)
        .map_err(|_| "No se pudo preparar el archivo público")?;
    temp_pub
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| "No se pudieron establecer los permisos públicos")?;
    temp_pub
        .write_all(npub.as_bytes())
        .map_err(|_| "No se pudo escribir la identidad pública")?;
    temp_pub
        .as_file()
        .sync_all()
        .map_err(|_| "No se pudo sincronizar la identidad pública")?;
    let _ = temp_pub.persist_noclobber(directory.join("mostro.pub")); // Ignoramos error si ya existe

    File::open(&directory).and_then(|f| f.sync_all()).map_err(
        |_| "Identidad guardada; no se pudo sincronizar el directorio. No repetir la importación",
    )?;
    Ok(npub)
}

/// Atomically writes mostro.pub with mode 0600 without touching or requiring mostro.nsec.
pub fn persist_public_key(root: &Path, npub: &str) -> Result<(), &'static str> {
    PublicKey::from_bech32(npub).map_err(|_| "Clave pública inválida")?;
    let directory = root.join("identity");
    if !directory.is_dir() {
        return Err("Directorio de identidad no existe");
    }
    let metadata = fs::symlink_metadata(&directory).map_err(|_| "Directorio no disponible")?;
    if !metadata.is_dir() || metadata.permissions().mode() & 0o077 != 0 {
        return Err("El directorio de identidad debe ser privado (0700) y no un enlace");
    }
    let mut temp_pub = tempfile::NamedTempFile::new_in(&directory)
        .map_err(|_| "No se pudo preparar el archivo público")?;
    temp_pub
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| "No se pudieron establecer los permisos públicos")?;
    temp_pub
        .write_all(npub.as_bytes())
        .map_err(|_| "No se pudo escribir la identidad pública")?;
    temp_pub
        .as_file()
        .sync_all()
        .map_err(|_| "No se pudo sincronizar la identidad pública")?;
    temp_pub
        .persist_noclobber(directory.join("mostro.pub"))
        .map_err(|_| "Ya existe mostro.pub o no se puede escribir")?;
    File::open(&directory)
        .and_then(|f| f.sync_all())
        .map_err(|_| "Identidad pública guardada; no se pudo sincronizar el directorio")?;
    Ok(())
}

pub fn import_interactive() -> Result<(), &'static str> {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err("La importación requiere una terminal interactiva local (-it)");
    }
    let root = PathBuf::from(std::env::var("CONFIG_DIR").unwrap_or_else(|_| "./var/config".into()));
    if !root.is_dir() {
        return Err("CONFIG_DIR debe existir antes de importar");
    }
    print!("npub esperado: ");
    io::stdout().flush().map_err(|_| "Terminal no disponible")?;
    let mut expected = String::new();
    io::stdin()
        .read_line(&mut expected)
        .map_err(|_| "No se pudo leer el npub")?;
    let secret = Zeroizing::new(
        rpassword::prompt_password("Clave privada nsec (entrada oculta): ")
            .map_err(|_| "No se pudo leer la clave privada")?,
    );
    let npub = import(&root, secret.trim(), expected.trim())?;
    println!("Identidad guardada para {npub}. El mercado permanece detenido.");
    Ok(())
}

/// Read the private identity only for local operations that require it.
/// The returned buffer is zeroized on drop and must never be logged.
pub(crate) fn read_private(root: &Path) -> Result<Option<Zeroizing<String>>, &'static str> {
    let directory = root.join("identity");
    let metadata = match fs::symlink_metadata(&directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Directorio de identidad no disponible"),
    };
    if !metadata.is_dir() || metadata.permissions().mode() & 0o077 != 0 {
        return Err("Directorio de identidad no privado");
    }
    let file = directory.join("mostro.nsec");
    let metadata = match fs::symlink_metadata(&file) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Archivo de identidad no disponible"),
    };
    if !metadata.is_file() || metadata.permissions().mode() & 0o077 != 0 || metadata.len() > 256 {
        return Err("Archivo de identidad no privado");
    }
    let contents =
        Zeroizing::new(fs::read_to_string(&file).map_err(|_| "No se pudo leer la identidad")?);
    SecretKey::from_bech32(contents.trim()).map_err(|_| "Identidad inválida")?;
    Ok(Some(contents))
}

/// Safely load the full keypair only for local cryptographic operations (such as chat decryption).
/// Secret material is never exposed over HTTP or in logs.
pub fn load_identity_keys(root: &Path) -> Result<Option<Keys>, &'static str> {
    let Some(contents) = read_private(root)? else {
        return Ok(None);
    };
    let secret = SecretKey::from_bech32(contents.trim()).map_err(|_| "Identidad inválida")?;
    Ok(Some(Keys::new(secret)))
}

/// Read the public key sidecar safely without reading or exposing nsec.
/// Validates permissions (0600 on file, 0700 on dir), rejects symlinks,
/// and validates npub format before returning. Falls back to MOSTRO_PUBLIC_KEY env var if file is absent.
pub fn read_public_key(root: &Path) -> Result<Option<String>, &'static str> {
    let directory = root.join("identity");
    let dir_meta = match fs::symlink_metadata(&directory) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return read_public_key_from_env();
        }
        Err(_) => return Err("Directorio de identidad no disponible"),
    };
    if !dir_meta.is_dir() || dir_meta.permissions().mode() & 0o077 != 0 {
        return Err("Directorio de identidad no privado");
    }

    let file = directory.join("mostro.pub");
    let metadata = match fs::symlink_metadata(&file) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return read_public_key_from_env();
        }
        Err(_) => return Err("Archivo de identidad pública no disponible"),
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.permissions().mode() & 0o077 != 0
        || metadata.len() > 256
    {
        return Err("Archivo de identidad pública no privado o no válido");
    }
    let content = fs::read_to_string(&file).map_err(|_| "No se pudo leer la clave pública")?;
    let trimmed = content.trim();
    PublicKey::from_bech32(trimmed).map_err(|_| "Contenido de mostro.pub no es un npub válido")?;
    Ok(Some(trimmed.to_string()))
}

fn read_public_key_from_env() -> Result<Option<String>, &'static str> {
    if let Ok(env_pub) =
        std::env::var("MOSTRO_PUBLIC_KEY").or_else(|_| std::env::var("MOSTRO_PUBKEY"))
    {
        let trimmed = env_pub.trim();
        if !trimmed.is_empty() {
            if PublicKey::from_bech32(trimmed).is_ok() {
                return Ok(Some(trimmed.to_string()));
            } else {
                return Err("Variable de entorno MOSTRO_PUBLIC_KEY contiene un npub inválido");
            }
        }
    }
    Ok(None)
}

/// Read only the imported identity's public key object.
/// No secret bytes are returned, logged, or sent to the browser.
pub fn inspect_public_key(root: &Path) -> Result<Option<PublicKey>, &'static str> {
    let Some(contents) = read_private(root)? else {
        return Ok(None);
    };
    let secret = SecretKey::from_bech32(contents.trim()).map_err(|_| "Identidad inválida")?;
    Ok(Some(Keys::new(secret).public_key()))
}

/// Read only the imported identity's public key for local preflight.
/// No secret bytes are returned, logged, or sent to the browser.
pub fn inspect(root: &Path) -> Result<Option<String>, &'static str> {
    inspect_public_key(root)?
        .map(|pk| pk.to_bech32().map_err(|_| "Identidad inválida"))
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(byte: u8) -> (String, String) {
        // Synthetic test keys only; never use these identities outside tests.
        let keys = Keys::new(SecretKey::from_slice(&[byte; 32]).unwrap());
        (
            keys.secret_key().to_bech32().unwrap(),
            keys.public_key().to_bech32().unwrap(),
        )
    }
    #[test]
    fn validates_pair_and_checksum_before_writing() {
        let root = tempfile::tempdir().unwrap();
        let (secret, public) = fixture(1);
        let (_, different) = fixture(2);
        assert!(import(root.path(), &secret, &different).is_err());
        assert!(import(root.path(), "nsec1invalid", &public).is_err());
        assert!(import(root.path(), &public, &public).is_err());
        assert!(!root.path().join("identity").exists());
    }
    #[test]
    fn private_persistence_never_overwrites_identity() {
        let root = tempfile::tempdir().unwrap();
        let (secret, public) = fixture(1);
        assert_eq!(import(root.path(), &secret, &public).unwrap(), public);
        let directory = root.path().join("identity");
        let path = directory.join("mostro.nsec");
        assert_eq!(fs::metadata(&directory).unwrap().mode() & 0o777, 0o700);
        assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
        let (other_secret, other_public) = fixture(2);
        assert!(import(root.path(), &other_secret, &other_public).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), secret);
        assert_eq!(fs::read_dir(directory).unwrap().count(), 2);
    }
    #[test]
    fn rejects_symlink_and_world_readable_directory() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let (secret, public) = fixture(1);
        let path = root.path().join("identity");
        std::os::unix::fs::symlink(other.path(), &path).unwrap();
        assert!(import(root.path(), &secret, &public).is_err());
        assert_eq!(fs::read_dir(other.path()).unwrap().count(), 0);
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(import(root.path(), &secret, &public).is_err());
    }
    #[test]
    fn read_public_key_enforces_permissions_and_rejects_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let (secret, public) = fixture(1);
        import(root.path(), &secret, &public).unwrap();
        let pub_path = root.path().join("identity/mostro.pub");
        assert_eq!(fs::metadata(&pub_path).unwrap().mode() & 0o777, 0o600);
        assert_eq!(read_public_key(root.path()).unwrap(), Some(public.clone()));

        // Non-private permissions rejected
        fs::set_permissions(&pub_path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_public_key(root.path()).is_err());

        // Restore permissions
        fs::set_permissions(&pub_path, fs::Permissions::from_mode(0o600)).unwrap();

        // Symlink rejected
        let other_dir = tempfile::tempdir().unwrap();
        let dummy_pub = other_dir.path().join("dummy.pub");
        fs::write(&dummy_pub, &public).unwrap();
        fs::remove_file(&pub_path).unwrap();
        std::os::unix::fs::symlink(&dummy_pub, &pub_path).unwrap();
        assert!(read_public_key(root.path()).is_err());
    }
}
