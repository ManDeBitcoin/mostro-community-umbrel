export function Icon({ name, size = 18 }: { name: string; size?: number }) {
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
export function StatusDot({ status }: { status?: string }) {
  const value = (status || '').toLowerCase();
  const cls = ['ok', 'connected', 'online', 'synced', 'healthy'].includes(value) ? 'good' : ['error', 'offline', 'down', 'disconnected'].includes(value) ? 'bad' : 'unknown';
  return <span className={`status-dot ${cls}`} />;
}
export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="field"><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}
export function Toggle({ checked, onChange, label, note }: { checked: boolean; onChange: (value: boolean) => void; label: string; note?: string }) {
  return <div className="toggle-row"><div><strong>{label}</strong>{note && <span>{note}</span>}</div><button type="button" role="switch" aria-label={label} aria-checked={checked} className={`toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}><i /></button></div>;
}
export function ActorBadge({ actor }: { actor: string }) {
  switch (actor) {
    case 'seller': return <span className="sim-actor-badge seller">Vendedor</span>;
    case 'buyer': return <span className="sim-actor-badge buyer">Comprador</span>;
    case 'mostro': return <span className="sim-actor-badge mostro">Mostro</span>;
    case 'solver': return <span className="sim-actor-badge solver">Mediador</span>;
    default: return <span className="sim-actor-badge">{actor}</span>;
  }
}
