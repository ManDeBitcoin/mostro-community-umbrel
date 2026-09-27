import { useCallback, useEffect, useMemo, useState } from 'react';

type Configuration = {
  community: { name: string; about: string; website: string; contact: string; language: string };
  market: { fiat_currencies: string[]; min_trade_sats: number; max_trade_sats: number; fee_bps: number; dev_fee_bps: number; max_routing_fee_bps: number };
  safety: { bond_enabled: boolean; bond_bps: number; base_bond_sats: number; bond_apply_to: 'make' | 'take' | 'both'; automatic_timeout_slash: boolean; pow: number; pow_first_contact: number };
  nostr: { relays: string[] };
  payment_methods: { id: string; label: string; category: string; active: boolean }[];
};
type ServiceInfo = {
  status: string;
  detail: string;
  version?: string;
  alias?: string;
  synced_to_chain?: boolean;
  synced_to_graph?: boolean | null;
  network?: string | null;
  num_active_channels?: number;
  num_pending_channels?: number;
  num_inactive_channels?: number;
  block_height?: number;
  liquidity?: { status: 'available' | 'unavailable'; local_balance_sats: string | null; remote_balance_sats: string | null; detail: string };
};
type Dashboard = {
  mostro: ServiceInfo;
  lightning: ServiceInfo;
  bitcoin: ServiceInfo;
  market_started: false;
};
type CommunityReply = { revision: number; config: Configuration | null };
const blankConfig = (): Configuration => ({
  community: { name: '', about: '', website: '', contact: '', language: 'es' },
  market: { fiat_currencies: [], min_trade_sats: 1000, max_trade_sats: 1000000, fee_bps: 0, dev_fee_bps: 0, max_routing_fee_bps: 0 },
  safety: { bond_enabled: false, bond_bps: 0, base_bond_sats: 0, bond_apply_to: 'both', automatic_timeout_slash: false, pow: 0, pow_first_contact: 0 },
  nostr: { relays: [] },
    payment_methods: [],
});
const percent = (bps: number) => (bps / 100).toString();
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { ...(init?.headers || {}), ...(init?.body ? { 'Content-Type': 'application/json' } : {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `Error del servidor (${response.status})`);
  return data as T;
}
function Icon({ name, size = 18 }: { name: string; size?: number }) {
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
  };
  return <svg {...common}>{paths[name] || paths.grid}</svg>;
}
function StatusDot({ status }: { status?: string }) {
  const value = (status || '').toLowerCase();
  const cls = ['ok', 'connected', 'online', 'synced', 'healthy'].includes(value) ? 'good' : ['error', 'offline', 'down', 'disconnected'].includes(value) ? 'bad' : 'unknown';
  return <span className={`status-dot ${cls}`} />;
}
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="field"><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}
function Toggle({ checked, onChange, label, note }: { checked: boolean; onChange: (value: boolean) => void; label: string; note?: string }) {
  return <div className="toggle-row"><div><strong>{label}</strong>{note && <span>{note}</span>}</div><button type="button" role="switch" aria-label={label} aria-checked={checked} className={`toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}><i /></button></div>;
}
function App() {
  const [page, setPage] = useState<'dashboard' | 'config'>('dashboard');
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState<Configuration>(blankConfig);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [communityLoaded, setCommunityLoaded] = useState(false);
  const [health, setHealth] = useState(false);
  const [apiError, setApiError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [currencyInput, setCurrencyInput] = useState('');
  const [relayInput, setRelayInput] = useState('');
  const [feeInputs, setFeeInputs] = useState({ fee: '', devFee: '', routingFee: '', bond: '' });

  const refresh = useCallback(async () => {
    setLoading(true); setApiError('');
    const healthPromise = api<{ status: string }>('/api/health').then((data) => setHealth(data.status === 'ok')).catch(() => setHealth(false));
    const dashboardPromise = api<Dashboard>('/api/dashboard').then(setDashboard).catch(() => setDashboard(null));
    const communityPromise = api<CommunityReply>('/api/community').then((data) => {
      setRevision(data.revision); setSaved(Boolean(data.config)); setDirty(false); setCommunityLoaded(true);
      const config = data.config || blankConfig(); setDraft(config);
      setFeeInputs(data.config ? { fee: percent(config.market.fee_bps), devFee: percent(config.market.dev_fee_bps), routingFee: percent(config.market.max_routing_fee_bps), bond: percent(config.safety.bond_bps) } : { fee: '', devFee: '', routingFee: '', bond: '' });
    }).catch((err: Error) => { setCommunityLoaded(false); setApiError(err.message); });
    await Promise.all([healthPromise, dashboardPromise, communityPromise]); setLoading(false);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const markDirty = () => { setDirty(true); setSaved(false); };
  const refreshSafely = () => { if (dirty && !window.confirm('Hay cambios sin guardar. ¿Descartarlos y recargar la configuración?')) return; void refresh(); };
  const updateCommunity = (key: keyof Configuration['community'], value: string) => { markDirty(); setDraft((old) => ({ ...old, community: { ...old.community, [key]: value } })); };
  const updateMarket = (key: keyof Configuration['market'], value: unknown) => { markDirty(); setDraft((old) => ({ ...old, market: { ...old.market, [key]: value } })); };
  const updateSafety = (key: keyof Configuration['safety'], value: unknown) => { markDirty(); setDraft((old) => ({ ...old, safety: { ...old.safety, [key]: value } })); };
  const addCurrency = () => { const code = currencyInput.trim().toUpperCase(); if (code && /^[A-Z]{3}$/.test(code) && !draft.market.fiat_currencies.includes(code)) updateMarket('fiat_currencies', [...draft.market.fiat_currencies, code]); setCurrencyInput(''); };
  const addRelay = () => { const url = relayInput.trim(); if (url && !draft.nostr.relays.includes(url)) { markDirty(); setDraft((old) => ({ ...old, nostr: { relays: [...old.nostr.relays, url] } })); } setRelayInput(''); };
  const updateFee = (key: keyof typeof feeInputs, marketKey: keyof Configuration['market'] | 'bond_bps', value: string) => {
    markDirty(); setFeeInputs((old) => ({ ...old, [key]: value }));
    const bps = Math.round(Number(value || 0) * 100);
    if (marketKey === 'bond_bps') updateSafety(marketKey, bps); else updateMarket(marketKey, bps);
  };
  const saveConfig = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true); setNotice('');
    if (!communityLoaded) { setSaving(false); setApiError('Recarga la configuración para obtener una revisión válida antes de guardar.'); return; }
    if (['fee', 'devFee', 'routingFee'].some((key) => feeInputs[key as keyof typeof feeInputs] === '') || (draft.safety.bond_enabled && feeInputs.bond === '')) {
      setSaving(false); setApiError('Elige un porcentaje para cada comisión. Usa 0 si no deseas cobrarla.'); return;
    }
    if (draft.community.contact.trim()) {
      try { const contactUrl = new URL(draft.community.contact); if (!['http:', 'https:'].includes(contactUrl.protocol)) throw new Error(); }
      catch { setSaving(false); setApiError('El contacto debe ser una URL que empiece con http:// o https://.'); return; }
    }
    try {
      const response = await api<CommunityReply>('/api/community', { method: 'PUT', headers: { 'X-Requested-With': 'mostro-community' }, body: JSON.stringify({ revision, config: draft }) });
      setRevision(response.revision); setDraft(response.config || draft); setSaved(true); setDirty(false); setNotice('Configuración guardada.'); setApiError('');
    } catch (err) { setNotice(''); setApiError(err instanceof Error ? err.message : 'No se pudo guardar la configuración.'); }
    finally { setSaving(false); }
  };
  const readiness = useMemo(() => [Boolean(draft.community.name.trim()), draft.market.fiat_currencies.length > 0, draft.nostr.relays.length > 0, draft.payment_methods.some((method) => method.active)].filter(Boolean).length, [draft]);
  const statuses = dashboard ? [
    { title: 'Mostro', icon: 'grid', data: dashboard.mostro },
    { title: 'Lightning', icon: 'bolt', data: dashboard.lightning },
    { title: 'Bitcoin', icon: 'bitcoin', data: dashboard.bitcoin },
  ] : [];
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">M</div><div className="brand-copy"><b>mostro</b><span>COMMUNITY MANAGER</span></div></div>
      <div className="workspace-label">ESPACIO DE TRABAJO</div>
      <div className="workspace"><div className="workspace-icon">{(draft.community.name || 'MC').slice(0, 2).toUpperCase()}</div><div><b>{draft.community.name || 'Mi comunidad'}</b><span>Entorno local</span></div><span className="workspace-chevron">⌄</span></div>
      <div className="nav-label">GENERAL</div>
      <nav className="nav-list" aria-label="Navegación principal">
        <button className={`nav-item ${page === 'dashboard' ? 'active' : ''}`} onClick={() => setPage('dashboard')}><Icon name="grid"/><span>Panel general</span>{page === 'dashboard' && <span className="nav-active-mark"/>}</button>
        <button className={`nav-item ${page === 'config' ? 'active' : ''}`} onClick={() => setPage('config')}><Icon name="sliders"/><span>Configuración</span>{page === 'config' && <span className="nav-active-mark"/>}</button>
      </nav>
      <div className="sidebar-spacer" />
      <div className="sidebar-bottom"><div className="mode-card"><span className="mode-icon"><Icon name="globe" size={16}/></span><div><b>Modo desarrollo</b><span>Mercado sin iniciar</span></div><span className="mode-dot"/></div><div className="sidebar-footer"><span className="avatar">MC</span><div><b>Administrador</b><span>Configuración local</span></div></div></div>
    </aside>
    <main className="main-area">
      <header className="topbar"><div className="breadcrumb"><span>Mi comunidad</span><Icon name="chevron" size={14}/><b>{page === 'dashboard' ? 'Panel general' : 'Configuración'}</b></div><div className="top-actions"><span className="environment-pill"><i/> Desarrollo</span><button className="icon-button" aria-label="Abrir configuración" onClick={() => setPage('config')}><Icon name="sliders" size={17}/></button><span className="top-avatar">MC</span></div></header>
      {page === 'dashboard' ? <section className="content dashboard-page">
        <div className="page-heading"><div><div className="eyebrow">MOSTRO COMMUNITY MANAGER <span className="eyebrow-sep">/</span> INICIO</div><h1>Panel general</h1><p>Estado de tu instancia y preparación de la comunidad.</p></div><button className="button button-secondary refresh-button" onClick={() => void refresh()} disabled={loading}><span className={loading ? 'spin' : ''}>↻</span> Actualizar</button></div>
        <div className="dev-banner"><div className="banner-icon"><Icon name="alert" size={18}/></div><div><b>Entorno de desarrollo</b><span>Prototipo de configuración: el mercado aún no está iniciado y no se puede iniciar desde este panel.</span></div><div className="banner-status"><i/> MERCADO INACTIVO</div></div>
        <div className="section-title-row"><div><h2>Servicios</h2><p>Conectividad reportada por la instancia local.</p></div><span className="updated-label">{loading ? 'Consultando…' : health ? 'API disponible' : 'API sin conexión'}</span></div>
        <div className="service-grid">{statuses.length ? statuses.map(({ title, icon, data }) => <article className="service-card" key={title}><div className="service-top"><span className="service-icon"><Icon name={icon}/></span><span className="service-status"><StatusDot status={data.status}/>{({ online: 'Conectado', offline: 'Sin conexión', unconfigured: 'Sin configurar', unknown: 'Desconocido', warning: 'Revisar' } as Record<string, string>)[data.status] || 'Desconocido'}</span></div><h3>{title}</h3><p>{data.detail || 'Sin detalles disponibles'}</p><div className="service-meta">{title === 'Mostro' && data.version ? <span>v{data.version}</span> : null}{title === 'Lightning' && data.alias ? <span>{data.alias}</span> : null}{title === 'Lightning' && typeof data.num_active_channels === 'number' ? <span>{data.num_active_channels} canales activos</span> : null}{title === 'Bitcoin' && typeof data.block_height === 'number' ? <span>Bloque {data.block_height.toLocaleString('es')}</span> : null}<Icon name="arrow" size={15}/></div></article>) : <div className="service-card unavailable"><div className="service-top"><span className="service-icon"><Icon name="grid"/></span><span className="service-status"><StatusDot/>Desconocido</span></div><h3>Servicios no disponibles</h3><p>{apiError || 'La API aún no informa el estado de los servicios.'}</p><div className="service-meta"><span>Reintenta cuando el servidor esté disponible</span></div></div>}</div>
        {dashboard?.lightning && <section className="lightning-details" aria-labelledby="lightning-details-title"><div className="lightning-heading"><div><h2 id="lightning-details-title">Detalles de Lightning</h2><p>Información reportada por el nodo.</p></div>{dashboard.lightning.network && <span className="network-tag">Red {dashboard.lightning.network}</span>}</div><div className="lightning-stats"><div><span>Sincronización de cadena</span><strong>{dashboard.lightning.synced_to_chain === true ? 'Sincronizado' : dashboard.lightning.synced_to_chain === false ? 'Pendiente' : 'Desconocido'}</strong></div><div><span>Sincronización del grafo</span><strong>{dashboard.lightning.synced_to_graph === true ? 'Sincronizado' : dashboard.lightning.synced_to_graph === false ? 'Pendiente' : 'Desconocido'}</strong></div><div><span>Canales activos</span><strong>{typeof dashboard.lightning.num_active_channels === 'number' ? dashboard.lightning.num_active_channels : 'Desconocido'}</strong></div><div><span>Canales pendientes</span><strong>{typeof dashboard.lightning.num_pending_channels === 'number' ? dashboard.lightning.num_pending_channels : 'Desconocido'}</strong></div><div><span>Canales inactivos</span><strong>{typeof dashboard.lightning.num_inactive_channels === 'number' ? dashboard.lightning.num_inactive_channels : 'Desconocido'}</strong></div></div><div className="liquidity-row"><div><span>Liquidez local</span><strong>{dashboard.lightning.liquidity?.status === 'available' && dashboard.lightning.liquidity.local_balance_sats !== null ? `${dashboard.lightning.liquidity.local_balance_sats} sats` : 'Desconocida'}</strong></div><div><span>Liquidez remota</span><strong>{dashboard.lightning.liquidity?.status === 'available' && dashboard.lightning.liquidity.remote_balance_sats !== null ? `${dashboard.lightning.liquidity.remote_balance_sats} sats` : 'Desconocida'}</strong></div><p>{dashboard.lightning.liquidity?.status === 'unavailable' ? dashboard.lightning.liquidity.detail || 'El nodo no informa la liquidez.' : 'Los datos de canales y liquidez no garantizan que una ruta o una operación esté disponible.'}</p></div></section>}
        <div className="dashboard-lower"><article className="setup-card"><div className="card-heading"><div><span className="card-kicker">PUESTA EN MARCHA</span><h2>Prepara tu comunidad</h2><p>Configura los datos esenciales antes de iniciar el mercado.</p></div><div className="progress-ring"><span>{readiness}<small>/4</small></span></div></div><progress className="setup-progress" value={readiness} max={4} aria-label="Preparación de la comunidad"/><div className="setup-checks"><span className={draft.community.name ? 'complete' : ''}><i>{draft.community.name ? <Icon name="check" size={12}/> : '1'}</i>Identidad</span><span className={draft.market.fiat_currencies.length ? 'complete' : ''}><i>{draft.market.fiat_currencies.length ? <Icon name="check" size={12}/> : '2'}</i>Monedas</span><span className={draft.nostr.relays.length ? 'complete' : ''}><i>{draft.nostr.relays.length ? <Icon name="check" size={12}/> : '3'}</i>Relays Nostr</span><span className={draft.payment_methods.some((m) => m.active) ? 'complete' : ''}><i>{draft.payment_methods.some((m) => m.active) ? <Icon name="check" size={12}/> : '4'}</i>Pagos</span></div><button className="button button-primary" onClick={() => setPage('config')}>Abrir configuración <Icon name="arrow" size={15}/></button></article>
          <article className="market-card"><div className="market-card-top"><span className="market-symbol"><Icon name="bolt" size={19}/></span><span className="market-tag"><i/> AÚN NO INICIADO</span></div><div className="market-empty"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="orbit-center"><span>₿</span></div></div><div className="market-copy"><h3>Mercado en desarrollo</h3><p>Este prototipo permite guardar los parámetros de la comunidad. El inicio del mercado aún no está disponible.</p><span className="market-note"><Icon name="alert" size={14}/> Operaciones aún no consultadas</span></div></article></div>
        <div className="bottom-note"><span className="secure-icon"><Icon name="check" size={13}/></span><span>Configuración local</span><span className="note-separator">·</span><span>Los cambios se guardan en el servidor de esta instancia</span><span className="note-spacer"/><span className="api-indicator"><StatusDot status={health ? 'ok' : ''}/>{health ? 'API conectada' : 'API no disponible'}</span></div>
      </section> : <section className="content config-page">
        <div className="page-heading"><div><div className="eyebrow">MOSTRO COMMUNITY MANAGER <span className="eyebrow-sep">/</span> AJUSTES</div><h1>Configuración</h1><p>Define la identidad y las reglas iniciales de tu comunidad.</p></div><div className="config-heading-actions"><span className={`save-state ${saved ? 'is-saved' : ''}`}><i/>{saved ? `Guardado · revisión ${revision}` : 'Cambios locales'}</span><button className="button button-secondary" onClick={refreshSafely} disabled={loading}>Recargar</button></div></div>
        <div className="config-layout"><nav className="config-nav"><a href="#identity">Identidad</a><a href="#market">Mercado</a><a href="#safety">Seguridad</a><a href="#nostr">Nostr</a><a href="#payments">Métodos de pago</a></nav>
          <form className="config-form" onSubmit={saveConfig}>
            <section className="config-section" id="identity"><div className="config-section-head"><span className="section-number">01</span><div><h2>Identidad de la comunidad</h2><p>Esta información ayuda a las personas a reconocer tu instancia.</p></div></div><div className="form-grid"><Field label="Nombre de la comunidad"><input value={draft.community.name} onChange={(e) => updateCommunity('name', e.target.value)} placeholder="Ej. Bitcoin Quito" maxLength={80}/></Field><Field label="Idioma"><select value={draft.community.language} onChange={(e) => updateCommunity('language', e.target.value)}><option value="es">Español</option><option value="en">English</option><option value="pt">Português</option></select></Field><Field label="Sitio web"><input type="url" value={draft.community.website} onChange={(e) => updateCommunity('website', e.target.value)} placeholder="https://tu-comunidad.org"/></Field><Field label="Contacto" hint="Dirección web pública de contacto"><input type="url" value={draft.community.contact} onChange={(e) => updateCommunity('contact', e.target.value)} placeholder="https://tu-comunidad.org/contacto"/></Field><div className="field full-width"><span className="field-label">Acerca de</span><textarea value={draft.community.about} onChange={(e) => updateCommunity('about', e.target.value)} placeholder="Describe brevemente tu comunidad" rows={3} maxLength={500}/><span className="field-hint">{draft.community.about.length}/500 caracteres</span></div></div></section>
            <section className="config-section" id="market"><div className="config-section-head"><span className="section-number">02</span><div><h2>Reglas del mercado</h2><p>Establece límites de operación y comisiones. Los porcentajes se convierten a puntos base al guardar.</p></div></div><div className="form-grid"><div className="field full-width"><span className="field-label">Monedas fiat</span><div className="chips">{draft.market.fiat_currencies.map((currency) => <button className="chip" type="button" key={currency} onClick={() => updateMarket('fiat_currencies', draft.market.fiat_currencies.filter((x) => x !== currency))}>{currency}<b>×</b></button>)}{draft.market.fiat_currencies.length === 0 && <span className="empty-hint">Sin monedas seleccionadas · elige una para habilitar operaciones</span>}</div><div className="inline-add"><input aria-label="Código ISO de moneda" value={currencyInput} onChange={(e) => setCurrencyInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addCurrency())} placeholder="Código ISO · ej. USD" maxLength={3}/><button type="button" onClick={addCurrency}>Añadir moneda</button></div></div><Field label="Operación mínima" hint="Valor expresado en satoshis"><input type="number" min="0" value={draft.market.min_trade_sats} onChange={(e) => updateMarket('min_trade_sats', Number(e.target.value))}/></Field><Field label="Operación máxima" hint="Valor expresado en satoshis"><input type="number" min="0" value={draft.market.max_trade_sats} onChange={(e) => updateMarket('max_trade_sats', Number(e.target.value))}/></Field><Field label="Comisión del mercado" hint="Déjalo en 0% si no deseas cobrar una comisión"><div className="input-suffix"><input type="number" min="0" step="0.01" value={feeInputs.fee} required onChange={(e) => updateFee('fee', 'fee_bps', e.target.value)}/><span>%</span></div></Field><Field label="Comisión de desarrollo" hint="Porcentaje de la comisión del operador destinado al desarrollo"><div className="input-suffix"><input type="number" min="0" step="0.01" value={feeInputs.devFee} required onChange={(e) => updateFee('devFee', 'dev_fee_bps', e.target.value)}/><span>%</span></div></Field><Field label="Comisión máxima de enrutamiento" hint="Límite tolerado para Lightning"><div className="input-suffix"><input type="number" min="0" step="0.01" value={feeInputs.routingFee} required onChange={(e) => updateFee('routingFee', 'max_routing_fee_bps', e.target.value)}/><span>%</span></div></Field></div></section>
            <section className="config-section" id="safety"><div className="config-section-head"><span className="section-number">03</span><div><h2>Seguridad y garantías</h2><p>Opciones de bonos y prueba de trabajo para reducir el abuso.</p></div></div><Toggle checked={draft.safety.bond_enabled} onChange={(v) => updateSafety('bond_enabled', v)} label="Exigir bono para las operaciones" note="Las personas reservan sats como garantía durante una operación."/>{draft.safety.bond_enabled && <div className="form-grid compact-grid"><Field label="Bono relativo" hint="Porcentaje del valor de la operación"><div className="input-suffix"><input type="number" min="0" step="0.01" value={feeInputs.bond} required onChange={(e) => updateFee('bond', 'bond_bps', e.target.value)}/><span>%</span></div></Field><Field label="Bono base" hint="En satoshis"><input type="number" min="0" value={draft.safety.base_bond_sats} onChange={(e) => updateSafety('base_bond_sats', Number(e.target.value))}/></Field><Field label="Aplicar a"><select value={draft.safety.bond_apply_to} onChange={(e) => updateSafety('bond_apply_to', e.target.value)}><option value="both">Quien publica y quien acepta</option><option value="make">Quien publica</option><option value="take">Quien acepta</option></select></Field></div>}<div className="toggle-divider"/><Toggle checked={draft.safety.automatic_timeout_slash} onChange={(v) => updateSafety('automatic_timeout_slash', v)} label="Penalización automática por vencimiento" note="Penaliza el bond por vencimiento en estados de espera; no se aplica a todos los plazos de una operación."/><div className="form-grid compact-grid pow-grid"><Field label="Prueba de trabajo" hint="Dificultad general"><input type="number" min="0" value={draft.safety.pow} onChange={(e) => updateSafety('pow', Number(e.target.value))}/></Field><Field label="Primera conversación" hint="Dificultad para el primer contacto"><input type="number" min="0" value={draft.safety.pow_first_contact} onChange={(e) => updateSafety('pow_first_contact', Number(e.target.value))}/></Field></div></section>
            <section className="config-section" id="nostr"><div className="config-section-head"><span className="section-number">04</span><div><h2>Relays de Nostr</h2><p>Define los relays que usará tu instancia para publicar y recibir eventos.</p></div></div><div className="chips">{draft.nostr.relays.map((relay) => <button className="chip relay-chip" type="button" key={relay} onClick={() => setDraft((old) => ({ ...old, nostr: { relays: old.nostr.relays.filter((x) => x !== relay) } }))}><span>{relay}</span><b>×</b></button>)}{draft.nostr.relays.length === 0 && <span className="empty-hint">Aún no has añadido relays.</span>}</div><div className="inline-add"><input type="url" value={relayInput} onChange={(e) => setRelayInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addRelay())} placeholder="wss://relay.example.org"/><button type="button" onClick={addRelay}>Añadir relay</button></div></section>
            <section className="config-section" id="payments"><div className="config-section-head"><span className="section-number">05</span><div><h2>Métodos de pago</h2><p>Activa las opciones de pago que tu comunidad puede ofrecer.</p></div></div>{draft.payment_methods.length === 0 && <p className="empty-hint payment-empty">No hay métodos de pago añadidos. Añade solo las opciones que tu comunidad admite.</p>}<div className="payment-list">{draft.payment_methods.map((method, index) => <div className="payment-row" key={index}><span className="payment-mark">{method.label.slice(0, 1) || '·'}</span><div className="payment-edit"><input aria-label="Identificador del método" required value={method.id} placeholder="id" onChange={(e) => { markDirty(); setDraft((old) => ({ ...old, payment_methods: old.payment_methods.map((item, i) => i === index ? { ...item, id: e.target.value } : item) })); }}/><input aria-label="Nombre del método" required value={method.label} placeholder="Nombre" onChange={(e) => { markDirty(); setDraft((old) => ({ ...old, payment_methods: old.payment_methods.map((item, i) => i === index ? { ...item, label: e.target.value } : item) })); }}/><input aria-label="Categoría del método" required value={method.category} placeholder="Categoría" onChange={(e) => { markDirty(); setDraft((old) => ({ ...old, payment_methods: old.payment_methods.map((item, i) => i === index ? { ...item, category: e.target.value } : item) })); }}/></div><span className={`payment-state ${method.active ? 'enabled' : ''}`}>{method.active ? 'Activo' : 'Inactivo'}</span><button type="button" role="switch" aria-label={`${method.active ? 'Desactivar' : 'Activar'} ${method.label || 'método de pago'}`} aria-checked={method.active} className={`toggle small ${method.active ? 'on' : ''}`} onClick={() => { markDirty(); setDraft((old) => ({ ...old, payment_methods: old.payment_methods.map((item, i) => i === index ? { ...item, active: !item.active } : item) })); }}><i/></button><button type="button" className="remove-payment" aria-label={`Eliminar ${method.label || 'método de pago'}`} onClick={() => { markDirty(); setDraft((old) => ({ ...old, payment_methods: old.payment_methods.filter((_, i) => i !== index) })); }}>×</button></div>)}</div><button type="button" className="add-payment" onClick={() => { markDirty(); setDraft((old) => ({ ...old, payment_methods: [...old.payment_methods, { id: '', label: '', category: '', active: true }] })); }}>+ Añadir método de pago</button></section>
            {(apiError || notice) && <div className={`form-message ${apiError ? 'error' : 'success'}`} role="status">{apiError || notice}</div>}
            <div className="form-footer"><div className="footer-copy"><span className="secure-icon"><Icon name="check" size={13}/></span><span>Los cambios se guardan en el servidor local.</span></div><button className="button button-primary save-button" type="submit" disabled={saving || loading || !communityLoaded}><Icon name="save" size={16}/>{saving ? 'Guardando…' : 'Guardar configuración'}</button></div>
          </form>
        </div>
      </section>}
    </main>
  </div>;
}
export default App;
