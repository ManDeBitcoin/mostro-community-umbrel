// What the summary page says, derived from the data the panel already has.
// Pure functions: no React and no fetching here.
import type { AutoBackupState, Configuration, DaemonNotice, DaemonReport, Dashboard, OrdersSnapshot } from '../types';
import type { Tone } from '../components/layout';
import type { PageId } from './navigation';
import { isOpenDispute } from './constants';
import { formatAge, formatBps, formatFraction, formatNumber } from './format';

export type MarketState = 'open' | 'maintenance' | 'starting' | 'unconfirmed' | 'lingering' | 'standby' | 'unconfigured' | 'loading' | 'unknown';

export type MarketStatus = {
  state: MarketState;
  tone: Tone;
  /** Two or three words, for the sidebar and the top bar. */
  label: string;
  title: string;
  detail: string;
};

export type LightningReadiness = 'ready' | 'no-channels' | 'channels-unknown' | 'syncing' | 'unreadable';

/**
 * What the read-only LND probe lets the panel say. "warning" is an LND that
 * answers while it still syncs; anything else means the panel cannot read it,
 * which says nothing about its channels.
 */
export function lightningReadiness(dashboard: Dashboard | null): LightningReadiness {
  const lightning = dashboard?.lightning;
  if (!lightning || (lightning.status !== 'online' && lightning.status !== 'warning')) return 'unreadable';
  if (lightning.synced_to_chain === false) return 'syncing';
  if (typeof lightning.num_active_channels !== 'number') return 'channels-unknown';
  return lightning.num_active_channels > 0 ? 'ready' : 'no-channels';
}

const LIGHTNING_STEP_DETAIL: Record<LightningReadiness, string> = {
  ready: 'Mostro retiene y paga los sats de cada operación a través de tu nodo LND.',
  'no-channels': 'LND responde, pero no tiene canales activos: el mercado no puede mover sats.',
  'channels-unknown': 'LND responde, pero no dice cuántos canales activos tiene. Compruébalo en la página de Lightning.',
  syncing: 'LND responde, pero aún se está sincronizando con la cadena de bloques.',
  unreadable: 'Mostro retiene y paga los sats de cada operación a través de tu nodo LND. El panel aún no puede leerlo.',
};

export const isActive = (daemon: DaemonReport | null) => daemon?.state === 'active_ready' || daemon?.state === 'active_running';
export const isMaintenance = (daemon: DaemonReport | null) => Boolean(daemon?.announced_fresh && daemon.announced?.tags?.maintenance_mode === 'true');

/** While a daemon is this young, not having announced itself yet is normal. The server warns past the same mark. */
const STARTUP_WINDOW_SECS = 660;

// What the same report says about Lightning that an open market cannot do
// without, most serious first. A panel that was never given read access to LND
// (`lnd_unconfigured`) is a choice of the install, not something that broke.
const OPEN_WITH_LIGHTNING_NOTICE: [code: string, title: string, detail: string][] = [
  ['lnd_unreadable', 'Tu mercado está abierto, pero el panel no puede leer Lightning', 'El nodo se anuncia y atiende a las apps. El panel no pudo leer LND, así que no puede comprobar sus canales ni su sincronización.'],
  ['lnd_no_channels', 'Tu mercado está abierto, pero Lightning no tiene canales activos', 'El nodo se anuncia y atiende a las apps, pero LND no tiene canales activos: no puede retener depósitos ni pagar a los compradores.'],
  ['lnd_not_synced', 'Tu mercado está abierto, pero LND no está sincronizado', 'El nodo se anuncia y atiende a las apps, pero LND no está sincronizado con la cadena de bloques: los depósitos y los pagos pueden fallar.'],
];

/**
 * One sentence about the market, from the daemon report alone so that the
 * headline cannot contradict itself.
 *
 * "Open" needs both halves: Mostro is activated here with its daemon running,
 * and the node has announced itself on the relays in the last minutes, which
 * is what an app can check. A recent announcement without Mostro activated
 * here is what is left of a daemon just stopped, or another instance using
 * the same key.
 */
export function marketStatus(daemon: DaemonReport | null, settled = true): MarketStatus {
  if (!daemon) {
    return settled
      ? { state: 'unknown', tone: 'neutral', label: 'Sin datos', title: 'No hay datos del nodo', detail: 'El panel no ha podido consultar el estado. Comprueba que la aplicación está en marcha y vuelve a cargar.' }
      : { state: 'loading', tone: 'neutral', label: 'Consultando…', title: 'Consultando el estado del nodo', detail: 'El panel está leyendo el estado del daemon, de Lightning y de los relays.' };
  }
  const announcing = Boolean(daemon.announced_fresh);
  if (!isActive(daemon)) {
    if (announcing) {
      return {
        state: 'lingering',
        tone: 'warn',
        label: 'Anuncio vigente',
        title: 'Mostro no está activado aquí, pero el nodo aún se anuncia',
        detail: 'Es normal durante unos minutos después de desactivarlo: las apps pueden verlo activo aunque nadie les responde. Si el anuncio se sigue renovando, otra instancia de Mostro usa esta misma clave: no actives una segunda.',
      };
    }
    return daemon.state === 'configured_standby'
      ? { state: 'standby', tone: 'info', label: 'Sin iniciar', title: 'El mercado está sin iniciar', detail: 'La identidad y las reglas están guardadas, y Mostro aún no está activado.' }
      : { state: 'unconfigured', tone: 'neutral', label: 'Sin preparar', title: 'Tu comunidad aún no está preparada', detail: 'Faltan la identidad del nodo o las reglas de la comunidad.' };
  }
  if (daemon.state === 'active_running') {
    if (isMaintenance(daemon)) {
      return { state: 'maintenance', tone: 'warn', label: 'En mantenimiento', title: 'El nodo está en mantenimiento', detail: 'El nodo anuncia que no acepta órdenes ni tomas nuevas.' };
    }
    if (announcing) {
      // Still open: the apps see the node and it answers them. But not all is well.
      const codes = new Set(daemonNotices(daemon).map((notice) => notice.code));
      const lightning = OPEN_WITH_LIGHTNING_NOTICE.find(([code]) => codes.has(code));
      if (lightning) return { state: 'open', tone: 'warn', label: 'Abierto con avisos', title: lightning[1], detail: lightning[2] };
      return { state: 'open', tone: 'good', label: 'Mercado abierto', title: 'Tu mercado está abierto', detail: 'El nodo anuncia su información en los relays y atiende a las apps. Este panel solo observa: no toma órdenes ni mueve fondos.' };
    }
    const running = daemon.running_for_secs;
    if (typeof running === 'number' && running <= STARTUP_WINDOW_SECS) {
      return {
        state: 'starting',
        tone: 'info',
        label: 'Arrancando',
        title: 'El nodo está arrancando',
        detail: daemon.announced_before_start
          ? 'El daemon acaba de arrancar. El anuncio que hay en los relays es anterior a este arranque: el panel espera el nuevo, que suele tardar menos de cinco minutos.'
          : 'El daemon está en ejecución y el panel aún no ha visto su información en los relays. Suele tardar menos de cinco minutos.',
      };
    }
    return {
      state: 'unconfirmed',
      tone: 'warn',
      label: 'Sin confirmar',
      title: 'El daemon está en ejecución, pero el panel no ve su anuncio',
      detail: `${typeof running === 'number' ? `Lleva ${formatAge(running)} en marcha y el` : 'El'} panel no ha visto su información reciente en los relays. Las apps no pueden confirmar que el nodo está activo: revisa los relays.`,
    };
  }
  return announcing
    ? { state: 'unconfirmed', tone: 'warn', label: 'Sin confirmar', title: 'El nodo se anuncia, pero el panel no ve el daemon en ejecución', detail: 'Puede estar reiniciándose. Si sigue así unos minutos, revisa los avisos en la página del nodo.' }
    : { state: 'unconfirmed', tone: 'warn', label: 'Sin confirmar', title: 'Mostro está activado, pero el nodo no se anuncia', detail: 'La configuración está activa y el panel no ve el daemon en ejecución ni su información reciente en los relays. Las apps lo verán inactivo.' };
}

/** The setup list is what the summary shows first in these two states. */
export const isSettingUp = (status: MarketStatus) => status.state === 'unconfigured' || status.state === 'standby';

export type AttentionItem = {
  id: string;
  tone: Tone;
  title: string;
  detail?: string;
  /** Where it is fixed. */
  page: PageId;
  action: string;
};

export type NoticeRoute = { title: string; page: PageId; action: string; setup?: boolean };

// Where each notice of the daemon report is dealt with, by the code the server
// gives it. `setup` marks the ones that are a step of the setup list.
// scripts/tests/test_panel_contract.py checks that every code of the server is here.
const NOTICE_ROUTES: Record<string, NoticeRoute> = {
  identity_missing: { title: 'Falta la identidad del nodo', page: 'node', action: 'Crear o importar', setup: true },
  rules_missing: { title: 'Faltan las reglas de la comunidad', page: 'config', action: 'Abrir configuración', setup: true },
  lnd_unconfigured: { title: 'El panel no puede leer Lightning', page: 'lightning', action: 'Ver Lightning', setup: true },
  lnd_unreadable: { title: 'El panel no puede leer Lightning', page: 'lightning', action: 'Ver Lightning', setup: true },
  lnd_no_channels: { title: 'Lightning necesita atención', page: 'lightning', action: 'Ver Lightning', setup: true },
  lnd_channels_unknown: { title: 'Lightning necesita atención', page: 'lightning', action: 'Ver Lightning', setup: true },
  lnd_not_synced: { title: 'Lightning necesita atención', page: 'lightning', action: 'Ver Lightning', setup: true },
  daemon_crash_loop: { title: 'El daemon se reinicia en bucle', page: 'node', action: 'Ver el nodo' },
  daemon_unexpected_exit: { title: 'El daemon terminó de forma inesperada', page: 'node', action: 'Ver el nodo' },
  daemon_not_verified: { title: 'El panel no ve el daemon en ejecución', page: 'node', action: 'Ver el nodo' },
  announcement_stale: { title: 'El nodo no se anuncia en los relays', page: 'node', action: 'Ver el nodo' },
  announcement_without_daemon: { title: 'El nodo se anuncia sin que el panel vea el daemon', page: 'node', action: 'Ver el nodo' },
  version_mismatch: { title: 'El daemon anuncia otra versión', page: 'node', action: 'Ver el nodo' },
  rules_not_applied: { title: 'Hay reglas guardadas sin aplicar al nodo', page: 'node', action: 'Aplicar en el nodo' },
  routing_fee_zero: { title: 'La comisión de enrutamiento es 0', page: 'config', action: 'Revisar' },
  pow_first_contact_above_base: { title: 'La prueba de trabajo puede dejar fuera a algunas apps', page: 'config', action: 'Revisar' },
};
const UNKNOWN_NOTICE: NoticeRoute = { title: 'Aviso del nodo', page: 'node', action: 'Ver el nodo' };

/** The notices of the report. An older server only sends the sentences. */
export const daemonNotices = (daemon: DaemonReport | null): DaemonNotice[] => daemon?.notices ?? (daemon?.warnings ?? []).map((text) => ({ code: '', text }));

export const routeNotice = (notice: DaemonNotice): NoticeRoute => NOTICE_ROUTES[notice.code] ?? UNKNOWN_NOTICE;

export type OverviewInput = {
  apiOnline: boolean;
  daemon: DaemonReport | null;
  orders: OrdersSnapshot | null;
  backups: AutoBackupState | null;
  /** Serious alerts the operator has not looked at yet. */
  unseenAlerts: number;
  hasUnsavedChanges: boolean;
  /** The setup list is on screen: what it already asks for is not repeated here. */
  duringSetup?: boolean;
};

/** Everything that needs the operator, most urgent first. */
export function attentionItems({ apiOnline, daemon, orders, backups, unseenAlerts, hasUnsavedChanges, duringSetup = false }: OverviewInput): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (!apiOnline) {
    items.push({ id: 'api', tone: 'bad', title: 'El panel no recibe respuesta de su servidor', detail: 'Los datos de esta página pueden estar desactualizados.', page: 'home', action: 'Reintentar' });
  }

  const openDisputes = (orders?.disputes ?? []).filter((dispute) => isOpenDispute(dispute.status)).length;
  if (openDisputes > 0) {
    items.push({
      id: 'disputes',
      tone: 'bad',
      title: openDisputes === 1 ? 'Hay 1 disputa abierta' : `Hay ${openDisputes} disputas abiertas`,
      detail:
        openDisputes === 1
          ? 'Necesita un mediador. También se cierra si el vendedor libera los sats o las partes cancelan de mutuo acuerdo.'
          : 'Necesitan un mediador. También se cierran si el vendedor libera los sats o las partes cancelan de mutuo acuerdo.',
      page: 'disputes',
      action: 'Ver disputas',
    });
  }

  // Two notices about the same thing read better as one item.
  const grouped = new Map<string, AttentionItem>();
  daemonNotices(daemon).forEach((notice) => {
    const route = routeNotice(notice);
    if (duringSetup && route.setup) return;
    const existing = grouped.get(route.title);
    if (existing) existing.detail = `${existing.detail} ${notice.text}`;
    else grouped.set(route.title, { id: `daemon-${grouped.size}`, tone: 'warn', title: route.title, detail: notice.text, page: route.page, action: route.action });
  });
  items.push(...grouped.values());

  // While the monitor is still connecting its data is not late yet.
  if (orders && (orders.state === 'disconnected' || orders.state === 'degraded' || (orders.state === 'live' && orders.is_stale))) {
    items.push({
      id: 'relays',
      tone: 'warn',
      title: orders.state === 'degraded' ? 'Algunos relays no responden' : 'El panel no recibe datos de los relays',
      detail: 'Las órdenes y disputas que ves pueden no estar al día.',
      page: 'orders',
      action: 'Ver relays',
    });
  }

  // Without a passphrase the automatic backup is simply off: not a failure.
  if (backups?.enabled && backups.last_error) {
    items.push({ id: 'backup-error', tone: 'warn', title: 'El último respaldo automático falló', detail: backups.last_error, page: 'backups', action: 'Ver respaldos' });
  } else if (!duringSetup && backups && daemon?.identity_present && backups.backups.length === 0) {
    items.push({
      id: 'backup-missing',
      tone: 'info',
      title: 'El panel no ve ningún respaldo',
      detail: 'Sin una copia de la identidad del nodo, perder este equipo es perder la comunidad.',
      page: 'backups',
      action: 'Crear respaldo',
    });
  }

  if (unseenAlerts > 0) {
    items.push({
      id: 'alerts',
      tone: 'warn',
      title: unseenAlerts === 1 ? '1 alerta grave sin revisar' : `${unseenAlerts} alertas graves sin revisar`,
      page: 'alerts',
      action: 'Ver alertas',
    });
  }

  if (hasUnsavedChanges) {
    items.push({ id: 'unsaved', tone: 'info', title: 'Tienes cambios de configuración sin guardar', page: 'config', action: 'Ir a guardar' });
  }
  return items;
}

export type SetupStep = {
  id: string;
  title: string;
  detail: string;
  done: boolean;
  page: PageId;
  action: string;
};

export type SetupInput = {
  dashboard: Dashboard | null;
  daemon: DaemonReport | null;
  backups: AutoBackupState | null;
  hasSavedConfig: boolean;
};

/** The way from an empty install to an open market, in the order it has to be done. */
export function setupSteps({ dashboard, daemon, backups, hasSavedConfig }: SetupInput): SetupStep[] {
  const lightning = lightningReadiness(dashboard);
  return [
    {
      id: 'identity',
      title: 'Crea la identidad del nodo',
      detail: 'La clave Nostr con la que tu nodo firma sus órdenes y mensajes.',
      done: Boolean(daemon?.identity_present),
      page: 'node',
      action: 'Crear o importar',
    },
    {
      id: 'rules',
      title: 'Define las reglas de la comunidad',
      detail: 'Nombre, monedas, límites, comisiones, relays y métodos de pago.',
      done: hasSavedConfig,
      page: 'config',
      action: 'Abrir configuración',
    },
    {
      id: 'backup',
      title: 'Guarda un respaldo cifrado',
      detail: 'Una copia cifrada de la identidad y las reglas. Hazla antes de abrir el mercado y cópiala después fuera de este equipo.',
      done: Boolean(backups && backups.backups.length > 0),
      page: 'backups',
      action: 'Ir a respaldos',
    },
    {
      id: 'lightning',
      title: 'Conecta Lightning con canales activos',
      detail: LIGHTNING_STEP_DETAIL[lightning],
      done: lightning === 'ready',
      page: 'lightning',
      action: 'Ver Lightning',
    },
    {
      id: 'activate',
      title: 'Activa Mostro',
      detail: 'Aplica las reglas guardadas y arranca el daemon.',
      done: isActive(daemon),
      page: 'node',
      action: 'Ir al nodo',
    },
    {
      id: 'announce',
      title: 'Comprueba que el nodo se anuncia',
      detail: 'El daemon publica su información en los relays al arrancar y cada cinco minutos. Es lo que las apps comprueban.',
      done: daemon?.state === 'active_running' && Boolean(daemon.announced_fresh),
      page: 'node',
      action: 'Ver el nodo',
    },
  ];
}

export type ServiceTile = {
  id: 'mostro' | 'lightning' | 'relays';
  title: string;
  icon: string;
  tone: Tone;
  label: string;
  detail: string;
  meta?: string;
  page: PageId;
};

const MOSTRO_TILE: Record<MarketState, { label: string; detail: string }> = {
  open: { label: 'En marcha', detail: 'El daemon atiende a las apps y se anuncia en los relays.' },
  maintenance: { label: 'En mantenimiento', detail: 'El daemon está en marcha y no acepta órdenes nuevas.' },
  starting: { label: 'Arrancando', detail: 'El daemon está en ejecución y aún no se ha anunciado en los relays.' },
  unconfirmed: { label: 'Sin confirmar', detail: 'La configuración está activa, pero el panel no puede confirmar que el nodo atiende a las apps.' },
  lingering: { label: 'Sin activar aquí', detail: 'Mostro no está activado en este equipo, pero el nodo aún figura anunciado en los relays.' },
  standby: { label: 'Sin activar', detail: 'El daemon está detenido. Se activa desde la página del nodo.' },
  unconfigured: { label: 'Sin activar', detail: 'El daemon está detenido. Para activarlo faltan la identidad o las reglas.' },
  loading: { label: 'Consultando…', detail: 'El panel está leyendo el estado del daemon.' },
  unknown: { label: 'Sin datos', detail: 'El panel no ha podido consultar el estado del daemon.' },
};

const LIGHTNING_TILE: Record<LightningReadiness, { tone: Tone; label: string }> = {
  ready: { tone: 'good', label: 'Conectado' },
  'no-channels': { tone: 'warn', label: 'Sin canales activos' },
  'channels-unknown': { tone: 'warn', label: 'Canales sin confirmar' },
  syncing: { tone: 'warn', label: 'Sincronizando' },
  unreadable: { tone: 'neutral', label: 'Sin acceso de lectura' },
};

const RELAYS_TILE: Record<OrdersSnapshot['state'], { tone: Tone; label: string; detail: string }> = {
  live: { tone: 'good', label: 'Conectados', detail: 'El panel recibe de ellos las órdenes y el anuncio de tu nodo.' },
  degraded: { tone: 'warn', label: 'Con fallos', detail: 'Algunos relays no responden al panel. Una app que solo use esos no verá tu nodo.' },
  disconnected: { tone: 'bad', label: 'Sin conexión', detail: 'El panel no recibe datos de ningún relay.' },
  connecting: { tone: 'info', label: 'Conectando', detail: 'El panel está conectando con los relays.' },
  syncing: { tone: 'info', label: 'Leyendo', detail: 'El panel está leyendo lo que los relays conservan de tu nodo.' },
  unconfigured: { tone: 'neutral', label: 'Sin configurar', detail: 'El panel lee los relays cuando el nodo tiene identidad y reglas guardadas.' },
};

/** The three things a market depends on, each with the page where it is managed. */
export function serviceTiles(dashboard: Dashboard | null, daemon: DaemonReport | null, orders: OrdersSnapshot | null, status: MarketStatus, settled = true): ServiceTile[] {
  // Not read yet, or not readable: neither is the same as "not there".
  const pending = { tone: 'neutral' as Tone, label: settled ? 'Sin datos' : 'Consultando…' };
  const lightning = dashboard?.lightning;
  const readiness = lightningReadiness(dashboard);
  const lightningTile = !lightning
    ? pending
    : readiness === 'unreadable' && lightning.status === 'offline'
      ? { tone: 'bad' as Tone, label: 'Sin respuesta' }
      : readiness === 'ready' && lightning.status === 'warning'
        ? lightning.synced_to_graph === false
          ? { tone: 'info' as Tone, label: 'Sincronizando el grafo' }
          : { tone: 'info' as Tone, label: 'Conectado, por revisar' }
        : LIGHTNING_TILE[readiness];
  const relays = orders?.relays ?? [];
  const relaysTile = orders ? RELAYS_TILE[orders.state] : { ...pending, detail: settled ? 'El panel no ha podido leer el estado de los relays.' : 'El panel está leyendo el estado de los relays.' };
  return [
    {
      id: 'mostro',
      title: 'Mostro',
      icon: 'server',
      // The headline of an open market can carry a notice about Lightning, which has its own tile.
      tone: status.state === 'open' ? 'good' : status.state === 'standby' || status.state === 'unconfigured' ? 'neutral' : status.tone,
      ...MOSTRO_TILE[status.state],
      meta: daemon?.mostro_version ? `mostrod ${daemon.mostro_version}` : undefined,
      page: 'node',
    },
    {
      id: 'lightning',
      title: 'Lightning',
      icon: 'bolt',
      ...lightningTile,
      detail: lightning?.detail || (settled ? 'El panel no ha podido leer el estado de Lightning.' : 'El panel está leyendo el estado de Lightning.'),
      meta: readiness === 'unreadable' ? undefined : [lightning?.alias, typeof lightning?.num_active_channels === 'number' ? `${lightning.num_active_channels} canales activos` : null].filter(Boolean).join(' · ') || undefined,
      page: 'lightning',
    },
    {
      id: 'relays',
      title: 'Relays',
      icon: 'globe',
      ...relaysTile,
      meta: relays.length > 0 ? `${relays.filter((relay) => relay.state === 'live').length} de ${relays.length} responden` : undefined,
      page: 'orders',
    },
  ];
}

/**
 * What the lists of the relay monitor are worth. Until it has read the relays
 * an empty list is not "no orders" and not "no disputes": nothing was read.
 */
export type OrdersReadiness = 'unread' | 'unconfigured' | 'reading' | 'unreachable' | 'read';

export function ordersReadiness(orders: OrdersSnapshot | null): OrdersReadiness {
  if (!orders) return 'unread';
  if (orders.state === 'unconfigured') return 'unconfigured';
  if (orders.state === 'connecting' || orders.state === 'syncing') return 'reading';
  // No relay answers and nothing is in memory: none has answered yet.
  const empty = orders.orders.length === 0 && (orders.disputes ?? []).length === 0 && !orders.node_info;
  return orders.state === 'disconnected' && empty ? 'unreachable' : 'read';
}

export type OrderStats = {
  readiness: OrdersReadiness;
  /** The monitor has read the relays: its lists can be counted. */
  known: boolean;
  pending: number;
  inProgress: number;
  completed: number;
  canceled: number;
  openDisputes: number;
  completedSats: number;
};

export function orderStats(orders: OrdersSnapshot | null): OrderStats {
  const list = orders?.orders ?? [];
  const count = (status: string) => list.filter((order) => order.status === status).length;
  const completed = list.filter((order) => order.status === 'success' || order.status === 'completed-by-admin');
  const readiness = ordersReadiness(orders);
  return {
    readiness,
    known: readiness === 'read',
    pending: count('pending'),
    inProgress: count('in-progress'),
    completed: completed.length,
    canceled: count('canceled'),
    openDisputes: (orders?.disputes ?? []).filter((dispute) => isOpenDispute(dispute.status)).length,
    completedSats: completed.reduce((sum, order) => sum + (Number.isFinite(order.amount_sats) ? order.amount_sats : 0), 0),
  };
}

export type RuleLine = { label: string; value: string; hint?: string };

/** Whether the saved rules have been read. Until they are, having none in hand does not mean there are none. */
export type RulesRead = 'loaded' | 'reading' | 'failed';

/** What a page says where the saved rules would go, while it does not have them. */
export const rulesNotReadNote = (read: RulesRead) =>
  read === 'failed' ? 'El panel no ha podido leer las reglas guardadas. Lo vuelve a intentar solo.' : 'Leyendo las reglas guardadas…';

const BOND_APPLIES: Record<string, string> = { make: 'quien publica', take: 'quien toma', both: 'quien publica y quien toma' };

/** The rules an app reads from the node's information event (kind 38385). */
export function announcedRules(tags: Record<string, string>): RuleLine[] {
  const lines: RuleLine[] = [];
  const fee = Number(tags.fee);
  if (tags.fee !== undefined && Number.isFinite(fee)) {
    lines.push({ label: 'Comisión', value: formatFraction(fee), hint: `${formatFraction(fee / 2)} a cada parte` });
  }
  if (tags.min_order_amount && tags.max_order_amount) {
    lines.push({ label: 'Límites por operación', value: `${formatNumber(tags.min_order_amount)} – ${formatNumber(tags.max_order_amount)} sats` });
  }
  if (tags.fiat_currencies_accepted !== undefined) {
    lines.push({ label: 'Monedas', value: tags.fiat_currencies_accepted ? tags.fiat_currencies_accepted.split(',').join(', ') : 'Todas' });
  }
  if (tags.bond_enabled !== undefined) {
    const pct = Number(tags.bond_amount_pct);
    lines.push(
      tags.bond_enabled === 'true'
        ? {
            label: 'Garantía',
            value: `${Number.isFinite(pct) ? formatFraction(pct) : '—'}, mínimo ${formatNumber(tags.bond_base_amount_sats || '0')} sats`,
            hint: `La paga ${BOND_APPLIES[tags.bond_apply_to] || tags.bond_apply_to || 'cada parte'}`,
          }
        : { label: 'Garantía', value: 'Desactivada' },
    );
  }
  if (tags.expiration_hours) {
    lines.push({ label: 'Vida de una orden sin tomar', value: `${tags.expiration_hours} h` });
  }
  if (tags.expiration_seconds) {
    lines.push({ label: 'Plazo tras tomar una orden', value: `${Math.round(Number(tags.expiration_seconds) / 60)} min`, hint: 'Para enviar la factura o pagar el depósito' });
  }
  if (tags.pow !== undefined || tags.pow_first_contact !== undefined) {
    lines.push({ label: 'Prueba de trabajo', value: `${tags.pow ?? '0'} general · ${tags.pow_first_contact ?? tags.pow ?? '0'} en el primer mensaje` });
  }
  if (tags.lnd_networks) {
    lines.push({ label: 'Red de Lightning', value: tags.lnd_networks });
  }
  return lines;
}

/** The same rules as saved in the panel, for when the node does not announce yet. */
export function savedRules(config: Configuration): RuleLine[] {
  return [
    { label: 'Comisión', value: formatBps(config.market.fee_bps), hint: `${formatBps(config.market.fee_bps / 2)} a cada parte` },
    { label: 'Límites por operación', value: `${formatNumber(config.market.min_trade_sats)} – ${formatNumber(config.market.max_trade_sats)} sats` },
    { label: 'Monedas', value: config.market.fiat_currencies.length ? config.market.fiat_currencies.join(', ') : 'Sin elegir' },
    config.safety.bond_enabled
      ? { label: 'Garantía', value: `${formatBps(config.safety.bond_bps)}, mínimo ${formatNumber(config.safety.base_bond_sats)} sats`, hint: `La paga ${BOND_APPLIES[config.safety.bond_apply_to]}` }
      : { label: 'Garantía', value: 'Desactivada' },
  ];
}
