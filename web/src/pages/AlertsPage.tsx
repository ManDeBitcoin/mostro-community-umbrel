import { useState } from 'react';
import type { NotificationItem } from '../types';
import { formatDateTime } from '../lib/format';
import type { Navigate, PageId } from '../lib/navigation';
import { type Tone, Badge, EmptyState, LinkButton, PageHeader, Panel } from '../components/layout';

type LevelFilter = 'all' | 'serious' | 'warning' | 'info';

export const alertTone = (level: string): Tone => (level === 'critical' || level === 'error' ? 'bad' : level === 'warning' ? 'warn' : 'info');
const LEVEL_LABEL: Record<string, string> = { critical: 'Crítica', error: 'Error', warning: 'Aviso', info: 'Información' };
// Where each kind of alert is dealt with.
export const ALERT_SOURCE: Record<string, { label: string; page: PageId; action: string }> = {
  relay: { label: 'Relays', page: 'orders', action: 'Ver relays' },
  dispute: { label: 'Disputas', page: 'disputes', action: 'Ver disputas' },
  backup: { label: 'Respaldos', page: 'backups', action: 'Ver respaldos' },
  card: { label: 'Tarjeta', page: 'connect', action: 'Ver conexión' },
  system: { label: 'Sistema', page: 'node', action: 'Ver el nodo' },
};
const matches = (filter: LevelFilter, level: string) =>
  filter === 'all' || (filter === 'serious' && (level === 'critical' || level === 'error')) || (filter === 'warning' && level === 'warning') || (filter === 'info' && level !== 'critical' && level !== 'error' && level !== 'warning');

export function AlertsPage({ notifications, read, settled, navigate }: { notifications: NotificationItem[]; /** The log has been read from the server. */ read: boolean; settled: boolean; navigate: Navigate }) {
  const [filter, setFilter] = useState<LevelFilter>('all');
  const count = (candidate: LevelFilter) => notifications.filter((item) => matches(candidate, item.level)).length;
  const filters: { id: LevelFilter; label: string }[] = [
    { id: 'all', label: 'Todas' },
    { id: 'serious', label: 'Graves' },
    { id: 'warning', label: 'Avisos' },
    { id: 'info', label: 'Información' },
  ];
  const shown = notifications.filter((item) => matches(filter, item.level));

  return (
    <section className="content alerts-page">
      <PageHeader group="Ajustes" title="Alertas" description="Los avisos que el panel ha registrado: relays que no responden, disputas que se abren, fallos al aplicar la configuración y relays que no aceptan la tarjeta de la comunidad. Llegan al momento, sin recargar." />
      <Panel
        aside={
          <div className="filter-chips" role="group" aria-label="Filtrar por gravedad">
            {filters.map((item) => (
              <button key={item.id} type="button" className={`filter-chip ${filter === item.id ? 'active' : ''}`} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>
                {item.label} <span>{count(item.id)}</span>
              </button>
            ))}
          </div>
        }
        title="Registro"
        description="Se conservan las 50 más recientes mientras la aplicación está en marcha."
      >
        {shown.length === 0 ? (
          !read ? (
            <EmptyState icon="bell" title={settled ? 'No se pudieron leer las alertas' : 'Consultando…'}>
              {settled ? 'El panel no ha recibido el registro de su servidor. Lo vuelve a intentar solo.' : 'Leyendo el registro de alertas.'}
            </EmptyState>
          ) : (
            <EmptyState icon="bell" title={notifications.length === 0 ? 'No hay alertas' : 'Ninguna alerta de este tipo'}>
              {notifications.length === 0 ? 'El panel no ha registrado ninguna desde que arrancó.' : 'Cambia el filtro para ver las demás.'}
            </EmptyState>
          )
        ) : (
          <ul className="alert-list">
            {shown.map((item) => {
              const source = ALERT_SOURCE[item.category];
              return (
              <li key={item.id} className={`alert-row tone-${alertTone(item.level)}`}>
                <div className="alert-main">
                  <div className="alert-title">
                    <Badge tone={alertTone(item.level)}>{LEVEL_LABEL[item.level] || item.level}</Badge>
                    <strong>{item.title}</strong>
                  </div>
                  <p>{item.message}</p>
                </div>
                <div className="alert-meta">
                  <time dateTime={new Date(item.timestamp * 1000).toISOString()}>{formatDateTime(item.timestamp)}</time>
                  <span>{source?.label || item.category}</span>
                  {source && <LinkButton onClick={() => navigate(source.page)}>{source.action}</LinkButton>}
                </div>
              </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </section>
  );
}
