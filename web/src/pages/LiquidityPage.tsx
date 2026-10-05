import { useCallback, useEffect, useState } from 'react';
import type { LndChannelsReport } from '../types';
import { copyToClipboard, api } from '../lib/api';
import { Icon, StatusDot } from '../components/ui';

export function LiquidityOperationsPage() {
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
