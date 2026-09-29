# Mostro Community Manager v1.0.5

Actualización con sincronización reactiva de mercado, monitor de órdenes en vivo y supervisión del daemon.

- Sincroniza automáticamente los cambios de comisión de mercado con el daemon activo y publica de inmediato el evento kind 38385 en relays Nostr para clientes como Mostrix.
- Supervisa y reinicia el daemon Mostro ante actualizaciones de configuración en caliente desde el panel.
- Incorpora barra de herramientas con actualización automática configurable para órdenes públicas (3s, 5s, 10s, 30s) y alertas reactivas.
- Habilita la conectividad externa del servicio web a relays Nostr y previene alertas duplicadas de reconexión.
- Reporte honesto del estado de ejecución del daemon en el panel general.
