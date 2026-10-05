import type { Simulator } from '../hooks/useSimulator';
import { ActorBadge, Icon } from '../components/ui';
import { formatNumber } from '../lib/format';
import { Callout, PageHeader, Panel } from '../components/layout';

// How each simulated case ends, in words. The codes are the simulator's own.
const SIMULATION_OUTCOME: Record<string, string> = {
  success: 'completada',
  success_dispute_resolved: 'completada por decisión del mediador',
  refunded_to_seller: 'cancelada, con los sats devueltos al vendedor',
  canceled: 'cancelada',
};

export function SimulatorPage({ simulator }: { simulator: Simulator }) {
  const { simScenarios, selectedScenario, setSelectedScenario, simSatsInput, setSimSatsInput, simulating, simulationReport, simError, handleRunSimulation } = simulator;
  const scenario = simScenarios.find((item) => item.id === selectedScenario);
  return (
    <section className="content simulation-page">
      <PageHeader
        group="Herramientas"
        title="Simulador de operaciones"
        description="Recorre una operación paso a paso con las reglas guardadas de tu comunidad. No mueve fondos ni publica nada."
        actions={
          simulationReport && (
            <button className="button button-secondary" onClick={() => void handleRunSimulation()} disabled={simulating}>
              <Icon name="refresh" size={14} /> {simulating ? 'Simulando…' : 'Repetir simulación'}
            </button>
          )
        }
      />

      <Callout tone="info" title="Es un ensayo, no una operación">
        Recorre los mensajes, las facturas, las garantías y las comisiones de una operación con las reglas guardadas. No ejecuta nada en Bitcoin ni en Lightning y no publica en los relays. La secuencia es la de Mostro v0.19.2; los identificadores son inventados y el cambio a fiat es orientativo.
      </Callout>

      <Panel id="sim-run" title="Qué quieres ensayar" description="Elige un caso y el tamaño de la operación.">
        <div className="sim-controls">
          <div className="sim-control-group" style={{ flex: '1 1 280px' }}>
            <label htmlFor="sim-scenario">Caso</label>
            <select id="sim-scenario" value={selectedScenario} onChange={(e) => setSelectedScenario(e.target.value)}>
              {simScenarios.length > 0 ? simScenarios.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              )) : (
                <>
                  <option value="happy_path">Operación completada</option>
                  <option value="dispute_settled_for_buyer">Disputa resuelta a favor del comprador</option>
                  <option value="dispute_refunded_to_seller">Disputa resuelta con devolución al vendedor</option>
                  <option value="seller_cancellation">Cancelación por el vendedor antes de la toma</option>
                </>
              )}
            </select>
          </div>
          <div className="sim-control-group">
            <label htmlFor="sim-sats">Importe de la orden en sats</label>
            <input id="sim-sats" type="number" min="1000" step="1000" value={simSatsInput} onChange={(e) => setSimSatsInput(e.target.value)} />
          </div>
          <div style={{ marginTop: 'auto' }}>
            <button type="button" className="button button-primary" onClick={() => void handleRunSimulation()} disabled={simulating}>
              <Icon name="play" size={14} /> {simulating ? 'Simulando…' : 'Simular'}
            </button>
          </div>
        </div>

        {scenario?.description && <p className="panel-note">{scenario.description}</p>}

        {simError && <div className="form-message error">{simError}</div>}

        {simulationReport ? (
          <>
            <div className="sim-complete-banner">
              <div>
                <strong>{simScenarios.find((item) => item.id === simulationReport.scenario)?.label || simulationReport.scenario}</strong> · orden de ejemplo <code>{simulationReport.order_id}</code>
              </div>
              <div>
                <span>Termina <strong>{SIMULATION_OUTCOME[simulationReport.final_status] || simulationReport.final_status}</strong></span>
              </div>
            </div>

            <div className="sim-financials">
              <div className="sim-financial-item">
                <span>Importe de la orden</span>
                <strong>{formatNumber(simulationReport.financials.trade_amount_sats)} sats</strong>
                <small>≈ {simulationReport.financials.fiat_amount} {simulationReport.financials.fiat_currency}</small>
              </div>
              <div className="sim-financial-item">
                <span>Garantía Vendedor</span>
                <strong>{formatNumber(simulationReport.financials.seller_bond_sats)} sats</strong>
                <small>Factura retenida aparte</small>
              </div>
              <div className="sim-financial-item">
                <span>Garantía Comprador</span>
                <strong>{formatNumber(simulationReport.financials.buyer_bond_sats)} sats</strong>
                <small>Factura retenida aparte</small>
              </div>
              <div className="sim-financial-item">
                <span>Comisión Mostro</span>
                <strong>{formatNumber(simulationReport.financials.total_mostro_fee_sats ?? simulationReport.financials.fee_sats ?? 0)} sats</strong>
                <small>{formatNumber(simulationReport.financials.fee_per_side_sats ?? 0)} sats/lado · Dev: {formatNumber(simulationReport.financials.dev_fee_sats ?? 0)} sats</small>
              </div>
              <div className="sim-financial-item">
                <span>Depósito del Vendedor</span>
                <strong>{formatNumber(simulationReport.financials.seller_hold_invoice_sats ?? simulationReport.financials.seller_total_locked_sats)} sats</strong>
                <small>Orden + su mitad de la comisión</small>
              </div>
              <div className="sim-financial-item">
                <span>Recibe el Comprador</span>
                <strong>{formatNumber(simulationReport.financials.buyer_receives_sats ?? 0)} sats</strong>
                <small>Orden − su mitad de la comisión</small>
              </div>
            </div>

            <div className="section-title-row" style={{ marginTop: '20px' }}>
              <div>
                <h2>Secuencia, paso a paso ({simulationReport.steps.length})</h2>
                <p>Qué mensaje viaja y qué pasa en Lightning en cada momento de la operación.</p>
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
                            Estado: <strong>{st.lightning_action.status}</strong> · {formatNumber(st.lightning_action.amount_sats)} sats
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </article>
              ))}
            </div>

          </>
        ) : (
          <div style={{ textAlign: 'center', padding: '30px', color: '#88988e' }}>
            <p>Pulsa Simular para ver los importes y la secuencia paso a paso.</p>
          </div>
        )}
      </Panel>
    </section>
  );
}
