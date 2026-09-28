import { useCallback, useEffect, useMemo, useState } from 'react';

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
  market_started: false;
};
type ConnectionInfo = {
  status: string;
  npub?: string | null;
  pubkey_hex?: string | null;
  relays: string[];
  nprofile?: string | null;
  nostr_uri?: string | null;
  qr_svg?: string | null;
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
};
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
};

type ChatHistory = {
  order_id: string;
  messages: ChatMessage[];
  count: number;
};

const blankConfig = (): Configuration => ({
  community: { name: '', about: '', website: '', contact: '', language: 'es' },
  market: { fiat_currencies: [], min_trade_sats: 1000, max_trade_sats: 1000000, fee_bps: 0, dev_fee_bps: 0, max_routing_fee_bps: 0 },
  safety: { bond_enabled: false, bond_bps: 0, base_bond_sats: 0, bond_apply_to: 'both', automatic_timeout_slash: false, pow: 0, pow_first_contact: 0 },
  nostr: { relays: [] },
  payment_methods: [],
});
const percent = (bps: number) => (bps / 100).toString();
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
function OrdersPage({ onSelectDispute }: { onSelectDispute?: (orderId: string) => void }) {
  const [snapshot, setSnapshot] = useState<OrdersSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [filterKind, setFilterKind] = useState<'all' | 'buy' | 'sell'>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');

  const fetchOrders = async () => {
    try {
      const data = await api<OrdersSnapshot>('/api/orders');
      setSnapshot(data);
    } catch (err) {
      console.error("No se pudo cargar el monitor", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOrders();
    const intId = setInterval(fetchOrders, 3000);
    return () => clearInterval(intId);
  }, []);

  if (loading && !snapshot) {
    return <section className="content"><div className="page-heading"><h1>Órdenes públicas</h1></div><p>Cargando monitor...</p></section>;
  }

  if (!snapshot) {
    return <section className="content"><div className="page-heading"><h1>Órdenes públicas</h1></div><p>Error al cargar el estado.</p></section>;
  }

  const { state, is_stale, last_update, source_npub, relays, orders } = snapshot;

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
    if (filterStatus === 'closed' && !['canceled', 'success', 'completed', 'failed', 'expired'].includes(o.status)) return false;
    if (filterStatus === 'dispute' && o.status !== 'dispute') return false;
    return true;
  });

  return (
    <section className="content">
      <div className="page-heading">
        <div>
          <div className="eyebrow">MONITOR DE SOLO LECTURA · MÓDULO 3A</div>
          <h1>Órdenes públicas</h1>
          <p>Órdenes anunciadas en Nostr por la identidad {source_npub ? <code style={{wordBreak: "break-all"}}>{source_npub.slice(0, 15)}...</code> : "no configurada"}</p>
        </div>
      </div>
      <div className="dev-banner">
        <div className="banner-icon"><Icon name="alert" size={18}/></div>
        <div>
          <b>Aviso de Solo Lectura</b>
          <span>Los eventos históricos presentados en este monitor no garantizan liquidez, confirmación de fondos ni que el daemon de Mostro esté en ejecución. Este panel no permite realizar pagos, tomar órdenes ni ejecutar arbitrajes.</span>
        </div>
      </div>

      {orders.some((o) => o.status === 'dispute') && (
        <div style={{ marginBottom: '16px', padding: '12px 16px', background: 'rgba(235, 115, 29, 0.1)', border: '1px solid rgba(235, 115, 29, 0.3)', borderRadius: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <strong style={{ color: '#eb731d', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Icon name="shield" size={15} /> Disputas activas detectadas
            </strong>
            <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#9ba3af' }}>
              Hay órdenes en estado de disputa que disponen de un canal de chat cifrado para arbitraje.
            </p>
          </div>
          {onSelectDispute && (
            <button
              type="button"
              className="button button-primary"
              style={{ fontSize: '11px', height: '32px' }}
              onClick={() => {
                const firstDispute = orders.find((o) => o.status === 'dispute');
                if (firstDispute) onSelectDispute(firstDispute.id);
              }}
            >
              Ir a Consola de Mediación →
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
          <span style={{ fontSize: '12px', fontWeight: 600, color: '#88988e' }}>Relays:</span>
          {relays.map((r) => (
            <span key={r.url} className={`chip ${r.state === 'live' ? 'complete' : ''}`} style={{ fontSize: '11px', padding: '3px 8px' }}>
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
            <option value="pending">Solo pendientes</option>
            <option value="closed">Cerradas / Finalizadas</option>
            <option value="dispute">En disputa</option>
          </select>
        </div>
        <div style={{ marginLeft: 'auto', fontSize: '13px', color: '#88988e' }}>
          <span>{filteredOrders.length} orden{filteredOrders.length === 1 ? '' : 'es'} mostrada{filteredOrders.length === 1 ? '' : 's'}</span>
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
          <div className="orders-table" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }} aria-label="Tabla de órdenes públicas">
              <thead>
                <tr>
                  <th>UUID / Fecha</th>
                  <th>Tipo</th>
                  <th>Cantidad (Sats)</th>
                  <th>Precio (Fiat)</th>
                  <th>Estado</th>
                  <th>Acción</th>
                </tr>
              </thead>
              <tbody>
                {filteredOrders.map(o => (
                  <tr key={o.id} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.08)' }}>
                    <td style={{ padding: '8px 0' }}>
                      <div style={{ fontSize: '13px', fontWeight: 'bold' }}><code>{o.id.slice(0, 8)}...</code></div>
                      <div style={{ fontSize: '11px', color: '#88988e' }}>{new Date(o.created_at * 1000).toLocaleString()}</div>
                    </td>
                    <td>{o.kind === 'sell' ? 'Venta' : 'Compra'}</td>
                    <td>{o.amount_sats === 0 ? "Por rango" : `${o.amount_sats_str || o.amount_sats.toLocaleString()} sats`}</td>
                    <td>
                      {o.fiat_amount_range.length === 2 ? `${o.fiat_amount_range[0]} - ${o.fiat_amount_range[1]}` : o.fiat_amount_range[0] || '0.00'} {o.fiat_code.toUpperCase()}
                      <br/>
                      <span style={{ fontSize: '11px', color: '#88988e' }}>{o.premium !== 0 ? `Premium: ${o.premium}%` : 'Precio de mercado'}</span>
                    </td>
                    <td><span className="sim-actor-badge">{o.status}</span></td>
                    <td>
                      {o.status === 'dispute' && onSelectDispute ? (
                        <button
                          type="button"
                          className="button button-secondary"
                          style={{ padding: '3px 8px', fontSize: '11px' }}
                          onClick={() => onSelectDispute(o.id)}
                          title="Abrir historial de mediación para esta disputa"
                        >
                          <Icon name="shield" size={13} /> Mediar
                        </button>
                      ) : (
                        <span style={{ fontSize: '11px', color: '#68776e' }}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
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
  const [history, setHistory] = useState<ChatHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [actionNotice, setActionNotice] = useState<string>('');
  const [ordersSnapshot, setOrdersSnapshot] = useState<OrdersSnapshot | null>(null);

  useEffect(() => {
    if (initialOrderId && initialOrderId !== selectedOrderId) {
      setSelectedOrderId(initialOrderId);
      setInputOrderId(initialOrderId);
    }
  }, [initialOrderId]);

  useEffect(() => {
    api<OrdersSnapshot>('/api/orders')
      .then((data) => {
        setOrdersSnapshot(data);
        if (!selectedOrderId && data.orders.length > 0) {
          const firstDispute = data.orders.find((o) => o.status === 'dispute');
          if (firstDispute) {
            setSelectedOrderId(firstDispute.id);
            setInputOrderId(firstDispute.id);
            if (onSelectOrder) onSelectOrder(firstDispute.id);
          }
        }
      })
      .catch(() => {});
  }, []);

  const fetchChat = useCallback(async (orderId: string) => {
    if (!orderId.trim()) return;
    setLoading(true);
    setError('');
    try {
      const data = await api<ChatHistory>(`/api/chat/${orderId.trim()}`);
      setHistory(data);
    } catch (err) {
      setHistory(null);
      setError(err instanceof Error ? err.message : 'Error al obtener mensajes cifrados');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedOrderId) {
      void fetchChat(selectedOrderId);
      const interval = setInterval(() => {
        void fetchChat(selectedOrderId);
      }, 4000);
      return () => clearInterval(interval);
    }
  }, [selectedOrderId, fetchChat]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const id = inputOrderId.trim();
    if (id) {
      setSelectedOrderId(id);
      if (onSelectOrder) onSelectOrder(id);
      void fetchChat(id);
    }
  };

  const handleAction = (type: 'adm-settle' | 'adm-refund') => {
    const actionName = type === 'adm-settle' ? 'adm-settle (liquidación al comprador)' : 'adm-refund (reembolso al vendedor)';
    setActionNotice(
      `Acción de arbitraje bosquejada para Módulo 3B: [${actionName}] registrada para la orden ${selectedOrderId}. En la siguiente fase se firmará y transmitirá el evento administrativo Kind 4/NIP-44 con el bot Mostro.`
    );
  };

  const disputeOrders = ordersSnapshot?.orders.filter((o) => o.status === 'dispute') || [];
  const selectedOrder = ordersSnapshot?.orders.find((o) => o.id === selectedOrderId);

  return (
    <section className="content mediation-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">CONSOLA DE MEDIACIÓN Y ARBITRAJE · MÓDULO 3B</div>
          <h1>Consola de Mediación</h1>
          <p>Supervisión de canales cifrados de disputa y resolución asistida de conflictos.</p>
        </div>
        <button
          className="button button-secondary"
          onClick={() => selectedOrderId && void fetchChat(selectedOrderId)}
          disabled={loading || !selectedOrderId}
        >
          <span className={loading ? 'spin' : ''}>↻</span> Actualizar chat
        </button>
      </div>

      <div className="dev-banner">
        <div className="banner-icon"><Icon name="shield" size={18} /></div>
        <div>
          <b>Cifrado Punto a Punto Hermético (NIP-04 y NIP-44 / GiftWrap NIP-59)</b>
          <span>
            Los mensajes de mediación dirigidos a la identidad de la comunidad se descifran exclusivamente en memoria con la clave privada local aislada. Las acciones administrativas de resolución están preparadas en modo asistido.
          </span>
        </div>
        <div className="banner-status"><i /> PROTOCOLO SEGURO</div>
      </div>

      <div className="sim-controls" style={{ marginBottom: '16px', display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
        <form onSubmit={handleSearch} style={{ display: 'flex', gap: '8px', flex: '1 1 320px', alignItems: 'center' }}>
          <div className="sim-control-group" style={{ flex: 1, minWidth: '220px' }}>
            <label>ID de la orden (UUID)</label>
            <input
              type="text"
              placeholder="Ej. edbd72f6-0bb0-4740-8b1c-7f51b6ad72ba"
              value={inputOrderId}
              onChange={(e) => setInputOrderId(e.target.value)}
            />
          </div>
          <button type="submit" className="button button-primary" style={{ marginTop: 'auto', height: '32px' }}>
            Cargar Chat
          </button>
        </form>

        {disputeOrders.length > 0 && (
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '11px', color: '#88988e' }}>Disputas activas:</span>
            {disputeOrders.map((o) => (
              <button
                key={o.id}
                type="button"
                className={`chip ${o.id === selectedOrderId ? 'complete' : ''}`}
                style={{ cursor: 'pointer', padding: '4px 10px' }}
                onClick={() => {
                  setSelectedOrderId(o.id);
                  setInputOrderId(o.id);
                  if (onSelectOrder) onSelectOrder(o.id);
                }}
              >
                <span className="dispute-badge">⚠ {o.id.slice(0, 8)}...</span>
                <span>{o.fiat_amount_range[0] || '0'} {o.fiat_code.toUpperCase()}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {actionNotice && (
        <div className="action-feedback-banner" style={{ marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <strong>✓ Notificación Administrativa</strong>
            <p style={{ margin: '4px 0 0', fontSize: '11px' }}>{actionNotice}</p>
          </div>
          <button
            type="button"
            className="button button-secondary"
            style={{ height: '28px', fontSize: '10px' }}
            onClick={() => setActionNotice('')}
          >
            Cerrar
          </button>
        </div>
      )}

      {error && <div className="form-message error">{error}</div>}

      <div className="mediation-grid">
        <div className="chat-window">
          <div className="chat-window-head">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Icon name="message" size={16} />
              <h3>
                {selectedOrderId ? (
                  <>Historial de Chat · <code>{selectedOrderId.slice(0, 8)}...</code></>
                ) : (
                  'Historial de Mensajes Cifrados'
                )}
              </h3>
            </div>
            {history && (
              <span className="updated-label">
                {history.count} mensaje{history.count === 1 ? '' : 's'} descifrado{history.count === 1 ? '' : 's'}
              </span>
            )}
          </div>

          <div className="chat-messages-list">
            {!selectedOrderId ? (
              <div className="chat-empty">
                <Icon name="shield" size={32} />
                <b>No hay orden seleccionada</b>
                <p>Ingresa un ID de orden o selecciona una disputa activa para consultar los mensajes cifrados.</p>
              </div>
            ) : loading && !history ? (
              <div className="chat-empty">
                <span className="spin" style={{ fontSize: '24px' }}>↻</span>
                <p>Descifrando mensajes cifrados en memoria...</p>
              </div>
            ) : !history || history.messages.length === 0 ? (
              <div className="chat-empty">
                <Icon name="message" size={32} />
                <b>Sin mensajes para la orden {selectedOrderId.slice(0, 8)}...</b>
                <p>
                  No se han registrado mensajes NIP-04 o NIP-44/59 para esta orden todavía. Cuando las partes o el bot envíen eventos a los relays, se sincronizarán y aparecerán aquí.
                </p>
              </div>
            ) : (
              history.messages.map((msg) => {
                const isFromCommunity = msg.is_from_me;
                const bubbleClass = isFromCommunity ? 'chat-bubble from-me' : 'chat-bubble from-other';
                const formattedTime = new Date(msg.created_at * 1000).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                });
                return (
                  <div key={msg.id} className={bubbleClass}>
                    <div className="chat-meta">
                      <span className="chat-sender">
                        {isFromCommunity ? 'Comunidad (Tú)' : (
                          <ActorBadge actor={msg.sender} />
                        )}
                      </span>
                      <span className="chat-time">{formattedTime}</span>
                      <span className={`chat-tag ${msg.kind === 1059 ? 'dispute' : ''}`}>
                        {msg.kind === 1059 ? 'NIP-59 / NIP-44' : msg.kind === 4 ? 'NIP-04' : `Kind ${msg.kind}`}
                      </span>
                      {msg.action && <span className="chat-tag dispute">{msg.action}</span>}
                    </div>
                    <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '12px' }}>
                      {msg.content}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="dispute-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h3>Arbitraje Asistido</h3>
            {selectedOrder ? (
              <span className="dispute-badge">{selectedOrder.status}</span>
            ) : (
              <span className="chat-tag">Consola</span>
            )}
          </div>

          <p style={{ margin: 0, fontSize: '11px', color: '#9ba3af', lineHeight: 1.4 }}>
            Herramientas para resolver disputas entre comprador y vendedor conforme a las pruebas aportadas en el chat y las confirmaciones bancarias/fiat.
          </p>

          {selectedOrder && (
            <div style={{ background: '#0e1412', border: '1px solid #1f2b24', borderRadius: '7px', padding: '10px 12px', fontSize: '11px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                <span style={{ color: '#829288' }}>Monto:</span>
                <strong>{selectedOrder.amount_sats.toLocaleString()} sats ({selectedOrder.fiat_amount_range[0] || '0'} {selectedOrder.fiat_code.toUpperCase()})</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                <span style={{ color: '#829288' }}>Tipo:</span>
                <span>{selectedOrder.kind === 'sell' ? 'Venta' : 'Compra'}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#829288' }}>Publicada:</span>
                <span>{new Date(selectedOrder.created_at * 1000).toLocaleString()}</span>
              </div>
            </div>
          )}

          <div className="action-box settle">
            <h4>Liberar Fondos al Comprador (adm-settle)</h4>
            <p>
              Instruye al bot Mostro para liquidar el Hold Invoice de garantía a favor del comprador una vez verificado el pago fiat.
            </p>
            <button
              type="button"
              className="button button-primary"
              disabled={!selectedOrderId}
              onClick={() => handleAction('adm-settle')}
            >
              <Icon name="check" size={14} /> Bosquejar adm-settle
            </button>
          </div>

          <div className="action-box refund">
            <h4>Reembolsar al Vendedor (adm-refund)</h4>
            <p>
              Instruye al bot Mostro para cancelar la orden y devolver los satoshis en custodia al vendedor si el comprador no pagó.
            </p>
            <button
              type="button"
              className="button button-secondary"
              disabled={!selectedOrderId}
              onClick={() => handleAction('adm-refund')}
            >
              <Icon name="arrow" size={14} /> Bosquejar adm-refund
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function App() {
  const [page, setPage] = useState<'dashboard' | 'orders' | 'mediation' | 'simulation' | 'config'>('dashboard');
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
  const [currencyInput, setCurrencyInput] = useState('');
  const [relayInput, setRelayInput] = useState('');
  const [feeInputs, setFeeInputs] = useState({ fee: '', devFee: '', routingFee: '', bond: '' });

  // Module 4: Notifications and Backup states
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [backupState, setBackupState] = useState<AutoBackupState | null>(null);
  const [triggeringBackup, setTriggeringBackup] = useState(false);
  const [backupPassphrase, setBackupPassphrase] = useState('');
  const [backupMessage, setBackupMessage] = useState('');

  // Simulation states
  const [simScenarios, setSimScenarios] = useState<SimulationScenarioInfo[]>([]);
  const [selectedScenario, setSelectedScenario] = useState('happy_path');
  const [simSatsInput, setSimSatsInput] = useState('50000');
  const [simulating, setSimulating] = useState(false);
  const [simulationReport, setSimulationReport] = useState<SimulationReport | null>(null);
  const [simError, setSimError] = useState('');

  const copyText = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => {
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
    const simScenariosPromise = api<SimulationScenarioInfo[]>('/api/simulation/scenarios').then((data) => {
      setSimScenarios(data);
    }).catch(() => setSimScenarios([]));
    const communityPromise = api<CommunityReply>('/api/community').then((data) => {
      setRevision(data.revision); setSaved(Boolean(data.config)); setDirty(false); setCommunityLoaded(true);
      const config = data.config || blankConfig(); setDraft(config);
      setFeeInputs(data.config ? { fee: percent(config.market.fee_bps), devFee: percent(config.market.dev_fee_bps), routingFee: percent(config.market.max_routing_fee_bps), bond: percent(config.safety.bond_bps) } : { fee: '', devFee: '', routingFee: '', bond: '' });
    }).catch((err: Error) => { setCommunityLoaded(false); setApiError(err.message); });
    await Promise.all([healthPromise, dashboardPromise, connectionPromise, daemonPromise, communityPromise, simScenariosPromise, notifsPromise, backupPromise]); setLoading(false);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

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
  const markDirty = () => { setDirty(true); setSaved(false); };
  const refreshSafely = () => { if (dirty && !window.confirm('Hay cambios sin guardar. ¿Descartarlos y recargar la configuración?')) return; void refresh(); };
  const updateCommunity = (key: keyof Configuration['community'], value: string) => { markDirty(); setDraft((old) => ({ ...old, community: { ...old.community, [key]: value } })); };
  const updateMarket = (key: keyof Configuration['market'], value: unknown) => { markDirty(); setDraft((old) => ({ ...old, market: { ...old.market, [key]: value } })); };
  const updateSafety = (key: keyof Configuration['safety'], value: unknown) => { markDirty(); setDraft((old) => ({ ...old, safety: { ...old.safety, [key]: value } })); };
  const addCurrency = () => { const code = currencyInput.trim().toUpperCase(); if (code && /^[A-Z]{3}$/.test(code) && !draft.market.fiat_currencies.includes(code)) updateMarket('fiat_currencies', [...draft.market.fiat_currencies, code]); setCurrencyInput(''); };
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
  const readiness = useMemo(() => [Boolean(draft.community.name.trim()), draft.market.fiat_currencies.length > 0, draft.nostr.relays.length > 0, draft.payment_methods.some((method) => method.active)].filter(Boolean).length, [draft]);
  const statuses = dashboard ? [
    { title: 'Mostro', icon: 'grid', data: dashboard.mostro },
    { title: 'Lightning', icon: 'bolt', data: dashboard.lightning },
    { title: 'Bitcoin', icon: 'bitcoin', data: dashboard.bitcoin },
  ] : [];
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">M</div><div className="brand-copy"><b>mostro</b><span>COMMUNITY MANAGER</span></div></div>
      <div className="workspace-label">ESPACIO DE TRABAJO</div>
      <div className="workspace"><div className="workspace-icon">{(draft.community.name || 'MC').slice(0, 2).toUpperCase()}</div><div><b>{draft.community.name || 'Mi comunidad'}</b><span>Entorno local</span></div><span className="workspace-chevron">⌄</span></div>
      <div className="nav-label">GENERAL</div>
      <nav className="nav-list" aria-label="Navegación principal">
        <button className={`nav-item ${page === 'dashboard' ? 'active' : ''}`} onClick={() => setPage('dashboard')}><Icon name="grid"/><span>Panel general</span>{page === 'dashboard' && <span className="nav-active-mark"/>}</button>
        <button className={`nav-item ${page === 'orders' ? 'active' : ''}`} onClick={() => setPage('orders')}><Icon name="bolt"/><span>Órdenes públicas</span>{page === 'orders' && <span className="nav-active-mark"/>}</button>
        <button className={`nav-item ${page === 'mediation' ? 'active' : ''}`} onClick={() => setPage('mediation')}><Icon name="shield"/><span>Mediación</span>{page === 'mediation' && <span className="nav-active-mark"/>}</button>
        <button className={`nav-item ${page === 'simulation' ? 'active' : ''}`} onClick={() => setPage('simulation')}><Icon name="play"/><span>Simulador P2P</span>{page === 'simulation' && <span className="nav-active-mark"/>}</button>
        <button className={`nav-item ${page === 'config' ? 'active' : ''}`} onClick={() => setPage('config')}><Icon name="sliders"/><span>Configuración</span>{page === 'config' && <span className="nav-active-mark"/>}</button>
      </nav>
      <div className="sidebar-spacer" />
      <div className="sidebar-bottom"><div className="mode-card"><span className="mode-icon"><Icon name="globe" size={16}/></span><div><b>Modo desarrollo</b><span>Mercado sin iniciar</span></div><span className="mode-dot"/></div><div className="sidebar-footer"><span className="avatar">MC</span><div><b>Administrador</b><span>Configuración local</span></div></div></div>
    </aside>
    <main className="main-area">
      <header className="topbar"><div className="breadcrumb"><span>Mi comunidad</span><Icon name="chevron" size={14}/><b>{page === 'dashboard' ? 'Panel general' : page === 'orders' ? 'Órdenes públicas' : page === 'mediation' ? 'Consola de mediación' : page === 'simulation' ? 'Simulador P2P' : 'Configuración'}</b></div><div className="top-actions"><span className="environment-pill"><i/> Desarrollo</span><button className="icon-button" aria-label="Abrir mediación" onClick={() => setPage('mediation')}><Icon name="shield" size={17}/></button><button className="icon-button" aria-label="Abrir simulador" onClick={() => setPage('simulation')}><Icon name="play" size={17}/></button><button className="icon-button" aria-label="Abrir configuración" onClick={() => setPage('config')}><Icon name="sliders" size={17}/></button><span className="top-avatar">MC</span></div></header>
      {page === 'dashboard' && (
        <section className="content dashboard-page">
        <div className="page-heading"><div><div className="eyebrow">MOSTRO COMMUNITY MANAGER <span className="eyebrow-sep">/</span> INICIO</div><h1>Panel general</h1><p>Estado de tu instancia y preparación de la comunidad.</p></div><button className="button button-secondary refresh-button" onClick={() => void refresh()} disabled={loading}><span className={loading ? 'spin' : ''}>↻</span> Actualizar</button></div>
        <div className="dev-banner"><div className="banner-icon"><Icon name="alert" size={18}/></div><div><b>Entorno de desarrollo</b><span>Prototipo de configuración: el mercado aún no está iniciado y no se puede iniciar desde este panel.</span></div><div className="banner-status"><i/> MERCADO INACTIVO</div></div>
        <div className="section-title-row"><div><h2>Servicios</h2><p>Conectividad reportada por la instancia local.</p></div><span className="updated-label">{loading ? 'Consultando…' : health ? 'API disponible' : 'API sin conexión'}</span></div>
        <div className="service-grid">{statuses.length ? statuses.map(({ title, icon, data }) => <article className="service-card" key={title}><div className="service-top"><span className="service-icon"><Icon name={icon}/></span><span className="service-status"><StatusDot status={data.status}/>{({ online: 'Conectado', offline: 'Sin conexión', unconfigured: 'Sin configurar', unknown: 'Desconocido', warning: 'Revisar' } as Record<string, string>)[data.status] || 'Desconocido'}</span></div><h3>{title}</h3><p>{data.detail || 'Sin detalles disponibles'}</p><div className="service-meta">{title === 'Mostro' && data.version ? <span>v{data.version}</span> : null}{title === 'Lightning' && data.alias ? <span>{data.alias}</span> : null}{title === 'Lightning' && typeof data.num_active_channels === 'number' ? <span>{data.num_active_channels} canales activos</span> : null}{title === 'Bitcoin' && typeof data.block_height === 'number' ? <span>Bloque {data.block_height.toLocaleString('es')}</span> : null}<Icon name="arrow" size={15}/></div></article>) : <div className="service-card unavailable"><div className="service-top"><span className="service-icon"><Icon name="grid"/></span><span className="service-status"><StatusDot/>Desconocido</span></div><h3>Servicios no disponibles</h3><p>{apiError || 'La API aún no informa el estado de los servicios.'}</p><div className="service-meta"><span>Reintenta cuando el servidor esté disponible</span></div></div>}</div>
        {dashboard?.lightning && <section className="lightning-details" aria-labelledby="lightning-details-title"><div className="lightning-heading"><div><h2 id="lightning-details-title">Detalles de Lightning</h2><p>Información reportada por el nodo.</p></div>{dashboard.lightning.network && <span className="network-tag">Red {dashboard.lightning.network}</span>}</div>{dashboard.lightning.num_active_channels === 0 && <p className="lightning-capacity-note" role="status">LND está conectado, pero no tiene canales activos. El mercado no tiene capacidad de intercambio Lightning.</p>}<div className="lightning-stats"><div><span>Sincronización de cadena</span><strong>{dashboard.lightning.synced_to_chain === true ? 'Sincronizado' : dashboard.lightning.synced_to_chain === false ? 'Pendiente' : 'Desconocido'}</strong></div><div><span>Sincronización del grafo</span><strong>{dashboard.lightning.synced_to_graph === true ? 'Sincronizado' : dashboard.lightning.synced_to_graph === false ? 'Pendiente' : 'Desconocido'}</strong></div><div><span>Canales activos</span><strong>{typeof dashboard.lightning.num_active_channels === 'number' ? dashboard.lightning.num_active_channels : 'Desconocido'}</strong></div><div><span>Canales pendientes</span><strong>{typeof dashboard.lightning.num_pending_channels === 'number' ? dashboard.lightning.num_pending_channels : 'Desconocido'}</strong></div><div><span>Canales inactivos</span><strong>{typeof dashboard.lightning.num_inactive_channels === 'number' ? dashboard.lightning.num_inactive_channels : 'Desconocido'}</strong></div></div><div className="liquidity-row"><div><span>Liquidez local</span><strong>{dashboard.lightning.liquidity?.status === 'available' && dashboard.lightning.liquidity.local_balance_sats !== null ? `${dashboard.lightning.liquidity.local_balance_sats} sats` : 'Desconocida'}</strong></div><div><span>Liquidez remota</span><strong>{dashboard.lightning.liquidity?.status === 'available' && dashboard.lightning.liquidity.remote_balance_sats !== null ? `${dashboard.lightning.liquidity.remote_balance_sats} sats` : 'Desconocida'}</strong></div><p>{dashboard.lightning.liquidity?.status === 'unavailable' ? dashboard.lightning.liquidity.detail || 'El nodo no informa la liquidez.' : 'Los datos de canales y liquidez no garantizan que una ruta o una operación esté disponible.'}</p></div></section>}
        {connection && connection.status === 'ready' && (
          <section className="connection-card" aria-labelledby="connection-title">
            <div className="connection-heading">
              <div>
                <h2 id="connection-title">Conexión con Mostro App</h2>
                <p>Datos públicos para que los usuarios conecten su cliente oficial Mostro a este nodo.</p>
              </div>
              <a href={connection.app_download_url} target="_blank" rel="noreferrer" className="button button-secondary download-link">
                Mostro App ↗
              </a>
            </div>
            <div className="connection-body">
              {connection.qr_svg && (
                <div className="qr-box" dangerouslySetInnerHTML={{ __html: connection.qr_svg }} title="Escanea con Mostro App" />
              )}
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
                {connection.nostr_uri && (
                  <div className="connection-row">
                    <span className="field-label">Nostr URI (nprofile con relays)</span>
                    <div className="copy-box">
                      <code>{connection.nostr_uri}</code>
                      <button type="button" className="copy-button" onClick={() => copyText(connection.nostr_uri || '', 'uri')}>
                        {copiedField === 'uri' ? 'Copiado ✓' : 'Copiar'}
                      </button>
                    </div>
                  </div>
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
                <StatusDot status={daemon.state === 'active_ready' ? 'online' : daemon.state === 'configured_standby' ? 'warning' : 'offline'} />
                {daemon.state === 'active_ready' ? 'Preparado para Mercado' : daemon.state === 'configured_standby' ? 'En Espera de Activación' : 'Sin Configurar'}
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
                  {activatingDaemon ? 'Activando...' : daemon.state === 'active_ready' ? 'Reactivar / Actualizar Configuración' : 'Activar Configuración de Mercado'}
                </button>
              )}
              {daemon.state === 'active_ready' && (
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => void handleDeactivateDaemon()}
                  disabled={activatingDaemon}
                >
                  Desactivar Mercado
                </button>
              )}
            </div>
          </section>
        )}
        <section className="sim-card" aria-labelledby="sim-title">
          <div className="sim-heading">
            <div>
              <h2 id="sim-title">Simulador Sintético de Protocolo P2P</h2>
              <p>Modelo interactivo sintético de órdenes, Hold Invoices Lightning, eventos Nostr y resolución de disputas (dry-run en memoria; regtest en vivo pendiente).</p>
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
                  <span>Fianza Vendedor</span>
                  <strong>{simulationReport.financials.seller_bond_sats.toLocaleString()} sats</strong>
                  <small>Garantía de cumplimiento</small>
                </div>
                <div className="sim-financial-item">
                  <span>Fianza Comprador</span>
                  <strong>{simulationReport.financials.buyer_bond_sats.toLocaleString()} sats</strong>
                  <small>Garantía anti-spam</small>
                </div>
                <div className="sim-financial-item">
                  <span>Comisión Mostro</span>
                  <strong>{(simulationReport.financials.total_mostro_fee_sats ?? simulationReport.financials.fee_sats ?? 0).toLocaleString()} sats</strong>
                  <small>{draft.market.fee_bps / 100}% de la orden</small>
                </div>
                <div className="sim-financial-item">
                  <span>Bloqueado Vendedor</span>
                  <strong>{simulationReport.financials.seller_total_locked_sats.toLocaleString()} sats</strong>
                  <small>Orden + fianza + comisión</small>
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
                      <span style={{ fontSize: '11px', textTransform: 'uppercase', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: n.level === 'error' ? 'rgba(239,68,68,0.2)' : n.level === 'warning' ? 'rgba(245,158,11,0.2)' : 'rgba(16,185,129,0.2)', color: n.level === 'error' ? '#ef4444' : n.level === 'warning' ? '#f59e0b' : '#10b981' }}>{n.category}</span>
                      <strong style={{ fontSize: '14px' }}>{n.title}</strong>
                    </div>
                    <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: '#9ca3af' }}>{n.message}</p>
                  </div>
                  <span style={{ fontSize: '12px', color: '#6b7280' }}>
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
            <div style={{ marginTop: '12px', padding: '10px 14px', borderRadius: '6px', background: backupMessage.startsWith('✓') ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)', color: backupMessage.startsWith('✓') ? '#10b981' : '#ef4444', fontSize: '13px' }}>
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
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px', fontSize: '13px' }}>
                    <code>{b.filename}</code>
                    <span style={{ color: '#9ca3af' }}>{(b.size_bytes / 1024).toFixed(1)} KB · {new Date(b.modified_timestamp * 1000).toLocaleDateString('es')}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        <div className="dashboard-lower"><article className="setup-card"><div className="card-heading"><div><span className="card-kicker">PUESTA EN MARCHA</span><h2>Prepara tu comunidad</h2><p>Configura los datos esenciales antes de iniciar el mercado.</p></div><div className="progress-ring"><span>{readiness}<small>/4</small></span></div></div><progress className="setup-progress" value={readiness} max={4} aria-label="Preparación de la comunidad"/><div className="setup-checks"><span className={draft.community.name ? 'complete' : ''}><i>{draft.community.name ? <Icon name="check" size={12}/> : '1'}</i>Identidad</span><span className={draft.market.fiat_currencies.length ? 'complete' : ''}><i>{draft.market.fiat_currencies.length ? <Icon name="check" size={12}/> : '2'}</i>Monedas</span><span className={draft.nostr.relays.length ? 'complete' : ''}><i>{draft.nostr.relays.length ? <Icon name="check" size={12}/> : '3'}</i>Relays Nostr</span><span className={draft.payment_methods.some((m) => m.active) ? 'complete' : ''}><i>{draft.payment_methods.some((m) => m.active) ? <Icon name="check" size={12}/> : '4'}</i>Pagos</span></div><button className="button button-primary" onClick={() => setPage('config')}>Abrir configuración <Icon name="arrow" size={15}/></button></article>
          <article className="market-card"><div className="market-card-top"><span className="market-symbol"><Icon name="bolt" size={19}/></span><span className="market-tag"><i/> AÚN NO INICIADO</span></div><div className="market-empty"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="orbit-center"><span>₿</span></div></div><div className="market-copy"><h3>Mercado en desarrollo</h3><p>Este prototipo permite guardar los parámetros de la comunidad. El inicio del mercado aún no está disponible.</p><span className="market-note"><Icon name="alert" size={14}/> Operaciones aún no consultadas</span></div></article></div>
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
              <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em', color: '#eb731d', textTransform: 'uppercase' }}>Modelo Sintético · Dry-Run en Memoria</span>
            </div>
            <p style={{ margin: 0, fontSize: '13px', color: '#9ba3af', lineHeight: 1.4 }}>
              Este simulador valida localmente el flujo del protocolo, las garantías (bonds) y las comisiones sin ejecutar transacciones en Bitcoin/Lightning ni relays Nostr en vivo. Los eventos y firmas son sintéticos y la equivalencia fiat es meramente ilustrativa (ciclo regtest en vivo pendiente).
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
                    <span>Fianza Vendedor</span>
                    <strong>{simulationReport.financials.seller_bond_sats.toLocaleString()} sats</strong>
                    <small>Garantía de cumplimiento</small>
                  </div>
                  <div className="sim-financial-item">
                    <span>Fianza Comprador</span>
                    <strong>{simulationReport.financials.buyer_bond_sats.toLocaleString()} sats</strong>
                    <small>Garantía anti-spam</small>
                  </div>
                  <div className="sim-financial-item">
                    <span>Comisión Mostro</span>
                    <strong>{(simulationReport.financials.total_mostro_fee_sats ?? simulationReport.financials.fee_sats ?? 0).toLocaleString()} sats</strong>
                    <small>{(simulationReport.financials.fee_per_side_sats ?? 0).toLocaleString()} sats/lado · Dev: {(simulationReport.financials.dev_fee_sats ?? 0).toLocaleString()} sats</small>
                  </div>
                  <div className="sim-financial-item">
                    <span>Bloqueado Vendedor</span>
                    <strong>{simulationReport.financials.seller_total_locked_sats.toLocaleString()} sats</strong>
                    <small>Total en Hold Invoice</small>
                  </div>
                  <div className="sim-financial-item">
                    <span>Bloqueado Comprador</span>
                    <strong>{simulationReport.financials.buyer_total_locked_sats.toLocaleString()} sats</strong>
                    <small>Fianza + tarifa</small>
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
                  <p style={{ marginTop: '20px', padding: '12px', fontSize: '12px', color: '#6b7280', background: 'rgba(255,255,255,0.02)', borderRadius: '6px', textAlign: 'center', lineHeight: 1.4 }}>
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
      {page === 'config' && <section className="content config-page">
        <div className="page-heading"><div><div className="eyebrow">MOSTRO COMMUNITY MANAGER <span className="eyebrow-sep">/</span> AJUSTES</div><h1>Configuración</h1><p>Define la identidad y las reglas iniciales de tu comunidad.</p></div><div className="config-heading-actions"><span className={`save-state ${saved ? 'is-saved' : ''}`}><i/>{saved ? `Guardado · revisión ${revision}` : 'Cambios locales'}</span><button className="button button-secondary" onClick={refreshSafely} disabled={loading}>Recargar</button></div></div>
        <div className="config-layout"><nav className="config-nav"><a href="#identity">Identidad</a><a href="#market">Mercado</a><a href="#safety">Seguridad</a><a href="#nostr">Nostr</a><a href="#payments">Métodos de pago</a></nav>
          <form className="config-form" onSubmit={saveConfig}>
            <section className="config-section" id="identity"><div className="config-section-head"><span className="section-number">01</span><div><h2>Identidad de la comunidad</h2><p>Esta información ayuda a las personas a reconocer tu instancia.</p></div></div><div className="form-grid"><Field label="Nombre de la comunidad"><input value={draft.community.name} onChange={(e) => updateCommunity('name', e.target.value)} placeholder="Ej. Bitcoin Quito" maxLength={80}/></Field><Field label="Idioma"><select value={draft.community.language} onChange={(e) => updateCommunity('language', e.target.value)}><option value="es">Español</option><option value="en">English</option><option value="pt">Português</option></select></Field><Field label="Sitio web"><input type="url" value={draft.community.website} onChange={(e) => updateCommunity('website', e.target.value)} placeholder="https://tu-comunidad.org"/></Field><Field label="Contacto" hint="Dirección web pública de contacto"><input type="url" value={draft.community.contact} onChange={(e) => updateCommunity('contact', e.target.value)} placeholder="https://tu-comunidad.org/contacto"/></Field><div className="field full-width"><span className="field-label">Acerca de</span><textarea value={draft.community.about} onChange={(e) => updateCommunity('about', e.target.value)} placeholder="Describe brevemente tu comunidad" rows={3} maxLength={500}/><span className="field-hint">{draft.community.about.length}/500 caracteres</span></div></div></section>
            <section className="config-section" id="market"><div className="config-section-head"><span className="section-number">02</span><div><h2>Reglas del mercado</h2><p>Establece límites de operación y comisiones. Los porcentajes se convierten a puntos base al guardar.</p></div></div><div className="form-grid"><div className="field full-width"><span className="field-label">Monedas fiat</span><div className="chips">{draft.market.fiat_currencies.map((currency) => <button className="chip" type="button" key={currency} onClick={() => updateMarket('fiat_currencies', draft.market.fiat_currencies.filter((x) => x !== currency))}>{currency}<b>×</b></button>)}{draft.market.fiat_currencies.length === 0 && <span className="empty-hint">Sin monedas seleccionadas · elige una para habilitar operaciones</span>}</div><div className="inline-add"><input aria-label="Código ISO de moneda" value={currencyInput} onChange={(e) => setCurrencyInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addCurrency())} placeholder="Código ISO · ej. USD" maxLength={3}/><button type="button" onClick={addCurrency}>Añadir moneda</button></div></div><Field label="Operación mínima" hint="Valor expresado en satoshis"><input type="number" min="0" value={draft.market.min_trade_sats} onChange={(e) => updateMarket('min_trade_sats', Number(e.target.value))}/></Field><Field label="Operación máxima" hint="Valor expresado en satoshis"><input type="number" min="0" value={draft.market.max_trade_sats} onChange={(e) => updateMarket('max_trade_sats', Number(e.target.value))}/></Field><Field label="Comisión del mercado" hint="Déjalo en 0% si no deseas cobrar una comisión"><div className="input-suffix"><input type="number" min="0" step="0.01" value={feeInputs.fee} required onChange={(e) => updateFee('fee', 'fee_bps', e.target.value)}/><span>%</span></div></Field><Field label="Comisión de desarrollo" hint="Porcentaje de la comisión del operador destinado al desarrollo"><div className="input-suffix"><input type="number" min="0" step="0.01" value={feeInputs.devFee} required onChange={(e) => updateFee('devFee', 'dev_fee_bps', e.target.value)}/><span>%</span></div></Field><Field label="Comisión máxima de enrutamiento" hint="Límite tolerado para Lightning"><div className="input-suffix"><input type="number" min="0" step="0.01" value={feeInputs.routingFee} required onChange={(e) => updateFee('routingFee', 'max_routing_fee_bps', e.target.value)}/><span>%</span></div></Field></div></section>
            <section className="config-section" id="safety"><div className="config-section-head"><span className="section-number">03</span><div><h2>Seguridad y garantías</h2><p>Opciones de bonos y prueba de trabajo para reducir el abuso.</p></div></div><Toggle checked={draft.safety.bond_enabled} onChange={(v) => updateSafety('bond_enabled', v)} label="Exigir bono para las operaciones" note="Las personas reservan sats como garantía durante una operación."/>{draft.safety.bond_enabled && <div className="form-grid compact-grid"><Field label="Bono relativo" hint="Porcentaje del valor de la operación"><div className="input-suffix"><input type="number" min="0" step="0.01" value={feeInputs.bond} required onChange={(e) => updateFee('bond', 'bond_bps', e.target.value)}/><span>%</span></div></Field><Field label="Bono base" hint="En satoshis"><input type="number" min="0" value={draft.safety.base_bond_sats} onChange={(e) => updateSafety('base_bond_sats', Number(e.target.value))}/></Field><Field label="Aplicar a"><select value={draft.safety.bond_apply_to} onChange={(e) => updateSafety('bond_apply_to', e.target.value)}><option value="both">Quien publica y quien acepta</option><option value="make">Quien publica</option><option value="take">Quien acepta</option></select></Field></div>}<div className="toggle-divider"/><Toggle checked={draft.safety.automatic_timeout_slash} onChange={(v) => updateSafety('automatic_timeout_slash', v)} label="Penalización automática por vencimiento" note="Penaliza el bond por vencimiento en estados de espera; no se aplica a todos los plazos de una operación."/><div className="form-grid compact-grid pow-grid"><Field label="Prueba de trabajo" hint="Dificultad general"><input type="number" min="0" value={draft.safety.pow} onChange={(e) => updateSafety('pow', Number(e.target.value))}/></Field><Field label="Primera conversación" hint="Dificultad para el primer contacto"><input type="number" min="0" value={draft.safety.pow_first_contact} onChange={(e) => updateSafety('pow_first_contact', Number(e.target.value))}/></Field></div></section>
            <section className="config-section" id="nostr"><div className="config-section-head"><span className="section-number">04</span><div><h2>Relays de Nostr</h2><p>Define los relays que usará tu instancia para publicar y recibir eventos.</p></div></div><div className="chips">{draft.nostr.relays.map((relay) => <button className="chip relay-chip" type="button" key={relay} onClick={() => setDraft((old) => ({ ...old, nostr: { relays: old.nostr.relays.filter((x) => x !== relay) } }))}><span>{relay}</span><b>×</b></button>)}{draft.nostr.relays.length === 0 && <span className="empty-hint">Aún no has añadido relays.</span>}</div><div className="inline-add"><input type="url" value={relayInput} onChange={(e) => setRelayInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addRelay())} placeholder="wss://relay.example.org"/><button type="button" onClick={addRelay}>Añadir relay</button></div></section>
            <section className="config-section" id="payments"><div className="config-section-head"><span className="section-number">05</span><div><h2>Métodos de pago</h2><p>Activa las opciones de pago que tu comunidad puede ofrecer.</p></div></div>{draft.payment_methods.length === 0 && <p className="empty-hint payment-empty">No hay métodos de pago añadidos. Añade solo las opciones que tu comunidad admite.</p>}<div className="payment-list">{draft.payment_methods.map((method, index) => <div className="payment-row" key={index}><span className="payment-mark">{method.label.slice(0, 1) || '·'}</span><div className="payment-edit"><input aria-label="Identificador del método" required value={method.id} placeholder="id" onChange={(e) => { markDirty(); setDraft((old) => ({ ...old, payment_methods: old.payment_methods.map((item, i) => i === index ? { ...item, id: e.target.value } : item) })); }}/><input aria-label="Nombre del método" required value={method.label} placeholder="Nombre" onChange={(e) => { markDirty(); setDraft((old) => ({ ...old, payment_methods: old.payment_methods.map((item, i) => i === index ? { ...item, label: e.target.value } : item) })); }}/><input aria-label="Categoría del método" required value={method.category} placeholder="Categoría" onChange={(e) => { markDirty(); setDraft((old) => ({ ...old, payment_methods: old.payment_methods.map((item, i) => i === index ? { ...item, category: e.target.value } : item) })); }}/></div><span className={`payment-state ${method.active ? 'enabled' : ''}`}>{method.active ? 'Activo' : 'Inactivo'}</span><button type="button" role="switch" aria-label={`${method.active ? 'Desactivar' : 'Activar'} ${method.label || 'método de pago'}`} aria-checked={method.active} className={`toggle small ${method.active ? 'on' : ''}`} onClick={() => { markDirty(); setDraft((old) => ({ ...old, payment_methods: old.payment_methods.map((item, i) => i === index ? { ...item, active: !item.active } : item) })); }}><i/></button><button type="button" className="remove-payment" aria-label={`Eliminar ${method.label || 'método de pago'}`} onClick={() => { markDirty(); setDraft((old) => ({ ...old, payment_methods: old.payment_methods.filter((_, i) => i !== index) })); }}>×</button></div>)}</div><button type="button" className="add-payment" onClick={() => { markDirty(); setDraft((old) => ({ ...old, payment_methods: [...old.payment_methods, { id: '', label: '', category: '', active: true }] })); }}>+ Añadir método de pago</button></section>
            {(apiError || notice) && <div className={`form-message ${apiError ? 'error' : 'success'}`} role="status">{apiError || notice}</div>}
            <div className="form-footer"><div className="footer-copy"><span className="secure-icon"><Icon name="check" size={13}/></span><span>Los cambios se guardan en el servidor local.</span></div><button className="button button-primary save-button" type="submit" disabled={saving || loading || !communityLoaded}><Icon name="save" size={16}/>{saving ? 'Guardando…' : 'Guardar configuración'}</button></div>
          </form>
        </div>
      </section>}
    </main>
  </div>;
}
export default App;
