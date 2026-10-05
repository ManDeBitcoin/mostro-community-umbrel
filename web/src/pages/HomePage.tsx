import type { Configuration } from '../types';
import type { PanelData } from '../hooks/usePanelData';
import type { Navigate } from '../lib/navigation';
import { formatDateTime, formatNumber, formatTime } from '../lib/format';
import { type AttentionItem, type MarketStatus, type OrderStats, type RuleLine, type RulesRead, type ServiceTile, type SetupStep, isSettingUp, rulesNotReadNote } from '../lib/overview';
import { Icon } from '../components/ui';
import { Badge, EmptyState, LinkButton, PageHeader, Panel, Stat } from '../components/layout';
import { alertTone } from './AlertsPage';

const HERO_ICON: Record<string, string> = { good: 'check', warn: 'alert', bad: 'alert', info: 'info', neutral: 'circle' };

export function HomePage({
  data,
  communityName,
  status,
  attention,
  steps,
  services,
  stats,
  rules,
  rulesAnnounced,
  savedConfig,
  rulesRead,
  activating,
  onActivate,
  navigate,
}: {
  data: PanelData;
  communityName: string;
  status: MarketStatus;
  attention: AttentionItem[];
  steps: SetupStep[];
  services: ServiceTile[];
  stats: OrderStats;
  rules: RuleLine[];
  /** The rules come from the node's announcement, not from the saved draft. */
  rulesAnnounced: boolean;
  savedConfig: Configuration | null;
  /** Until the saved rules have been read, `savedConfig` says nothing. */
  rulesRead: RulesRead;
  activating: boolean;
  onActivate: () => void;
  navigate: Navigate;
}) {
  const { daemon, notifications, loading, settled, updatedAt, refresh } = data;
  // "All is well" needs the data that would say otherwise: the daemon report
  // and what the relays hold, which is where an open dispute would show.
  const relaysRead = stats.readiness === 'read' || stats.readiness === 'unconfigured';
  const canJudge = daemon !== null && relaysRead;
  const pendingSteps = steps.filter((step) => !step.done);
  const nextStep = pendingSteps[0];
  const setupDone = steps.length - pendingSteps.length;
  const settingUp = isSettingUp(status);
  // The main action is the next step of the setup, so the two never disagree.
  const canActivateNow = settingUp && nextStep?.id === 'activate' && Boolean(daemon?.can_activate);
  // While setting up, the headline names the next step, the same one its button opens.
  const headline =
    settingUp && nextStep
      ? nextStep.id === 'activate'
        ? { title: 'Todo listo para abrir el mercado', detail: 'Activa Mostro para que el nodo empiece a anunciarse en los relays y a aceptar órdenes.' }
        : { title: status.title, detail: `${status.detail} Siguiente paso: ${nextStep.title.charAt(0).toLowerCase()}${nextStep.title.slice(1)}.` }
      : status;

  const setupPanel = settingUp && pendingSteps.length > 0 && (
    <Panel
      id="setup"
      title="Puesta en marcha"
      description="Los pasos para pasar de una instalación vacía a un mercado abierto, en el orden en que hay que darlos."
      aside={<Badge tone={setupDone === steps.length ? 'good' : 'info'}>{setupDone} de {steps.length}</Badge>}
    >
      <ol className="setup-list">
        {steps.map((step, index) => {
          const isNext = step === nextStep;
          return (
            <li key={step.id} className={`setup-step ${step.done ? 'is-done' : isNext ? 'is-next' : ''}`}>
              <span className="setup-mark" aria-hidden="true">{step.done ? <Icon name="check" size={14} /> : index + 1}</span>
              <div className="setup-text">
                <strong>{step.title}</strong>
                <span>{step.detail}</span>
              </div>
              {step.done ? (
                <span className="setup-state">Hecho</span>
              ) : (
                <button type="button" className={`button ${isNext ? 'button-primary' : 'button-secondary'}`} onClick={() => navigate(step.page)}>
                  {step.action}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </Panel>
  );

  return (
    <section className="content home-page">
      <PageHeader
        group="Inicio"
        title={communityName || 'Resumen'}
        description="Cómo está tu comunidad ahora y qué requiere tu atención."
        actions={
          <>
            <span className="updated-label">{loading ? 'Consultando…' : updatedAt ? `Actualizado a las ${formatTime(updatedAt)}` : ''}</span>
            <button type="button" className="button button-secondary" onClick={() => void refresh()} disabled={loading}>
              <Icon name="refresh" size={14} /> Actualizar
            </button>
          </>
        }
      />

      <section className={`status-hero tone-${status.tone}`} aria-labelledby="market-status-title">
        <div className="status-hero-main">
          <span className="status-hero-icon"><Icon name={HERO_ICON[status.tone]} size={22} /></span>
          <div>
            <span className="status-hero-kicker">Estado del mercado</span>
            <h2 id="market-status-title">{headline.title}</h2>
            <p>{headline.detail}</p>
          </div>
          <div className="status-hero-action">
            {canActivateNow ? (
              <button type="button" className="button button-primary" onClick={onActivate} disabled={activating}>
                <Icon name="power" size={15} /> {activating ? 'Activando…' : 'Activar Mostro'}
              </button>
            ) : settingUp && nextStep ? (
              <button type="button" className="button button-primary" onClick={() => navigate(nextStep.page)}>
                {nextStep.action} <Icon name="next" size={14} />
              </button>
            ) : (
              <button type="button" className="button button-secondary" onClick={() => navigate('node')}>
                Ver el nodo <Icon name="next" size={14} />
              </button>
            )}
          </div>
        </div>
        {rules.length > 0 && (
          <div className="status-hero-rules">
            <span className="status-hero-rules-title">{rulesAnnounced ? 'Lo que anuncia el nodo a las apps' : 'Reglas guardadas. El nodo no las está anunciando ahora'}</span>
            <dl>
              {rules.slice(0, 4).map((rule) => (
                <div key={rule.label}>
                  <dt>{rule.label}</dt>
                  <dd>{rule.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </section>

      {setupPanel}

      {(attention.length > 0 || !setupPanel) && (
      <Panel
        id="attention"
        title={attention.length > 0 ? 'Requiere tu atención' : canJudge ? 'Nada requiere tu atención' : 'Aún no se puede comprobar'}
        description={attention.length > 0 ? 'Ordenado de más a menos urgente. Cada aviso lleva a la página donde se resuelve.' : undefined}
        aside={attention.length > 0 ? <Badge tone={attention.some((item) => item.tone === 'bad') ? 'bad' : 'warn'}>{attention.length}</Badge> : canJudge ? <Badge tone="good">Todo en orden</Badge> : undefined}
      >
        {attention.length > 0 ? (
          <ul className="attention-list">
            {attention.map((item) => (
              <li key={item.id} className={`attention-item tone-${item.tone}`}>
                <span className="attention-icon"><Icon name={item.tone === 'info' ? 'info' : 'alert'} size={16} /></span>
                <div className="attention-text">
                  <strong>{item.title}</strong>
                  {item.detail && <span>{item.detail}</span>}
                </div>
                <button type="button" className="button button-secondary" onClick={() => (item.id === 'api' ? void refresh() : navigate(item.page))}>
                  {item.action}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="panel-note">
            {canJudge
              ? 'No hay disputas abiertas ni avisos del nodo, de Lightning o de los respaldos.'
              : daemon !== null && stats.readiness === 'reading'
                ? 'El panel aún está leyendo los relays: todavía no sabe si hay disputas abiertas.'
                : settled
                  ? 'El panel no ha podido leer el estado del nodo o de los relays.'
                  : 'Consultando el estado del nodo y de los relays…'}
          </p>
        )}
      </Panel>
      )}

      <Panel
        id="activity"
        title="Actividad del mercado"
        description="Las órdenes que tu nodo ha anunciado y que los relays aún conservan. El estado público es menos preciso que el real: una orden publicada puede estar ya tomada."
        aside={<LinkButton onClick={() => navigate('orders')}>Ver las órdenes</LinkButton>}
      >
        {stats.known ? (
          <div className="stat-grid">
            <Stat label="Ofertas publicadas" value={formatNumber(stats.pending)} hint="A la espera de alguien que las tome" onClick={() => navigate('orders', 'pending')} />
            <Stat label="En curso" value={formatNumber(stats.inProgress)} hint="Tomadas y sin cerrar" tone={stats.inProgress > 0 ? 'info' : 'neutral'} onClick={() => navigate('orders', 'in-progress')} />
            <Stat label="Completadas" value={formatNumber(stats.completed)} hint={stats.completedSats > 0 ? `${formatNumber(stats.completedSats)} sats` : 'Ninguna todavía'} tone={stats.completed > 0 ? 'good' : 'neutral'} onClick={() => navigate('orders', 'success')} />
            <Stat label="Canceladas" value={formatNumber(stats.canceled)} hint="Retiradas, vencidas o devueltas" onClick={() => navigate('orders', 'canceled')} />
            <Stat label="Disputas abiertas" value={formatNumber(stats.openDisputes)} hint={stats.openDisputes > 0 ? 'Esperan a un mediador' : 'Ninguna'} tone={stats.openDisputes > 0 ? 'bad' : 'neutral'} onClick={() => navigate('disputes')} />
          </div>
        ) : stats.readiness === 'unread' ? (
          <p className="panel-note">{settled ? 'El panel no ha podido leer las órdenes.' : 'Consultando las órdenes…'}</p>
        ) : stats.readiness === 'reading' ? (
          // Counting now would show zeros, or a part of the book, as if they were the totals.
          <p className="panel-note">Leyendo las órdenes en los relays…</p>
        ) : stats.readiness === 'unreachable' ? (
          <p className="panel-note">Ningún relay responde ahora: el panel no sabe qué órdenes hay.</p>
        ) : (
          <EmptyState icon="list" title="Aún no hay órdenes que contar">
            El panel empieza a leer las órdenes cuando el nodo tiene identidad y relays configurados.
          </EmptyState>
        )}
      </Panel>

      <Panel id="services" title="Servicios" description="De qué depende tu mercado. Cada tarjeta lleva a la página donde se gestiona.">
        <div className="service-row">
          {services.map((service) => (
            <button key={service.id} type="button" className="service-tile is-link" onClick={() => navigate(service.page)}>
              <div className="service-tile-top">
                <span className="service-tile-icon"><Icon name={service.icon} size={17} /></span>
                <Badge tone={service.tone}>{service.label}</Badge>
              </div>
              <strong>{service.title}</strong>
              <p>{service.detail}</p>
              {service.meta && <span className="service-tile-meta">{service.meta}</span>}
            </button>
          ))}
        </div>
      </Panel>

      <Panel id="recent-alerts" title="Últimas alertas" aside={<LinkButton onClick={() => navigate('alerts')}>Ver todas</LinkButton>}>
        {notifications.length === 0 ? (
          <p className="panel-note">{data.notificationsRead ? 'El panel no ha registrado ninguna alerta.' : settled ? 'El panel no ha podido leer las alertas.' : 'Consultando las alertas…'}</p>
        ) : (
          <ul className="alert-list compact">
            {notifications.slice(0, 3).map((item) => (
              <li key={item.id} className={`alert-row tone-${alertTone(item.level)}`}>
                <div className="alert-main">
                  <div className="alert-title"><strong>{item.title}</strong></div>
                  <p>{item.message}</p>
                </div>
                <div className="alert-meta">
                  <time dateTime={new Date(item.timestamp * 1000).toISOString()}>{formatDateTime(item.timestamp)}</time>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {!savedConfig && !settingUp && (
        rulesRead === 'loaded'
          ? <p className="panel-note">Aún no hay reglas guardadas. <LinkButton onClick={() => navigate('config')}>Abrir configuración</LinkButton></p>
          : <p className="panel-note">{rulesNotReadNote(rulesRead)}</p>
      )}
    </section>
  );
}
