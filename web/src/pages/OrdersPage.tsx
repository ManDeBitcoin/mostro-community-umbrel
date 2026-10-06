import { useCallback, useEffect, useRef, useState } from 'react';
import type { OrdersSnapshot } from '../types';
import type { Navigate } from '../lib/navigation';
import { api } from '../lib/api';
import { ORDER_STATUS_LABELS, isOpenDispute } from '../lib/constants';
import { formatDateTime, formatFiatAmount, formatNumber, formatTime, formatWhen, shortId } from '../lib/format';
import { ordersReadiness } from '../lib/overview';
import { Icon, StatusDot } from '../components/ui';
import { type Tone, Badge, Callout, EmptyState, LinkButton, PageHeader, Panel } from '../components/layout';

type StatusFilter = 'all' | 'pending' | 'in-progress' | 'success' | 'canceled';
const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'Todas' },
  { id: 'pending', label: 'Publicadas' },
  { id: 'in-progress', label: 'En curso' },
  { id: 'success', label: 'Completadas' },
  { id: 'canceled', label: 'Canceladas' },
];
const isStatusFilter = (value: string): value is StatusFilter => STATUS_FILTERS.some((item) => item.id === value);
const matchesStatus = (filter: StatusFilter, status: string) =>
  filter === 'all' || status === filter || (filter === 'success' && status === 'completed-by-admin');
const STATUS_TONE: Record<string, Tone> = { pending: 'info', 'in-progress': 'warn', success: 'good', 'completed-by-admin': 'good', canceled: 'neutral' };

const MONITOR_STATE: Record<string, string> = {
  unconfigured: 'Sin configurar',
  connecting: 'Conectando con los relays',
  syncing: 'Leyendo los eventos guardados',
  live: 'En vivo',
  degraded: 'Con relays caídos',
  disconnected: 'Sin conexión con los relays',
};
const RELAY_STATE: Record<string, string> = { live: 'en vivo', connecting: 'conectando', syncing: 'sincronizando', degraded: 'con fallos', disconnected: 'sin conexión', unconfigured: 'sin configurar' };

/**
 * The node's public order book, read only. `initialStatus` comes from the
 * address, so the summary page can link to "the orders in progress".
 */
export function OrdersPage({ initialStatus = '', navigate }: { initialStatus?: string; navigate: Navigate }) {
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
  // The status filter lives in the address: a figure of the summary can link
  // to it, and the menu entry always opens the whole book.
  const filterStatus: StatusFilter = isStatusFilter(initialStatus) ? initialStatus : 'all';
  const setFilterStatus = (next: StatusFilter) => navigate('orders', next === 'all' ? '' : next);
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

  const header = (actions?: React.ReactNode) => (
    <PageHeader
      group="Mercado"
      title="Órdenes"
      description="Las órdenes que tu nodo anuncia en los relays. Es una vista de solo lectura: el panel no toma órdenes ni mueve fondos."
      actions={actions}
    />
  );

  if (loading && !snapshot) {
    return <section className="content orders-page">{header()}<Panel><EmptyState icon="list" title="Leyendo las órdenes…" /></Panel></section>;
  }

  if (!snapshot) {
    return (
      <section className="content orders-page">
        {header()}
        <Callout tone="bad" title="No se pudieron leer las órdenes" action={<button type="button" className="button button-secondary" onClick={() => void fetchOrders(true)}>Reintentar</button>}>
          El panel no recibió respuesta de su servidor.
        </Callout>
      </section>
    );
  }

  // Nothing to read yet: no toolbar and no filters, only what is missing.
  if (snapshot.state === 'unconfigured') {
    return (
      <section className="content orders-page">
        {header()}
        <Panel>
          <EmptyState icon="list" title="Aún no hay órdenes que leer" action={<LinkButton onClick={() => navigate('home')}>Ver la puesta en marcha</LinkButton>}>
            El panel lee de los relays las órdenes de tu nodo. Para eso necesita la identidad del nodo y al menos un relay guardado en Configuración.
          </EmptyState>
        </Panel>
      </section>
    );
  }

  const { state, is_stale, last_update, source_npub, relays, orders } = snapshot;
  const openDisputes = (snapshot.disputes || []).filter((d) => isOpenDispute(d.status));
  const countOf = (filter: StatusFilter) => orders.filter((o) => matchesStatus(filter, o.status)).length;
  // Until the relays have been read, a count would be a zero nobody read, or a part of the book.
  const counted = ordersReadiness(snapshot) === 'read';
  const filteredOrders = orders.filter((o) => (filterKind === 'all' || o.kind === filterKind) && matchesStatus(filterStatus, o.status));

  return (
    <section className="content orders-page">
      {header(
        <div className="orders-updater-toolbar">
          <div className="orders-updater-status">
            <span className={`auto-refresh-pill ${autoRefresh ? 'is-live' : 'is-paused'}`}>
              <span className={`status-dot ${autoRefresh ? 'good pulse' : 'unknown'}`} />
              {autoRefresh ? (
                <>
                  <b>En vivo</b>
                  <small>({countdown} s)</small>
                </>
              ) : (
                <b>En pausa</b>
              )}
            </span>
            {lastRefreshedAt && <span className="last-sync-label">Leído a las {formatTime(lastRefreshedAt)}</span>}
          </div>
          <div className="orders-updater-actions">
            <div className="interval-selector">
              <label htmlFor="orders-refresh-interval" className="interval-label">Cada</label>
              <select
                id="orders-refresh-interval"
                value={refreshIntervalSec}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setRefreshIntervalSec(val);
                  setCountdown(val);
                }}
                className="interval-select"
                title="Cada cuánto se vuelven a leer las órdenes"
              >
                <option value={3}>3 s</option>
                <option value={5}>5 s</option>
                <option value={10}>10 s</option>
                <option value={30}>30 s</option>
              </select>
            </div>
            <button
              type="button"
              className="button button-secondary auto-toggle-btn"
              onClick={() => {
                const nextState = !autoRefresh;
                setAutoRefresh(nextState);
                if (nextState) {
                  setCountdown(refreshIntervalSec);
                  void fetchOrders(true);
                }
              }}
            >
              {autoRefresh ? 'Pausar' : 'Reanudar'}
            </button>
            <button
              type="button"
              className="button button-secondary refresh-button"
              onClick={() => {
                setCountdown(refreshIntervalSec);
                void fetchOrders(true);
              }}
              disabled={refreshing || loading}
            >
              <Icon name="refresh" size={14} /> Actualizar
            </button>
          </div>
        </div>,
      )}

      {newOrdersCount > 0 && (
        <div className="new-orders-banner" role="status">
          <div className="new-orders-info">
            <span className="new-orders-icon">⚡</span>
            <span>
              <strong>{newOrdersCount === 1 ? '1 orden nueva' : `${newOrdersCount} órdenes nuevas`}</strong> desde que abriste esta página.
            </span>
          </div>
          <button type="button" className="button button-secondary dismiss-btn" onClick={() => setNewOrdersCount(0)}>
            Entendido
          </button>
        </div>
      )}

      {openDisputes.length > 0 && (
        <Callout
          tone="bad"
          title={openDisputes.length === 1 ? 'Hay 1 disputa abierta' : `Hay ${openDisputes.length} disputas abiertas`}
          action={<button type="button" className="button button-primary" onClick={() => navigate('disputes')}>Ver disputas</button>}
        >
          El nodo las anuncia aparte. El estado público de una orden no cambia cuando entra en disputa.
        </Callout>
      )}

      <Panel
        id="orders-monitor"
        title="Libro de órdenes"
        description={
          <>
            Publicadas por {source_npub ? <code>{shortId(source_npub, 16)}</code> : 'una identidad sin configurar'}.{' '}
            {is_stale ? 'Datos retenidos: el panel no recibe eventos nuevos' : 'Datos al día'}
            {last_update > 0 && `, último evento a las ${formatTime(last_update)}`}.
          </>
        }
        aside={<Badge tone={state === 'live' && !is_stale ? 'good' : 'warn'}>{MONITOR_STATE[state] || state}</Badge>}
      >
        {relays && relays.length > 0 && (
          <div className="relay-row">
            <span className="field-label">Relays</span>
            {relays.map((r) => (
              <span key={r.url} className="chip" title={r.last_error || undefined}>
                <StatusDot status={r.state === 'live' ? 'online' : r.state === 'connecting' || r.state === 'syncing' ? 'warning' : 'offline'} />
                {r.url.replace(/^wss?:\/\//, '')} · {RELAY_STATE[r.state] || r.state}
              </span>
            ))}
          </div>
        )}

        <details className="help-details">
          <summary>Cómo leer el estado de una orden</summary>
          <p>
            El nodo solo publica cuatro estados y son menos precisos que el real. Una orden «Publicada» puede estar ya tomada, y una «En curso» sigue así mientras está activa, con el pago fiat enviado o en disputa. El detalle de cada orden está en sus mensajes.
          </p>
        </details>

        <div className="orders-filters">
          <div className="filter-chips" role="group" aria-label="Filtrar por estado">
            {STATUS_FILTERS.map((item) => (
              <button key={item.id} type="button" className={`filter-chip ${filterStatus === item.id ? 'active' : ''}`} aria-pressed={filterStatus === item.id} onClick={() => setFilterStatus(item.id)}>
                {item.label}{counted && <> <span>{countOf(item.id)}</span></>}
              </button>
            ))}
          </div>
          <label className="inline-select">
            <span>Tipo</span>
            <select value={filterKind} onChange={(e) => setFilterKind(e.target.value as 'all' | 'buy' | 'sell')}>
              <option value="all">Compras y ventas</option>
              <option value="sell">Solo ventas</option>
              <option value="buy">Solo compras</option>
            </select>
          </label>
        </div>

        {orders.length === 0 ? (
          state === 'syncing' || state === 'connecting' ? (
            <EmptyState icon="list" title="Leyendo los relays…">Las órdenes aparecerán en cuanto los relays respondan.</EmptyState>
          ) : state === 'disconnected' || is_stale ? (
            // No data is not the same as no orders.
            <EmptyState icon="list" title="El panel no recibe datos de los relays">No puede saber si tu nodo tiene órdenes publicadas. Revisa el estado de cada relay, arriba.</EmptyState>
          ) : (
            <EmptyState icon="list" title="Tu nodo no ha publicado órdenes">Aparecerán aquí cuando alguien publique una orden en tu comunidad.</EmptyState>
          )
        ) : filteredOrders.length === 0 ? (
          <EmptyState icon="list" title="Ninguna orden con ese filtro">
            Cambia el estado o el tipo para ver las demás.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data-table" aria-label="Órdenes del nodo">
              <thead>
                <tr>
                  <th>Orden</th>
                  <th>Tipo</th>
                  <th>Importe</th>
                  <th>Sats</th>
                  <th>Pago</th>
                  <th>Estado</th>
                  <th><span className="sr-only">Mensajes</span></th>
                </tr>
              </thead>
              <tbody>
                {filteredOrders.map((o) => (
                  <tr key={o.id} className={newlyAddedIds.has(o.id) ? 'order-row-highlight' : ''}>
                    <td>
                      <code className="order-id" title={o.id}>{shortId(o.id)}</code>
                      <small title={formatDateTime(o.published_at || o.created_at)}>{formatWhen(o.published_at || o.created_at)}</small>
                    </td>
                    <td>{o.kind === 'sell' ? 'Venta' : 'Compra'}</td>
                    <td>
                      <strong>
                        {formatFiatAmount(o.fiat_amount_range, o.fiat_code)}
                      </strong>
                      <small>
                        {o.fiat_amount_range.length === 2 ? 'Rango · ' : ''}
                        {o.premium !== 0
                          ? `Precio de mercado, prima ${o.premium > 0 ? '+' : ''}${o.premium} %`
                          : o.status === 'pending' && o.amount_sats > 0
                            ? 'Precio fijo en sats'
                            : o.status === 'pending'
                              ? 'Precio de mercado, sin prima'
                              : 'Sin prima'}
                      </small>
                    </td>
                    <td>{o.amount_sats > 0 ? formatNumber(o.amount_sats_str || o.amount_sats) : o.status === 'pending' ? <small>Se fijan al tomarla</small> : '—'}</td>
                    <td><small>{o.payment_methods.length > 0 ? o.payment_methods.join(', ') : '—'}</small></td>
                    <td><Badge tone={STATUS_TONE[o.status] || 'neutral'}>{ORDER_STATUS_LABELS[o.status] || o.status}</Badge></td>
                    <td className="cell-action">
                      <button type="button" className="button button-secondary button-small" onClick={() => navigate('disputes', o.id)} title="Ver los mensajes de protocolo de esta orden">
                        <Icon name="message" size={13} /> Mensajes
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {orders.length > 0 && <p className="panel-note">{filteredOrders.length} de {orders.length} órdenes.</p>}
      </Panel>
    </section>
  );
}
