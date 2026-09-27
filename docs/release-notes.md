Importación local de identidad Nostr mediante terminal interactiva: entrada oculta de nsec, validación contra el npub esperado y almacenamiento con permisos privados. Rechaza claves inválidas y evita sustituir identidades existentes. La clave no se expone en la API ni en el panel.

Después de actualizar, consulta docs/identity.md en el repositorio. La clave se almacena sin cifrar con permisos 0600; el backup cifrado sigue pendiente. Esta versión no conecta LND ni inicia Mostro. Conserva los borradores guardados en preview.4.
