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
    home: <><path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/></>,
    list: <><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></>,
    server: <><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></>,
    qr: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20.5 14v.01M14 20.5v.01M17.5 20.5H21v-3"/></>,
    bell: <><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></>,
    refresh: <><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"/><path d="M3 21v-5h5"/></>,
    info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></>,
    x: <path d="M18 6 6 18M6 6l12 12"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    key: <><circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8.2-8.2M16 7l3 3M13.5 9.5l2 2"/></>,
    power: <><path d="M12 3v9"/><path d="M6.4 6.4a8 8 0 1 0 11.2 0"/></>,
    external: <><path d="M14 4h6v6M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></>,
    menu: <path d="M4 6h16M4 12h16M4 18h16"/>,
    circle: <circle cx="12" cy="12" r="9"/>,
    next: <path d="M5 12h14M13 6l6 6-6 6"/>,
    book: <><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Z"/><path d="M19 19v2H6"/></>,
    dot: <circle cx="12" cy="12" r="3.5" fill="currentColor"/>,
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
export function Toggle({ checked, onChange, label, note, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; label: string; note?: string; disabled?: boolean }) {
  return <div className="toggle-row"><div><strong>{label}</strong>{note && <span>{note}</span>}</div><button type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} className={`toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}><i /></button></div>;
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
