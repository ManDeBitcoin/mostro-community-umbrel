import { useCallback, useEffect, useRef, useState } from 'react';
import type { DisputeView, OrdersSnapshot, ChatMessage, ChatHistory } from '../types';
import { copyToClipboard, api } from '../lib/api';
import { ORDER_STATUS_LABELS, DISPUTE_STATUS_LABELS } from '../lib/constants';
import { formatDateTime, formatNumber, formatStamp, formatWhen, shortId } from '../lib/format';
import { Icon } from '../components/ui';
import { Badge, Callout, PageHeader, Panel } from '../components/layout';

const isOrderId = (text: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text);
// A dispute the panel cannot tie to an order is addressed by its own id: `#/disputas/disputa-<id>`.
const DISPUTE_PREFIX = 'disputa-';

export function MediationConsole({
  initialOrderId = '',
  onSelectOrder,
}: {
  initialOrderId?: string;
  onSelectOrder?: (orderId: string, options?: { replace?: boolean }) => void;
}) {
  // The order on screen is the one in the address, so Back and Forward, a
  // reload and a shared link all show the same thing. Only a real order id is
  // accepted: it goes into a request path.
  const selectedOrderId = isOrderId(initialOrderId) ? initialOrderId.toLowerCase() : '';
  const addressedDisputeId = initialOrderId.startsWith(DISPUTE_PREFIX) && isOrderId(initialOrderId.slice(DISPUTE_PREFIX.length)) ? initialOrderId.slice(DISPUTE_PREFIX.length).toLowerCase() : '';
  const [inputOrderId, setInputOrderId] = useState<string>(selectedOrderId);
  // The row clicked last, to tell apart two disputes of one order. It only
  // counts while it belongs to the order on screen.
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
    setInputOrderId(selectedOrderId);
  }, [selectedOrderId]);

  // The panel can learn the order of a dispute later, from its messages. The
  // address then moves on to that order, where the guide can name both ids.
  useEffect(() => {
    const learned = addressedDisputeId ? (disputes || []).find((d) => d.id === addressedDisputeId)?.order_id : null;
    if (learned && onSelectOrder) onSelectOrder(learned, { replace: true });
  }, [addressedDisputeId, disputes, onSelectOrder]);

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
    if (!isOrderId(orderId)) return;
    setLoading(true);
    setError('');
    try {
      const data = await api<ChatHistory>(`/api/chat/${encodeURIComponent(orderId)}`);
      // A slower answer for the order shown before must not replace this one.
      if (data.order_id === selectedOrderRef.current) setHistory(data);
    } catch (err) {
      if (orderId === selectedOrderRef.current) {
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
    if (onSelectOrder) onSelectOrder(orderId);
  };

  const selectDispute = (d: DisputeView) => {
    setSelectedDisputeId(d.id);
    selectOrder(d.order_id || `${DISPUTE_PREFIX}${d.id}`);
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const id = inputOrderId.trim().toLowerCase();
    if (!id) return;
    if (!isOrderId(id)) {
      setError('Eso no es el identificador de una orden. Tiene este aspecto: edbd72f6-0bb0-4740-8b1c-7f51b6ad72ba.');
      return;
    }
    setSelectedDisputeId('');
    // Selecting another order loads it through the effect; asking again
    // for the same one refreshes it.
    if (id === selectedOrderId) void fetchChat(id);
    else selectOrder(id);
  };

  const copy = (text: string, key: string) =>
    copyToClipboard(text, () => {
      setCopied(key);
      setTimeout(() => setCopied(''), 1800);
    });

  const sortedDisputes = [...(disputes || [])].sort((a, b) => Number(b.is_open) - Number(a.is_open) || b.updated_at - a.updated_at);
  const openCount = sortedDisputes.filter((d) => d.is_open).length;
  // A dispute is only shown together with the order it belongs to. After Back
  // or Forward the address can name another order than the row clicked last,
  // and the guide below prints commands with both ids.
  const selectedDispute = addressedDisputeId
    ? sortedDisputes.find((d) => d.id === addressedDisputeId && !d.order_id)
    : selectedOrderId
      ? sortedDisputes.find((d) => d.id === selectedDisputeId && d.order_id === selectedOrderId) ||
        sortedDisputes.find((d) => d.order_id === selectedOrderId) ||
        (history?.dispute_id && history.order_id === selectedOrderId ? sortedDisputes.find((d) => d.id === history.dispute_id) : undefined)
      : undefined;
  const badOrderParam = Boolean(initialOrderId) && !selectedOrderId && !addressedDisputeId;
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
      <PageHeader
        group="Mercado"
        title="Disputas"
        description="Las disputas que anuncia tu nodo y el historial de mensajes entre los usuarios y el daemon en cada orden."
        actions={
          <button
            type="button"
            className="button button-secondary"
            onClick={() => {
              void fetchDisputes();
              if (selectedOrderId) void fetchChat(selectedOrderId);
            }}
            disabled={loading}
          >
            <Icon name="refresh" size={14} /> Actualizar
          </button>
        }
      />

      <Callout tone="info" title="Esta página observa, no resuelve">
        Muestra las disputas que publica el nodo y los mensajes de protocolo entre cada usuario y el daemon, descifrados en memoria con la identidad del nodo. No puede leer el chat entre comprador y vendedor ni el del mediador con las partes: se cifran con claves que el nodo no tiene. Lo que envía un usuario es una petición: solo una respuesta del daemon confirma que la procesó.
      </Callout>

      <Panel
        id="disputes-list"
        title="Disputas del nodo"
        description={
          disputesError && disputes === null
              ? 'No se pudieron consultar las disputas.'
              : disputes === null
                ? 'Cargando…'
                : sortedDisputes.length === 0
                  ? monitorIsLive
                    ? 'El nodo no ha anunciado ninguna disputa en los relays configurados.'
                    : 'Sin disputas conocidas todavía.'
                  : `${openCount} abierta${openCount === 1 ? '' : 's'} de ${sortedDisputes.length} anunciada${sortedDisputes.length === 1 ? '' : 's'}.`
        }
        aside={disputes !== null ? <Badge tone={openCount > 0 ? 'bad' : 'good'}>{openCount > 0 ? `${openCount} abierta${openCount === 1 ? '' : 's'}` : 'Ninguna abierta'}</Badge> : undefined}
      >
        {(disputesError || (ordersSnapshot && !monitorIsLive)) && (
        <div className="form-message error">
          {disputesError
            ? `No se pudieron consultar las disputas (${disputesError}). La lista puede estar incompleta.`
            : `El monitor de relays no está al día (estado: ${monitorState}${ordersSnapshot?.is_stale ? ', datos retenidos' : ''}). Puede haber disputas abiertas que aún no aparecen aquí.`}
        </div>
      )}
        {sortedDisputes.length > 0 && (
          <div className="table-wrap">
            <table className="data-table" aria-label="Disputas anunciadas por el nodo">
              <thead>
                <tr>
                  <th>Disputa</th>
                  <th>Estado</th>
                  <th>La abrió</th>
                  <th>Abierta</th>
                  <th>Orden</th>
                </tr>
              </thead>
              <tbody>
              {sortedDisputes.map((d) => (
                <tr
                  key={d.id}
                  className={selectedDispute?.id === d.id ? 'order-row-highlight' : ''}
                  style={{ cursor: 'pointer' }}
                  onClick={() => selectDispute(d)}
                >
                  <td>
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
                      <code>{shortId(d.id)}</code>
                    </button>
                  </td>
                  <td>
                    <Badge tone={d.status === 'initiated' ? 'bad' : d.is_open ? 'warn' : 'neutral'}>{DISPUTE_STATUS_LABELS[d.status] || d.status}</Badge>
                  </td>
                  <td>{d.initiator === 'buyer' ? 'Comprador' : d.initiator === 'seller' ? 'Vendedor' : '—'}</td>
                  <td title={formatDateTime(d.published_at || d.updated_at)}>{formatWhen(d.published_at || d.updated_at)}</td>
                  <td>
                    {d.order_id ? <code>{shortId(d.order_id)}</code> : <small>Sin identificar</small>}
                  </td>
                </tr>
              ))}
            </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="sim-controls" style={{ marginBottom: '16px', display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
        <form onSubmit={handleSearch} style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', flex: '1 1 220px', minWidth: 0, alignItems: 'flex-end' }}>
          <div className="sim-control-group" style={{ flex: '1 1 180px', minWidth: 0 }}>
            <label htmlFor="order-search">Ver los mensajes de una orden (UUID)</label>
            <input
              id="order-search"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="Ej. edbd72f6-0bb0-4740-8b1c-7f51b6ad72ba"
              value={inputOrderId}
              onChange={(e) => setInputOrderId(e.target.value)}
            />
          </div>
          <button type="submit" className="button button-primary" style={{ height: '32px' }}>
            Cargar mensajes
          </button>
        </form>
      </div>

      {badOrderParam && <div className="form-message error" role="alert">La dirección no lleva el identificador de una orden. Elige una disputa de la tabla o escribe el UUID de la orden.</div>}
      {error && <div className="form-message error" role="alert">{error}</div>}

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
                const formattedTime = formatStamp(msg.created_at);
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
                    <code>{msg.sender.slice(0, 12)}…{msg.sender.slice(-4)}</code> · {formatDateTime(msg.created_at)} · {msg.action || 'sin acción'}
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
                      {selectedOrder.amount_sats > 0 ? `${formatNumber(selectedOrder.amount_sats)} sats · ` : ''}
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
