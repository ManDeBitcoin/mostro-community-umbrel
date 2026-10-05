# Identidad visual y dirección de interfaz

Esta propuesta le da identidad propia a Mostro Community Manager y fija una base visual compartida para una futura aplicación de trading. Toma como referencia el tono abierto, directo y enérgico de [mostro.network](https://mostro.network/) y las formas angulares y el verde de su [logo](https://github.com/MostroP2P/mostro/blob/main/static/logo.png). El símbolo generado reinterpreta esos rasgos como una M conectada a tres puntos: la comunidad que administra el panel.

## Revisión del panel actual

El panel ya tiene una dirección reconocible: fondo verde carbón, tarjetas discretas, estados de servicio, acento menta y avisos ámbar. Esa combinación encaja con herramientas de operación y con la identidad de Mostro. El producto también creció más allá del primer dashboard: ahora reúne órdenes públicas, mediación, simulación, lectura de liquidez, configuración y controles del daemon.

## Organización del panel

Desde la versión 1.0.12 el panel se ordena por lo que el operador quiere hacer, no por el orden en que se construyó cada módulo.

| Grupo | Páginas | Pregunta que responde |
| --- | --- | --- |
| Inicio | Resumen | ¿Está abierto mi mercado y qué requiere mi atención? |
| Mercado | Órdenes, Disputas | ¿Qué está pasando en mi comunidad? |
| Nodo | Nodo Mostro, Lightning, Conexión de apps | ¿Funciona lo que sostiene el mercado y cómo se conecta una app? |
| Ajustes | Configuración, Respaldos, Alertas | ¿Qué reglas tiene mi comunidad y cómo la protejo? |
| Herramientas | Simulador | ¿Qué pasaría en una operación con estas reglas? |

Reglas que siguen todas las páginas:

- **Una página, un asunto.** Cada una empieza con su grupo, su título y una frase que dice para qué sirve.
- **Cada página tiene dirección propia** (`#/ordenes`, `#/nodo`…). Recargar no cambia de sitio y el retroceso del navegador funciona.
- **El resumen no repite: enlaza.** Lo que requiere atención aparece una vez, con un botón a la página donde se resuelve. El servidor da a cada aviso un código estable y el panel decide con él a qué página lleva; no interpreta el texto.
- **Durante la puesta en marcha manda la lista de pasos.** El titular y su botón nombran siempre el siguiente paso pendiente.
- **El panel no inventa.** Si no puede leer un dato lo dice, y no muestra un cero ni un «no hay» en su lugar: «consultando» y «no se pudo leer» son estados distintos de «vacío». «Mercado abierto» exige dos cosas: que Mostro esté activado aquí con su daemon en ejecución, y que el nodo se haya anunciado en los relays en los últimos minutos, que es lo que una app puede comprobar.
- **Un término por cosa.** «Garantía» es el bono antiabuso; «depósito» son los sats que retiene el vendedor; «publicada» es una orden que el nodo anuncia como oferta, aunque pueda estar ya tomada. El panel está en español; el idioma de la comunidad es un dato de la comunidad, no de la interfaz.
- **Un formato por dato.** Fechas con `4 oct 2026, 17:08` y reloj de 24 horas; edades recientes como `hace 12 min`; sats agrupados con espacio fino; porcentajes con coma. Los textos que redacta el servidor siguen las mismas reglas, salvo las descripciones del simulador y los resúmenes de mensajes de protocolo, que aún escriben los sats sin agrupar.
- **Los colores significan lo mismo en todas partes** y van siempre con texto: verde para lo confirmado, ámbar para lo que hay que revisar, rojo para lo que retiene fondos o falla, azul para lo informativo.
- **Sirve en un teléfono.** Por debajo de 860 px el menú es un cajón y ninguna página se desborda a lo ancho; las tablas se desplazan dentro de su panel.

La pantalla de operador prioriza densidad. En la app final conviene mantener el sistema visual y cambiar la jerarquía: más tamaño de texto, controles táctiles amplios y menos datos simultáneos. Las métricas del nodo y las tareas administrativas pertenecen al panel del operador; las acciones de compra y venta deben dominar el cliente.

## Marca y archivos

- `assets/logo.png`: logotipo horizontal principal seleccionado, con texto legible para fondos oscuros. También aparece en la galería de Umbrel y en el README.
- `assets/logo-ambient.png`: variante horizontal transparente y de bajo contraste, reservada para fondos decorativos amplios; no usarla como logotipo principal ni sobre fondos claros.
- `assets/icon.png`: icono cuadrado seleccionado para Umbrel y catálogos.
- `web/public/brand-mark.png`: copia exacta del icono servida por Vite, usada en la navegación web y como favicon.

El [registro de prompts](brand-imagegen-prompts.md) documenta la generación. Los tres PNG anteriores son las variantes que el usuario eligió después; se conservan sin retoques.

La M conserva la energía de los picos de Mostro y tres puntos expresan la idea de nodos conectados. «COMMUNITY MANAGER» identifica claramente el panel del operador. Mantener despejada alrededor del símbolo una zona igual a un cuarto de su ancho; en tamaños pequeños usar solo el icono.

## Sistema visual compartido

| Uso | Color |
| --- | --- |
| Fondo principal | `#0C1110` |
| Superficie | `#121918` |
| Superficie elevada | `#151D1B` |
| Borde | `#242E2A` |
| Texto principal | `#E8EEEB` |
| Texto secundario | `#8B9992` |
| Verde de marca | `#64D985` |
| Acción y estado positivo | `#76DFA0` |
| Atención y espera | `#E4BA6D` |
| Error o acción bloqueada | `#ED887D` |

Usar tipografía de sistema sin dependencias externas para que el cliente funcione sin conexión. Reservar una fuente monoespaciada para importes, identificadores y claves. En el cliente, el texto base debe ser de 15–16 px y los controles táctiles de al menos 44 px; reservar los rótulos pequeños para metadatos secundarios.

Los colores de estado deben significar lo mismo en todas las pantallas y acompañarse de texto o un icono. Verde indica una acción disponible o confirmada; ámbar indica espera, revisión o advertencia; rojo indica fallo o una acción que requiere detenerse. Un número de canales o un nodo conectado no debe presentarse como garantía de que una operación puede completarse.

## Aplicación para el usuario final

Diseñar primero para móvil y mantener el flujo legible en escritorio. La navegación principal puede usar cuatro destinos: **Mercado**, **Mis órdenes**, **Actividad** y **Perfil**. El operador conserva su navegación actual; el cliente no debe copiar sus métricas ni herramientas de administración.

1. **Mercado:** lista de ofertas con compra/venta expresada en texto, moneda fiat, importe, precio o prima, métodos de pago y nodo elegido. Filtros accesibles para moneda, importe, método y nodo. Diferenciar compra y venta además del color.
2. **Publicar oferta:** elección de compra o venta, importe en sats y fiat, límites, precio/prima y medio de pago. Antes de confirmar, mostrar comisiones, bond y qué fondos quedarán bloqueados durante la operación.
3. **Detalle de orden:** contraparte y nodo, importe acordado, estado actual y una línea de tiempo corta. Mantener el chat cifrado junto a las instrucciones de pago y dejar explícito qué acción corresponde a cada persona.
4. **Confirmaciones:** antes de liberar sats, mostrar una confirmación específica que recuerde comprobar la recepción del pago fiat. Para cancelar, reclamar o abrir una disputa, explicar el efecto antes de pedir confirmación.
5. **Perfil y seguridad:** acceso a la frase de recuperación con avisos contextuales, selección de nodo/relays, preferencias de moneda y privacidad. Evitar solicitar correo, teléfono u otros datos que el protocolo no necesita.

## Estados que deben diseñarse

Preparar pantallas para lista vacía, carga, datos atrasados, relay desconectado, oferta vencida, pago pendiente, disputa abierta y error recuperable. Mostrar la hora de última actualización cuando el libro de órdenes no esté en vivo; etiquetar claramente simulaciones y datos de diagnóstico; no inventar disponibilidad ni liquidez. Si la identidad no tiene respaldo, avisar antes de iniciar una operación.

## Criterios para futuras pantallas

- Mantener el fondo oscuro, las superficies verdes carbón y el acento menta como continuidad con el panel y la marca.
- Usar ámbar para espera o cautela y rojo para fallo; reservar el verde brillante para acciones y estados confirmados.
- Dar prioridad al importe, la moneda y el próximo paso. Dejar datos técnicos de Nostr y Lightning en detalles secundarios.
- Escribir el estado de la operación en lenguaje directo y mostrar siempre quién debe actuar.
- Presentar tarifas, bonds y fondos bloqueados antes de la confirmación final.
- Diseñar primero el ancho de teléfono; las acciones principales deben quedar accesibles con una mano y conservar contraste alto.
