# Publicación de versiones de Umbrel

El manifiesto de la tienda solo debe anunciar una versión cuya imagen multi-arquitectura ya esté publicada y sea descargable sin credenciales. La `1.0.4` mostró por qué: Umbrel sincronizó el manifiesto antes de que terminara la compilación y respondió `manifest unknown` al intentar actualizar.

## Regla de publicación

1. Preparar los cambios y escribir `docs/release-notes.md` con el encabezado `# Mostro Community Manager vX.Y.Z`. **No cambiar todavía** la versión de `umbrel-app.yml`, las cuatro imágenes de `docker-compose.yml` ni la versión anunciada en el README.
2. Ejecutar `./scripts/check.sh` y `python3 -m unittest discover -s scripts/tests`. Crear y publicar el tag anotado `vX.Y.Z` en el commit probado.
3. `publish.yml` rechaza un tag si el manifiesto ya anuncia la nueva versión. Construye y prueba amd64 y arm64, publica la imagen, verifica acceso anónimo a ambas arquitecturas y crea la release.
4. Solo después de esas comprobaciones, el mismo workflow actualiza en `main` el manifiesto, las cuatro referencias de Compose, las notas de Umbrel y el README. Si la publicación o la promoción fallan, la tienda conserva la versión anterior.
5. `store-guard.yml` comprueba que cualquier versión anunciada en la tienda tenga una imagen pública para ambas arquitecturas. `main` exige ese check antes de aceptar un commit; la promoción automática lo ejecuta en una rama temporal antes de avanzar `main`.

No crear ni subir manualmente un commit que cambie la versión del manifiesto antes de que GHCR tenga la imagen. No mover un tag existente para apuntarlo a otro commit; ante un fallo transitorio se puede reintentar el workflow del mismo tag. Para comprobar una versión desde fuera de GitHub, ejecutar `python3 scripts/verify-public-image.py X.Y.Z`.

Umbrel sincroniza la tienda y ofrece la actualización, pero no la aplica automáticamente a las instalaciones. El operador debe elegir **Actualizar** en la interfaz de Umbrel cuando la publicación haya terminado.
