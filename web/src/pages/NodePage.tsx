import { useState } from 'react';
import type { Configuration } from '../types';
import type { PanelData } from '../hooks/usePanelData';
import type { Identity } from '../hooks/useIdentity';
import type { Navigate } from '../lib/navigation';
import { copyToClipboard } from '../lib/api';
import { formatAge, formatAgo, formatDateTime, shortKey } from '../lib/format';
import { type MarketStatus, announcedRules, daemonNotices, isActive, routeNotice, savedRules } from '../lib/overview';
import { Icon } from '../components/ui';
import { Badge, Callout, Fact, FactGrid, LinkButton, PageHeader, Panel } from '../components/layout';

const VERSION_SOURCE: Record<string, string> = {
  announced: 'La anuncia el nodo en los relays',
  binary: 'Es la del binario incluido; el nodo aún no la anuncia',
  pinned: 'Es la que fija el paquete; sin confirmar',
};

export function NodePage({
  data,
  status,
  savedConfig,
  identity,
  activating,
  onActivate,
  onDeactivate,
  navigate,
}: {
  data: PanelData;
  status: MarketStatus;
  savedConfig: Configuration | null;
  identity: Identity;
  activating: boolean;
  onActivate: () => void;
  onDeactivate: () => void;
  navigate: Navigate;
}) {
  const { daemon } = data;
  const [copied, setCopied] = useState(false);
  const active = isActive(daemon);
  const running = daemon?.state === 'active_running';
  const announced = daemon?.announced ?? null;
  const rules = announced ? announcedRules(announced.tags) : savedConfig ? savedRules(savedConfig) : [];
  const notices = daemonNotices(daemon);
  // The record of the last unexpected exit stays on disk until Mostro is
  // deactivated. It is only news while it is recent or the daemon is down.
  const lastExit = daemon?.last_exit ?? null;
  const exitIsNews = Boolean(lastExit) && (!running || Date.now() / 1000 - (lastExit?.at_unix ?? 0) < 3600);

  const copyNpub = () => {
    if (!daemon?.npub) return;
    copyToClipboard(daemon.npub, () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const powerPanel = daemon && (
      <Panel id="node-power" title="Encender y apagar" description="Mostro solo arranca cuando tú lo activas.">
        <div className="power-grid">
          <div className="power-option">
            <strong>{active ? 'Aplicar las reglas y reiniciar' : 'Activar Mostro'}</strong>
            <p>
              {active
                ? 'Vuelve a escribir la configuración del daemon con las reglas guardadas y lo reinicia. Al guardar en Configuración ya se aplican solas; usa esto si quieres forzar el reinicio.'
                : 'Escribe la configuración del daemon con las reglas guardadas y lo arranca. El nodo empieza a anunciarse en los relays y a aceptar órdenes.'}
            </p>
            <button type="button" className={`button ${active ? 'button-secondary' : 'button-primary'}`} onClick={onActivate} disabled={activating || !daemon.can_activate}>
              <Icon name={active ? 'refresh' : 'power'} size={15} /> {activating ? 'Procesando…' : active ? 'Aplicar y reiniciar' : 'Activar Mostro'}
            </button>
            <small>{daemon.can_activate ? (active ? 'El reinicio corta unos segundos la atención a las apps.' : 'Antes de activar, comprueba que Lightning tiene canales activos.') : 'No se puede activar todavía: faltan la identidad o las reglas guardadas.'}</small>
          </div>
          <div className="power-option">
            <strong>Desactivar Mostro</strong>
            <p>Detiene el daemon. El nodo deja de anunciarse y de atender a las apps, también en las operaciones que estén en curso, hasta que lo actives de nuevo.</p>
            <button type="button" className="button button-danger" onClick={onDeactivate} disabled={activating || !active}>
              <Icon name="power" size={15} /> Desactivar Mostro
            </button>
            <small>{active ? 'Las órdenes ya publicadas siguen visibles en los relays hasta que caducan.' : 'Mostro no está activado.'}</small>
          </div>
        </div>
      </Panel>
  );

  const identityPanel = (
    <Panel
      id="node-identity"
      title="Identidad del nodo"
      description="La clave Nostr con la que tu nodo firma sus órdenes y mensajes. Es lo que las apps reconocen como tu comunidad."
      aside={daemon ? <Badge tone={daemon.identity_present ? 'good' : 'warn'}>{daemon.identity_present ? 'Creada' : 'Falta'}</Badge> : undefined}
    >
      {!daemon ? (
        // Not knowing yet is not the same as not having one: no offer to create a key here.
        <p className="panel-note">{data.settled ? 'El panel no ha podido leer el estado del nodo. Vuelve a intentarlo en unos segundos.' : 'Consultando el estado del nodo…'}</p>
      ) : daemon.identity_present ? (
        <>
          <div className="copy-field">
            <span className="field-label">Clave pública (npub)</span>
            <div className="copy-box">
              <code>{daemon.npub || '—'}</code>
              <button type="button" className="copy-button" onClick={copyNpub} disabled={!daemon.npub}>
                {copied ? 'Copiado ✓' : 'Copiar'}
              </button>
            </div>
          </div>
          <p className="panel-note">
            La clave privada no se muestra ni se puede leer desde el panel. Si aún no tienes una copia, guarda un respaldo cifrado. <LinkButton onClick={() => navigate('backups')}>Ir a respaldos</LinkButton>
          </p>
        </>
      ) : (
        <>
          <p className="panel-note">Puedes crear una clave nueva o usar una que ya tengas. La clave privada se guarda solo en este equipo.</p>
          <div className="button-row">
            <button type="button" className="button button-primary" onClick={() => void identity.handleGenerateIdentity()} disabled={identity.isGeneratingIdentity}>
              <Icon name="key" size={15} /> {identity.isGeneratingIdentity ? 'Generando…' : 'Crear una identidad nueva'}
            </button>
            <button type="button" className="button button-secondary" onClick={identity.openImport} disabled={identity.isGeneratingIdentity}>
              Tengo una clave nsec
            </button>
          </div>
        </>
      )}
    </Panel>
  );

  return (
    <section className="content node-page">
      <PageHeader
        group="Nodo"
        title="Nodo Mostro"
        description="Enciende o apaga el mercado y comprueba qué anuncia tu nodo a las apps."
      />

      <Callout tone={status.tone} title={status.title}>
        {status.detail}
      </Callout>

      {lastExit && exitIsNews && (
        <Callout tone="warn" title="El daemon se detuvo por su cuenta">
          Terminó con código {lastExit.code} a los {formatAge(lastExit.uptime_secs)} de arrancar, {formatAgo(lastExit.at_unix)}. {running ? 'El supervisor lo volvió a arrancar.' : 'El supervisor lo vuelve a intentar con una pausa entre intentos.'}
        </Callout>
      )}

      {notices.length > 0 && (
        <Panel id="node-warnings" title="Avisos del nodo" description="Lo que el panel ha detectado al revisar la identidad, las reglas, Lightning y el anuncio en los relays.">
          <ul className="notice-list">
            {notices.map((notice) => {
              const route = routeNotice(notice);
              return (
                <li key={`${notice.code}:${notice.text}`}>
                  <Icon name="alert" size={15} />
                  <span>{notice.text}</span>
                  {route.page !== 'node' && <LinkButton onClick={() => navigate(route.page)}>{route.action}</LinkButton>}
                </li>
              );
            })}
          </ul>
        </Panel>
      )}

      {/* What is missing comes first: without an identity there is nothing to switch on. */}
      {daemon?.identity_present ? <>{powerPanel}{identityPanel}</> : <>{identityPanel}{powerPanel}</>}

      {daemon && (
        <Panel id="node-state" title="Estado del daemon" description="Lo que el panel sabe del proceso mostrod y de las reglas que tiene cargadas.">
          <FactGrid>
            <Fact label="Versión de Mostro" value={daemon.mostro_version ? `v${daemon.mostro_version}` : 'Desconocida'} hint={VERSION_SOURCE[daemon.version_source || ''] || undefined} mono />
            <Fact
              label="Último anuncio en los relays"
              value={announced && typeof daemon.announced_age_secs === 'number' ? `Hace ${formatAge(daemon.announced_age_secs)}` : 'Sin anuncio'}
              hint={daemon.announced_fresh ? 'Reciente: las apps ven el nodo activo' : announced ? 'Antiguo: las apps pueden darlo por inactivo' : 'El panel no ha visto ninguno en sus relays'}
            />
            <Fact
              label="Proceso del daemon"
              value={running ? 'En ejecución' : active ? 'No se ve en ejecución' : 'Detenido'}
              hint={
                running && typeof daemon.running_for_secs === 'number'
                  ? `Desde hace ${formatAge(daemon.running_for_secs)}`
                  : lastExit && !exitIsNews
                    ? `Última parada inesperada ${formatAgo(lastExit.at_unix)}, con código ${lastExit.code}`
                    : active
                      ? undefined
                      : 'Mostro no está activado'
              }
            />
            <Fact label="Protocolo de mensajes" value={`v${daemon.protocol_version || 2}`} hint="Eventos kind 14 cifrados con NIP-44" />
            <Fact label="Reglas guardadas" value={daemon.draft_revision !== null && daemon.draft_revision !== undefined ? `Revisión ${daemon.draft_revision}` : 'Ninguna'} hint="Lo último que guardaste en Configuración" />
            <Fact label="Reglas activas en el nodo" value={daemon.active_revision ? `Revisión ${daemon.active_revision}` : 'Ninguna'} hint={active ? 'Las que el daemon tiene cargadas' : 'Mostro no está activado'} />
            <Fact label="Huella de settings.toml" value={daemon.active_settings_hash ? <span title={daemon.active_settings_hash}>{shortKey(daemon.active_settings_hash, 12, 8)}</span> : '—'} hint="SHA-256 del archivo que lee el daemon" mono />
          </FactGrid>
        </Panel>
      )}

      <Panel
        id="node-rules"
        title="Lo que ven las apps"
        description={
          !announced
            ? rules.length > 0
              ? 'El panel no ha visto ningún anuncio de tu nodo en sus relays. Estas son las reglas guardadas, que anunciará al activarse.'
              : 'El panel no ha visto ningún anuncio de tu nodo en sus relays. Anunciará las reglas que guardes en Configuración.'
            : daemon?.announced_fresh
              ? 'Las reglas que tu nodo anuncia en los relays. Las apps las leen de ahí, no de este panel.'
              : 'Lo último que anunció tu nodo. Ahora no se está anunciando, así que las apps pueden darlo por inactivo.'
        }
        aside={announced ? <Badge tone={daemon?.announced_fresh ? 'good' : 'warn'}>{daemon?.announced_fresh ? 'Anuncio reciente' : `Anuncio de ${formatDateTime(announced.created_at)}`}</Badge> : undefined}
      >
        {rules.length > 0 ? (
          <FactGrid>
            {rules.map((rule) => (
              <Fact key={rule.label} label={rule.label} value={rule.value} hint={rule.hint} />
            ))}
          </FactGrid>
        ) : (
          <p className="panel-note">Aún no hay reglas guardadas. <LinkButton onClick={() => navigate('config')}>Abrir configuración</LinkButton></p>
        )}
        <p className="panel-note">
          Para que una app opere con tu comunidad necesita la clave pública del nodo y sus relays. <LinkButton onClick={() => navigate('connect')}>Conexión de apps</LinkButton>
        </p>
      </Panel>
    </section>
  );
}
