import { useCallback, useEffect, useRef, useState } from 'react';
import type { OrdersSnapshot } from '../types';
import { api } from '../lib/api';
import { ORDER_STATUS_LABELS, CLOSED_ORDER_STATUSES, isOpenDispute } from '../lib/constants';
import { Icon, StatusDot } from '../components/ui';

export function OrdersPage({ onSelectDispute }: { onSelectDispute?: (orderId: string) => void }) {
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
