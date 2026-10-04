import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CURRENCY_CODES, CURRENCY_MAP, getCurrencyDisplayName } from './currencies';

type Configuration = {
  community: { name: string; about: string; website: string; contact: string; language: string };
  market: { fiat_currencies: string[]; min_trade_sats: number; max_trade_sats: number; fee_bps: number; dev_fee_bps: number; max_routing_fee_bps: number };
  safety: { bond_enabled: boolean; bond_bps: number; base_bond_sats: number; bond_apply_to: 'make' | 'take' | 'both'; automatic_timeout_slash: boolean; pow: number; pow_first_contact: number };
  nostr: { relays: string[] };
  payment_methods: { id: string; label: string; category: string; active: boolean }[];
};
type ServiceInfo = {
  status: string;
  detail: string;
  version?: string;
  alias?: string;
  synced_to_chain?: boolean;
  synced_to_graph?: boolean | null;
  network?: string | null;
  num_active_channels?: number;
  num_pending_channels?: number;
  num_inactive_channels?: number;
  block_height?: number;
  liquidity?: { status: 'available' | 'unavailable'; local_balance_sats: string | null; remote_balance_sats: string | null; detail: string };
};
type Dashboard = {
  mostro: ServiceInfo;
  lightning: ServiceInfo;
  bitcoin: ServiceInfo;
  market_started: boolean;
};
type CommunityCard = {
  version: number;
  name: string;
  pubkey: string;
  relays: string[];
  currency: string;
  payment_methods: string[];
  fee_bps: number;
  bond_percent: number;
  website: string;
  contact: string;
  signature: string;
};

type ConnectionInfo = {
  status: string;
  npub?: string | null;
  pubkey_hex?: string | null;
  relays: string[];
  nprofile?: string | null;
  nostr_uri?: string | null;
  qr_svg?: string | null;
  qr_json_svg?: string | null;
  json_uri?: string | null;
  card_uri?: string | null;
  qr_card_svg?: string | null;
  card?: CommunityCard | null;
  app_download_url: string;
  instructions: string;
};
type DaemonReport = {
  state: 'unconfigured' | 'configured_standby' | 'active_ready' | 'active_running';
  identity_present: boolean;
  npub?: string | null;
  draft_revision?: number | null;
  active_revision?: number | null;
  active_settings_hash?: string | null;
  active_settings_path?: string | null;
  lnd_channel_count: number;
  lnd_synced: boolean;
  can_activate: boolean;
  warnings: string[];
  mostro_version?: string;
  version_source?: 'announced' | 'binary' | 'pinned' | string;
  packaged_version?: string;
  protocol_version?: number;
  announced?: NodeInfo | null;
  announced_age_secs?: number | null;
  announced_fresh?: boolean;
  last_exit?: { at_unix: number; code: number; uptime_secs: number } | null;
};
type NodeInfo = {
  event_id: string;
  created_at: number;
  name?: string | null;
  mostro_version?: string | null;
  protocol_version?: string | null;
  tags: Record<string, string>;
};
type DisputeSummary = {
  id: string;
  event_id: string;
  status: string;
  initiator?: string | null;
  published_at?: number | null;
  updated_at: number;
};
type DisputeView = DisputeSummary & { order_id?: string | null; is_open: boolean };
type SimulationScenarioInfo = {
  id: string;
  label: string;
  description: string;
};
type SimulationStep = {
  step_number: number;
  action_code: string;
  title: string;
  actor: 'seller' | 'buyer' | 'mostro' | 'solver';
  order_status: string;
  description: string;
  nostr_event?: {
    kind: number;
    event_id: string;
    sender: string;
    recipient?: string | null;
    summary: string;
  } | null;
  lightning_action?: {
    action: string;
    amount_sats: number;
    payment_hash: string;
    status: string;
  } | null;
};
type SimulationReport = {
  scenario: string;
  order_id: string;
  bot_npub: string;
  payment_method: string;
  financials: {
    trade_amount_sats: number;
    fiat_currency: string;
    fiat_amount: string;
    seller_bond_sats: number;
    buyer_bond_sats: number;
    total_mostro_fee_sats: number;
    fee_per_side_sats: number;
    dev_fee_sats: number;
    fee_sats?: number;
    seller_hold_invoice_sats?: number;
    buyer_receives_sats?: number;
    seller_total_locked_sats: number;
    buyer_total_locked_sats: number;
  };
  steps: SimulationStep[];
  final_status: string;
  is_success: boolean;
  duration_simulated_ms: number;
  timestamp_unix: number;
  simulation_mode?: string;
  disclaimer?: string;
};
type CommunityReply = { revision: number; config: Configuration | null };

type NotificationItem = {
  id: string;
  level: string;
  category: string;
  title: string;
  message: string;
  timestamp: number;
  details?: Record<string, unknown>;
};

type BackupEntry = {
  filename: string;
  path: string;
  size_bytes: number;
  modified_timestamp: number;
};

type AutoBackupState = {
  enabled: boolean;
  target_dir: string;
  interval_secs: number;
  retention_count: number;
  last_run_timestamp: number | null;
  last_run_success: boolean | null;
  last_error: string | null;
  last_backup_path: string | null;
  backups: BackupEntry[];
};

type OrderSummary = {
  id: string;
  event_id: string;
  kind: string;
  status: string;
  fiat_code: string;
  fiat_amount_range: string[];
  amount_sats: number;
  amount_sats_str?: string;
  payment_methods: string[];
  premium: number;
  created_at: number;
  expires_at: number | null;
  published_at?: number | null;
};

type RelayStatus = {
  url: string;
  state: 'unconfigured' | 'connecting' | 'syncing' | 'live' | 'degraded' | 'disconnected';
  last_error?: string | null;
};

type OrdersSnapshot = {
  state: 'unconfigured' | 'connecting' | 'syncing' | 'live' | 'degraded' | 'disconnected';
  is_stale: boolean;
  last_update: number;
  source_npub: string | null;
  relays?: RelayStatus[];
  orders: OrderSummary[];
  disputes?: DisputeSummary[];
  node_info?: NodeInfo | null;
  node_info_age_secs?: number | null;
};

type ChatMessage = {
  id: string;
  order_id: string;
  sender: string;
  recipient?: string | null;
  created_at: number;
  kind: number;
  action?: string | null;
  content: string;
  is_from_me: boolean;
  role?: 'daemon' | 'user' | 'admin' | string;
  variant?: string;
  dispute_id?: string | null;
  acknowledged?: boolean;
};

type ChatHistory = {
  order_id: string;
  messages: ChatMessage[];
  count: number;
  dispute_id?: string | null;
};

type CommissionBondPreset = {
  id: string;
  nameEs: string;
  nameEn: string;
  descEs: string;
  descEn: string;
  feeBps: number;
  devFeeBps: number;
  maxRoutingFeeBps: number;
  bondEnabled: boolean;
  bondBps: number;
  baseBondSats: number;
  bondApplyTo: 'make' | 'take' | 'both';
  automaticTimeoutSlash: boolean;
};

const COMMISSION_BOND_PRESETS: CommissionBondPreset[] = [
  {
    id: 'standard',
    nameEs: 'Equilibrado / Recomendado (0.5% com. · 3% fianza)',
    nameEn: 'Balanced / Recommended (0.5% fee · 3% bond)',
    descEs: 'Comisión de mercado 0.5%, fianza del 3% (mínimo 5,000 sats). Ideal para comunidades activas.',
    descEn: '0.5% market fee, 3% bond (5,000 sats minimum). Ideal for active communities.',
    feeBps: 50,
    devFeeBps: 1000,
    maxRoutingFeeBps: 10,
    bondEnabled: true,
    bondBps: 300,
    baseBondSats: 5000,
    bondApplyTo: 'both',
    automaticTimeoutSlash: true,
  },
  {
    id: 'safe',
    nameEs: 'Bajo Riesgo / Fianza Alta (0.8% com. · 5% fianza)',
    nameEn: 'Low Risk / High Bond (0.8% fee · 5% bond)',
    descEs: 'Fianza reforzada del 5% (mínimo 10,000 sats) y comisión 0.8%. Recomendado para nuevos mercados.',
    descEn: 'Reinforced 5% bond (10,000 sats minimum) and 0.8% fee. Recommended for new markets.',
    feeBps: 80,
    devFeeBps: 1000,
    maxRoutingFeeBps: 10,
    bondEnabled: true,
    bondBps: 500,
    baseBondSats: 10000,
    bondApplyTo: 'both',
    automaticTimeoutSlash: true,
  },
  {
    id: 'zero',
    nameEs: 'Cero Comisión / Fianza Comunitaria (0.0% com. · 2% fianza)',
    nameEn: 'Zero Fee / Community Bond (0.0% fee · 2% bond)',
    descEs: 'Sin comisión de mercado para fomentar adopción; fianza del 2% (mínimo 2,000 sats) contra spam.',
    descEn: 'No market fee to foster adoption; 2% bond (2,000 sats minimum) to deter spam.',
    feeBps: 0,
    devFeeBps: 1000,
    maxRoutingFeeBps: 10,
    bondEnabled: true,
    bondBps: 200,
    baseBondSats: 2000,
    bondApplyTo: 'both',
    automaticTimeoutSlash: true,
  },
];

const POPULAR_CURRENCIES = ['USD', 'EUR', 'ARS', 'VES', 'COP', 'BRL', 'MXN', 'CLP', 'PEN', 'GBP', 'CHF'];

const blankConfig = (): Configuration => ({
  community: { name: '', about: '', website: '', contact: '', language: 'es' },
  market: { fiat_currencies: [], min_trade_sats: 1000, max_trade_sats: 1000000, fee_bps: 0, dev_fee_bps: 3000, max_routing_fee_bps: 20 },
  safety: { bond_enabled: false, bond_bps: 0, base_bond_sats: 0, bond_apply_to: 'both', automatic_timeout_slash: false, pow: 0, pow_first_contact: 0 },
  nostr: { relays: [] },
  payment_methods: [],
});
const percent = (bps: number) => (bps / 100).toString();

const copyToClipboard = (text: string, onSuccess: () => void) => {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(onSuccess);
  } else {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "absolute";
    textArea.style.left = "-999999px";
    document.body.prepend(textArea);
    textArea.select();
    try {
      document.execCommand('copy');
      onSuccess();
    } catch (error) {
      console.error(error);
    } finally {
      textArea.remove();
    }
  }
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'X-Requested-With': 'mostro-community',
      ...(init?.headers || {}),
      ...(init?.body ? { 'Content-Type': 'application/json' } : {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `Error del servidor (${response.status})`);
  return data as T;
}
function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const };
  const paths: Record<string, React.ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/></>,
    sliders: <><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="2" y1="14" x2="6" y2="14"/><line x1="10" y1="8" x2="14" y2="8"/><line x1="18" y1="16" x2="22" y2="16"/></>,
    bolt: <path d="m13 2-3 8h7l-6 12 1-9H5l8-11Z"/>,
    bitcoin: <><path d="M9 4h5.5a3 3 0 0 1 0 6H9V4Z"/><path d="M9 10h6a3.5 3.5 0 0 1 0 7H9v-7Z"/><path d="M11 2v20M15 2v2M15 18v2"/></>,
    globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></>,
    chevron: <path d="m9 18 6-6-6-6"/>,
    check: <path d="m5 12 4 4L19 6"/>,
    arrow: <><path d="M7 17 17 7M7 7h10v10"/></>,
    save: <><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/></>,
    alert: <><path d="m10.3 3.9-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3.1l-8-14a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></>,
    play: <polygon points="6 3 20 12 6 21 6 3" fill="currentColor"/>,
    shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>,
    message: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>,
  };
  return <svg {...common}>{paths[name] || paths.grid}</svg>;
}
function StatusDot({ status }: { status?: string }) {
  const value = (status || '').toLowerCase();
  const cls = ['ok', 'connected', 'online', 'synced', 'healthy'].includes(value) ? 'good' : ['error', 'offline', 'down', 'disconnected'].includes(value) ? 'bad' : 'unknown';
  return <span className={`status-dot ${cls}`} />;
}
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="field"><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}
function Toggle({ checked, onChange, label, note }: { checked: boolean; onChange: (value: boolean) => void; label: string; note?: string }) {
  return <div className="toggle-row"><div><strong>{label}</strong>{note && <span>{note}</span>}</div><button type="button" role="switch" aria-label={label} aria-checked={checked} className={`toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}><i /></button></div>;
}
function ActorBadge({ actor }: { actor: string }) {
  switch (actor) {
    case 'seller': return <span className="sim-actor-badge seller">Vendedor</span>;
    case 'buyer': return <span className="sim-actor-badge buyer">Comprador</span>;
    case 'mostro': return <span className="sim-actor-badge mostro">Mostro</span>;
    case 'solver': return <span className="sim-actor-badge solver">Mediador</span>;
    default: return <span className="sim-actor-badge">{actor}</span>;
  }
}
// Statuses mostrod publishes in kind 38383. The tag is coarse: a taken order
// is usually `in-progress` until it closes, but a sell order taken with the
// invoice attached stays `pending`. Disputes are announced in kind 38386.
const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: 'Pendiente',
  'in-progress': 'En curso',
  success: 'Completada',
  canceled: 'Cancelada',
  'completed-by-admin': 'Resuelta por mediador',
};
const CLOSED_ORDER_STATUSES = ['success', 'canceled', 'completed-by-admin', 'canceled-by-admin', 'cooperatively-canceled', 'settled-by-admin', 'completed', 'failed', 'expired'];
const DISPUTE_STATUS_LABELS: Record<string, string> = {
  initiated: 'Abierta, sin mediador',
  'in-progress': 'En mediación',
  settled: 'Resuelta: pago al comprador',
  'seller-refunded': 'Resuelta: devolución al vendedor',
  released: 'Cerrada: el vendedor liberó',
  'cooperatively-canceled': 'Cerrada: cancelación de mutuo acuerdo',
};
const isOpenDispute = (status: string) => status === 'initiated' || status === 'in-progress';
const formatAge = (secs: number) => secs < 90 ? `${secs} s` : secs < 5400 ? `${Math.round(secs / 60)} min` : `${Math.round(secs / 3600)} h`;

function OrdersPage({ onSelectDispute }: { onSelectDispute?: (orderId: string) => void }) {
  const [snapshot, setSnapshot] = useState<OrdersSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('mostro_orders_auto_refresh');
      return saved !== null ? saved === 'true' : true;
    } catch {
      return true;
    }
  });
  const [refreshIntervalSec, setRefreshIntervalSec] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('mostro_orders_refresh_interval');
      return saved ? Math.max(2, Math.min(60, Number(saved))) : 3;
    } catch {
      return 3;
    }
  });
  const [countdown, setCountdown] = useState<number>(3);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [filterKind, setFilterKind] = useState<'all' | 'buy' | 'sell'>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [newOrdersCount, setNewOrdersCount] = useState<number>(0);
  const [newlyAddedIds, setNewlyAddedIds] = useState<Set<string>>(new Set());

  const knownOrderIdsRef = useRef<Set<string>>(new Set());
  const initialFetchDoneRef = useRef(false);

  const fetchOrders = useCallback(async (isManual = false) => {
    if (isManual) {
      setRefreshing(true);
    }
    try {
      const data = await api<OrdersSnapshot>('/api/orders');
      setSnapshot(data);
      setLastRefreshedAt(new Date());

      if (data.orders && data.orders.length > 0) {
        const currentIds = new Set(data.orders.map(o => o.id));
        if (initialFetchDoneRef.current) {
          const freshIds: string[] = [];
          for (const id of currentIds) {
            if (!knownOrderIdsRef.current.has(id)) {
              freshIds.push(id);
            }
          }
          if (freshIds.length > 0) {
            setNewOrdersCount(prev => prev + freshIds.length);
            setNewlyAddedIds(prev => {
              const next = new Set(prev);
              freshIds.forEach(id => next.add(id));
              return next;
            });
            setTimeout(() => {
              setNewlyAddedIds(prev => {
                const next = new Set(prev);
                freshIds.forEach(id => next.delete(id));
                return next;
              });
            }, 6000);
          }
        }
        knownOrderIdsRef.current = currentIds;
        initialFetchDoneRef.current = true;
      }
    } catch (err) {
      console.error("No se pudo cargar el monitor", err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('mostro_orders_auto_refresh', String(autoRefresh));
    } catch {}
  }, [autoRefresh]);

  useEffect(() => {
    try {
      localStorage.setItem('mostro_orders_refresh_interval', String(refreshIntervalSec));
    } catch {}
  }, [refreshIntervalSec]);

  useEffect(() => {
    void fetchOrders();
  }, [fetchOrders]);

  useEffect(() => {
    if (!autoRefresh) {
      return;
    }
    setCountdown(refreshIntervalSec);
    const intervalTimer = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          void fetchOrders();
          return refreshIntervalSec;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(intervalTimer);
  }, [autoRefresh, refreshIntervalSec, fetchOrders]);

  if (loading && !snapshot) {
    return <section className="content"><div className="page-heading"><h1>Órdenes públicas</h1></div><p>Cargando monitor...</p></section>;
  }

  if (!snapshot) {
    return <section className="content"><div className="page-heading"><h1>Órdenes públicas</h1></div><p>Error al cargar el estado.</p></section>;
  }

  const { state, is_stale, last_update, source_npub, relays, orders } = snapshot;
  const openDisputes = (snapshot.disputes || []).filter((d) => isOpenDispute(d.status));

  const stateLabels: Record<string, string> = {
    unconfigured: "Sin configurar (falta identidad pública o relays)",
    connecting: "Conectando a relays...",
    syncing: "Sincronizando eventos...",
    live: "En vivo (sincronizado)",
    degraded: "Degradado (al menos un relay activo, otros desconectados)",
    disconnected: "Desconectado"
  };

  const filteredOrders = orders.filter((o) => {
    if (filterKind !== 'all' && o.kind !== filterKind) return false;
    if (filterStatus === 'pending' && o.status !== 'pending') return false;
    if (filterStatus === 'in-progress' && o.status !== 'in-progress') return false;
    if (filterStatus === 'closed' && !CLOSED_ORDER_STATUSES.includes(o.status)) return false;
    return true;
  });

  return (
    <section className="content orders-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">MONITOR DE SOLO LECTURA</div>
          <h1>Órdenes públicas</h1>
          <p>Órdenes anunciadas en Nostr por la identidad {source_npub ? <code style={{wordBreak: "break-all"}}>{source_npub.slice(0, 15)}...</code> : "no configurada"}</p>
        </div>
        <div className="orders-updater-toolbar">
          <div className="orders-updater-status">
            <span className={`auto-refresh-pill ${autoRefresh ? 'is-live' : 'is-paused'}`}>
              <span className={`status-dot ${autoRefresh ? 'good pulse' : 'unknown'}`} />
              {autoRefresh ? (
                <>
                  <b>En vivo</b>
                  <small>({countdown}s)</small>
                </>
              ) : (
                <b>Pausado</b>
              )}
            </span>
            {lastRefreshedAt && (
              <span className="last-sync-label" title={lastRefreshedAt.toLocaleString()}>
                Sincronizado {lastRefreshedAt.toLocaleTimeString()}
              </span>
            )}
          </div>
          <div className="orders-updater-actions">
            <div className="interval-selector">
              <label htmlFor="orders-refresh-interval" className="interval-label">Frecuencia:</label>
              <select
                id="orders-refresh-interval"
                value={refreshIntervalSec}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setRefreshIntervalSec(val);
                  setCountdown(val);
                }}
                className="interval-select"
                title="Intervalo de actualización automática"
              >
                <option value={3}>Cada 3 seg</option>
                <option value={5}>Cada 5 seg</option>
                <option value={10}>Cada 10 seg</option>
                <option value={30}>Cada 30 seg</option>
              </select>
            </div>
            <button
              type="button"
              className={`button ${autoRefresh ? 'button-secondary' : 'button-primary'} auto-toggle-btn`}
              onClick={() => {
                const nextState = !autoRefresh;
                setAutoRefresh(nextState);
                if (nextState) {
                  setCountdown(refreshIntervalSec);
                  void fetchOrders(true);
                }
              }}
              title={autoRefresh ? 'Pausar actualización periódica' : 'Activar actualización periódica'}
            >
              {autoRefresh ? '⏸ Pausar' : '▶ Reanudar'}
            </button>
            <button
              type="button"
              className="button button-secondary refresh-button"
              onClick={() => {
                setCountdown(refreshIntervalSec);
                void fetchOrders(true);
              }}
              disabled={refreshing || loading}
              title="Forzar actualización inmediata"
            >
              <span className={refreshing ? 'spin' : ''}>↻</span> Actualizar
            </button>
          </div>
        </div>
      </div>
      {newOrdersCount > 0 && (
        <div className="new-orders-banner" role="status">
          <div className="new-orders-info">
            <span className="new-orders-icon">⚡</span>
            <span>
              <strong>{newOrdersCount === 1 ? '1 orden nueva detectada' : `${newOrdersCount} órdenes nuevas detectadas`}</strong> en el monitor.
            </span>
          </div>
          <button
            type="button"
            className="button button-secondary dismiss-btn"
            onClick={() => setNewOrdersCount(0)}
          >
            Entendido
          </button>
        </div>
      )}
      <div className="dev-banner">
        <div className="banner-icon"><Icon name="alert" size={18}/></div>
        <div>
          <b>Aviso de Solo Lectura</b>
          <span>Este monitor muestra el estado público que el daemon anuncia, que es menos detallado que el real: una orden «Pendiente» puede estar ya tomada y una «En curso» puede estar en disputa. No garantiza liquidez ni que el daemon esté en ejecución, y no permite pagar, tomar órdenes ni arbitrar.</span>
        </div>
      </div>

      {openDisputes.length > 0 && (
        <div style={{ marginBottom: '16px', padding: '12px 16px', background: 'rgba(235, 115, 29, 0.1)', border: '1px solid rgba(235, 115, 29, 0.3)', borderRadius: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <div>
            <strong style={{ color: '#eb731d', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Icon name="shield" size={15} /> {openDisputes.length} disputa{openDisputes.length === 1 ? '' : 's'} abierta{openDisputes.length === 1 ? '' : 's'} en el nodo
            </strong>
            <p style={{ margin: '4px 0 0', fontSize: '14px', color: '#9ba3af' }}>
              El nodo las anuncia en eventos propios (kind 38386). El estado público de una orden no cambia al entrar en disputa.
            </p>
          </div>
          {onSelectDispute && (
            <button
              type="button"
              className="button button-primary"
              style={{ fontSize: '13px', height: '32px' }}
              onClick={() => onSelectDispute('')}
            >
              Ver disputas →
            </button>
          )}
        </div>
      )}

      <div className="section-title-row">
        <div><h2>Estado de Conexión</h2><p>{stateLabels[state]}</p></div>
        <span className="updated-label">
          {is_stale ? "Datos retenidos (obsoletos)" : "Datos frescos"}
          {last_update > 0 && ` (Última vez: ${new Date(last_update * 1000).toLocaleTimeString()})`}
        </span>
      </div>

      {relays && relays.length > 0 && (
        <div style={{ marginBottom: '16px', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: '14px', fontWeight: 600, color: '#88988e' }}>Relays:</span>
          {relays.map((r) => (
            <span key={r.url} className={`chip ${r.state === 'live' ? 'complete' : ''}`} style={{ fontSize: '13px', padding: '3px 8px' }}>
              <StatusDot status={r.state === 'live' ? 'online' : r.state === 'connecting' || r.state === 'syncing' ? 'warning' : 'offline'} />
              {r.url.replace(/^wss?:\/\//, '')} ({r.state})
            </span>
          ))}
        </div>
      )}

      <div className="sim-controls" style={{ marginBottom: '16px', display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="sim-control-group" style={{ minWidth: '150px' }}>
          <label>Tipo</label>
          <select value={filterKind} onChange={(e) => setFilterKind(e.target.value as any)}>
            <option value="all">Todos los tipos</option>
            <option value="sell">Solo ventas</option>
            <option value="buy">Solo compras</option>
          </select>
        </div>
        <div className="sim-control-group" style={{ minWidth: '160px' }}>
          <label>Estado</label>
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
            <option value="all">Todos los estados</option>
            <option value="pending">Pendientes</option>
            <option value="in-progress">En curso</option>
            <option value="closed">Cerradas</option>
          </select>
        </div>
        <div style={{ marginLeft: 'auto', fontSize: '15px', color: '#88988e' }}>
          <span>{filteredOrders.length} {filteredOrders.length === 1 ? 'orden mostrada' : 'órdenes mostradas'}</span>
        </div>
      </div>

      <div className="form-grid">
        {state === 'unconfigured' ? (
          <p className="empty-hint">El monitor no tiene un origen configurado. Si importaste una clave, recarga la configuración o define la identidad pública.</p>
        ) : orders.length === 0 ? (
          <p className="empty-hint">{state === 'syncing' ? "Esperando eventos confirmados (EOSE)..." : "No se encontraron órdenes publicadas para este autor."}</p>
        ) : filteredOrders.length === 0 ? (
          <p className="empty-hint">No hay órdenes que coincidan con los filtros seleccionados.</p>
        ) : (
          <div className="orders-table" style={{ overflowX: 'auto', maxWidth: '100%', gridColumn: '1 / -1' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }} aria-label="Tabla de órdenes públicas">
              <thead>
                <tr>
                  <th>UUID / Creada</th>
                  <th>Tipo</th>
                  <th>Sats</th>
                  <th>Importe fiat y precio</th>
                  <th>Estado</th>
                  <th>Mensajes</th>
                </tr>
              </thead>
              <tbody>
                {filteredOrders.map(o => {
                  const isNew = newlyAddedIds.has(o.id);
                  return (
                    <tr
                      key={o.id}
                      className={isNew ? 'order-row-highlight' : ''}
                      style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.08)' }}
                    >
                    <td style={{ padding: '8px 0' }}>
                      <div style={{ fontSize: '15px', fontWeight: 'bold' }}><code>{o.id.slice(0, 8)}...</code></div>
                      <div style={{ fontSize: '13px', color: '#88988e' }}>{new Date((o.published_at || o.created_at) * 1000).toLocaleString()}</div>
                    </td>
                    <td>{o.kind === 'sell' ? 'Venta' : 'Compra'}</td>
                    <td>{o.amount_sats > 0 ? `${o.amount_sats_str || o.amount_sats.toLocaleString()} sats` : o.status === 'pending' ? 'Se fijan al tomarla' : '—'}</td>
                    <td>
                      {o.fiat_amount_range.length === 2 ? `${o.fiat_amount_range[0]} – ${o.fiat_amount_range[1]}` : o.fiat_amount_range[0] || '0'} {o.fiat_code.toUpperCase()}
                      {o.fiat_amount_range.length === 2 && <span style={{ fontSize: '13px', color: '#88988e' }}> (rango)</span>}
                      <br/>
                      <span style={{ fontSize: '13px', color: '#88988e' }}>
                        {o.premium !== 0
                          ? `Precio de mercado, prima ${o.premium > 0 ? '+' : ''}${o.premium} %`
                          : o.status === 'pending' && o.amount_sats > 0
                            ? 'Precio fijo en sats'
                            : o.status === 'pending' ? 'Precio de mercado, sin prima' : 'Sin prima'}
                      </span>
                    </td>
                    <td><span className="sim-actor-badge" title={o.status}>{ORDER_STATUS_LABELS[o.status] || o.status}</span></td>
                    <td>
                      {onSelectDispute ? (
                        <button
                          type="button"
                          className="button button-secondary"
                          style={{ padding: '3px 8px', fontSize: '13px' }}
                          onClick={() => onSelectDispute(o.id)}
                          title="Ver los mensajes de protocolo de esta orden"
                        >
                          <Icon name="message" size={13} /> Ver
                        </button>
                      ) : (
                        <span style={{ fontSize: '13px', color: '#68776e' }}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function MediationConsole({
  initialOrderId = '',
  onSelectOrder,
}: {
  initialOrderId?: string;
  onSelectOrder?: (orderId: string) => void;
}) {
  const [selectedOrderId, setSelectedOrderId] = useState<string>(initialOrderId);
  const [inputOrderId, setInputOrderId] = useState<string>(initialOrderId);
  const [selectedDisputeId, setSelectedDisputeId] = useState<string>('');
  const [history, setHistory] = useState<ChatHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [disputes, setDisputes] = useState<DisputeView[] | null>(null);
  const [disputesError, setDisputesError] = useState<string>('');
  const [ordersSnapshot, setOrdersSnapshot] = useState<OrdersSnapshot | null>(null);
  const [copied, setCopied] = useState<string>('');
  const selectedOrderRef = useRef<string>(initialOrderId);

  useEffect(() => {
    if (initialOrderId && initialOrderId !== selectedOrderId) {
      setSelectedOrderId(initialOrderId);
      setInputOrderId(initialOrderId);
    }
  }, [initialOrderId]);

  const fetchDisputes = useCallback(async () => {
    // The two requests fail independently: a failed one must never read as
    // "there are no disputes".
    const [list, snapshot] = await Promise.allSettled([
      api<DisputeView[]>('/api/disputes'),
      api<OrdersSnapshot>('/api/orders'),
    ]);
    if (list.status === 'fulfilled') {
      setDisputes(list.value);
      setDisputesError('');
    } else {
      setDisputesError(list.reason instanceof Error ? list.reason.message : 'Error de conexión');
    }
    if (snapshot.status === 'fulfilled') setOrdersSnapshot(snapshot.value);
  }, []);

  useEffect(() => {
    void fetchDisputes();
    const interval = setInterval(() => void fetchDisputes(), 8000);
    return () => clearInterval(interval);
  }, [fetchDisputes]);

  const fetchChat = useCallback(async (orderId: string) => {
    if (!orderId.trim()) return;
    setLoading(true);
    setError('');
    try {
      const data = await api<ChatHistory>(`/api/chat/${orderId.trim()}`);
      // A slower answer for the order shown before must not replace this one.
      if (data.order_id === selectedOrderRef.current) setHistory(data);
    } catch (err) {
      if (orderId.trim() === selectedOrderRef.current) {
        setHistory(null);
        setError(err instanceof Error ? err.message : 'No se pudieron obtener los mensajes de la orden');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    selectedOrderRef.current = selectedOrderId;
    // Never show the previous order's messages under the new order's id.
    setHistory(null);
    setError('');
    if (selectedOrderId) {
      void fetchChat(selectedOrderId);
      const interval = setInterval(() => {
        void fetchChat(selectedOrderId);
      }, 4000);
      return () => clearInterval(interval);
    }
  }, [selectedOrderId, fetchChat]);

  const selectOrder = (orderId: string) => {
    setSelectedOrderId(orderId);
    setInputOrderId(orderId);
    if (onSelectOrder) onSelectOrder(orderId);
  };

  const selectDispute = (d: DisputeView) => {
    setSelectedDisputeId(d.id);
    if (d.order_id) selectOrder(d.order_id);
    else {
      setSelectedOrderId('');
      setInputOrderId('');
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const id = inputOrderId.trim();
    if (id) {
      setSelectedDisputeId('');
      // Selecting another order loads it through the effect; asking again
      // for the same one refreshes it.
      if (id === selectedOrderId) void fetchChat(id);
      else selectOrder(id);
    }
  };

  const copy = (text: string, key: string) =>
    copyToClipboard(text, () => {
      setCopied(key);
      setTimeout(() => setCopied(''), 1800);
    });

  const sortedDisputes = [...(disputes || [])].sort((a, b) => Number(b.is_open) - Number(a.is_open) || b.updated_at - a.updated_at);
  const openCount = sortedDisputes.filter((d) => d.is_open).length;
  const selectedDispute =
    sortedDisputes.find((d) => d.id === selectedDisputeId) ||
    sortedDisputes.find((d) => selectedOrderId && d.order_id === selectedOrderId) ||
    (history?.dispute_id && history.order_id === selectedOrderId ? sortedDisputes.find((d) => d.id === history.dispute_id) : undefined);
  const monitorState = ordersSnapshot?.state;
  const monitorIsLive = monitorState === 'live' && !ordersSnapshot?.is_stale;
  const selectedOrder = ordersSnapshot?.orders.find((o) => o.id === selectedOrderId);
  // Messages from keys the daemon never addressed about this order are kept
  // out of the timeline: anyone can send them.
  const timelineMessages = (history?.messages || []).filter((m) => m.is_from_me || m.acknowledged !== false);
  const unrecognizedMessages = (history?.messages || []).filter((m) => !m.is_from_me && m.acknowledged === false);
  const roleLabel = (msg: ChatMessage) =>
    msg.role === 'admin' ? 'Administrador (clave del nodo)' : msg.is_from_me ? 'Daemon Mostro' : `Usuario ${msg.sender.slice(0, 12)}…${msg.sender.slice(-4)}`;

  return (
    <section className="content mediation-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">DISPUTAS Y MENSAJES DE PROTOCOLO · SOLO LECTURA</div>
          <h1>Consola de Mediación</h1>
          <p>Disputas que anuncia tu nodo e historial de mensajes entre los usuarios y el daemon para cada orden.</p>
        </div>
        <button
          className="button button-secondary"
          onClick={() => {
            void fetchDisputes();
            if (selectedOrderId) void fetchChat(selectedOrderId);
          }}
          disabled={loading}
        >
          <span className={loading ? 'spin' : ''}>↻</span> Actualizar
        </button>
      </div>

      <div className="dev-banner">
        <div className="banner-icon"><Icon name="shield" size={18} /></div>
        <div>
          <b>Qué muestra esta consola y qué no</b>
          <span>
            Muestra las disputas publicadas por el nodo (kind 38386) y los mensajes de protocolo v2 (kind 14, cifrado NIP-44) entre cada usuario y el daemon, descifrados en memoria con la identidad del nodo. No puede leer el chat entre comprador y vendedor ni el del mediador con las partes: se cifran con claves que el nodo no tiene. Tampoco resuelve disputas. Lo que envía un usuario es una petición: solo una respuesta del daemon confirma que la procesó.
          </span>
        </div>
        <div className="banner-status"><i /> SOLO LECTURA</div>
      </div>

      <div className="section-title-row">
        <div>
          <h2>Disputas del nodo</h2>
          <p>
            {disputesError && disputes === null
              ? 'No se pudieron consultar las disputas.'
              : disputes === null
                ? 'Cargando…'
                : sortedDisputes.length === 0
                  ? monitorIsLive
                    ? 'El nodo no ha anunciado ninguna disputa en los relays configurados.'
                    : 'Sin disputas conocidas todavía.'
                  : `${openCount} abierta${openCount === 1 ? '' : 's'} de ${sortedDisputes.length} anunciada${sortedDisputes.length === 1 ? '' : 's'}.`}
          </p>
        </div>
      </div>

      {(disputesError || (ordersSnapshot && !monitorIsLive)) && (
        <div className="form-message error">
          {disputesError
            ? `No se pudieron consultar las disputas (${disputesError}). La lista puede estar incompleta.`
            : `El monitor de relays no está al día (estado: ${monitorState}${ordersSnapshot?.is_stale ? ', datos retenidos' : ''}). Puede haber disputas abiertas que aún no aparecen aquí.`}
        </div>
      )}

      {sortedDisputes.length > 0 && (
        <div className="orders-table" style={{ overflowX: 'auto', maxWidth: '100%', marginBottom: '20px' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }} aria-label="Disputas anunciadas por el nodo">
            <thead>
              <tr>
                <th>Disputa</th>
                <th>Estado</th>
                <th>La abrió</th>
                <th>Abierta el</th>
                <th>Orden</th>
              </tr>
            </thead>
            <tbody>
              {sortedDisputes.map((d) => (
                <tr
                  key={d.id}
                  className={selectedDispute?.id === d.id ? 'order-row-highlight' : ''}
                  style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.08)', cursor: 'pointer' }}
                  onClick={() => selectDispute(d)}
                >
                  <td style={{ padding: '8px 0' }}>
                    <button
                      type="button"
                      className="copy-button"
                      aria-pressed={selectedDispute?.id === d.id}
                      title={`Ver la disputa ${d.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        selectDispute(d);
                      }}
                    >
                      <code>{d.id.slice(0, 8)}…</code>
                    </button>
                  </td>
                  <td>
                    <span className={d.is_open ? 'dispute-badge' : 'sim-actor-badge'} title={d.status}>
                      {DISPUTE_STATUS_LABELS[d.status] || d.status}
                    </span>
                  </td>
                  <td>{d.initiator === 'buyer' ? 'Comprador' : d.initiator === 'seller' ? 'Vendedor' : '—'}</td>
                  <td>{new Date((d.published_at || d.updated_at) * 1000).toLocaleString()}</td>
                  <td>
                    {d.order_id ? <code>{d.order_id.slice(0, 8)}…</code> : <span style={{ fontSize: '13px', color: '#88988e' }}>Sin identificar</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="sim-controls" style={{ marginBottom: '16px', display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
        <form onSubmit={handleSearch} style={{ display: 'flex', gap: '8px', flex: '1 1 320px', alignItems: 'center' }}>
          <div className="sim-control-group" style={{ flex: 1, minWidth: '220px' }}>
            <label>Ver los mensajes de una orden (UUID)</label>
            <input
              type="text"
              placeholder="Ej. edbd72f6-0bb0-4740-8b1c-7f51b6ad72ba"
              value={inputOrderId}
              onChange={(e) => setInputOrderId(e.target.value)}
            />
          </div>
          <button type="submit" className="button button-primary" style={{ marginTop: 'auto', height: '32px' }}>
            Cargar mensajes
          </button>
        </form>
      </div>

      {error && <div className="form-message error">{error}</div>}

      <div className="mediation-grid">
        <div className="chat-window">
          <div className="chat-window-head">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Icon name="message" size={16} />
              <h3>
                {selectedOrderId ? (
                  <>Mensajes de protocolo · <code>{selectedOrderId.slice(0, 8)}…</code></>
                ) : (
                  'Mensajes de protocolo'
                )}
              </h3>
            </div>
            {history && (
              <span className="updated-label">
                {timelineMessages.length} mensaje{timelineMessages.length === 1 ? '' : 's'}
              </span>
            )}
          </div>

          <div className="chat-messages-list">
            {!selectedOrderId ? (
              <div className="chat-empty">
                <Icon name="shield" size={32} />
                <b>{selectedDispute ? 'Orden de la disputa sin identificar' : 'Ninguna orden seleccionada'}</b>
                <p>
                  {selectedDispute
                    ? 'El evento público de una disputa no nombra la orden. Este panel la conoce cuando ve los mensajes en los que el daemon avisa a las partes; si la disputa es anterior a los últimos 30 días o los relays ya no conservan esos mensajes, búscala por el UUID de la orden.'
                    : 'Elige una disputa de la tabla o escribe el UUID de una orden.'}
                </p>
              </div>
            ) : loading && !history ? (
              <div className="chat-empty">
                <span className="spin" style={{ fontSize: '24px' }}>↻</span>
                <p>Descifrando mensajes en memoria…</p>
              </div>
            ) : !history || timelineMessages.length === 0 ? (
              <div className="chat-empty">
                <Icon name="message" size={32} />
                <b>{error ? 'No se pudieron cargar los mensajes' : `Sin mensajes para la orden ${selectedOrderId.slice(0, 8)}…`}</b>
                <p>
                  {error
                    ? 'El panel no pudo leer el historial de esta orden. El motivo aparece arriba; se reintenta cada pocos segundos.'
                    : 'Los relays conservan los mensajes del daemon unos 30 días. Una orden que nadie ha tomado solo tiene el mensaje de creación.'}
                </p>
              </div>
            ) : (
              timelineMessages.map((msg) => {
                const bubbleClass = msg.is_from_me ? 'chat-bubble from-me' : 'chat-bubble from-other';
                const formattedTime = new Date(msg.created_at * 1000).toLocaleString([], {
                  day: '2-digit',
                  month: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                });
                return (
                  <div key={msg.id} className={bubbleClass}>
                    <div className="chat-meta">
                      <span className="chat-sender" title={msg.sender}>{roleLabel(msg)}</span>
                      <span className="chat-time">{formattedTime}</span>
                      {msg.action && <span className="chat-tag dispute">{msg.action}</span>}
                    </div>
                    {msg.content && (
                      <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '14px' }}>
                        {msg.content}
                      </div>
                    )}
                  </div>
                );
              })
            )}
            {unrecognizedMessages.length > 0 && (
              <details style={{ marginTop: '12px', fontSize: '13px', color: '#9ba3af' }}>
                <summary>
                  {unrecognizedMessages.length} mensaje{unrecognizedMessages.length === 1 ? '' : 's'} de claves que el daemon no reconoció en esta orden
                </summary>
                <p style={{ margin: '8px 0' }}>
                  Cualquiera puede enviar al nodo un mensaje que nombre esta orden. El daemon nunca respondió a estas claves como parte de la operación, así que no son prueba de nada.
                </p>
                {unrecognizedMessages.map((msg) => (
                  <div key={msg.id} style={{ borderTop: '1px solid #1f2b24', padding: '6px 0', wordBreak: 'break-word' }}>
                    <code>{msg.sender.slice(0, 12)}…{msg.sender.slice(-4)}</code> · {new Date(msg.created_at * 1000).toLocaleString()} · {msg.action || 'sin acción'}
                    {msg.content ? ` · ${msg.content}` : ''}
                  </div>
                ))}
              </details>
            )}
          </div>
        </div>

        <div className="dispute-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h3>Cómo se resuelve una disputa</h3>
            {selectedDispute ? (
              <span className={selectedDispute.is_open ? 'dispute-badge' : 'chat-tag'}>
                {DISPUTE_STATUS_LABELS[selectedDispute.status] || selectedDispute.status}
              </span>
            ) : (
              <span className="chat-tag">Guía</span>
            )}
          </div>

          <p style={{ margin: 0, fontSize: '13px', color: '#9ba3af', lineHeight: 1.4 }}>
            La resuelve un mediador (solver) registrado en el nodo, desde un cliente de mediación como Mostrix o mostro-cli. Este panel no ejecuta esas acciones: mueven fondos de los usuarios y se firman con la clave del mediador.
          </p>

          {(selectedDispute || selectedOrder) && (
            <div style={{ background: '#0e1412', border: '1px solid #1f2b24', borderRadius: '7px', padding: '10px 12px', fontSize: '13px', display: 'grid', gap: '4px' }}>
              {selectedDispute && (
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center' }}>
                  <span style={{ color: '#829288' }}>Disputa:</span>
                  <span>
                    <code>{selectedDispute.id.slice(0, 13)}…</code>{' '}
                    <button type="button" className="copy-button" onClick={() => copy(selectedDispute.id, 'dispute')}>
                      {copied === 'dispute' ? 'Copiado ✓' : 'Copiar ID'}
                    </button>
                  </span>
                </div>
              )}
              {selectedOrderId && (
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center' }}>
                  <span style={{ color: '#829288' }}>Orden:</span>
                  <span>
                    <code>{selectedOrderId.slice(0, 13)}…</code>{' '}
                    <button type="button" className="copy-button" onClick={() => copy(selectedOrderId, 'order')}>
                      {copied === 'order' ? 'Copiado ✓' : 'Copiar ID'}
                    </button>
                  </span>
                </div>
              )}
              {selectedOrder && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: '#829288' }}>Importe:</span>
                    <strong>
                      {selectedOrder.amount_sats > 0 ? `${selectedOrder.amount_sats.toLocaleString()} sats · ` : ''}
                      {selectedOrder.fiat_amount_range.join(' – ') || '0'} {selectedOrder.fiat_code.toUpperCase()}
                    </strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: '#829288' }}>Orden pública:</span>
                    <span>{selectedOrder.kind === 'sell' ? 'Venta' : 'Compra'} · {ORDER_STATUS_LABELS[selectedOrder.status] || selectedOrder.status}</span>
                  </div>
                </>
              )}
            </div>
          )}

          {selectedOrderId && !selectedDispute && (
            <p style={{ margin: 0, fontSize: '13px', color: '#d6b25e', lineHeight: 1.4 }}>
              Esta orden no tiene ninguna disputa anunciada por el nodo. Los pasos de abajo solo se aplican a una orden en disputa.
            </p>
          )}

          <div className="action-box settle">
            <h4>1. Tomar la disputa</h4>
            <p>El mediador la toma con su clave. La disputa pasa a «En mediación» y Mostro le entrega los datos de la orden y el canal con cada parte.</p>
            <code style={{ display: 'block', fontSize: '12px', wordBreak: 'break-all' }}>mostro-cli admtakedispute -d {selectedDispute?.id || '<id-de-la-disputa>'}</code>
          </div>

          <div className="action-box settle">
            <h4>2a. El comprador demostró el pago</h4>
            <p>Mostro cobra el depósito del vendedor y paga al comprador.</p>
            <code style={{ display: 'block', fontSize: '12px', wordBreak: 'break-all' }}>mostro-cli admsettle -o {(selectedDispute && selectedOrderId) || '<id-de-la-orden>'}</code>
          </div>

          <div className="action-box refund">
            <h4>2b. El pago fiat no existió</h4>
            <p>Mostro cancela el depósito y los sats vuelven al vendedor.</p>
            <code style={{ display: 'block', fontSize: '12px', wordBreak: 'break-all' }}>mostro-cli admcancel -o {(selectedDispute && selectedOrderId) || '<id-de-la-orden>'}</code>
          </div>

          <p style={{ margin: 0, fontSize: '12px', color: '#829288', lineHeight: 1.4 }}>
            La clave del propio nodo es administradora por defecto. Para no usarla en otro equipo, registra una clave de mediador aparte con <code>mostro-cli admaddsolver -n &lt;npub&gt;</code>.
          </p>
        </div>
      </div>
    </section>
  );
}

type LndChannel = {
  channel_point: string;
  remote_pubkey: string;
  alias?: string;
  capacity_sats: string;
  local_balance_sats: string;
  remote_balance_sats: string;
  active: boolean;
  private: boolean;
};

type LndChannelsReport = {
  status: string;
  detail: string;
  total_capacity_sats: string;
  total_local_balance_sats: string;
  total_remote_balance_sats: string;
  num_active_channels: number;
  num_inactive_channels: number;
  is_mock: boolean;
  inbound_sufficient: boolean;
  channels: LndChannel[];
};

function LiquidityOperationsPage() {
  const [report, setReport] = useState<LndChannelsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [useMock, setUseMock] = useState(false);
  const [error, setError] = useState('');

  const fetchChannels = useCallback(async (mockMode: boolean) => {
    setLoading(true);
    setError('');
    try {
      const data = await api<LndChannelsReport>(`/api/lnd/channels${mockMode ? '?mock=true' : ''}`);
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al consultar canales LND');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchChannels(useMock);
  }, [useMock, fetchChannels]);

  const copyText = (text: string, label: string) => {
    copyToClipboard(text, () => {
      setCopiedKey(label);
      setTimeout(() => setCopiedKey(null), 2000);
    });
  };

  const totalCap = Number(report?.total_capacity_sats || 0);
  const totalLocal = Number(report?.total_local_balance_sats || 0);
  const totalRemote = Number(report?.total_remote_balance_sats || 0);

  const localPct = totalCap > 0 ? Math.round((totalLocal / totalCap) * 100) : 0;
  const remotePct = totalCap > 0 ? Math.round((totalRemote / totalCap) * 100) : 0;

  return (
    <section className="content liquidity-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">MOSTRO COMMUNITY MANAGER <span className="eyebrow-sep">/</span> LIGHTNING</div>
          <h1>Operaciones LND y Gestión de Liquidez</h1>
          <p>Supervisión de canales Lightning, liquidez entrante (inbound) y guía operativa para el nodo Mostro.</p>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void fetchChannels(useMock)}
            disabled={loading}
          >
            <span className={loading ? 'spin' : ''}>↻</span> Actualizar canales
          </button>
        </div>
      </div>

      <div className="sim-controls" style={{ marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '13px', fontWeight: 600, color: '#88988e' }}>Modo de consulta:</span>
          <button
            type="button"
            className={`chip ${!useMock ? 'complete' : ''}`}
            onClick={() => setUseMock(false)}
            style={{ cursor: 'pointer' }}
          >
            Estado Real (Nodo LND)
          </button>
          <button
            type="button"
            className={`chip ${useMock ? 'complete' : ''}`}
            onClick={() => setUseMock(true)}
            style={{ cursor: 'pointer' }}
          >
            Vista Simulada / Demostración
          </button>
        </div>
        <span className="updated-label">
          {report?.is_mock ? 'Datos simulados (modo demo)' : report?.status === 'online' ? 'LND conectado en vivo' : 'LND sin canales configurados'}
        </span>
      </div>

      {report?.status === 'unconfigured' && !useMock && (
        <div className="dev-banner" style={{ marginBottom: '16px' }}>
          <div className="banner-icon"><Icon name="alert" size={18} /></div>
          <div>
            <b>LND no configurado o sin credenciales de solo lectura</b>
            <span>Para monitorear canales reales, monta las variables LND_REST_URL, LND_TLS_CERT y LND_READONLY_MACAROON o activa la Vista Simulada.</span>
          </div>
          <button
            type="button"
            className="button button-secondary"
            style={{ marginLeft: 'auto', height: '30px', fontSize: '12px' }}
            onClick={() => setUseMock(true)}
          >
            Cargar datos de prueba
          </button>
        </div>
      )}

      {error && <div className="form-message error">{error}</div>}

      <div className="sim-financials" style={{ marginBottom: '16px' }}>
        <div className="sim-financial-item">
          <span>Capacidad Total</span>
          <strong>{totalCap.toLocaleString()} sats</strong>
          <small>{report?.num_active_channels || 0} canales activos</small>
        </div>
        <div className="sim-financial-item">
          <span>Liquidez Saliente (Local)</span>
          <strong style={{ color: '#76e0a1' }}>{totalLocal.toLocaleString()} sats</strong>
          <small>{localPct}% · Para pagar al comprador</small>
        </div>
        <div className="sim-financial-item">
          <span>Liquidez Entrante (Inbound / Remota)</span>
          <strong style={{ color: '#67c8f5' }}>{totalRemote.toLocaleString()} sats</strong>
          <small>{remotePct}% · Para retener al vendedor</small>
        </div>
        <div className="sim-financial-item">
          <span>Estado de Liquidez</span>
          <strong style={{ color: report?.inbound_sufficient ? '#76e0a1' : '#f59e0b' }}>
            {report?.inbound_sufficient ? 'Suficiente ✓' : 'Requiere Inbound ⚠'}
          </strong>
          <small>{report?.num_inactive_channels || 0} inactivos</small>
        </div>
      </div>

      {totalCap > 0 && (
        <div style={{ marginBottom: '20px', background: '#101614', border: '1px solid #202c25', borderRadius: '8px', padding: '12px 16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '13px' }}>
            <span style={{ color: '#76e0a1' }}>Local (Saliente): {localPct}%</span>
            <span style={{ color: '#67c8f5' }}>Remota / Inbound (Entrante): {remotePct}%</span>
          </div>
          <div style={{ height: '8px', borderRadius: '4px', background: '#202c25', overflow: 'hidden', display: 'flex' }}>
            <div style={{ width: `${localPct}%`, background: '#76e0a1', transition: 'width 0.3s' }} />
            <div style={{ width: `${remotePct}%`, background: '#67c8f5', transition: 'width 0.3s' }} />
          </div>
        </div>
      )}

      <div className="connection-card" style={{ marginBottom: '24px' }}>
        <div className="connection-heading">
          <div>
            <h2>Canales Lightning Abiertos ({report?.channels.length || 0})</h2>
            <p>Lista de canales activos y balances direccionales con peers de la red.</p>
          </div>
        </div>
        {!report || report.channels.length === 0 ? (
          <div className="empty-hint" style={{ padding: '24px 0', textAlign: 'center' }}>
            <p>No se encontraron canales abiertos.</p>
            <p style={{ fontSize: '13px', color: '#68776e' }}>Consulta la guía paso a paso a continuación para abrir canales hacia el nodo Mostro.</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto', marginTop: '10px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #202c25', color: '#829288' }}>
                  <th style={{ padding: '8px 10px' }}>Peer / Alias</th>
                  <th style={{ padding: '8px 10px' }}>Capacidad</th>
                  <th style={{ padding: '8px 10px' }}>Saldo Local</th>
                  <th style={{ padding: '8px 10px' }}>Saldo Remoto (Inbound)</th>
                  <th style={{ padding: '8px 10px' }}>Estado</th>
                  <th style={{ padding: '8px 10px' }}>Punto de Canal</th>
                </tr>
              </thead>
              <tbody>
                {report.channels.map((c, idx) => {
                  const cap = Number(c.capacity_sats || 0);
                  const loc = Number(c.local_balance_sats || 0);
                  const rem = Number(c.remote_balance_sats || 0);
                  return (
                    <tr key={idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      <td style={{ padding: '10px', maxWidth: '200px' }}>
                        <strong>{c.alias || (c.remote_pubkey ? `${c.remote_pubkey.slice(0, 10)}...` : 'Peer')}</strong>
                        <div style={{ fontSize: '11px', color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          <code>{c.remote_pubkey}</code>
                        </div>
                      </td>
                      <td style={{ padding: '10px' }}><strong>{cap.toLocaleString()}</strong> sats</td>
                      <td style={{ padding: '10px', color: '#76e0a1' }}>{loc.toLocaleString()} sats</td>
                      <td style={{ padding: '10px', color: '#67c8f5' }}>{rem.toLocaleString()} sats</td>
                      <td style={{ padding: '10px' }}>
                        <span className={`chip ${c.active ? 'complete' : ''}`} style={{ fontSize: '11px', padding: '2px 6px' }}>
                          <StatusDot status={c.active ? 'online' : 'offline'} />
                          {c.active ? 'Activo' : 'Inactivo'}
                        </span>
                      </td>
                      <td style={{ padding: '10px' }}>
                        <button
                          type="button"
                          className="copy-button"
                          style={{ fontSize: '11px' }}
                          onClick={() => copyText(c.channel_point, `cp-${idx}`)}
                        >
                          {copiedKey === `cp-${idx}` ? 'Copiado ✓' : 'Copiar Point'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="connection-card">
        <div className="connection-heading">
          <div>
            <div className="eyebrow">MANUAL OPERATIVO DE LIQUIDEZ</div>
            <h2>Guía Paso a Paso: Preparación de Canales Lightning</h2>
            <p>Procedimiento para asegurar capacidad de recepción (Inbound) y enrutamiento en tu nodo Mostro.</p>
          </div>
        </div>

        <div className="sim-timeline" style={{ marginTop: '16px' }}>
          <article className="sim-step">
            <span className="sim-step-node" />
            <div className="sim-step-header">
              <span className="sim-step-num">Paso 1</span>
              <span className="sim-actor-badge mostro">Concepto Clave</span>
              <span className="sim-step-title">La Regla de Oro: Inbound vs Outbound Liquidity</span>
            </div>
            <p className="sim-step-desc">
              En Mostro, el bot actúa como un árbitro y depositario de garantías temporales (Hold Invoices). Para que un vendedor pueda publicar una orden o tomar una orden de compra, debe pagar un Hold Invoice al bot Mostro. Esto significa que los satoshis viajan <strong>desde el vendedor hacia tu nodo LND</strong>, lo cual requiere obligatoriamente <strong>Liquidez Entrante (Inbound Liquidity)</strong>. Si tu nodo solo tiene liquidez local (fondos de tu lado), los pagos de los vendedores rebotarán.
            </p>
          </article>

          <article className="sim-step">
            <span className="sim-step-node" />
            <div className="sim-step-header">
              <span className="sim-step-num">Paso 2</span>
              <span className="sim-actor-badge buyer">Acción Operador</span>
              <span className="sim-step-title">Obtener Canales Entrantes (Inbound) mediante Alby Hub o LSP</span>
            </div>
            <p className="sim-step-desc">
              La forma más rápida y confiable de obtener capacidad entrante en Umbrel es utilizar un Proveedor de Servicios Lightning (LSP) o conectar Alby Hub a tu nodo LND:
            </p>
            <ul style={{ margin: '6px 0 0 16px', padding: 0, fontSize: '13px', color: '#9ba3af', lineHeight: 1.6 }}>
              <li><strong>Alby Hub en Umbrel:</strong> Abre la app Alby Hub en tu Umbrel, ve a <em>Canales</em> y solicita apertura de canal entrante (Inbound Channel) seleccionando Alby LSP u Olympic.</li>
              <li><strong>Servicios LSP de Apertura Directa:</strong> Puedes adquirir liquidez entrante usando servicios como <em>Amboss Magma</em>, <em>LNBig</em>, <em>Voltage LSP</em> o <em>Boltz Submarine Swaps</em>.</li>
              <li><strong>Capacidad sugerida:</strong> Para una comunidad pequeña a mediana, se recomienda contar con al menos <strong>500,000 a 1,500,000 sats</strong> de liquidez entrante disponible.</li>
            </ul>
          </article>

          <article className="sim-step">
            <span className="sim-step-node" />
            <div className="sim-step-header">
              <span className="sim-step-num">Paso 3</span>
              <span className="sim-actor-badge seller">Conectividad</span>
              <span className="sim-step-title">Abrir Canales Salientes (Outbound) hacia Grandes Nodos de Enrutamiento</span>
            </div>
            <p className="sim-step-desc">
              Cuando el comprador confirma la recepción del dinero fiat, el bot Mostro debe pagar la factura Lightning al comprador para liberarle los satoshis. Para que este pago no falle por falta de ruta:
            </p>
            <ul style={{ margin: '6px 0 0 16px', padding: 0, fontSize: '13px', color: '#9ba3af', lineHeight: 1.6 }}>
              <li>Abre 2 o 3 canales salientes bien conectados con peers de alta fiabilidad como <strong>ACINQ</strong>, <strong>Kraken</strong>, <strong>Bitfinex</strong> o <strong>River</strong>.</li>
              <li>Asegúrate de que la comisión máxima de enrutamiento configurada en Mostro (<code>max_routing_fee_bps</code> en la pestaña Configuración) permita encontrar caminos viables.</li>
            </ul>
          </article>

          <article className="sim-step">
            <span className="sim-step-node" />
            <div className="sim-step-header">
              <span className="sim-step-num">Paso 4</span>
              <span className="sim-actor-badge solver">Monitoreo</span>
              <span className="sim-step-title">Verificación de Salud y Activación del Mercado</span>
            </div>
            <p className="sim-step-desc">
              Una vez confirmados los canales en la blockchain (mínimo 3 confirmaciones para que LND los marque como activos):
            </p>
            <ul style={{ margin: '6px 0 0 16px', padding: 0, fontSize: '13px', color: '#9ba3af', lineHeight: 1.6 }}>
              <li>Verifica que la tarjeta de <em>Lightning</em> en el <strong>Panel General</strong> muestre canales activos y estado "Sincronizado".</li>
              <li>Ejecuta un ciclo de prueba en el <strong>Simulador P2P</strong> para verificar las comisiones y los flujos financieros.</li>
              <li>Dirígete a la tarjeta <em>Orquestación del Demonio Mostro</em> y haz clic en <strong>Activar Configuración de Mercado</strong> para iniciar operaciones en tu comunidad.</li>
            </ul>
          </article>
        </div>
      </div>
    </section>
  );
}

const configNavSections: { id: 'identity' | 'market' | 'safety' | 'nostr' | 'payments'; label: string }[] = [
  { id: 'identity', label: 'Identidad' },
  { id: 'market', label: 'Mercado' },
  { id: 'safety', label: 'Seguridad' },
  { id: 'nostr', label: 'Nostr' },
  { id: 'payments', label: 'Métodos de pago' },
];

function App() {
  const [page, setPage] = useState<'dashboard' | 'orders' | 'mediation' | 'simulation' | 'liquidity' | 'config'>('dashboard');
  const [activeConfigNav, setActiveConfigNav] = useState<'identity' | 'market' | 'safety' | 'nostr' | 'payments'>('identity');
  const [selectedDisputeOrderId, setSelectedDisputeOrderId] = useState<string>('');
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [connection, setConnection] = useState<ConnectionInfo | null>(null);
  const [daemon, setDaemon] = useState<DaemonReport | null>(null);
  const [activatingDaemon, setActivatingDaemon] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState<Configuration>(blankConfig);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [communityLoaded, setCommunityLoaded] = useState(false);
  const [health, setHealth] = useState(false);
  const [apiError, setApiError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [relayInput, setRelayInput] = useState('');
  const [feeInputs, setFeeInputs] = useState({ fee: '', devFee: '', routingFee: '', bond: '' });
  const [currencySearchQuery, setCurrencySearchQuery] = useState('');
  const [isCurrencyDropdownOpen, setIsCurrencyDropdownOpen] = useState(false);
  const currencyDropdownRef = useRef<HTMLDivElement | null>(null);

  const [isGeneratingIdentity, setIsGeneratingIdentity] = useState(false);
  const [generatedIdentity, setGeneratedIdentity] = useState<{ nsec: string; npub: string } | null>(null);
  const [hasBackedUpNsec, setHasBackedUpNsec] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importNsec, setImportNsec] = useState('');
  const [showImportNsec, setShowImportNsec] = useState(false);
  const [importError, setImportError] = useState('');
  const [isImporting, setIsImporting] = useState(false);

  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [backupState, setBackupState] = useState<AutoBackupState | null>(null);
  const [triggeringBackup, setTriggeringBackup] = useState(false);
  const [backupPassphrase, setBackupPassphrase] = useState('');
  const [backupMessage, setBackupMessage] = useState('');

  const [simScenarios, setSimScenarios] = useState<SimulationScenarioInfo[]>([]);
  const [selectedScenario, setSelectedScenario] = useState('happy_path');
  const [simSatsInput, setSimSatsInput] = useState('50000');
  const [simulating, setSimulating] = useState(false);
  const [simulationReport, setSimulationReport] = useState<SimulationReport | null>(null);
  const [simError, setSimError] = useState('');
  const [qrFormat, setQrFormat] = useState<'card' | 'uri' | 'json'>('card');

  const copyText = (text: string, label: string) => {
    copyToClipboard(text, () => {
      setCopiedField(label);
      setTimeout(() => setCopiedField(null), 2000);
    });
  };

  const refresh = useCallback(async () => {
    setLoading(true); setApiError('');
    const healthPromise = api<{ status: string }>('/api/health').then((data) => setHealth(data.status === 'ok')).catch(() => setHealth(false));
    const dashboardPromise = api<Dashboard>('/api/dashboard').then(setDashboard).catch(() => setDashboard(null));
    const connectionPromise = api<ConnectionInfo>('/api/connection').then(setConnection).catch(() => setConnection(null));
    const daemonPromise = api<DaemonReport>('/api/daemon/status').then(setDaemon).catch(() => setDaemon(null));
    const notifsPromise = api<NotificationItem[]>('/api/notifications').then(setNotifications).catch(() => {});
    const backupPromise = api<AutoBackupState>('/api/backup/status').then(setBackupState).catch(() => {});
    const presetsPromise = api<unknown>('/api/community/presets').catch(() => {});
    const simScenariosPromise = api<SimulationScenarioInfo[]>('/api/simulation/scenarios').then((data) => {
      setSimScenarios(data);
    }).catch(() => setSimScenarios([]));
    const communityPromise = api<CommunityReply>('/api/community').then((data) => {
      setRevision(data.revision); setSaved(Boolean(data.config)); setDirty(false); setCommunityLoaded(true);
      const config = data.config || blankConfig(); setDraft(config);
      setFeeInputs(data.config ? { fee: percent(config.market.fee_bps), devFee: percent(config.market.dev_fee_bps), routingFee: percent(config.market.max_routing_fee_bps), bond: percent(config.safety.bond_bps) } : { fee: '', devFee: '', routingFee: '', bond: '' });
    }).catch((err: Error) => { setCommunityLoaded(false); setApiError(err.message); });
    await Promise.all([healthPromise, dashboardPromise, connectionPromise, daemonPromise, communityPromise, simScenariosPromise, notifsPromise, backupPromise, presetsPromise]); setLoading(false);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  // The daemon card and the market card describe a live state ("hace N s",
  // "el nodo atiende a los clientes"), so they are refreshed on their own
  // without reloading the draft being edited.
  useEffect(() => {
    if (page !== 'dashboard') return;
    const timer = setInterval(() => {
      api<Dashboard>('/api/dashboard').then(setDashboard).catch(() => {});
      api<DaemonReport>('/api/daemon/status').then(setDaemon).catch(() => {});
    }, 20000);
    return () => clearInterval(timer);
  }, [page]);

  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource('/api/notifications/sse');
      es.addEventListener('notification', (e) => {
        try {
          const item: NotificationItem = JSON.parse(e.data);
          setNotifications((prev) => [item, ...prev.filter((n) => n.id !== item.id)].slice(0, 50));
        } catch {}
      });
    } catch {}

    return () => {
      es?.close();
    };
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (currencyDropdownRef.current && !currencyDropdownRef.current.contains(event.target as Node)) {
        setIsCurrencyDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const filteredCurrencies = useMemo(() => {
    const q = currencySearchQuery.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (!q) {
      return CURRENCY_CODES.slice(0, 30);
    }
    return CURRENCY_CODES.filter((item) => {
      const codeMatch = item.code.toLowerCase().includes(q);
      const enMatch = item.nameEn.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes(q);
      const esMatch = item.nameEs.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes(q);
      return codeMatch || enMatch || esMatch;
    }).slice(0, 50);
  }, [currencySearchQuery]);

  const handleTriggerBackup = async () => {
    setTriggeringBackup(true);
    setBackupMessage('');
    try {
      const res = await api<{ status: string; path: string; revision: number }>('/api/backup/trigger', {
        method: 'POST',
        headers: { 'X-Requested-With': 'mostro-community' },
        body: JSON.stringify({ passphrase: backupPassphrase || undefined }),
      });
      setBackupMessage(`✓ Respaldo generado con éxito: revisión ${res.revision}`);
      setBackupPassphrase('');
      const updated = await api<AutoBackupState>('/api/backup/status');
      setBackupState(updated);
    } catch (err) {
      setBackupMessage(err instanceof Error ? `Error: ${err.message}` : 'Error al generar respaldo');
    } finally {
      setTriggeringBackup(false);
    }
  };

  const handleRunSimulation = async (scenarioOverride?: string) => {
    setSimulating(true);
    setSimError('');
    const targetScenario = scenarioOverride || selectedScenario;
    const sats = Number(simSatsInput) || 50000;
    try {
      const report = await api<SimulationReport>('/api/simulation/run', {
        method: 'POST',
        headers: { 'X-Requested-With': 'mostro-community' },
        body: JSON.stringify({
          scenario: targetScenario,
          trade_sats: sats,
        }),
      });
      setSimulationReport(report);
    } catch (err) {
      setSimError(err instanceof Error ? err.message : 'Error al ejecutar la simulación');
    } finally {
      setSimulating(false);
    }
  };

  const handleGenerateIdentity = async () => {
    setIsGeneratingIdentity(true);
    setApiError('');
    try {
      const res = await api<{ nsec: string; npub: string; status: string }>('/api/identity/generate', {
        method: 'POST',
        body: JSON.stringify({})
      });
      setGeneratedIdentity({ nsec: res.nsec, npub: res.npub });
      setHasBackedUpNsec(false);
      void refresh();
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Error al generar identidad');
    } finally {
      setIsGeneratingIdentity(false);
    }
  };

  const handleImportIdentity = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importNsec.trim()) return;
    setIsImporting(true);
    setImportError('');
    try {
      const res = await api<{ npub: string; status: string }>('/api/identity/import', {
        method: 'POST',
        body: JSON.stringify({ nsec: importNsec.trim() })
      });
      setIsImportModalOpen(false);
      setImportNsec('');
      setNotice(`✓ Identidad importada con éxito: ${res.npub}`);
      void refresh();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Error al importar identidad');
    } finally {
      setIsImporting(false);
    }
  };

  const applyCommissionBondPreset = (preset: CommissionBondPreset) => {
    markDirty();
    setDraft((old) => ({
      ...old,
      market: {
        ...old.market,
        fee_bps: preset.feeBps,
        dev_fee_bps: preset.devFeeBps,
        max_routing_fee_bps: preset.maxRoutingFeeBps,
      },
      safety: {
        ...old.safety,
        bond_enabled: preset.bondEnabled,
        bond_bps: preset.bondBps,
        base_bond_sats: preset.baseBondSats,
        bond_apply_to: preset.bondApplyTo,
        automatic_timeout_slash: preset.automaticTimeoutSlash,
      },
    }));
    setFeeInputs({
      fee: percent(preset.feeBps),
      devFee: percent(preset.devFeeBps),
      routingFee: percent(preset.maxRoutingFeeBps),
      bond: percent(preset.bondBps),
    });
    setNotice(
      draft.community.language === 'en'
        ? `✓ Preset applied: ${preset.nameEn}`
        : `✓ Plantilla de comisiones aplicada: ${preset.nameEs}`
    );
  };

  const markDirty = () => { setDirty(true); setSaved(false); };
  const refreshSafely = () => { if (dirty && !window.confirm('Hay cambios sin guardar. ¿Descartarlos y recargar la configuración?')) return; void refresh(); };
  const updateCommunity = (key: keyof Configuration['community'], value: string) => { markDirty(); setDraft((old) => ({ ...old, community: { ...old.community, [key]: value } })); };
  const updateMarket = (key: keyof Configuration['market'], value: unknown) => { markDirty(); setDraft((old) => ({ ...old, market: { ...old.market, [key]: value } })); };
  const updateSafety = (key: keyof Configuration['safety'], value: unknown) => { markDirty(); setDraft((old) => ({ ...old, safety: { ...old.safety, [key]: value } })); };
  const toggleCurrency = (code: string) => {
    markDirty();
    const exists = draft.market.fiat_currencies.includes(code);
    if (exists) {
      updateMarket('fiat_currencies', draft.market.fiat_currencies.filter((c) => c !== code));
    } else {
      if (draft.market.fiat_currencies.length >= 30) {
        setApiError(
          draft.community.language === 'en'
            ? 'Maximum 30 fiat currencies allowed by Mostro'
            : 'Máximo 30 monedas fiat permitidas por Mostro'
        );
        return;
      }
      updateMarket('fiat_currencies', [...draft.market.fiat_currencies, code]);
    }
  };
  const handleCurrencyKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredCurrencies.length > 0) {
        toggleCurrency(filteredCurrencies[0].code);
        setCurrencySearchQuery('');
      }
    }
  };
  const addRelay = () => { const url = relayInput.trim(); if (url && !draft.nostr.relays.includes(url)) { markDirty(); setDraft((old) => ({ ...old, nostr: { relays: [...old.nostr.relays, url] } })); } setRelayInput(''); };
  const updateFee = (key: keyof typeof feeInputs, marketKey: keyof Configuration['market'] | 'bond_bps', value: string) => {
    markDirty(); setFeeInputs((old) => ({ ...old, [key]: value }));
    const bps = Math.round(Number(value || 0) * 100);
    if (marketKey === 'bond_bps') updateSafety(marketKey, bps); else updateMarket(marketKey, bps);
  };
  const saveConfig = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true); setNotice('');
    if (!communityLoaded) { setSaving(false); setApiError('Recarga la configuración para obtener una revisión válida antes de guardar.'); return; }
    if (['fee', 'devFee', 'routingFee'].some((key) => feeInputs[key as keyof typeof feeInputs] === '') || (draft.safety.bond_enabled && feeInputs.bond === '')) {
      setSaving(false); setApiError('Elige un porcentaje para cada comisión. Usa 0 si no deseas cobrarla.'); return;
    }
    if (draft.community.contact.trim()) {
      try { const contactUrl = new URL(draft.community.contact); if (!['http:', 'https:'].includes(contactUrl.protocol)) throw new Error(); }
      catch { setSaving(false); setApiError('El contacto debe ser una URL que empiece con http:// o https://.'); return; }
    }
    try {
      const response = await api<CommunityReply>('/api/community', { method: 'PUT', headers: { 'X-Requested-With': 'mostro-community' }, body: JSON.stringify({ revision, config: draft }) });
      setRevision(response.revision); setDraft(response.config || draft); setSaved(true); setDirty(false); setNotice('Configuración guardada.'); setApiError('');
      await refresh();
    } catch (err) { setNotice(''); setApiError(err instanceof Error ? err.message : 'No se pudo guardar la configuración.'); }
    finally { setSaving(false); }
  };
  const handleActivateDaemon = async () => {
    if (!window.confirm('¿Deseas activar la configuración para el daemon Mostro con las reglas del borrador actual?')) return;
    setActivatingDaemon(true);
    try {
      await api('/api/daemon/activate', {
        method: 'PUT',
        headers: { 'X-Requested-With': 'mostro-community' },
      });
      setNotice('Configuración activa de Mostro activada con éxito.');
      await refresh();
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Error al activar el daemon');
    } finally {
      setActivatingDaemon(false);
    }
  };
  const handleDeactivateDaemon = async () => {
    if (!window.confirm('¿Deseas desactivar la configuración activa de Mostro?')) return;
    setActivatingDaemon(true);
    try {
      await api('/api/daemon/deactivate', {
        method: 'PUT',
        headers: { 'X-Requested-With': 'mostro-community' },
      });
      setNotice('Configuración activa desactivada.');
      await refresh();
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Error al desactivar el daemon');
    } finally {
      setActivatingDaemon(false);
    }
  };
  const hasActiveConfiguration = daemon?.state === 'active_ready' || daemon?.state === 'active_running';
  const isDaemonRunning = daemon?.state === 'active_running';
  const nodeInMaintenance = Boolean(daemon?.announced_fresh && daemon.announced?.tags?.maintenance_mode === 'true');
  const readiness = useMemo(() => [Boolean(draft.community.name.trim()), draft.market.fiat_currencies.length > 0, draft.nostr.relays.length > 0, draft.payment_methods.some((method) => method.active)].filter(Boolean).length, [draft]);
  const activeCategories = useMemo(() => {
    const seen = new Set<string>();
    draft.payment_methods.forEach((m) => {
      const trimmed = m.category.trim();
      if (trimmed) seen.add(trimmed);
    });
    return Array.from(seen).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }, [draft.payment_methods]);

  useEffect(() => {
    if (page !== 'config') return;

    const handleScroll = () => {
      const scrollPos = window.scrollY + 130;
      for (let i = configNavSections.length - 1; i >= 0; i--) {
        const item = configNavSections[i];
        const el = document.getElementById(item.id);
        if (el && scrollPos >= el.offsetTop) {
          setActiveConfigNav(item.id);
          break;
        }
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener('scroll', handleScroll);
  }, [page]);
  const statuses = dashboard ? [
    { title: 'Mostro', icon: 'grid', data: dashboard.mostro },
    { title: 'Lightning', icon: 'bolt', data: dashboard.lightning },
    { title: 'Bitcoin', icon: 'bitcoin', data: dashboard.bitcoin },
  ] : [];
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><img className="brand-mark" src="/brand-mark.png" alt="" aria-hidden="true"/><div className="brand-copy"><b>MOSTRO</b><span>COMMUNITY MANAGER</span></div></div>
      <div className="workspace-label">ESPACIO DE TRABAJO</div>
      <div className="workspace"><div className="workspace-icon">{(draft.community.name || 'MC').slice(0, 2).toUpperCase()}</div><div><b>{draft.community.name || 'Mi comunidad'}</b><span>Entorno local</span></div><span className="workspace-chevron">⌄</span></div>
      <div className="nav-label">GENERAL</div>
      <nav className="nav-list" aria-label="Navegación principal">
        <button className={`nav-item ${page === 'dashboard' ? 'active' : ''}`} onClick={() => setPage('dashboard')}><Icon name="grid"/><span>Panel general</span>{page === 'dashboard' && <span className="nav-active-mark"/>}</button>
        <button className={`nav-item ${page === 'orders' ? 'active' : ''}`} onClick={() => setPage('orders')}><Icon name="bolt"/><span>Órdenes públicas</span>{page === 'orders' && <span className="nav-active-mark"/>}</button>
        <button className={`nav-item ${page === 'mediation' ? 'active' : ''}`} onClick={() => setPage('mediation')}><Icon name="shield"/><span>Mediación</span>{page === 'mediation' && <span className="nav-active-mark"/>}</button>
        <button className={`nav-item ${page === 'simulation' ? 'active' : ''}`} onClick={() => setPage('simulation')}><Icon name="play"/><span>Simulador P2P</span>{page === 'simulation' && <span className="nav-active-mark"/>}</button>
        <button className={`nav-item ${page === 'liquidity' ? 'active' : ''}`} onClick={() => setPage('liquidity')}><Icon name="bitcoin"/><span>Operaciones LND</span>{page === 'liquidity' && <span className="nav-active-mark"/>}</button>
        <button className={`nav-item ${page === 'config' ? 'active' : ''}`} onClick={() => setPage('config')}><Icon name="sliders"/><span>Configuración</span>{page === 'config' && <span className="nav-active-mark"/>}</button>
      </nav>
      <div className="sidebar-spacer" />
      <div className="sidebar-bottom"><div className="mode-card"><span className="mode-icon"><Icon name="globe" size={16}/></span><div><b>{isDaemonRunning ? 'Nodo Mostro activo' : hasActiveConfiguration ? 'Configuración preparada' : 'Modo desarrollo'}</b><span>{isDaemonRunning ? 'Mercado en línea' : hasActiveConfiguration ? 'Mercado sin verificar' : 'Mercado sin iniciar'}</span></div><span className="mode-dot" style={isDaemonRunning ? { background: '#52c41a', boxShadow: '0 0 8px rgba(82,196,26,0.6)' } : {}}/></div><div className="sidebar-footer"><span className="avatar">MC</span><div><b>Administrador</b><span>Configuración local</span></div></div></div>
    </aside>
    <main className="main-area">
      <header className="topbar"><div className="breadcrumb"><span>Mi comunidad</span><Icon name="chevron" size={14}/><b>{page === 'dashboard' ? 'Panel general' : page === 'orders' ? 'Órdenes públicas' : page === 'mediation' ? 'Consola de mediación' : page === 'simulation' ? 'Simulador P2P' : page === 'liquidity' ? 'Operaciones LND y Liquidez' : 'Configuración'}</b></div><div className="top-actions"><span className="environment-pill"><i/> Desarrollo</span><button className="icon-button" aria-label="Abrir mediación" onClick={() => setPage('mediation')}><Icon name="shield" size={17}/></button><button className="icon-button" aria-label="Abrir simulador" onClick={() => setPage('simulation')}><Icon name="play" size={17}/></button><button className="icon-button" aria-label="Abrir liquidez LND" onClick={() => setPage('liquidity')}><Icon name="bitcoin" size={17}/></button><button className="icon-button" aria-label="Abrir configuración" onClick={() => setPage('config')}><Icon name="sliders" size={17}/></button><span className="top-avatar">MC</span></div></header>
      {page === 'dashboard' && (
        <section className="content dashboard-page">
        <div className="page-heading"><div><div className="eyebrow">MOSTRO COMMUNITY MANAGER <span className="eyebrow-sep">/</span> INICIO</div><h1>Panel general</h1><p>Estado de tu instancia y preparación de la comunidad.</p></div><div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>{daemon?.can_activate && (<button type="button" className={`button ${hasActiveConfiguration ? 'button-secondary' : 'button-primary'}`} onClick={() => void (hasActiveConfiguration ? handleDeactivateDaemon() : handleActivateDaemon())} disabled={activatingDaemon || loading} title={hasActiveConfiguration ? 'Desactivar demonio Mostro' : 'Activar demonio Mostro'}>{activatingDaemon ? 'Procesando...' : hasActiveConfiguration ? 'Desactivar Mostro (Off)' : 'Activar Mostro (On)'}</button>)}<button className="button button-secondary refresh-button" onClick={() => void refresh()} disabled={loading}><span className={loading ? 'spin' : ''}>↻</span> Actualizar</button></div></div>
        <div className="dev-banner" style={isDaemonRunning ? { background: 'rgba(82, 196, 26, 0.08)', borderColor: 'rgba(82, 196, 26, 0.3)' } : {}}><div className="banner-icon"><Icon name={isDaemonRunning ? 'check' : 'alert'} size={18}/></div><div><b>{isDaemonRunning ? 'Nodo Mostro en ejecución' : hasActiveConfiguration ? 'Configuración preparada' : 'Entorno de desarrollo'}</b><span>{isDaemonRunning ? 'El motor Mostro está activo y sincronizado con tu configuración. El nodo anuncia y procesa órdenes en los relays Nostr configurados.' : hasActiveConfiguration ? 'La configuración está guardada. Comprueba en tu cliente la identidad, versión y reglas anunciadas por el nodo antes de operar; el arranque y la recepción de órdenes requieren verificación.' : 'Activa la configuración de tu comunidad y verifica el arranque del daemon antes de operar.'}</span></div><div className="banner-status" style={isDaemonRunning ? { color: '#7ee0a5', borderColor: 'rgba(82, 196, 26, 0.4)' } : {}}><i style={isDaemonRunning ? { background: '#52c41a' } : {}}/> {isDaemonRunning ? 'MERCADO EN LÍNEA' : hasActiveConfiguration ? 'MERCADO SIN VERIFICAR' : 'MERCADO SIN INICIAR'}</div></div>
        {!daemon?.identity_present && (
          <section className="onboarding-banner-card" aria-labelledby="onboarding-title">
            <div className="onboarding-banner-header">
              <div className="onboarding-badge">PASO 1 · IDENTIDAD NOSTR SOBERANA</div>
              <h2 id="onboarding-title">Inicia tu Comunidad Mostro P2P</h2>
              <p>
                Para que tu nodo Mostro pueda recibir órdenes, comunicarse por chat cifrado y liquidar intercambios de forma autónoma en Nostr, necesita una clave criptográfica (nsec/npub). Puedes crear una nueva en 1 clic o importar una existente.
              </p>
            </div>
            <div className="onboarding-action-buttons">
              <button
                type="button"
                className="button button-primary onboarding-btn-main"
                onClick={() => void handleGenerateIdentity()}
                disabled={isGeneratingIdentity}
              >
                <Icon name="bolt" size={18} />
                <span>{isGeneratingIdentity ? 'Generando identidad...' : 'Crear Nueva Identidad en 1 Clic'}</span>
              </button>
              <button
                type="button"
                className="button button-secondary onboarding-btn-alt"
                onClick={() => {
                  setImportError('');
                  setImportNsec('');
                  setIsImportModalOpen(true);
                }}
                disabled={isGeneratingIdentity}
              >
                <Icon name="save" size={18} />
                <span>Tengo una clave nsec existente</span>
              </button>
            </div>
          </section>
        )}
        <div className="section-title-row"><div><h2>Servicios</h2><p>Conectividad reportada por la instancia local.</p></div><span className="updated-label">{loading ? 'Consultando…' : health ? 'API disponible' : 'API sin conexión'}</span></div>
        <div className="service-grid">{statuses.length ? statuses.map(({ title, icon, data }) => <article className="service-card" key={title}><div className="service-top"><span className="service-icon"><Icon name={icon}/></span><span className="service-status"><StatusDot status={data.status}/>{({ online: 'Conectado', offline: 'Sin conexión', unconfigured: 'Sin configurar', unknown: 'Desconocido', warning: 'Revisar' } as Record<string, string>)[data.status] || 'Desconocido'}</span></div><h3>{title}</h3><p>{data.detail || 'Sin detalles disponibles'}</p><div className="service-meta">{title === 'Mostro' && (data.version || daemon?.mostro_version) ? <span>v{data.version || daemon?.mostro_version}</span> : null}{title === 'Lightning' && data.alias ? <span>{data.alias}</span> : null}{title === 'Lightning' && typeof data.num_active_channels === 'number' ? <span>{data.num_active_channels} canales activos</span> : null}{title === 'Bitcoin' && typeof data.block_height === 'number' ? <span>Bloque {data.block_height.toLocaleString('es')}</span> : null}<Icon name="arrow" size={15}/></div></article>) : <div className="service-card unavailable"><div className="service-top"><span className="service-icon"><Icon name="grid"/></span><span className="service-status"><StatusDot/>Desconocido</span></div><h3>Servicios no disponibles</h3><p>{apiError || 'La API aún no informa el estado de los servicios.'}</p><div className="service-meta"><span>Reintenta cuando el servidor esté disponible</span></div></div>}</div>
        {dashboard?.lightning && <section className="lightning-details" aria-labelledby="lightning-details-title"><div className="lightning-heading"><div><h2 id="lightning-details-title">Detalles de Lightning</h2><p>Información reportada por el nodo.</p></div>{dashboard.lightning.network && <span className="network-tag">Red {dashboard.lightning.network}</span>}</div>{dashboard.lightning.num_active_channels === 0 && <p className="lightning-capacity-note" role="status">LND está conectado, pero no tiene canales activos. El mercado no tiene capacidad de intercambio Lightning.</p>}<div className="lightning-stats"><div><span>Sincronización de cadena</span><strong>{dashboard.lightning.synced_to_chain === true ? 'Sincronizado' : dashboard.lightning.synced_to_chain === false ? 'Pendiente' : 'Desconocido'}</strong></div><div><span>Sincronización del grafo</span><strong>{dashboard.lightning.synced_to_graph === true ? 'Sincronizado' : dashboard.lightning.synced_to_graph === false ? 'Pendiente' : 'Desconocido'}</strong></div><div><span>Canales activos</span><strong>{typeof dashboard.lightning.num_active_channels === 'number' ? dashboard.lightning.num_active_channels : 'Desconocido'}</strong></div><div><span>Canales pendientes</span><strong>{typeof dashboard.lightning.num_pending_channels === 'number' ? dashboard.lightning.num_pending_channels : 'Desconocido'}</strong></div><div><span>Canales inactivos</span><strong>{typeof dashboard.lightning.num_inactive_channels === 'number' ? dashboard.lightning.num_inactive_channels : 'Desconocido'}</strong></div></div><div className="liquidity-row"><div><span>Liquidez local</span><strong>{dashboard.lightning.liquidity?.status === 'available' && dashboard.lightning.liquidity.local_balance_sats !== null ? `${dashboard.lightning.liquidity.local_balance_sats} sats` : 'Desconocida'}</strong></div><div><span>Liquidez remota</span><strong>{dashboard.lightning.liquidity?.status === 'available' && dashboard.lightning.liquidity.remote_balance_sats !== null ? `${dashboard.lightning.liquidity.remote_balance_sats} sats` : 'Desconocida'}</strong></div><p>{dashboard.lightning.liquidity?.status === 'unavailable' ? dashboard.lightning.liquidity.detail || 'El nodo no informa la liquidez.' : 'Los datos de canales y liquidez no garantizan que una ruta o una operación esté disponible.'}</p></div><div style={{ marginTop: '10px', textAlign: 'right' }}><button type="button" className="button button-secondary" style={{ fontSize: '12px', height: '28px' }} onClick={() => setPage('liquidity')}>Operaciones LND y Guía de Liquidez →</button></div></section>}
        {connection && connection.status === 'ready' && (
          <section className="connection-card" aria-labelledby="connection-title">
            <div className="connection-heading">
              <div>
                <h2 id="connection-title">Conexión de clientes con este nodo</h2>
                <p>Un cliente necesita la clave pública del nodo y sus relays. Comisiones, límites y garantía los lee del evento de información que publica el daemon.</p>
              </div>
              <a href={connection.app_download_url} target="_blank" rel="noreferrer" className="button button-secondary download-link">
                Mostro App ↗
              </a>
            </div>

            <div className="connection-body">
              <div className="connection-qr-pane">
                <div className="qr-toggle-group">
                  <button
                    type="button"
                    className={`qr-toggle-btn ${qrFormat === 'card' ? 'active' : ''}`}
                    onClick={() => setQrFormat('card')}
                  >
                    Tarjeta firmada
                  </button>
                  <button
                    type="button"
                    className={`qr-toggle-btn ${qrFormat === 'uri' ? 'active' : ''}`}
                    onClick={() => setQrFormat('uri')}
                  >
                    nprofile
                  </button>
                  <button
                    type="button"
                    className={`qr-toggle-btn ${qrFormat === 'json' ? 'active' : ''}`}
                    onClick={() => setQrFormat('json')}
                  >
                    JSON
                  </button>
                </div>

                <div className="qr-box-wrapper">
                  {(() => {
                    const svg = qrFormat === 'card' ? connection.qr_card_svg : qrFormat === 'uri' ? connection.qr_svg : connection.qr_json_svg;
                    return svg ? (
                      <div className="qr-box" dangerouslySetInnerHTML={{ __html: svg }} title="Código QR de conexión" />
                    ) : (
                      <span className="empty-hint">Sin tarjeta: guarda la configuración de la comunidad. El nombre, la web y el contacto no pueden contener «&», ni los relays y métodos de pago «&» o «,».</span>
                    );
                  })()}
                </div>

                <span className="qr-hint-caption">
                  {qrFormat === 'card'
                    ? 'Tarjeta de la comunidad firmada por el nodo (mostro://community/…): nombre, relays, moneda y métodos de pago'
                    : qrFormat === 'uri'
                      ? 'Solo identidad y relays (nprofile). El cliente no recibe moneda ni métodos de pago'
                      : 'La misma tarjeta firmada, como JSON'}
                </span>
              </div>

              <div className="connection-details">
                <div className="connection-row">
                  <span className="field-label">Clave pública Nostr (npub)</span>
                  <div className="copy-box">
                    <code>{connection.npub}</code>
                    <button type="button" className="copy-button" onClick={() => copyText(connection.npub || '', 'npub')}>
                      {copiedField === 'npub' ? 'Copiado ✓' : 'Copiar'}
                    </button>
                  </div>
                </div>

                <div className="connection-row">
                  <span className="field-label">Identificador hex del nodo</span>
                  <div className="copy-box">
                    <code>{connection.pubkey_hex}</code>
                    <button type="button" className="copy-button" onClick={() => copyText(connection.pubkey_hex || '', 'hex')}>
                      {copiedField === 'hex' ? 'Copiado ✓' : 'Copiar'}
                    </button>
                  </div>
                </div>

                {qrFormat === 'card' ? (
                  connection.card_uri && (
                    <div className="connection-row">
                      <span className="field-label">Enlace de la tarjeta firmada</span>
                      <div className="copy-box">
                        <code>{connection.card_uri}</code>
                        <button type="button" className="copy-button" onClick={() => copyText(connection.card_uri || '', 'card_uri')}>
                          {copiedField === 'card_uri' ? 'Copiado ✓' : 'Copiar'}
                        </button>
                      </div>
                    </div>
                  )
                ) : qrFormat === 'uri' ? (
                  connection.nostr_uri && (
                    <div className="connection-row">
                      <span className="field-label">Enlace con nprofile (identidad y relays)</span>
                      <div className="copy-box">
                        <code>{connection.nostr_uri}</code>
                        <button type="button" className="copy-button" onClick={() => copyText(connection.nostr_uri || '', 'uri')}>
                          {copiedField === 'uri' ? 'Copiado ✓' : 'Copiar'}
                        </button>
                      </div>
                    </div>
                  )
                ) : (
                  connection.json_uri && (
                    <div className="connection-row">
                      <span className="field-label">Tarjeta firmada en JSON</span>
                      <div className="copy-box">
                        <code>{connection.json_uri}</code>
                        <button type="button" className="copy-button" onClick={() => copyText(connection.json_uri || '', 'json_uri')}>
                          {copiedField === 'json_uri' ? 'Copiado ✓' : 'Copiar'}
                        </button>
                      </div>
                    </div>
                  )
                )}

                <div className="connection-relays-row">
                  <span className="field-label">Relays Nostr:</span>
                  {connection.relays.length > 0 ? (
                    <div className="chips">
                      {connection.relays.map((r) => <span key={r} className="chip">{r}</span>)}
                    </div>
                  ) : (
                    <span className="empty-hint">Sin relays guardados en el borrador</span>
                  )}
                </div>
              </div>
            </div>
          </section>
        )}
        {daemon && (
          <section className="daemon-card" aria-labelledby="daemon-title">
            <div className="daemon-heading">
              <div>
                <h2 id="daemon-title">Orquestación del Demonio Mostro</h2>
                <p>Control del archivo de configuración activa y estado de arranque del motor P2P.</p>
              </div>
              <span className="service-status">
                <StatusDot status={isDaemonRunning ? 'online' : hasActiveConfiguration || daemon.state === 'configured_standby' ? 'warning' : 'offline'} />
                {isDaemonRunning ? 'En ejecución (Online)' : hasActiveConfiguration ? 'Ejecución sin verificar' : daemon.state === 'configured_standby' ? 'En Espera de Activación' : 'Sin Configurar'}
              </span>
            </div>
            {daemon.warnings.length > 0 && (
              <div className="daemon-warnings" role="alert">
                {daemon.warnings.map((w, idx) => (
                  <div key={idx}>⚠ {w}</div>
                ))}
              </div>
            )}
            <div className="daemon-grid">
              <div className="daemon-grid-item">
                <span>Versión del daemon Mostro</span>
                <strong>{daemon.mostro_version ? `v${daemon.mostro_version}` : 'Desconocida'}</strong>
                <small>
                  {daemon.version_source === 'announced'
                    ? 'Anunciada por el daemon en los relays'
                    : daemon.version_source === 'binary'
                      ? 'Binario incluido en el paquete; el daemon aún no la anuncia'
                      : 'Versión fijada por el paquete; sin confirmar'}
                </small>
              </div>
              <div className="daemon-grid-item">
                <span>Anuncio del nodo en relays</span>
                <strong>
                  {daemon.announced && typeof daemon.announced_age_secs === 'number'
                    ? `Hace ${formatAge(daemon.announced_age_secs)}`
                    : 'Sin anuncio'}
                </strong>
                <small>
                  {daemon.announced_fresh
                    ? 'Reciente: los clientes ven el nodo activo'
                    : daemon.announced
                      ? 'Antiguo: los clientes pueden darlo por inactivo'
                      : 'El daemon publica su información cada 5 minutos'}
                </small>
              </div>
              <div className="daemon-grid-item">
                <span>Protocolo de mensajes</span>
                <strong>{`v${daemon.protocol_version || 2} (kind 14, NIP-44)`}</strong>
              </div>
              <div className="daemon-grid-item">
                <span>Identidad Nostr del bot</span>
                <strong>{daemon.npub ? daemon.npub.slice(0, 16) + '...' + daemon.npub.slice(-8) : 'No importada'}</strong>
              </div>
              <div className="daemon-grid-item">
                <span>Revisión borrador</span>
                <strong>{daemon.draft_revision !== null && daemon.draft_revision !== undefined ? `Revisión ${daemon.draft_revision}` : 'Sin borrador'}</strong>
              </div>
              <div className="daemon-grid-item">
                <span>Configuración activa</span>
                <strong>{daemon.active_revision ? `Revisión ${daemon.active_revision}` : 'Ninguna'}</strong>
              </div>
              <div className="daemon-grid-item">
                <span>SHA-256 settings.toml</span>
                <strong>{daemon.active_settings_hash ? daemon.active_settings_hash.slice(0, 16) + '...' : 'Inactivo'}</strong>
              </div>
            </div>
            <div className="daemon-actions">
              {daemon.can_activate && (
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => void handleActivateDaemon()}
                  disabled={activatingDaemon}
                >
                  {activatingDaemon ? 'Activando...' : hasActiveConfiguration ? 'Reactivar Mostro / Actualizar Configuración' : 'Activar Mostro'}
                </button>
              )}
              {hasActiveConfiguration && (
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => void handleDeactivateDaemon()}
                  disabled={activatingDaemon}
                >
                  Desactivar Mostro
                </button>
              )}
            </div>
          </section>
        )}
        <section className="connection-card" aria-labelledby="order-help-title">
          <h2 id="order-help-title">Reglas para crear órdenes desde cualquier cliente</h2>
          <p>Una orden lleva un importe fijo en sats o un precio de mercado con prima, nunca ambos. Mostro rechaza la combinación con «invalid_parameters».</p>
          <details>
            <summary>Cómo resolver «Invalid parameters» o «prima no válida»</summary>
            <ul>
              <li><strong>Precio de mercado:</strong> Amount = 0, Fiat = 5 USD y Premium = 10 para +10 %. Mostro calcula los sats con su cotización cuando alguien toma la orden.</li>
              <li><strong>Importe fijo:</strong> Amount = 10000, Fiat = 5 USD y Premium = 0.</li>
              <li><strong>Rango:</strong> mínimo y máximo en fiat, Amount = 0 y Fiat = 0. La prima es opcional.</li>
            </ul>
            <p>El importe fiat y la prima son números enteros. Los sats resultantes deben estar entre el mínimo y el máximo del nodo y la moneda debe estar admitida. La prima de una orden no es la comisión del nodo.</p>
            <p>Si una app envía los sats estimados junto con una prima, el fallo está en la app: debe enviar Amount = 0. La guía <code>docs/INTEGRACION-APPS.md</code> del repositorio detalla el contrato completo para desarrolladores.</p>
            <p>Si el cliente muestra otra versión o límites distintos de los configurados aquí, compara la clave pública y los relays, y revisa arriba el anuncio del nodo en relays.</p>
          </details>
        </section>
        <section className="sim-card" aria-labelledby="sim-title">
          <div className="sim-heading">
            <div>
              <h2 id="sim-title">Simulador Sintético de Protocolo P2P</h2>
              <p>Modelo interactivo sintético de órdenes, Hold Invoices Lightning, eventos Nostr y resolución de disputas (dry-run en memoria, con la secuencia de Mostro v0.19.2).</p>
            </div>
            <button className="button button-secondary" onClick={() => setPage('simulation')}>
              Abrir Simulador Completo <Icon name="arrow" size={14}/>
            </button>
          </div>
          <div className="sim-controls">
            <div className="sim-control-group">
              <label>Escenario de prueba</label>
              <select value={selectedScenario} onChange={(e) => setSelectedScenario(e.target.value)}>
                {simScenarios.length > 0 ? simScenarios.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                )) : (
                  <>
                    <option value="happy_path">Intercambio Exitoso (Happy Path)</option>
                    <option value="dispute_settled_for_buyer">Disputa Resuelta a Favor del Comprador</option>
                    <option value="dispute_refunded_to_seller">Disputa con Reembolso al Vendedor</option>
                    <option value="seller_cancellation">Cancelación de Orden por el Vendedor</option>
                  </>
                )}
              </select>
            </div>
            <div className="sim-control-group">
              <label>Monto de la orden (satoshis)</label>
              <input type="number" min="1000" step="1000" value={simSatsInput} onChange={(e) => setSimSatsInput(e.target.value)} />
            </div>
            <div style={{ marginTop: 'auto', display: 'flex', gap: '8px' }}>
              <button
                type="button"
                className="button button-primary"
                onClick={() => void handleRunSimulation()}
                disabled={simulating}
              >
                <Icon name="play" size={14}/> {simulating ? 'Simulando ciclo...' : 'Ejecutar Simulación'}
              </button>
            </div>
          </div>
          {simError && <div className="form-message error">{simError}</div>}
          {simulationReport && (
            <div>
              <div className="sim-complete-banner">
                <span>✓ Simulación sintética ejecutada: {simulationReport.scenario} (Orden: {simulationReport.order_id})</span>
                <span>Estado: <code>{simulationReport.final_status}</code> ({simulationReport.duration_simulated_ms} ms)</span>
              </div>
              <div className="sim-financials">
                <div className="sim-financial-item">
                  <span>Monto Orden</span>
                  <strong>{simulationReport.financials.trade_amount_sats.toLocaleString()} sats</strong>
                  <small>≈ {simulationReport.financials.fiat_amount} {simulationReport.financials.fiat_currency}</small>
                </div>
                <div className="sim-financial-item">
                  <span>Garantía Vendedor</span>
                  <strong>{simulationReport.financials.seller_bond_sats.toLocaleString()} sats</strong>
                  <small>Factura retenida aparte</small>
                </div>
                <div className="sim-financial-item">
                  <span>Garantía Comprador</span>
                  <strong>{simulationReport.financials.buyer_bond_sats.toLocaleString()} sats</strong>
                  <small>Factura retenida aparte</small>
                </div>
                <div className="sim-financial-item">
                  <span>Comisión Mostro</span>
                  <strong>{(simulationReport.financials.total_mostro_fee_sats ?? simulationReport.financials.fee_sats ?? 0).toLocaleString()} sats</strong>
                  <small>{draft.market.fee_bps / 100}% en total, la mitad por parte</small>
                </div>
                <div className="sim-financial-item">
                  <span>Depósito del Vendedor</span>
                  <strong>{(simulationReport.financials.seller_hold_invoice_sats ?? simulationReport.financials.seller_total_locked_sats).toLocaleString()} sats</strong>
                  <small>Orden + su mitad de la comisión</small>
                </div>
              </div>
              <div style={{ textAlign: 'right', marginTop: '6px' }}>
                <button type="button" className="button button-secondary" onClick={() => setPage('simulation')}>
                  Ver los {simulationReport.steps.length} pasos detallados en el Simulador →
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="connection-card" aria-labelledby="notifications-title" style={{ marginTop: '16px' }}>
          <div className="connection-heading">
            <div>
              <h2 id="notifications-title">Alertas y Notificaciones de Eventos (SSE en vivo)</h2>
              <p>Transmisión reactiva en tiempo real sobre la salud de relays, órdenes en disputa y eventos críticos del nodo.</p>
            </div>
            <span className="service-status">
              <StatusDot status={notifications.some((n) => n.level === 'error' || n.level === 'critical') ? 'warning' : 'online'} />
              {notifications.length} eventos registrados
            </span>
          </div>
          {notifications.length === 0 ? (
            <p className="empty-hint" style={{ padding: '16px 0' }}>No hay alertas recientes; el nodo opera de manera estable.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' }}>
              {notifications.slice(0, 6).map((n) => (
                <div key={n.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'rgba(255,255,255,0.03)', borderRadius: '6px', borderLeft: `3px solid ${n.level === 'error' ? '#ef4444' : n.level === 'warning' ? '#f59e0b' : '#10b981'}` }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: '13px', textTransform: 'uppercase', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: n.level === 'error' ? 'rgba(239,68,68,0.2)' : n.level === 'warning' ? 'rgba(245,158,11,0.2)' : 'rgba(16,185,129,0.2)', color: n.level === 'error' ? '#ef4444' : n.level === 'warning' ? '#f59e0b' : '#10b981' }}>{n.category}</span>
                      <strong style={{ fontSize: '16px' }}>{n.title}</strong>
                    </div>
                    <p style={{ margin: '4px 0 0 0', fontSize: '15px', color: '#9ca3af' }}>{n.message}</p>
                  </div>
                  <span style={{ fontSize: '14px', color: '#6b7280' }}>
                    {n.timestamp ? new Date(n.timestamp * 1000).toLocaleTimeString('es') : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="connection-card" aria-labelledby="backup-title" style={{ marginTop: '16px' }}>
          <div className="connection-heading">
            <div>
              <h2 id="backup-title">Backups Automáticos Offsite y Persistencia</h2>
              <p>Exportación cifrada periódica con retención en carpeta segura (0700/0600) y medio secundario.</p>
            </div>
            <span className="service-status">
              <StatusDot status={backupState?.enabled ? 'online' : 'warning'} />
              {backupState?.enabled ? 'Worker Automático Activo' : 'En Espera de Frase / Manual'}
            </span>
          </div>
          <div className="daemon-grid" style={{ marginTop: '12px' }}>
            <div className="daemon-grid-item">
              <span>Carpeta secundaria</span>
              <strong>{backupState?.target_dir || '/data/backup'}</strong>
            </div>
            <div className="daemon-grid-item">
              <span>Política de retención</span>
              <strong>{backupState?.retention_count ?? 7} respaldos más recientes</strong>
            </div>
            <div className="daemon-grid-item">
              <span>Intervalo de respaldo</span>
              <strong>{backupState?.interval_secs ? `${Math.round(backupState.interval_secs / 3600)} horas` : 'Diario (24h)'}</strong>
            </div>
            <div className="daemon-grid-item">
              <span>Último respaldo ejecutado</span>
              <strong>{backupState?.last_run_timestamp ? new Date(backupState.last_run_timestamp * 1000).toLocaleString('es') : 'Sin ejecuciones recientes'}</strong>
            </div>
          </div>
          {backupState?.last_error && (
            <div className="daemon-warnings" style={{ marginTop: '12px' }}>
              <div>⚠ {backupState.last_error}</div>
            </div>
          )}
          {backupMessage && (
            <div style={{ marginTop: '12px', padding: '10px 14px', borderRadius: '6px', background: backupMessage.startsWith('✓') ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)', color: backupMessage.startsWith('✓') ? '#10b981' : '#ef4444', fontSize: '15px' }}>
              {backupMessage}
            </div>
          )}
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: '14px', flexWrap: 'wrap' }}>
            <input
              type="password"
              placeholder="Frase de cifrado (mínimo 16 caracteres)"
              value={backupPassphrase}
              onChange={(e) => setBackupPassphrase(e.target.value)}
              style={{ flex: '1 1 240px', padding: '8px 12px', borderRadius: '6px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.15)', color: '#fff' }}
            />
            <button
              type="button"
              className="button button-primary"
              onClick={() => void handleTriggerBackup()}
              disabled={triggeringBackup || (backupPassphrase.length > 0 && backupPassphrase.length < 16)}
            >
              {triggeringBackup ? 'Cifrando respaldo...' : 'Ejecutar Respaldo Ahora'}
            </button>
          </div>
          {backupState?.backups && backupState.backups.length > 0 && (
            <div style={{ marginTop: '16px' }}>
              <span className="field-label">Respaldos verificados en medio secundario ({backupState.backups.length})</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '6px' }}>
                {backupState.backups.slice(0, 5).map((b, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px', fontSize: '15px' }}>
                    <code>{b.filename}</code>
                    <span style={{ color: '#9ca3af' }}>{(b.size_bytes / 1024).toFixed(1)} KB · {new Date(b.modified_timestamp * 1000).toLocaleDateString('es')}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        <div className="dashboard-lower"><article className="setup-card"><div className="card-heading"><div><span className="card-kicker">PUESTA EN MARCHA</span><h2>Prepara tu comunidad</h2><p>Configura los datos esenciales antes de iniciar el mercado.</p></div><div className="progress-ring"><span>{readiness}<small>/4</small></span></div></div><progress className="setup-progress" value={readiness} max={4} aria-label="Preparación de la comunidad"/><div className="setup-checks"><span className={draft.community.name ? 'complete' : ''}><i>{draft.community.name ? <Icon name="check" size={12}/> : '1'}</i>Identidad</span><span className={draft.market.fiat_currencies.length ? 'complete' : ''}><i>{draft.market.fiat_currencies.length ? <Icon name="check" size={12}/> : '2'}</i>Monedas</span><span className={draft.nostr.relays.length ? 'complete' : ''}><i>{draft.nostr.relays.length ? <Icon name="check" size={12}/> : '3'}</i>Relays Nostr</span><span className={draft.payment_methods.some((m) => m.active) ? 'complete' : ''}><i>{draft.payment_methods.some((m) => m.active) ? <Icon name="check" size={12}/> : '4'}</i>Pagos</span></div><button className="button button-primary" onClick={() => setPage('config')}>Abrir configuración <Icon name="arrow" size={15}/></button></article>
          <article className="market-card"><div className="market-card-top"><span className="market-symbol"><Icon name="bolt" size={19}/></span><span className="market-tag"><i/> {dashboard?.market_started ? 'MERCADO ACTIVO' : nodeInMaintenance ? 'EN MANTENIMIENTO' : hasActiveConfiguration ? 'SIN CONFIRMAR' : 'AÚN NO INICIADO'}</span></div><div className="market-empty"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="orbit-center"><span>₿</span></div></div><div className="market-copy"><h3>{dashboard?.market_started ? 'El nodo atiende a los clientes' : nodeInMaintenance ? 'Nodo en mantenimiento' : hasActiveConfiguration ? 'Mercado sin confirmar' : 'Mercado sin iniciar'}</h3><p>{dashboard?.market_started ? 'El daemon anuncia su información en los relays configurados, que es lo que los clientes comprueban antes de operar.' : nodeInMaintenance ? 'El daemon anuncia modo mantenimiento: no acepta órdenes ni tomas nuevas. Las operaciones en curso siguen su proceso.' : hasActiveConfiguration ? 'La configuración está activa, pero el daemon no ha anunciado su información en los relays en los últimos minutos. Revisa la tarjeta del daemon.' : 'Guarda la configuración y activa Mostro para abrir el mercado de tu comunidad.'}</p><span className="market-note"><Icon name="alert" size={14}/> {dashboard?.market_started ? 'Este panel no realiza pagos ni toma órdenes' : 'Sin operaciones que mostrar'}</span></div></article></div>
        <div className="bottom-note"><span className="secure-icon"><Icon name="check" size={13}/></span><span>Configuración local</span><span className="note-separator">·</span><span>Los cambios se guardan en el servidor de esta instancia</span><span className="note-spacer"/><span className="api-indicator"><StatusDot status={health ? 'ok' : ''}/>{health ? 'API conectada' : 'API no disponible'}</span></div>
      </section>
      )}
      {page === 'simulation' && (
        <section className="content simulation-page">
          <div className="page-heading">
            <div>
              <div className="eyebrow">MOSTRO COMMUNITY MANAGER <span className="eyebrow-sep">/</span> PROTOCOLO P2P</div>
              <h1>Simulador Sintético de Protocolo P2P</h1>
              <p>Modelo sintético en memoria para evaluar órdenes, Hold Invoices, eventos Nostr y disputas con las reglas de tu comunidad.</p>
            </div>
            <button className="button button-secondary" onClick={() => void handleRunSimulation()} disabled={simulating}>
              <span className={simulating ? 'spin' : ''}>↻</span> {simulating ? 'Simulando...' : 'Reejecutar Simulación'}
            </button>
          </div>

          <div className="sim-notice-card" style={{ marginBottom: '16px', padding: '12px 16px', background: 'rgba(235, 115, 29, 0.08)', border: '1px solid rgba(235, 115, 29, 0.25)', borderRadius: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
              <span style={{ fontSize: '13px', fontWeight: 700, letterSpacing: '0.06em', color: '#eb731d', textTransform: 'uppercase' }}>Modelo Sintético · Dry-Run en Memoria</span>
            </div>
            <p style={{ margin: 0, fontSize: '15px', color: '#9ba3af', lineHeight: 1.4 }}>
              Este simulador recorre el flujo de una operación, las garantías (bonds) y las comisiones con la configuración guardada, sin ejecutar transacciones en Bitcoin/Lightning ni publicar en relays. La secuencia de mensajes y facturas es la de Mostro v0.19.2; los eventos son sintéticos y la equivalencia fiat es ilustrativa.
            </p>
          </div>

          <div className="sim-card">
            <div className="sim-heading">
              <div>
                <h2>Parámetros del Ciclo de Prueba</h2>
                <p>Elige el escenario de prueba y la cantidad de satoshis a transaccionar.</p>
              </div>
            </div>
            <div className="sim-controls">
              <div className="sim-control-group" style={{ flex: '1 1 280px' }}>
                <label>Escenario de prueba</label>
                <select value={selectedScenario} onChange={(e) => setSelectedScenario(e.target.value)}>
                  {simScenarios.length > 0 ? simScenarios.map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  )) : (
                    <>
                      <option value="happy_path">Intercambio Exitoso (Happy Path)</option>
                      <option value="dispute_settled_for_buyer">Disputa Resuelta a Favor del Comprador</option>
                      <option value="dispute_refunded_to_seller">Disputa con Reembolso al Vendedor</option>
                      <option value="seller_cancellation">Cancelación de Orden por el Vendedor</option>
                    </>
                  )}
                </select>
              </div>
              <div className="sim-control-group">
                <label>Monto de la orden (sats)</label>
                <input
                  type="number"
                  min="1000"
                  step="1000"
                  value={simSatsInput}
                  onChange={(e) => setSimSatsInput(e.target.value)}
                />
              </div>
              <div style={{ marginTop: 'auto' }}>
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => void handleRunSimulation()}
                  disabled={simulating}
                >
                  <Icon name="play" size={14}/> {simulating ? 'Simulando ciclo...' : 'Ejecutar Simulación'}
                </button>
              </div>
            </div>

            {simError && <div className="form-message error">{simError}</div>}

            {simulationReport ? (
              <>
                <div className="sim-complete-banner">
                  <div>
                    <strong>Escenario:</strong> {simulationReport.scenario} · <strong>Orden:</strong> <code>{simulationReport.order_id}</code>
                  </div>
                  <div>
                    <span>Estado: <code>{simulationReport.final_status}</code></span> · <span>{simulationReport.duration_simulated_ms} ms</span>
                  </div>
                </div>

                <div className="sim-financials">
                  <div className="sim-financial-item">
                    <span>Monto Orden</span>
                    <strong>{simulationReport.financials.trade_amount_sats.toLocaleString()} sats</strong>
                    <small>≈ {simulationReport.financials.fiat_amount} {simulationReport.financials.fiat_currency}</small>
                  </div>
                  <div className="sim-financial-item">
                    <span>Garantía Vendedor</span>
                    <strong>{simulationReport.financials.seller_bond_sats.toLocaleString()} sats</strong>
                    <small>Factura retenida aparte</small>
                  </div>
                  <div className="sim-financial-item">
                    <span>Garantía Comprador</span>
                    <strong>{simulationReport.financials.buyer_bond_sats.toLocaleString()} sats</strong>
                    <small>Factura retenida aparte</small>
                  </div>
                  <div className="sim-financial-item">
                    <span>Comisión Mostro</span>
                    <strong>{(simulationReport.financials.total_mostro_fee_sats ?? simulationReport.financials.fee_sats ?? 0).toLocaleString()} sats</strong>
                    <small>{(simulationReport.financials.fee_per_side_sats ?? 0).toLocaleString()} sats/lado · Dev: {(simulationReport.financials.dev_fee_sats ?? 0).toLocaleString()} sats</small>
                  </div>
                  <div className="sim-financial-item">
                    <span>Depósito del Vendedor</span>
                    <strong>{(simulationReport.financials.seller_hold_invoice_sats ?? simulationReport.financials.seller_total_locked_sats).toLocaleString()} sats</strong>
                    <small>Orden + su mitad de la comisión</small>
                  </div>
                  <div className="sim-financial-item">
                    <span>Recibe el Comprador</span>
                    <strong>{(simulationReport.financials.buyer_receives_sats ?? 0).toLocaleString()} sats</strong>
                    <small>Orden − su mitad de la comisión</small>
                  </div>
                </div>

                <div className="section-title-row" style={{ marginTop: '20px' }}>
                  <div>
                    <h2>Secuencia Simulada de Pasos ({simulationReport.steps.length} eventos)</h2>
                    <p>Traza sintética ilustrativa de eventos Nostr y transacciones Lightning en cada fase de la operación.</p>
                  </div>
                </div>

                <div className="sim-timeline">
                  {simulationReport.steps.map((st) => (
                    <article className="sim-step" key={st.step_number}>
                      <span className="sim-step-node" />
                      <div className="sim-step-header">
                        <span className="sim-step-num">Paso {st.step_number}</span>
                        <ActorBadge actor={st.actor} />
                        <span className="sim-step-title">{st.title}</span>
                        <span className="sim-status-tag">{st.order_status}</span>
                      </div>
                      <p className="sim-step-desc">{st.description}</p>
                      {(st.nostr_event || st.lightning_action) && (
                        <div className="sim-details-row">
                          {st.nostr_event && (
                            <div className="sim-pill">
                              <div className="sim-pill-head">
                                <span>NOSTR (Kind {st.nostr_event.kind})</span>
                              </div>
                              <code>id: {st.nostr_event.event_id}</code>
                              <span className="sim-pill-sub">{st.nostr_event.summary}</span>
                            </div>
                          )}
                          {st.lightning_action && (
                            <div className="sim-pill">
                              <div className="sim-pill-head">
                                <span>LIGHTNING: {st.lightning_action.action}</span>
                              </div>
                              <code>hash: {st.lightning_action.payment_hash}</code>
                              <span className="sim-pill-sub">
                                Estado: <strong>{st.lightning_action.status}</strong> · {st.lightning_action.amount_sats.toLocaleString()} sats
                              </span>
                            </div>
                          )}
                        </div>
                      )}
                    </article>
                  ))}
                </div>

                {simulationReport.disclaimer && (
                  <p style={{ marginTop: '20px', padding: '12px', fontSize: '14px', color: '#6b7280', background: 'rgba(255,255,255,0.02)', borderRadius: '6px', textAlign: 'center', lineHeight: 1.4 }}>
                    {simulationReport.disclaimer}
                  </p>
                )}
              </>
            ) : (
              <div style={{ textAlign: 'center', padding: '30px', color: '#88988e' }}>
                <p>Haz clic en "Ejecutar Simulación" para calcular las finanzas y ver el flujo paso a paso en tiempo real.</p>
              </div>
            )}
          </div>
        </section>
      )}
      {page === 'orders' && (
        <OrdersPage
          onSelectDispute={(orderId) => {
            setSelectedDisputeOrderId(orderId);
            setPage('mediation');
          }}
        />
      )}
      {page === 'mediation' && (
        <MediationConsole
          initialOrderId={selectedDisputeOrderId}
          onSelectOrder={(orderId) => setSelectedDisputeOrderId(orderId)}
        />
      )}
      {page === 'liquidity' && (
        <LiquidityOperationsPage />
      )}
      {page === 'config' && <section className="content config-page">
        <div className="page-heading"><div><div className="eyebrow">MOSTRO COMMUNITY MANAGER <span className="eyebrow-sep">/</span> AJUSTES</div><h1>Configuración</h1><p>Define la identidad y las reglas iniciales de tu comunidad.</p></div><div className="config-heading-actions"><span className={`save-state ${saved ? 'is-saved' : ''}`}><i/>{saved ? `Guardado · revisión ${revision}` : 'Cambios locales'}</span>{daemon?.can_activate && (<button type="button" className="button button-primary" onClick={() => void handleActivateDaemon()} disabled={activatingDaemon || saving || loading}>{activatingDaemon ? 'Activando...' : hasActiveConfiguration ? 'Reactivar Mostro' : 'Activar Mostro'}</button>)}<button className="button button-secondary" onClick={refreshSafely} disabled={loading}>Recargar</button></div></div>
        <div className="preset-commissions-banner">
          <div className="preset-commissions-head">
            <span className="preset-commissions-badge">
              {draft.community.language === 'en' ? 'COMMISSION & BOND PRESETS' : 'PRELLENADO DE COMISIONES Y BONOS'}
            </span>
            <h3>
              {draft.community.language === 'en' ? 'Quick fee & bond presets' : 'Plantillas rápidas de comisiones y fianza'}
            </h3>
            <p>
              {draft.community.language === 'en'
                ? 'Configure market fees, dev fees, routing limits, and anti-spam bonds in one click without affecting your community identity or payment methods.'
                : 'Ajusta comisiones de mercado, desarrollo, enrutamiento y fianzas anti-spam en un clic sin modificar la identidad ni tus métodos de pago.'}
            </p>
          </div>
          <div className="preset-commissions-grid">
            {COMMISSION_BOND_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className="preset-commission-card-btn"
                onClick={() => applyCommissionBondPreset(p)}
              >
                <strong>{draft.community.language === 'en' ? p.nameEn : p.nameEs}</strong>
                <span>{draft.community.language === 'en' ? p.descEn : p.descEs}</span>
                <span className="preset-apply-label">
                  {draft.community.language === 'en' ? 'Apply fees & bonds →' : 'Aplicar comisiones y bonos →'}
                </span>
              </button>
            ))}
          </div>
        </div>
        {notice && <div className="form-message success" style={{ marginBottom: '14px' }}>{notice}</div>}
        <div className="config-layout">
          <nav className="config-nav" aria-label="Secciones de configuración">
            {configNavSections.map((sec) => (
              <a
                key={sec.id}
                href={`#${sec.id}`}
                className={activeConfigNav === sec.id ? 'active' : ''}
                onClick={(e) => {
                  e.preventDefault();
                  setActiveConfigNav(sec.id);
                  const el = document.getElementById(sec.id);
                  if (el) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }
                }}
              >
                {sec.label}
              </a>
            ))}
          </nav>
          <form className="config-form" onSubmit={saveConfig}>
            <section className="config-section" id="identity"><div className="config-section-head"><span className="section-number">01</span><div><h2>Identidad de la comunidad</h2><p>Esta información ayuda a las personas a reconocer tu instancia.</p></div></div><div className="form-grid"><Field label="Nombre de la comunidad"><input value={draft.community.name} onChange={(e) => updateCommunity('name', e.target.value)} placeholder="Ej. Bitcoin Quito" maxLength={80}/></Field><Field label="Idioma"><select value={draft.community.language} onChange={(e) => updateCommunity('language', e.target.value)}><option value="es">Español</option><option value="en">English</option><option value="pt">Português</option></select></Field><Field label="Sitio web"><input type="url" value={draft.community.website} onChange={(e) => updateCommunity('website', e.target.value)} placeholder="https://tu-comunidad.org"/></Field><Field label="Contacto" hint="Dirección web pública de contacto"><input type="url" value={draft.community.contact} onChange={(e) => updateCommunity('contact', e.target.value)} placeholder="https://tu-comunidad.org/contacto"/></Field><div className="field full-width"><span className="field-label">Acerca de</span><textarea value={draft.community.about} onChange={(e) => updateCommunity('about', e.target.value)} placeholder="Describe brevemente tu comunidad" rows={3} maxLength={500}/><span className="field-hint">{draft.community.about.length}/500 caracteres</span></div></div></section>
            <section className="config-section" id="market"><div className="config-section-head"><span className="section-number">02</span><div><h2>Reglas del mercado</h2><p>Establece límites de operación y comisiones. Los porcentajes se convierten a puntos base al guardar.</p></div></div><div className="form-grid">
              <div className="field full-width">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '6px' }}>
                  <span className="field-label" style={{ margin: 0 }}>
                    {draft.community.language === 'en' ? 'Fiat currencies' : 'Monedas fiat'}
                  </span>
                  <span className="field-hint" style={{ margin: 0 }}>
                    {draft.market.fiat_currencies.length}/30 {draft.community.language === 'en' ? 'selected' : 'seleccionadas'}
                  </span>
                </div>
                <div className="chips currency-selected-chips">
                  {draft.market.fiat_currencies.map((code) => {
                    const displayName = getCurrencyDisplayName(code, draft.community.language);
                    return (
                      <button
                        className="currency-chip-badge"
                        type="button"
                        key={code}
                        onClick={() => toggleCurrency(code)}
                        title={draft.community.language === 'en' ? `Remove ${code} - ${displayName}` : `Eliminar ${code} - ${displayName}`}
                      >
                        <strong>{code}</strong>
                        <span>{displayName}</span>
                        <b>×</b>
                      </button>
                    );
                  })}
                  {draft.market.fiat_currencies.length === 0 && (
                    <span className="empty-hint">
                      {draft.community.language === 'en'
                        ? 'No fiat currencies selected · add at least one to enable trading'
                        : 'Sin monedas seleccionadas · elige una para habilitar operaciones'}
                    </span>
                  )}
                </div>
                <div className="currency-search-wrap" ref={currencyDropdownRef}>
                  <input
                    type="text"
                    className="currency-search-input"
                    value={currencySearchQuery}
                    onChange={(e) => {
                      setCurrencySearchQuery(e.target.value);
                      setIsCurrencyDropdownOpen(true);
                    }}
                    onFocus={() => setIsCurrencyDropdownOpen(true)}
                    onKeyDown={handleCurrencyKeyDown}
                    placeholder={
                      draft.community.language === 'en'
                        ? 'Search currency by code (USD, EUR) or name (Dollar, Peso)...'
                        : 'Buscar moneda por abreviación (USD, EUR) o nombre (Dólar, Peso)...'
                    }
                  />
                  {currencySearchQuery && (
                    <button
                      type="button"
                      className="currency-search-clear"
                      aria-label="Limpiar búsqueda"
                      onClick={() => {
                        setCurrencySearchQuery('');
                        setIsCurrencyDropdownOpen(true);
                      }}
                    >
                      ✕
                    </button>
                  )}
                  {isCurrencyDropdownOpen && (
                    <div className="currency-dropdown-menu">
                      <div className="currency-dropdown-header">
                        <span>
                          {currencySearchQuery.trim()
                            ? draft.community.language === 'en'
                              ? `Results for "${currencySearchQuery}" (${filteredCurrencies.length})`
                              : `Resultados para "${currencySearchQuery}" (${filteredCurrencies.length})`
                            : draft.community.language === 'en'
                            ? 'Select currencies from the ISO 4217 catalog'
                            : 'Selecciona monedas del catálogo oficial ISO 4217'}
                        </span>
                        <button
                          type="button"
                          className="currency-dropdown-close"
                          onClick={() => setIsCurrencyDropdownOpen(false)}
                        >
                          {draft.community.language === 'en' ? 'Close' : 'Cerrar'}
                        </button>
                      </div>
                      <div className="currency-dropdown-list">
                        {filteredCurrencies.length === 0 ? (
                          <div className="currency-dropdown-empty">
                            {draft.community.language === 'en'
                              ? `No currencies found matching "${currencySearchQuery}"`
                              : `No se encontraron monedas que coincidan con "${currencySearchQuery}"`}
                          </div>
                        ) : (
                          filteredCurrencies.map((item) => {
                            const isSelected = draft.market.fiat_currencies.includes(item.code);
                            const isEn = draft.community.language === 'en';
                            const primaryName = isEn ? item.nameEn : item.nameEs;
                            const secondaryName = isEn ? item.nameEs : item.nameEn;
                            return (
                              <div
                                key={item.code}
                                className={`currency-dropdown-item ${isSelected ? 'selected' : ''}`}
                                onClick={() => toggleCurrency(item.code)}
                              >
                                <span className="currency-code-tag">{item.code}</span>
                                <div className="currency-item-names">
                                  <span className="currency-primary-name">{primaryName}</span>
                                  <span className="currency-secondary-name">{secondaryName}</span>
                                </div>
                                <span className={`currency-item-action ${isSelected ? 'is-selected' : ''}`}>
                                  {isSelected
                                    ? isEn
                                      ? '✓ Selected'
                                      : '✓ Seleccionada'
                                    : isEn
                                    ? '+ Add'
                                    : '+ Añadir'}
                                </span>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  )}
                </div>
                <div className="currency-popular-row">
                  <span className="currency-popular-label">
                    {draft.community.language === 'en' ? 'Quick add:' : 'Monedas populares:'}
                  </span>
                  {POPULAR_CURRENCIES.map((code) => {
                    const isSelected = draft.market.fiat_currencies.includes(code);
                    return (
                      <button
                        key={code}
                        type="button"
                        className={`currency-quick-pill ${isSelected ? 'active' : ''}`}
                        onClick={() => toggleCurrency(code)}
                        title={getCurrencyDisplayName(code, draft.community.language)}
                      >
                        {isSelected ? `✓ ${code}` : `+ ${code}`}
                      </button>
                    );
                  })}
                </div>
              </div>
              <Field label="Operación mínima" hint="Valor expresado en satoshis"><input type="number" min="0" value={draft.market.min_trade_sats} onChange={(e) => updateMarket('min_trade_sats', Number(e.target.value))}/></Field><Field label="Operación máxima" hint="Valor expresado en satoshis"><input type="number" min="0" value={draft.market.max_trade_sats} onChange={(e) => updateMarket('max_trade_sats', Number(e.target.value))}/></Field><Field label="Comisión total por operación" hint="Mostro cobra la mitad al comprador y la mitad al vendedor. 0% si no deseas cobrar"><div className="input-suffix"><input type="number" min="0" step="0.01" value={feeInputs.fee} required onChange={(e) => updateFee('fee', 'fee_bps', e.target.value)}/><span>%</span></div></Field><Field label="Aporte al desarrollo de Mostro" hint="Parte de tu comisión que el nodo envía al fondo de desarrollo, solo en mainnet. Entre 10% y 100%"><div className="input-suffix"><input type="number" min="10" max="100" step="0.01" value={feeInputs.devFee} required onChange={(e) => updateFee('devFee', 'dev_fee_bps', e.target.value)}/><span>%</span></div></Field><Field label="Comisión máxima de enrutamiento" hint="Tope que el nodo acepta pagar a la red al enviar los sats al comprador. Con 0% solo salen pagos por rutas gratuitas; Mostro usa 0,2% por defecto"><div className="input-suffix"><input type="number" min="0" step="0.01" value={feeInputs.routingFee} required onChange={(e) => updateFee('routingFee', 'max_routing_fee_bps', e.target.value)}/><span>%</span></div></Field></div></section>
            <section className="config-section" id="safety"><div className="config-section-head"><span className="section-number">03</span><div><h2>Seguridad y garantías</h2><p>Opciones de bonos y prueba de trabajo para reducir el abuso.</p></div></div><Toggle checked={draft.safety.bond_enabled} onChange={(v) => updateSafety('bond_enabled', v)} label="Exigir bono para las operaciones" note="Las personas reservan sats como garantía durante una operación."/>{draft.safety.bond_enabled && <div className="form-grid compact-grid"><Field label="Bono relativo" hint="Porcentaje del valor de la operación. Se aplica el mayor entre este y el bono mínimo"><div className="input-suffix"><input type="number" min="0" step="0.01" value={feeInputs.bond} required onChange={(e) => updateFee('bond', 'bond_bps', e.target.value)}/><span>%</span></div></Field><Field label="Bono mínimo" hint="Suelo en satoshis: no se suma al porcentaje"><input type="number" min="0" value={draft.safety.base_bond_sats} onChange={(e) => updateSafety('base_bond_sats', Number(e.target.value))}/></Field><Field label="Aplicar a"><select value={draft.safety.bond_apply_to} onChange={(e) => updateSafety('bond_apply_to', e.target.value)}><option value="both">Quien publica y quien acepta</option><option value="make">Quien publica</option><option value="take">Quien acepta</option></select></Field></div>}<div className="toggle-divider"/><Toggle checked={draft.safety.automatic_timeout_slash} onChange={(v) => updateSafety('automatic_timeout_slash', v)} label="Penalización automática por vencimiento" note="Penaliza el bond por vencimiento en estados de espera; no se aplica a todos los plazos de una operación."/><div className="form-grid compact-grid pow-grid"><Field label="Prueba de trabajo" hint="Dificultad general"><input type="number" min="0" value={draft.safety.pow} onChange={(e) => updateSafety('pow', Number(e.target.value))}/></Field><Field label="Primera conversación" hint="Dificultad del primer mensaje de cada clave. Si supera la general, las apps que no la calculan no reciben respuesta"><input type="number" min="0" value={draft.safety.pow_first_contact} onChange={(e) => updateSafety('pow_first_contact', Number(e.target.value))}/></Field></div></section>
            <section className="config-section" id="nostr"><div className="config-section-head"><span className="section-number">04</span><div><h2>Relays de Nostr</h2><p>Define los relays que usará tu instancia para publicar y recibir eventos.</p></div></div><div className="chips">{draft.nostr.relays.map((relay) => <button className="chip relay-chip" type="button" key={relay} onClick={() => setDraft((old) => ({ ...old, nostr: { relays: old.nostr.relays.filter((x) => x !== relay) } }))}><span>{relay}</span><b>×</b></button>)}{draft.nostr.relays.length === 0 && <span className="empty-hint">Aún no has añadido relays.</span>}</div><div className="inline-add"><input type="url" value={relayInput} onChange={(e) => setRelayInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addRelay())} placeholder="wss://relay.example.org"/><button type="button" onClick={addRelay}>Añadir relay</button></div></section>
            <section className="config-section" id="payments">
              <div className="config-section-head"><span className="section-number">05</span><div><h2>Métodos de pago</h2><p>Activa las opciones de pago que tu comunidad puede ofrecer.</p></div></div>
              {activeCategories.length > 0 && (
                <div className="payment-summary-bar">
                  <span className="payment-summary-title">Categorías en uso ({activeCategories.length}):</span>
                  <div className="payment-summary-chips">
                    {activeCategories.map((cat) => {
                      const count = draft.payment_methods.filter((m) => m.category.trim().toLowerCase() === cat.toLowerCase()).length;
                      return (
                        <span key={cat} className="payment-summary-badge" title={`${count} método(s) en esta categoría`}>
                          <span className="summary-dot" />
                          {cat} <span className="summary-count">{count}</span>
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}
              {draft.payment_methods.length === 0 && <p className="empty-hint payment-empty">No hay métodos de pago añadidos. Añade solo las opciones que tu comunidad admite.</p>}
              <div className="payment-list">
                {draft.payment_methods.map((method, index) => (
                  <div className="payment-row" key={index}>
                    <span className="payment-mark">{method.label.slice(0, 1) || '·'}</span>
                    <div className="payment-col-main">
                      <div className="payment-edit">
                        <input
                          aria-label="Identificador del método"
                          required
                          value={method.id}
                          placeholder="id"
                          onChange={(e) => {
                            markDirty();
                            setDraft((old) => ({ ...old, payment_methods: old.payment_methods.map((item, i) => i === index ? { ...item, id: e.target.value } : item) }));
                          }}
                        />
                        <input
                          aria-label="Nombre del método"
                          required
                          value={method.label}
                          placeholder="Nombre"
                          onChange={(e) => {
                            markDirty();
                            const newLabel = e.target.value;
                            setDraft((old) => ({
                              ...old,
                              payment_methods: old.payment_methods.map((item, i) => {
                                if (i !== index) return item;
                                const updated = { ...item, label: newLabel };
                                if (!item.id || item.id === item.label.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '')) {
                                  updated.id = newLabel.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '');
                                }
                                return updated;
                              }),
                            }));
                          }}
                        />
                        <input
                          aria-label="Categoría del método"
                          required
                          value={method.category}
                          placeholder="Categoría"
                          onChange={(e) => {
                            markDirty();
                            setDraft((old) => ({ ...old, payment_methods: old.payment_methods.map((item, i) => i === index ? { ...item, category: e.target.value } : item) }));
                          }}
                        />
                      </div>
                      {activeCategories.length > 0 && (
                        <div className="payment-category-tags">
                          <span className="payment-category-label">Tags activos:</span>
                          {activeCategories.map((cat) => {
                            const isSelected = method.category.trim().toLowerCase() === cat.toLowerCase();
                            return (
                              <button
                                type="button"
                                key={cat}
                                className={`category-tag-pill ${isSelected ? 'selected' : ''}`}
                                title={isSelected ? `Categoría asignada: ${cat}` : `Asignar "${cat}" a este método`}
                                onClick={() => {
                                  markDirty();
                                  setDraft((old) => ({
                                    ...old,
                                    payment_methods: old.payment_methods.map((item, i) =>
                                      i === index ? { ...item, category: cat } : item
                                    ),
                                  }));
                                }}
                              >
                                {isSelected ? '✓ ' : '+ '}{cat}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    <span className={`payment-state ${method.active ? 'enabled' : ''}`}>{method.active ? 'Activo' : 'Inactivo'}</span>
                    <button
                      type="button"
                      role="switch"
                      aria-label={`${method.active ? 'Desactivar' : 'Activar'} ${method.label || 'método de pago'}`}
                      aria-checked={method.active}
                      className={`toggle small ${method.active ? 'on' : ''}`}
                      onClick={() => {
                        markDirty();
                        setDraft((old) => ({ ...old, payment_methods: old.payment_methods.map((item, i) => i === index ? { ...item, active: !item.active } : item) }));
                      }}
                    >
                      <i/>
                    </button>
                    <button
                      type="button"
                      className="remove-payment"
                      aria-label={`Eliminar ${method.label || 'método de pago'}`}
                      onClick={() => {
                        markDirty();
                        setDraft((old) => ({ ...old, payment_methods: old.payment_methods.filter((_, i) => i !== index) }));
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="add-payment"
                onClick={() => {
                  markDirty();
                  setDraft((old) => ({ ...old, payment_methods: [...old.payment_methods, { id: '', label: '', category: '', active: true }] }));
                }}
              >
                + Añadir método de pago
              </button>
            </section>
            {(apiError || notice) && <div className={`form-message ${apiError ? 'error' : 'success'}`} role="status">{apiError || notice}</div>}
            <div className="form-footer"><div className="footer-copy"><span className="secure-icon"><Icon name="check" size={13}/></span><span>Los cambios se guardan en el servidor local.</span></div><button className="button button-primary save-button" type="submit" disabled={saving || loading || !communityLoaded}><Icon name="save" size={16}/>{saving ? 'Guardando…' : 'Guardar configuración'}</button></div>
          </form>
        </div>
      </section>}
    </main>
    {generatedIdentity && (
      <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="custody-title">
        <div className="modal-dialog">
          <div className="modal-header">
            <h3 id="custody-title">¡Identidad Mostro Generada con Éxito!</h3>
            <button
              type="button"
              className="modal-close-btn"
              aria-label="Cerrar modal"
              onClick={() => {
                if (!hasBackedUpNsec) {
                  if (window.confirm('¿Seguro que deseas cerrar? Asegúrate de haber copiado y guardado tu clave privada (nsec).')) {
                    setGeneratedIdentity(null);
                  }
                } else {
                  setGeneratedIdentity(null);
                }
              }}
            >
              ✕
            </button>
          </div>
          <div className="modal-body">
            <div className="security-warning-box">
              <strong>⚠ RESGUARDO OBLIGATORIO DE CLAVE PRIVADA (NSEC)</strong>
              Esta clave privada es la credencial maestra de tu nodo Mostro. Cópiala y guárdala ahora mismo en tu gestor de contraseñas seguro. Por motivos de seguridad y soberanía, Mostro Community Manager nunca volverá a mostrarte la clave privada completa.
            </div>

            <div className="key-display-group">
              <label>Clave Privada Nostr (nsec) — ¡Secreto!</label>
              <div className="copy-box">
                <code style={{ color: '#ffd993', fontWeight: 600 }}>{generatedIdentity.nsec}</code>
                <button
                  type="button"
                  className="copy-button"
                  onClick={() => copyText(generatedIdentity.nsec, 'modal_nsec')}
                >
                  {copiedField === 'modal_nsec' ? 'Copiado ✓' : 'Copiar nsec'}
                </button>
              </div>
            </div>

            <div className="key-display-group">
              <label>Clave Pública Nostr (npub) — Identidad Pública</label>
              <div className="copy-box">
                <code>{generatedIdentity.npub}</code>
                <button
                  type="button"
                  className="copy-button"
                  onClick={() => copyText(generatedIdentity.npub, 'modal_npub')}
                >
                  {copiedField === 'modal_npub' ? 'Copiado ✓' : 'Copiar npub'}
                </button>
              </div>
            </div>

            <label className="custody-checklist">
              <input
                type="checkbox"
                checked={hasBackedUpNsec}
                onChange={(e) => setHasBackedUpNsec(e.target.checked)}
              />
              <span>Confirmo que he copiado y guardado mi clave privada (nsec) en mi gestor de contraseñas u otro medio seguro.</span>
            </label>
          </div>
          <div className="modal-footer">
            <button
              type="button"
              className="button button-primary"
              disabled={!hasBackedUpNsec}
              onClick={() => {
                setGeneratedIdentity(null);
                setPage('config');
                setNotice('✓ Identidad lista. Ahora elige una plantilla regional o personaliza las reglas de tu comunidad.');
              }}
            >
              Continuar a Configuración →
            </button>
          </div>
        </div>
      </div>
    )}
    {isImportModalOpen && (
      <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="import-title">
        <div className="modal-dialog">
          <div className="modal-header">
            <h3 id="import-title">Importar Clave Privada Nostr (nsec)</h3>
            <button
              type="button"
              className="modal-close-btn"
              aria-label="Cerrar modal"
              onClick={() => {
                setIsImportModalOpen(false);
                setImportNsec('');
                setImportError('');
              }}
            >
              ✕
            </button>
          </div>
          <form onSubmit={handleImportIdentity}>
            <div className="modal-body">
              <p style={{ margin: 0, fontSize: '13.5px', color: '#a3b4ab', lineHeight: 1.5 }}>
                Ingresa la clave privada (en formato <code>nsec1...</code>) que utilizará tu bot Mostro para firmar eventos, comunicarse con los usuarios y publicar órdenes.
              </p>
              <div className="field">
                <span className="field-label">Clave privada (nsec)</span>
                <div style={{ position: 'relative' }}>
                  <input
                    type={showImportNsec ? 'text' : 'password'}
                    value={importNsec}
                    onChange={(e) => setImportNsec(e.target.value)}
                    placeholder="nsec1..."
                    required
                    style={{ paddingRight: '80px', fontFamily: 'monospace' }}
                  />
                  <button
                    type="button"
                    className="button button-secondary"
                    style={{ position: 'absolute', right: '4px', top: '4px', height: '30px', padding: '0 8px', fontSize: '11px' }}
                    onClick={() => setShowImportNsec(!showImportNsec)}
                  >
                    {showImportNsec ? 'Ocultar' : 'Ver'}
                  </button>
                </div>
              </div>
              {importError && (
                <div className="form-message error" style={{ margin: 0 }}>
                  ⚠ {importError}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-secondary"
                onClick={() => {
                  setIsImportModalOpen(false);
                  setImportNsec('');
                  setImportError('');
                }}
                disabled={isImporting}
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="button button-primary"
                disabled={isImporting || !importNsec.trim()}
              >
                {isImporting ? 'Validando...' : 'Importar y Vincular'}
              </button>
            </div>
          </form>
        </div>
      </div>
    )}
  </div>;
}
export default App;
