import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CURRENCY_CODES, getCurrencyDisplayName } from './currencies';
import type { Configuration, Dashboard, ConnectionInfo, DaemonReport, SimulationScenarioInfo, SimulationReport, CommunityReply, NotificationItem, AutoBackupState, CommissionBondPreset } from './types';
import { copyToClipboard, api } from './lib/api';
import { percent, formatAge } from './lib/format';
import { COMMISSION_BOND_PRESETS, POPULAR_CURRENCIES, blankConfig, configNavSections } from './lib/constants';
import { Icon, StatusDot, Field, Toggle, ActorBadge } from './components/ui';
import { OrdersPage } from './pages/OrdersPage';
import { MediationConsole } from './pages/MediationPage';
import { LiquidityOperationsPage } from './pages/LiquidityPage';

function App() {
  const [page, setPage] = useState<'dashboard' | 'orders' | 'mediation' | 'simulation' | 'liquidity' | 'config'>('dashboard');
  const [activeConfigNav, setActiveConfigNav] = useState<'identity' | 'market' | 'safety' | 'nostr' | 'payments'>('identity');
  const [selectedDisputeOrderId, setSelectedDisputeOrderId] = useState<string>('');
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [connection, setConnection] = useState<ConnectionInfo | null>(null);
  const [daemon, setDaemon] = useState<DaemonReport | null>(null);
  const [activatingDaemon, setActivatingDaemon] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
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
  const [relayInput, setRelayInput] = useState('');
  const [feeInputs, setFeeInputs] = useState({ fee: '', devFee: '', routingFee: '', bond: '' });
  const [currencySearchQuery, setCurrencySearchQuery] = useState('');
  const [isCurrencyDropdownOpen, setIsCurrencyDropdownOpen] = useState(false);
  const currencyDropdownRef = useRef<HTMLDivElement | null>(null);

  const [isGeneratingIdentity, setIsGeneratingIdentity] = useState(false);
  const [generatedIdentity, setGeneratedIdentity] = useState<{ nsec: string; npub: string } | null>(null);
  const [hasBackedUpNsec, setHasBackedUpNsec] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importNsec, setImportNsec] = useState('');
  const [showImportNsec, setShowImportNsec] = useState(false);
  const [importError, setImportError] = useState('');
  const [isImporting, setIsImporting] = useState(false);

  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [backupState, setBackupState] = useState<AutoBackupState | null>(null);
  const [triggeringBackup, setTriggeringBackup] = useState(false);
  const [backupPassphrase, setBackupPassphrase] = useState('');
  const [backupMessage, setBackupMessage] = useState('');

  const [simScenarios, setSimScenarios] = useState<SimulationScenarioInfo[]>([]);
  const [selectedScenario, setSelectedScenario] = useState('happy_path');
  const [simSatsInput, setSimSatsInput] = useState('50000');
  const [simulating, setSimulating] = useState(false);
  const [simulationReport, setSimulationReport] = useState<SimulationReport | null>(null);
  const [simError, setSimError] = useState('');
  const [qrFormat, setQrFormat] = useState<'card' | 'uri' | 'json'>('card');

  const copyText = (text: string, label: string) => {
    copyToClipboard(text, () => {
      setCopiedField(label);
      setTimeout(() => setCopiedField(null), 2000);
    });
  };

  const refresh = useCallback(async () => {
    setLoading(true); setApiError('');
    const healthPromise = api<{ status: string }>('/api/health').then((data) => setHealth(data.status === 'ok')).catch(() => setHealth(false));
    const dashboardPromise = api<Dashboard>('/api/dashboard').then(setDashboard).catch(() => setDashboard(null));
    const connectionPromise = api<ConnectionInfo>('/api/connection').then(setConnection).catch(() => setConnection(null));
    const daemonPromise = api<DaemonReport>('/api/daemon/status').then(setDaemon).catch(() => setDaemon(null));
    const notifsPromise = api<NotificationItem[]>('/api/notifications').then(setNotifications).catch(() => {});
    const backupPromise = api<AutoBackupState>('/api/backup/status').then(setBackupState).catch(() => {});
    const presetsPromise = api<unknown>('/api/community/presets').catch(() => {});
    const simScenariosPromise = api<SimulationScenarioInfo[]>('/api/simulation/scenarios').then((data) => {
      setSimScenarios(data);
    }).catch(() => setSimScenarios([]));
    const communityPromise = api<CommunityReply>('/api/community').then((data) => {
      setRevision(data.revision); setSaved(Boolean(data.config)); setDirty(false); setCommunityLoaded(true);
      const config = data.config || blankConfig(); setDraft(config);
      setFeeInputs(data.config ? { fee: percent(config.market.fee_bps), devFee: percent(config.market.dev_fee_bps), routingFee: percent(config.market.max_routing_fee_bps), bond: percent(config.safety.bond_bps) } : { fee: '', devFee: '', routingFee: '', bond: '' });
    }).catch((err: Error) => { setCommunityLoaded(false); setApiError(err.message); });
    await Promise.all([healthPromise, dashboardPromise, connectionPromise, daemonPromise, communityPromise, simScenariosPromise, notifsPromise, backupPromise, presetsPromise]); setLoading(false);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  // The daemon card and the market card describe a live state ("hace N s",
  // "el nodo atiende a los clientes"), so they are refreshed on their own
  // without reloading the draft being edited.
  useEffect(() => {
    if (page !== 'dashboard') return;
    const timer = setInterval(() => {
      api<Dashboard>('/api/dashboard').then(setDashboard).catch(() => {});
      api<DaemonReport>('/api/daemon/status').then(setDaemon).catch(() => {});
    }, 20000);
    return () => clearInterval(timer);
  }, [page]);

  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource('/api/notifications/sse');
      es.addEventListener('notification', (e) => {
        try {
          const item: NotificationItem = JSON.parse(e.data);
          setNotifications((prev) => [item, ...prev.filter((n) => n.id !== item.id)].slice(0, 50));
        } catch {}
      });
    } catch {}

    return () => {
      es?.close();
    };
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (currencyDropdownRef.current && !currencyDropdownRef.current.contains(event.target as Node)) {
        setIsCurrencyDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const filteredCurrencies = useMemo(() => {
    const q = currencySearchQuery.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (!q) {
      return CURRENCY_CODES.slice(0, 30);
    }
    return CURRENCY_CODES.filter((item) => {
      const codeMatch = item.code.toLowerCase().includes(q);
      const enMatch = item.nameEn.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes(q);
      const esMatch = item.nameEs.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes(q);
      return codeMatch || enMatch || esMatch;
    }).slice(0, 50);
  }, [currencySearchQuery]);

  const handleTriggerBackup = async () => {
    setTriggeringBackup(true);
    setBackupMessage('');
    try {
      const res = await api<{ status: string; path: string; revision: number }>('/api/backup/trigger', {
        method: 'POST',
        headers: { 'X-Requested-With': 'mostro-community' },
        body: JSON.stringify({ passphrase: backupPassphrase || undefined }),
      });
      setBackupMessage(`✓ Respaldo generado con éxito: revisión ${res.revision}`);
      setBackupPassphrase('');
      const updated = await api<AutoBackupState>('/api/backup/status');
      setBackupState(updated);
    } catch (err) {
      setBackupMessage(err instanceof Error ? `Error: ${err.message}` : 'Error al generar respaldo');
    } finally {
      setTriggeringBackup(false);
    }
  };

  const handleRunSimulation = async (scenarioOverride?: string) => {
    setSimulating(true);
    setSimError('');
    const targetScenario = scenarioOverride || selectedScenario;
    const sats = Number(simSatsInput) || 50000;
    try {
      const report = await api<SimulationReport>('/api/simulation/run', {
        method: 'POST',
        headers: { 'X-Requested-With': 'mostro-community' },
        body: JSON.stringify({
          scenario: targetScenario,
          trade_sats: sats,
        }),
      });
      setSimulationReport(report);
    } catch (err) {
      setSimError(err instanceof Error ? err.message : 'Error al ejecutar la simulación');
    } finally {
      setSimulating(false);
    }
  };

  const handleGenerateIdentity = async () => {
    setIsGeneratingIdentity(true);
    setApiError('');
    try {
      const res = await api<{ nsec: string; npub: string; status: string }>('/api/identity/generate', {
        method: 'POST',
        body: JSON.stringify({})
      });
      setGeneratedIdentity({ nsec: res.nsec, npub: res.npub });
      setHasBackedUpNsec(false);
      void refresh();
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Error al generar identidad');
    } finally {
      setIsGeneratingIdentity(false);
    }
  };

  const handleImportIdentity = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importNsec.trim()) return;
    setIsImporting(true);
    setImportError('');
    try {
      const res = await api<{ npub: string; status: string }>('/api/identity/import', {
        method: 'POST',
        body: JSON.stringify({ nsec: importNsec.trim() })
      });
      setIsImportModalOpen(false);
      setImportNsec('');
      setNotice(`✓ Identidad importada con éxito: ${res.npub}`);
      void refresh();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Error al importar identidad');
    } finally {
      setIsImporting(false);
    }
  };

  const applyCommissionBondPreset = (preset: CommissionBondPreset) => {
    markDirty();
    setDraft((old) => ({
      ...old,
      market: {
        ...old.market,
        fee_bps: preset.feeBps,
        dev_fee_bps: preset.devFeeBps,
        max_routing_fee_bps: preset.maxRoutingFeeBps,
      },
      safety: {
        ...old.safety,
        bond_enabled: preset.bondEnabled,
        bond_bps: preset.bondBps,
        base_bond_sats: preset.baseBondSats,
        bond_apply_to: preset.bondApplyTo,
        automatic_timeout_slash: preset.automaticTimeoutSlash,
      },
    }));
    setFeeInputs({
      fee: percent(preset.feeBps),
      devFee: percent(preset.devFeeBps),
      routingFee: percent(preset.maxRoutingFeeBps),
      bond: percent(preset.bondBps),
    });
    setNotice(
      draft.community.language === 'en'
        ? `✓ Preset applied: ${preset.nameEn}`
        : `✓ Plantilla de comisiones aplicada: ${preset.nameEs}`
    );
  };

  const markDirty = () => { setDirty(true); setSaved(false); };
  const refreshSafely = () => { if (dirty && !window.confirm('Hay cambios sin guardar. ¿Descartarlos y recargar la configuración?')) return; void refresh(); };
  const updateCommunity = (key: keyof Configuration['community'], value: string) => { markDirty(); setDraft((old) => ({ ...old, community: { ...old.community, [key]: value } })); };
  const updateMarket = (key: keyof Configuration['market'], value: unknown) => { markDirty(); setDraft((old) => ({ ...old, market: { ...old.market, [key]: value } })); };
  const updateSafety = (key: keyof Configuration['safety'], value: unknown) => { markDirty(); setDraft((old) => ({ ...old, safety: { ...old.safety, [key]: value } })); };
  const toggleCurrency = (code: string) => {
    markDirty();
    const exists = draft.market.fiat_currencies.includes(code);
    if (exists) {
      updateMarket('fiat_currencies', draft.market.fiat_currencies.filter((c) => c !== code));
    } else {
      if (draft.market.fiat_currencies.length >= 30) {
        setApiError(
          draft.community.language === 'en'
            ? 'Maximum 30 fiat currencies allowed by Mostro'
            : 'Máximo 30 monedas fiat permitidas por Mostro'
        );
        return;
      }
      updateMarket('fiat_currencies', [...draft.market.fiat_currencies, code]);
    }
  };
  const handleCurrencyKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredCurrencies.length > 0) {
        toggleCurrency(filteredCurrencies[0].code);
        setCurrencySearchQuery('');
      }
    }
  };
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
      await refresh();
    } catch (err) { setNotice(''); setApiError(err instanceof Error ? err.message : 'No se pudo guardar la configuración.'); }
    finally { setSaving(false); }
  };
  const handleActivateDaemon = async () => {
    if (!window.confirm('¿Deseas activar la configuración para el daemon Mostro con las reglas del borrador actual?')) return;
    setActivatingDaemon(true);
    try {
      await api('/api/daemon/activate', {
        method: 'PUT',
        headers: { 'X-Requested-With': 'mostro-community' },
      });
      setNotice('Configuración activa de Mostro activada con éxito.');
      await refresh();
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Error al activar el daemon');
    } finally {
      setActivatingDaemon(false);
    }
  };
  const handleDeactivateDaemon = async () => {
    if (!window.confirm('¿Deseas desactivar la configuración activa de Mostro?')) return;
    setActivatingDaemon(true);
    try {
      await api('/api/daemon/deactivate', {
        method: 'PUT',
        headers: { 'X-Requested-With': 'mostro-community' },
      });
      setNotice('Configuración activa desactivada.');
      await refresh();
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Error al desactivar el daemon');
    } finally {
      setActivatingDaemon(false);
    }
  };
  const hasActiveConfiguration = daemon?.state === 'active_ready' || daemon?.state === 'active_running';
  const isDaemonRunning = daemon?.state === 'active_running';
  const nodeInMaintenance = Boolean(daemon?.announced_fresh && daemon.announced?.tags?.maintenance_mode === 'true');
  const readiness = useMemo(() => [Boolean(draft.community.name.trim()), draft.market.fiat_currencies.length > 0, draft.nostr.relays.length > 0, draft.payment_methods.some((method) => method.active)].filter(Boolean).length, [draft]);
  const activeCategories = useMemo(() => {
    const seen = new Set<string>();
    draft.payment_methods.forEach((m) => {
      const trimmed = m.category.trim();
      if (trimmed) seen.add(trimmed);
    });
    return Array.from(seen).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }, [draft.payment_methods]);

  useEffect(() => {
    if (page !== 'config') return;

    const handleScroll = () => {
      const scrollPos = window.scrollY + 130;
      for (let i = configNavSections.length - 1; i >= 0; i--) {
        const item = configNavSections[i];
        const el = document.getElementById(item.id);
        if (el && scrollPos >= el.offsetTop) {
          setActiveConfigNav(item.id);
          break;
        }
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener('scroll', handleScroll);
  }, [page]);
  const statuses = dashboard ? [
    { title: 'Mostro', icon: 'grid', data: dashboard.mostro },
    { title: 'Lightning', icon: 'bolt', data: dashboard.lightning },
    { title: 'Bitcoin', icon: 'bitcoin', data: dashboard.bitcoin },
  ] : [];
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><img className="brand-mark" src="/brand-mark.png" alt="" aria-hidden="true"/><div className="brand-copy"><b>MOSTRO</b><span>COMMUNITY MANAGER</span></div></div>
      <div className="workspace-label">ESPACIO DE TRABAJO</div>
      <div className="workspace"><div className="workspace-icon">{(draft.community.name || 'MC').slice(0, 2).toUpperCase()}</div><div><b>{draft.community.name || 'Mi comunidad'}</b><span>Entorno local</span></div><span className="workspace-chevron">⌄</span></div>
      <div className="nav-label">GENERAL</div>
      <nav className="nav-list" aria-label="Navegación principal">
        <button className={`nav-item ${page === 'dashboard' ? 'active' : ''}`} onClick={() => setPage('dashboard')}><Icon name="grid"/><span>Panel general</span>{page === 'dashboard' && <span className="nav-active-mark"/>}</button>
        <button className={`nav-item ${page === 'orders' ? 'active' : ''}`} onClick={() => setPage('orders')}><Icon name="bolt"/><span>Órdenes públicas</span>{page === 'orders' && <span className="nav-active-mark"/>}</button>
        <button className={`nav-item ${page === 'mediation' ? 'active' : ''}`} onClick={() => setPage('mediation')}><Icon name="shield"/><span>Mediación</span>{page === 'mediation' && <span className="nav-active-mark"/>}</button>
        <button className={`nav-item ${page === 'simulation' ? 'active' : ''}`} onClick={() => setPage('simulation')}><Icon name="play"/><span>Simulador P2P</span>{page === 'simulation' && <span className="nav-active-mark"/>}</button>
        <button className={`nav-item ${page === 'liquidity' ? 'active' : ''}`} onClick={() => setPage('liquidity')}><Icon name="bitcoin"/><span>Operaciones LND</span>{page === 'liquidity' && <span className="nav-active-mark"/>}</button>
        <button className={`nav-item ${page === 'config' ? 'active' : ''}`} onClick={() => setPage('config')}><Icon name="sliders"/><span>Configuración</span>{page === 'config' && <span className="nav-active-mark"/>}</button>
      </nav>
      <div className="sidebar-spacer" />
      <div className="sidebar-bottom"><div className="mode-card"><span className="mode-icon"><Icon name="globe" size={16}/></span><div><b>{isDaemonRunning ? 'Nodo Mostro activo' : hasActiveConfiguration ? 'Configuración preparada' : 'Modo desarrollo'}</b><span>{isDaemonRunning ? 'Mercado en línea' : hasActiveConfiguration ? 'Mercado sin verificar' : 'Mercado sin iniciar'}</span></div><span className="mode-dot" style={isDaemonRunning ? { background: '#52c41a', boxShadow: '0 0 8px rgba(82,196,26,0.6)' } : {}}/></div><div className="sidebar-footer"><span className="avatar">MC</span><div><b>Administrador</b><span>Configuración local</span></div></div></div>
    </aside>
    <main className="main-area">
      <header className="topbar"><div className="breadcrumb"><span>Mi comunidad</span><Icon name="chevron" size={14}/><b>{page === 'dashboard' ? 'Panel general' : page === 'orders' ? 'Órdenes públicas' : page === 'mediation' ? 'Consola de mediación' : page === 'simulation' ? 'Simulador P2P' : page === 'liquidity' ? 'Operaciones LND y Liquidez' : 'Configuración'}</b></div><div className="top-actions"><span className="environment-pill"><i/> Desarrollo</span><button className="icon-button" aria-label="Abrir mediación" onClick={() => setPage('mediation')}><Icon name="shield" size={17}/></button><button className="icon-button" aria-label="Abrir simulador" onClick={() => setPage('simulation')}><Icon name="play" size={17}/></button><button className="icon-button" aria-label="Abrir liquidez LND" onClick={() => setPage('liquidity')}><Icon name="bitcoin" size={17}/></button><button className="icon-button" aria-label="Abrir configuración" onClick={() => setPage('config')}><Icon name="sliders" size={17}/></button><span className="top-avatar">MC</span></div></header>
      {page === 'dashboard' && (
        <section className="content dashboard-page">
        <div className="page-heading"><div><div className="eyebrow">MOSTRO COMMUNITY MANAGER <span className="eyebrow-sep">/</span> INICIO</div><h1>Panel general</h1><p>Estado de tu instancia y preparación de la comunidad.</p></div><div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>{daemon?.can_activate && (<button type="button" className={`button ${hasActiveConfiguration ? 'button-secondary' : 'button-primary'}`} onClick={() => void (hasActiveConfiguration ? handleDeactivateDaemon() : handleActivateDaemon())} disabled={activatingDaemon || loading} title={hasActiveConfiguration ? 'Desactivar demonio Mostro' : 'Activar demonio Mostro'}>{activatingDaemon ? 'Procesando...' : hasActiveConfiguration ? 'Desactivar Mostro (Off)' : 'Activar Mostro (On)'}</button>)}<button className="button button-secondary refresh-button" onClick={() => void refresh()} disabled={loading}><span className={loading ? 'spin' : ''}>↻</span> Actualizar</button></div></div>
        <div className="dev-banner" style={isDaemonRunning ? { background: 'rgba(82, 196, 26, 0.08)', borderColor: 'rgba(82, 196, 26, 0.3)' } : {}}><div className="banner-icon"><Icon name={isDaemonRunning ? 'check' : 'alert'} size={18}/></div><div><b>{isDaemonRunning ? 'Nodo Mostro en ejecución' : hasActiveConfiguration ? 'Configuración preparada' : 'Entorno de desarrollo'}</b><span>{isDaemonRunning ? 'El motor Mostro está activo y sincronizado con tu configuración. El nodo anuncia y procesa órdenes en los relays Nostr configurados.' : hasActiveConfiguration ? 'La configuración está guardada. Comprueba en tu cliente la identidad, versión y reglas anunciadas por el nodo antes de operar; el arranque y la recepción de órdenes requieren verificación.' : 'Activa la configuración de tu comunidad y verifica el arranque del daemon antes de operar.'}</span></div><div className="banner-status" style={isDaemonRunning ? { color: '#7ee0a5', borderColor: 'rgba(82, 196, 26, 0.4)' } : {}}><i style={isDaemonRunning ? { background: '#52c41a' } : {}}/> {isDaemonRunning ? 'MERCADO EN LÍNEA' : hasActiveConfiguration ? 'MERCADO SIN VERIFICAR' : 'MERCADO SIN INICIAR'}</div></div>
        {!daemon?.identity_present && (
          <section className="onboarding-banner-card" aria-labelledby="onboarding-title">
            <div className="onboarding-banner-header">
              <div className="onboarding-badge">PASO 1 · IDENTIDAD NOSTR SOBERANA</div>
              <h2 id="onboarding-title">Inicia tu Comunidad Mostro P2P</h2>
              <p>
                Para que tu nodo Mostro pueda recibir órdenes, comunicarse por chat cifrado y liquidar intercambios de forma autónoma en Nostr, necesita una clave criptográfica (nsec/npub). Puedes crear una nueva en 1 clic o importar una existente.
              </p>
            </div>
            <div className="onboarding-action-buttons">
              <button
                type="button"
                className="button button-primary onboarding-btn-main"
                onClick={() => void handleGenerateIdentity()}
                disabled={isGeneratingIdentity}
              >
                <Icon name="bolt" size={18} />
                <span>{isGeneratingIdentity ? 'Generando identidad...' : 'Crear Nueva Identidad en 1 Clic'}</span>
              </button>
              <button
                type="button"
                className="button button-secondary onboarding-btn-alt"
                onClick={() => {
                  setImportError('');
                  setImportNsec('');
                  setIsImportModalOpen(true);
                }}
                disabled={isGeneratingIdentity}
              >
                <Icon name="save" size={18} />
                <span>Tengo una clave nsec existente</span>
              </button>
            </div>
          </section>
        )}
        <div className="section-title-row"><div><h2>Servicios</h2><p>Conectividad reportada por la instancia local.</p></div><span className="updated-label">{loading ? 'Consultando…' : health ? 'API disponible' : 'API sin conexión'}</span></div>
        <div className="service-grid">{statuses.length ? statuses.map(({ title, icon, data }) => <article className="service-card" key={title}><div className="service-top"><span className="service-icon"><Icon name={icon}/></span><span className="service-status"><StatusDot status={data.status}/>{({ online: 'Conectado', offline: 'Sin conexión', unconfigured: 'Sin configurar', unknown: 'Desconocido', warning: 'Revisar' } as Record<string, string>)[data.status] || 'Desconocido'}</span></div><h3>{title}</h3><p>{data.detail || 'Sin detalles disponibles'}</p><div className="service-meta">{title === 'Mostro' && (data.version || daemon?.mostro_version) ? <span>v{data.version || daemon?.mostro_version}</span> : null}{title === 'Lightning' && data.alias ? <span>{data.alias}</span> : null}{title === 'Lightning' && typeof data.num_active_channels === 'number' ? <span>{data.num_active_channels} canales activos</span> : null}{title === 'Bitcoin' && typeof data.block_height === 'number' ? <span>Bloque {data.block_height.toLocaleString('es')}</span> : null}<Icon name="arrow" size={15}/></div></article>) : <div className="service-card unavailable"><div className="service-top"><span className="service-icon"><Icon name="grid"/></span><span className="service-status"><StatusDot/>Desconocido</span></div><h3>Servicios no disponibles</h3><p>{apiError || 'La API aún no informa el estado de los servicios.'}</p><div className="service-meta"><span>Reintenta cuando el servidor esté disponible</span></div></div>}</div>
        {dashboard?.lightning && <section className="lightning-details" aria-labelledby="lightning-details-title"><div className="lightning-heading"><div><h2 id="lightning-details-title">Detalles de Lightning</h2><p>Información reportada por el nodo.</p></div>{dashboard.lightning.network && <span className="network-tag">Red {dashboard.lightning.network}</span>}</div>{dashboard.lightning.num_active_channels === 0 && <p className="lightning-capacity-note" role="status">LND está conectado, pero no tiene canales activos. El mercado no tiene capacidad de intercambio Lightning.</p>}<div className="lightning-stats"><div><span>Sincronización de cadena</span><strong>{dashboard.lightning.synced_to_chain === true ? 'Sincronizado' : dashboard.lightning.synced_to_chain === false ? 'Pendiente' : 'Desconocido'}</strong></div><div><span>Sincronización del grafo</span><strong>{dashboard.lightning.synced_to_graph === true ? 'Sincronizado' : dashboard.lightning.synced_to_graph === false ? 'Pendiente' : 'Desconocido'}</strong></div><div><span>Canales activos</span><strong>{typeof dashboard.lightning.num_active_channels === 'number' ? dashboard.lightning.num_active_channels : 'Desconocido'}</strong></div><div><span>Canales pendientes</span><strong>{typeof dashboard.lightning.num_pending_channels === 'number' ? dashboard.lightning.num_pending_channels : 'Desconocido'}</strong></div><div><span>Canales inactivos</span><strong>{typeof dashboard.lightning.num_inactive_channels === 'number' ? dashboard.lightning.num_inactive_channels : 'Desconocido'}</strong></div></div><div className="liquidity-row"><div><span>Liquidez local</span><strong>{dashboard.lightning.liquidity?.status === 'available' && dashboard.lightning.liquidity.local_balance_sats !== null ? `${dashboard.lightning.liquidity.local_balance_sats} sats` : 'Desconocida'}</strong></div><div><span>Liquidez remota</span><strong>{dashboard.lightning.liquidity?.status === 'available' && dashboard.lightning.liquidity.remote_balance_sats !== null ? `${dashboard.lightning.liquidity.remote_balance_sats} sats` : 'Desconocida'}</strong></div><p>{dashboard.lightning.liquidity?.status === 'unavailable' ? dashboard.lightning.liquidity.detail || 'El nodo no informa la liquidez.' : 'Los datos de canales y liquidez no garantizan que una ruta o una operación esté disponible.'}</p></div><div style={{ marginTop: '10px', textAlign: 'right' }}><button type="button" className="button button-secondary" style={{ fontSize: '12px', height: '28px' }} onClick={() => setPage('liquidity')}>Operaciones LND y Guía de Liquidez →</button></div></section>}
        {connection && connection.status === 'ready' && (
          <section className="connection-card" aria-labelledby="connection-title">
            <div className="connection-heading">
              <div>
                <h2 id="connection-title">Conexión de clientes con este nodo</h2>
                <p>Un cliente necesita la clave pública del nodo y sus relays. Comisiones, límites y garantía los lee del evento de información que publica el daemon.</p>
              </div>
              <a href={connection.app_download_url} target="_blank" rel="noreferrer" className="button button-secondary download-link">
                Mostro App ↗
              </a>
            </div>

            <div className="connection-body">
              <div className="connection-qr-pane">
                <div className="qr-toggle-group">
                  <button
                    type="button"
                    className={`qr-toggle-btn ${qrFormat === 'card' ? 'active' : ''}`}
                    onClick={() => setQrFormat('card')}
                  >
                    Tarjeta firmada
                  </button>
                  <button
                    type="button"
                    className={`qr-toggle-btn ${qrFormat === 'uri' ? 'active' : ''}`}
                    onClick={() => setQrFormat('uri')}
                  >
                    nprofile
                  </button>
                  <button
                    type="button"
                    className={`qr-toggle-btn ${qrFormat === 'json' ? 'active' : ''}`}
                    onClick={() => setQrFormat('json')}
                  >
                    JSON
                  </button>
                </div>

                <div className="qr-box-wrapper">
                  {(() => {
                    const svg = qrFormat === 'card' ? connection.qr_card_svg : qrFormat === 'uri' ? connection.qr_svg : connection.qr_json_svg;
                    return svg ? (
                      <div className="qr-box" dangerouslySetInnerHTML={{ __html: svg }} title="Código QR de conexión" />
                    ) : (
                      <span className="empty-hint">Sin tarjeta: guarda la configuración de la comunidad. El nombre, la web y el contacto no pueden contener «&», ni los relays y métodos de pago «&» o «,».</span>
                    );
                  })()}
                </div>

                <span className="qr-hint-caption">
                  {qrFormat === 'card'
                    ? 'Tarjeta de la comunidad firmada por el nodo (mostro://community/…): nombre, relays, moneda y métodos de pago'
                    : qrFormat === 'uri'
                      ? 'Solo identidad y relays (nprofile). El cliente no recibe moneda ni métodos de pago'
                      : 'La misma tarjeta firmada, como JSON'}
                </span>
              </div>

              <div className="connection-details">
                <div className="connection-row">
                  <span className="field-label">Clave pública Nostr (npub)</span>
                  <div className="copy-box">
                    <code>{connection.npub}</code>
                    <button type="button" className="copy-button" onClick={() => copyText(connection.npub || '', 'npub')}>
                      {copiedField === 'npub' ? 'Copiado ✓' : 'Copiar'}
                    </button>
                  </div>
                </div>

                <div className="connection-row">
                  <span className="field-label">Identificador hex del nodo</span>
                  <div className="copy-box">
                    <code>{connection.pubkey_hex}</code>
                    <button type="button" className="copy-button" onClick={() => copyText(connection.pubkey_hex || '', 'hex')}>
                      {copiedField === 'hex' ? 'Copiado ✓' : 'Copiar'}
                    </button>
                  </div>
                </div>

                {qrFormat === 'card' ? (
                  connection.card_uri && (
                    <div className="connection-row">
                      <span className="field-label">Enlace de la tarjeta firmada</span>
                      <div className="copy-box">
                        <code>{connection.card_uri}</code>
                        <button type="button" className="copy-button" onClick={() => copyText(connection.card_uri || '', 'card_uri')}>
                          {copiedField === 'card_uri' ? 'Copiado ✓' : 'Copiar'}
                        </button>
                      </div>
                    </div>
                  )
                ) : qrFormat === 'uri' ? (
                  connection.nostr_uri && (
                    <div className="connection-row">
                      <span className="field-label">Enlace con nprofile (identidad y relays)</span>
                      <div className="copy-box">
                        <code>{connection.nostr_uri}</code>
                        <button type="button" className="copy-button" onClick={() => copyText(connection.nostr_uri || '', 'uri')}>
                          {copiedField === 'uri' ? 'Copiado ✓' : 'Copiar'}
                        </button>
                      </div>
                    </div>
                  )
                ) : (
                  connection.json_uri && (
                    <div className="connection-row">
                      <span className="field-label">Tarjeta firmada en JSON</span>
                      <div className="copy-box">
                        <code>{connection.json_uri}</code>
                        <button type="button" className="copy-button" onClick={() => copyText(connection.json_uri || '', 'json_uri')}>
                          {copiedField === 'json_uri' ? 'Copiado ✓' : 'Copiar'}
                        </button>
                      </div>
                    </div>
                  )
                )}

                <div className="connection-relays-row">
                  <span className="field-label">Relays Nostr:</span>
                  {connection.relays.length > 0 ? (
                    <div className="chips">
                      {connection.relays.map((r) => <span key={r} className="chip">{r}</span>)}
                    </div>
                  ) : (
                    <span className="empty-hint">Sin relays guardados en el borrador</span>
                  )}
                </div>
              </div>
            </div>
          </section>
        )}
        {daemon && (
          <section className="daemon-card" aria-labelledby="daemon-title">
            <div className="daemon-heading">
              <div>
                <h2 id="daemon-title">Orquestación del Demonio Mostro</h2>
                <p>Control del archivo de configuración activa y estado de arranque del motor P2P.</p>
              </div>
              <span className="service-status">
                <StatusDot status={isDaemonRunning ? 'online' : hasActiveConfiguration || daemon.state === 'configured_standby' ? 'warning' : 'offline'} />
                {isDaemonRunning ? 'En ejecución (Online)' : hasActiveConfiguration ? 'Ejecución sin verificar' : daemon.state === 'configured_standby' ? 'En Espera de Activación' : 'Sin Configurar'}
              </span>
            </div>
            {daemon.warnings.length > 0 && (
              <div className="daemon-warnings" role="alert">
                {daemon.warnings.map((w, idx) => (
                  <div key={idx}>⚠ {w}</div>
                ))}
              </div>
            )}
            <div className="daemon-grid">
              <div className="daemon-grid-item">
                <span>Versión del daemon Mostro</span>
                <strong>{daemon.mostro_version ? `v${daemon.mostro_version}` : 'Desconocida'}</strong>
                <small>
                  {daemon.version_source === 'announced'
                    ? 'Anunciada por el daemon en los relays'
                    : daemon.version_source === 'binary'
                      ? 'Binario incluido en el paquete; el daemon aún no la anuncia'
                      : 'Versión fijada por el paquete; sin confirmar'}
                </small>
              </div>
              <div className="daemon-grid-item">
                <span>Anuncio del nodo en relays</span>
                <strong>
                  {daemon.announced && typeof daemon.announced_age_secs === 'number'
                    ? `Hace ${formatAge(daemon.announced_age_secs)}`
                    : 'Sin anuncio'}
                </strong>
                <small>
                  {daemon.announced_fresh
                    ? 'Reciente: los clientes ven el nodo activo'
                    : daemon.announced
                      ? 'Antiguo: los clientes pueden darlo por inactivo'
                      : 'El daemon publica su información cada 5 minutos'}
                </small>
              </div>
              <div className="daemon-grid-item">
                <span>Protocolo de mensajes</span>
                <strong>{`v${daemon.protocol_version || 2} (kind 14, NIP-44)`}</strong>
              </div>
              <div className="daemon-grid-item">
                <span>Identidad Nostr del bot</span>
                <strong>{daemon.npub ? daemon.npub.slice(0, 16) + '...' + daemon.npub.slice(-8) : 'No importada'}</strong>
              </div>
              <div className="daemon-grid-item">
                <span>Revisión borrador</span>
                <strong>{daemon.draft_revision !== null && daemon.draft_revision !== undefined ? `Revisión ${daemon.draft_revision}` : 'Sin borrador'}</strong>
              </div>
              <div className="daemon-grid-item">
                <span>Configuración activa</span>
                <strong>{daemon.active_revision ? `Revisión ${daemon.active_revision}` : 'Ninguna'}</strong>
              </div>
              <div className="daemon-grid-item">
                <span>SHA-256 settings.toml</span>
                <strong>{daemon.active_settings_hash ? daemon.active_settings_hash.slice(0, 16) + '...' : 'Inactivo'}</strong>
              </div>
            </div>
            <div className="daemon-actions">
              {daemon.can_activate && (
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => void handleActivateDaemon()}
                  disabled={activatingDaemon}
                >
                  {activatingDaemon ? 'Activando...' : hasActiveConfiguration ? 'Reactivar Mostro / Actualizar Configuración' : 'Activar Mostro'}
                </button>
              )}
              {hasActiveConfiguration && (
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => void handleDeactivateDaemon()}
                  disabled={activatingDaemon}
                >
                  Desactivar Mostro
                </button>
              )}
            </div>
          </section>
        )}
        <section className="connection-card" aria-labelledby="order-help-title">
          <h2 id="order-help-title">Reglas para crear órdenes desde cualquier cliente</h2>
          <p>Una orden lleva un importe fijo en sats o un precio de mercado con prima, nunca ambos. Mostro rechaza la combinación con «invalid_parameters».</p>
          <details>
            <summary>Cómo resolver «Invalid parameters» o «prima no válida»</summary>
            <ul>
              <li><strong>Precio de mercado:</strong> Amount = 0, Fiat = 5 USD y Premium = 10 para +10 %. Mostro calcula los sats con su cotización cuando alguien toma la orden.</li>
              <li><strong>Importe fijo:</strong> Amount = 10000, Fiat = 5 USD y Premium = 0.</li>
              <li><strong>Rango:</strong> mínimo y máximo en fiat, Amount = 0 y Fiat = 0. La prima es opcional.</li>
            </ul>
            <p>El importe fiat y la prima son números enteros. Los sats resultantes deben estar entre el mínimo y el máximo del nodo y la moneda debe estar admitida. La prima de una orden no es la comisión del nodo.</p>
            <p>Si una app envía los sats estimados junto con una prima, el fallo está en la app: debe enviar Amount = 0. La guía <code>docs/INTEGRACION-APPS.md</code> del repositorio detalla el contrato completo para desarrolladores.</p>
            <p>Si el cliente muestra otra versión o límites distintos de los configurados aquí, compara la clave pública y los relays, y revisa arriba el anuncio del nodo en relays.</p>
          </details>
        </section>
        <section className="sim-card" aria-labelledby="sim-title">
          <div className="sim-heading">
            <div>
              <h2 id="sim-title">Simulador Sintético de Protocolo P2P</h2>
              <p>Modelo interactivo sintético de órdenes, Hold Invoices Lightning, eventos Nostr y resolución de disputas (dry-run en memoria, con la secuencia de Mostro v0.19.2).</p>
            </div>
            <button className="button button-secondary" onClick={() => setPage('simulation')}>
              Abrir Simulador Completo <Icon name="arrow" size={14}/>
            </button>
          </div>
          <div className="sim-controls">
            <div className="sim-control-group">
              <label>Escenario de prueba</label>
              <select value={selectedScenario} onChange={(e) => setSelectedScenario(e.target.value)}>
                {simScenarios.length > 0 ? simScenarios.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                )) : (
                  <>
                    <option value="happy_path">Intercambio Exitoso (Happy Path)</option>
                    <option value="dispute_settled_for_buyer">Disputa Resuelta a Favor del Comprador</option>
                    <option value="dispute_refunded_to_seller">Disputa con Reembolso al Vendedor</option>
                    <option value="seller_cancellation">Cancelación de Orden por el Vendedor</option>
                  </>
                )}
              </select>
            </div>
            <div className="sim-control-group">
              <label>Monto de la orden (satoshis)</label>
              <input type="number" min="1000" step="1000" value={simSatsInput} onChange={(e) => setSimSatsInput(e.target.value)} />
            </div>
            <div style={{ marginTop: 'auto', display: 'flex', gap: '8px' }}>
              <button
                type="button"
                className="button button-primary"
                onClick={() => void handleRunSimulation()}
                disabled={simulating}
              >
                <Icon name="play" size={14}/> {simulating ? 'Simulando ciclo...' : 'Ejecutar Simulación'}
              </button>
            </div>
          </div>
          {simError && <div className="form-message error">{simError}</div>}
          {simulationReport && (
            <div>
              <div className="sim-complete-banner">
                <span>✓ Simulación sintética ejecutada: {simulationReport.scenario} (Orden: {simulationReport.order_id})</span>
                <span>Estado: <code>{simulationReport.final_status}</code> ({simulationReport.duration_simulated_ms} ms)</span>
              </div>
              <div className="sim-financials">
                <div className="sim-financial-item">
                  <span>Monto Orden</span>
                  <strong>{simulationReport.financials.trade_amount_sats.toLocaleString()} sats</strong>
                  <small>≈ {simulationReport.financials.fiat_amount} {simulationReport.financials.fiat_currency}</small>
                </div>
                <div className="sim-financial-item">
                  <span>Garantía Vendedor</span>
                  <strong>{simulationReport.financials.seller_bond_sats.toLocaleString()} sats</strong>
                  <small>Factura retenida aparte</small>
                </div>
                <div className="sim-financial-item">
                  <span>Garantía Comprador</span>
                  <strong>{simulationReport.financials.buyer_bond_sats.toLocaleString()} sats</strong>
                  <small>Factura retenida aparte</small>
                </div>
                <div className="sim-financial-item">
                  <span>Comisión Mostro</span>
                  <strong>{(simulationReport.financials.total_mostro_fee_sats ?? simulationReport.financials.fee_sats ?? 0).toLocaleString()} sats</strong>
                  <small>{draft.market.fee_bps / 100}% en total, la mitad por parte</small>
                </div>
                <div className="sim-financial-item">
                  <span>Depósito del Vendedor</span>
                  <strong>{(simulationReport.financials.seller_hold_invoice_sats ?? simulationReport.financials.seller_total_locked_sats).toLocaleString()} sats</strong>
                  <small>Orden + su mitad de la comisión</small>
                </div>
              </div>
              <div style={{ textAlign: 'right', marginTop: '6px' }}>
                <button type="button" className="button button-secondary" onClick={() => setPage('simulation')}>
                  Ver los {simulationReport.steps.length} pasos detallados en el Simulador →
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="connection-card" aria-labelledby="notifications-title" style={{ marginTop: '16px' }}>
          <div className="connection-heading">
            <div>
              <h2 id="notifications-title">Alertas y Notificaciones de Eventos (SSE en vivo)</h2>
              <p>Transmisión reactiva en tiempo real sobre la salud de relays, órdenes en disputa y eventos críticos del nodo.</p>
            </div>
            <span className="service-status">
              <StatusDot status={notifications.some((n) => n.level === 'error' || n.level === 'critical') ? 'warning' : 'online'} />
              {notifications.length} eventos registrados
            </span>
          </div>
          {notifications.length === 0 ? (
            <p className="empty-hint" style={{ padding: '16px 0' }}>No hay alertas recientes; el nodo opera de manera estable.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' }}>
              {notifications.slice(0, 6).map((n) => (
                <div key={n.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'rgba(255,255,255,0.03)', borderRadius: '6px', borderLeft: `3px solid ${n.level === 'error' ? '#ef4444' : n.level === 'warning' ? '#f59e0b' : '#10b981'}` }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: '13px', textTransform: 'uppercase', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: n.level === 'error' ? 'rgba(239,68,68,0.2)' : n.level === 'warning' ? 'rgba(245,158,11,0.2)' : 'rgba(16,185,129,0.2)', color: n.level === 'error' ? '#ef4444' : n.level === 'warning' ? '#f59e0b' : '#10b981' }}>{n.category}</span>
                      <strong style={{ fontSize: '16px' }}>{n.title}</strong>
                    </div>
                    <p style={{ margin: '4px 0 0 0', fontSize: '15px', color: '#9ca3af' }}>{n.message}</p>
                  </div>
                  <span style={{ fontSize: '14px', color: '#6b7280' }}>
                    {n.timestamp ? new Date(n.timestamp * 1000).toLocaleTimeString('es') : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="connection-card" aria-labelledby="backup-title" style={{ marginTop: '16px' }}>
          <div className="connection-heading">
            <div>
              <h2 id="backup-title">Backups Automáticos Offsite y Persistencia</h2>
              <p>Exportación cifrada periódica con retención en carpeta segura (0700/0600) y medio secundario.</p>
            </div>
            <span className="service-status">
              <StatusDot status={backupState?.enabled ? 'online' : 'warning'} />
              {backupState?.enabled ? 'Worker Automático Activo' : 'En Espera de Frase / Manual'}
            </span>
          </div>
          <div className="daemon-grid" style={{ marginTop: '12px' }}>
            <div className="daemon-grid-item">
              <span>Carpeta secundaria</span>
              <strong>{backupState?.target_dir || '/data/backup'}</strong>
            </div>
            <div className="daemon-grid-item">
              <span>Política de retención</span>
              <strong>{backupState?.retention_count ?? 7} respaldos más recientes</strong>
            </div>
            <div className="daemon-grid-item">
              <span>Intervalo de respaldo</span>
              <strong>{backupState?.interval_secs ? `${Math.round(backupState.interval_secs / 3600)} horas` : 'Diario (24h)'}</strong>
            </div>
            <div className="daemon-grid-item">
              <span>Último respaldo ejecutado</span>
              <strong>{backupState?.last_run_timestamp ? new Date(backupState.last_run_timestamp * 1000).toLocaleString('es') : 'Sin ejecuciones recientes'}</strong>
            </div>
          </div>
          {backupState?.last_error && (
            <div className="daemon-warnings" style={{ marginTop: '12px' }}>
              <div>⚠ {backupState.last_error}</div>
            </div>
          )}
          {backupMessage && (
            <div style={{ marginTop: '12px', padding: '10px 14px', borderRadius: '6px', background: backupMessage.startsWith('✓') ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)', color: backupMessage.startsWith('✓') ? '#10b981' : '#ef4444', fontSize: '15px' }}>
              {backupMessage}
            </div>
          )}
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: '14px', flexWrap: 'wrap' }}>
            <input
              type="password"
              placeholder="Frase de cifrado (mínimo 16 caracteres)"
              value={backupPassphrase}
              onChange={(e) => setBackupPassphrase(e.target.value)}
              style={{ flex: '1 1 240px', padding: '8px 12px', borderRadius: '6px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.15)', color: '#fff' }}
            />
            <button
              type="button"
              className="button button-primary"
              onClick={() => void handleTriggerBackup()}
              disabled={triggeringBackup || (backupPassphrase.length > 0 && backupPassphrase.length < 16)}
            >
              {triggeringBackup ? 'Cifrando respaldo...' : 'Ejecutar Respaldo Ahora'}
            </button>
          </div>
          {backupState?.backups && backupState.backups.length > 0 && (
            <div style={{ marginTop: '16px' }}>
              <span className="field-label">Respaldos verificados en medio secundario ({backupState.backups.length})</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '6px' }}>
                {backupState.backups.slice(0, 5).map((b, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px', fontSize: '15px' }}>
                    <code>{b.filename}</code>
                    <span style={{ color: '#9ca3af' }}>{(b.size_bytes / 1024).toFixed(1)} KB · {new Date(b.modified_timestamp * 1000).toLocaleDateString('es')}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        <div className="dashboard-lower"><article className="setup-card"><div className="card-heading"><div><span className="card-kicker">PUESTA EN MARCHA</span><h2>Prepara tu comunidad</h2><p>Configura los datos esenciales antes de iniciar el mercado.</p></div><div className="progress-ring"><span>{readiness}<small>/4</small></span></div></div><progress className="setup-progress" value={readiness} max={4} aria-label="Preparación de la comunidad"/><div className="setup-checks"><span className={draft.community.name ? 'complete' : ''}><i>{draft.community.name ? <Icon name="check" size={12}/> : '1'}</i>Identidad</span><span className={draft.market.fiat_currencies.length ? 'complete' : ''}><i>{draft.market.fiat_currencies.length ? <Icon name="check" size={12}/> : '2'}</i>Monedas</span><span className={draft.nostr.relays.length ? 'complete' : ''}><i>{draft.nostr.relays.length ? <Icon name="check" size={12}/> : '3'}</i>Relays Nostr</span><span className={draft.payment_methods.some((m) => m.active) ? 'complete' : ''}><i>{draft.payment_methods.some((m) => m.active) ? <Icon name="check" size={12}/> : '4'}</i>Pagos</span></div><button className="button button-primary" onClick={() => setPage('config')}>Abrir configuración <Icon name="arrow" size={15}/></button></article>
          <article className="market-card"><div className="market-card-top"><span className="market-symbol"><Icon name="bolt" size={19}/></span><span className="market-tag"><i/> {dashboard?.market_started ? 'MERCADO ACTIVO' : nodeInMaintenance ? 'EN MANTENIMIENTO' : hasActiveConfiguration ? 'SIN CONFIRMAR' : 'AÚN NO INICIADO'}</span></div><div className="market-empty"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="orbit-center"><span>₿</span></div></div><div className="market-copy"><h3>{dashboard?.market_started ? 'El nodo atiende a los clientes' : nodeInMaintenance ? 'Nodo en mantenimiento' : hasActiveConfiguration ? 'Mercado sin confirmar' : 'Mercado sin iniciar'}</h3><p>{dashboard?.market_started ? 'El daemon anuncia su información en los relays configurados, que es lo que los clientes comprueban antes de operar.' : nodeInMaintenance ? 'El daemon anuncia modo mantenimiento: no acepta órdenes ni tomas nuevas. Las operaciones en curso siguen su proceso.' : hasActiveConfiguration ? 'La configuración está activa, pero el daemon no ha anunciado su información en los relays en los últimos minutos. Revisa la tarjeta del daemon.' : 'Guarda la configuración y activa Mostro para abrir el mercado de tu comunidad.'}</p><span className="market-note"><Icon name="alert" size={14}/> {dashboard?.market_started ? 'Este panel no realiza pagos ni toma órdenes' : 'Sin operaciones que mostrar'}</span></div></article></div>
        <div className="bottom-note"><span className="secure-icon"><Icon name="check" size={13}/></span><span>Configuración local</span><span className="note-separator">·</span><span>Los cambios se guardan en el servidor de esta instancia</span><span className="note-spacer"/><span className="api-indicator"><StatusDot status={health ? 'ok' : ''}/>{health ? 'API conectada' : 'API no disponible'}</span></div>
      </section>
      )}
      {page === 'simulation' && (
        <section className="content simulation-page">
          <div className="page-heading">
            <div>
              <div className="eyebrow">MOSTRO COMMUNITY MANAGER <span className="eyebrow-sep">/</span> PROTOCOLO P2P</div>
              <h1>Simulador Sintético de Protocolo P2P</h1>
              <p>Modelo sintético en memoria para evaluar órdenes, Hold Invoices, eventos Nostr y disputas con las reglas de tu comunidad.</p>
            </div>
            <button className="button button-secondary" onClick={() => void handleRunSimulation()} disabled={simulating}>
              <span className={simulating ? 'spin' : ''}>↻</span> {simulating ? 'Simulando...' : 'Reejecutar Simulación'}
            </button>
          </div>

          <div className="sim-notice-card" style={{ marginBottom: '16px', padding: '12px 16px', background: 'rgba(235, 115, 29, 0.08)', border: '1px solid rgba(235, 115, 29, 0.25)', borderRadius: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
              <span style={{ fontSize: '13px', fontWeight: 700, letterSpacing: '0.06em', color: '#eb731d', textTransform: 'uppercase' }}>Modelo Sintético · Dry-Run en Memoria</span>
            </div>
            <p style={{ margin: 0, fontSize: '15px', color: '#9ba3af', lineHeight: 1.4 }}>
              Este simulador recorre el flujo de una operación, las garantías (bonds) y las comisiones con la configuración guardada, sin ejecutar transacciones en Bitcoin/Lightning ni publicar en relays. La secuencia de mensajes y facturas es la de Mostro v0.19.2; los eventos son sintéticos y la equivalencia fiat es ilustrativa.
            </p>
          </div>

          <div className="sim-card">
            <div className="sim-heading">
              <div>
                <h2>Parámetros del Ciclo de Prueba</h2>
                <p>Elige el escenario de prueba y la cantidad de satoshis a transaccionar.</p>
              </div>
            </div>
            <div className="sim-controls">
              <div className="sim-control-group" style={{ flex: '1 1 280px' }}>
                <label>Escenario de prueba</label>
                <select value={selectedScenario} onChange={(e) => setSelectedScenario(e.target.value)}>
                  {simScenarios.length > 0 ? simScenarios.map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  )) : (
                    <>
                      <option value="happy_path">Intercambio Exitoso (Happy Path)</option>
                      <option value="dispute_settled_for_buyer">Disputa Resuelta a Favor del Comprador</option>
                      <option value="dispute_refunded_to_seller">Disputa con Reembolso al Vendedor</option>
                      <option value="seller_cancellation">Cancelación de Orden por el Vendedor</option>
                    </>
                  )}
                </select>
              </div>
              <div className="sim-control-group">
                <label>Monto de la orden (sats)</label>
                <input
                  type="number"
                  min="1000"
                  step="1000"
                  value={simSatsInput}
                  onChange={(e) => setSimSatsInput(e.target.value)}
                />
              </div>
              <div style={{ marginTop: 'auto' }}>
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => void handleRunSimulation()}
                  disabled={simulating}
                >
                  <Icon name="play" size={14}/> {simulating ? 'Simulando ciclo...' : 'Ejecutar Simulación'}
                </button>
              </div>
            </div>

            {simError && <div className="form-message error">{simError}</div>}

            {simulationReport ? (
              <>
                <div className="sim-complete-banner">
                  <div>
                    <strong>Escenario:</strong> {simulationReport.scenario} · <strong>Orden:</strong> <code>{simulationReport.order_id}</code>
                  </div>
                  <div>
                    <span>Estado: <code>{simulationReport.final_status}</code></span> · <span>{simulationReport.duration_simulated_ms} ms</span>
                  </div>
                </div>

                <div className="sim-financials">
                  <div className="sim-financial-item">
                    <span>Monto Orden</span>
                    <strong>{simulationReport.financials.trade_amount_sats.toLocaleString()} sats</strong>
                    <small>≈ {simulationReport.financials.fiat_amount} {simulationReport.financials.fiat_currency}</small>
                  </div>
                  <div className="sim-financial-item">
                    <span>Garantía Vendedor</span>
                    <strong>{simulationReport.financials.seller_bond_sats.toLocaleString()} sats</strong>
                    <small>Factura retenida aparte</small>
                  </div>
                  <div className="sim-financial-item">
                    <span>Garantía Comprador</span>
                    <strong>{simulationReport.financials.buyer_bond_sats.toLocaleString()} sats</strong>
                    <small>Factura retenida aparte</small>
                  </div>
                  <div className="sim-financial-item">
                    <span>Comisión Mostro</span>
                    <strong>{(simulationReport.financials.total_mostro_fee_sats ?? simulationReport.financials.fee_sats ?? 0).toLocaleString()} sats</strong>
                    <small>{(simulationReport.financials.fee_per_side_sats ?? 0).toLocaleString()} sats/lado · Dev: {(simulationReport.financials.dev_fee_sats ?? 0).toLocaleString()} sats</small>
                  </div>
                  <div className="sim-financial-item">
                    <span>Depósito del Vendedor</span>
                    <strong>{(simulationReport.financials.seller_hold_invoice_sats ?? simulationReport.financials.seller_total_locked_sats).toLocaleString()} sats</strong>
                    <small>Orden + su mitad de la comisión</small>
                  </div>
                  <div className="sim-financial-item">
                    <span>Recibe el Comprador</span>
                    <strong>{(simulationReport.financials.buyer_receives_sats ?? 0).toLocaleString()} sats</strong>
                    <small>Orden − su mitad de la comisión</small>
                  </div>
                </div>

                <div className="section-title-row" style={{ marginTop: '20px' }}>
                  <div>
                    <h2>Secuencia Simulada de Pasos ({simulationReport.steps.length} eventos)</h2>
                    <p>Traza sintética ilustrativa de eventos Nostr y transacciones Lightning en cada fase de la operación.</p>
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
                                Estado: <strong>{st.lightning_action.status}</strong> · {st.lightning_action.amount_sats.toLocaleString()} sats
                              </span>
                            </div>
                          )}
                        </div>
                      )}
                    </article>
                  ))}
                </div>

                {simulationReport.disclaimer && (
                  <p style={{ marginTop: '20px', padding: '12px', fontSize: '14px', color: '#6b7280', background: 'rgba(255,255,255,0.02)', borderRadius: '6px', textAlign: 'center', lineHeight: 1.4 }}>
                    {simulationReport.disclaimer}
                  </p>
                )}
              </>
            ) : (
              <div style={{ textAlign: 'center', padding: '30px', color: '#88988e' }}>
                <p>Haz clic en "Ejecutar Simulación" para calcular las finanzas y ver el flujo paso a paso en tiempo real.</p>
              </div>
            )}
          </div>
        </section>
      )}
      {page === 'orders' && (
        <OrdersPage
          onSelectDispute={(orderId) => {
            setSelectedDisputeOrderId(orderId);
            setPage('mediation');
          }}
        />
      )}
      {page === 'mediation' && (
        <MediationConsole
          initialOrderId={selectedDisputeOrderId}
          onSelectOrder={(orderId) => setSelectedDisputeOrderId(orderId)}
        />
      )}
      {page === 'liquidity' && (
        <LiquidityOperationsPage />
      )}
      {page === 'config' && <section className="content config-page">
        <div className="page-heading"><div><div className="eyebrow">MOSTRO COMMUNITY MANAGER <span className="eyebrow-sep">/</span> AJUSTES</div><h1>Configuración</h1><p>Define la identidad y las reglas iniciales de tu comunidad.</p></div><div className="config-heading-actions"><span className={`save-state ${saved ? 'is-saved' : ''}`}><i/>{saved ? `Guardado · revisión ${revision}` : 'Cambios locales'}</span>{daemon?.can_activate && (<button type="button" className="button button-primary" onClick={() => void handleActivateDaemon()} disabled={activatingDaemon || saving || loading}>{activatingDaemon ? 'Activando...' : hasActiveConfiguration ? 'Reactivar Mostro' : 'Activar Mostro'}</button>)}<button className="button button-secondary" onClick={refreshSafely} disabled={loading}>Recargar</button></div></div>
        <div className="preset-commissions-banner">
          <div className="preset-commissions-head">
            <span className="preset-commissions-badge">
              {draft.community.language === 'en' ? 'COMMISSION & BOND PRESETS' : 'PRELLENADO DE COMISIONES Y BONOS'}
            </span>
            <h3>
              {draft.community.language === 'en' ? 'Quick fee & bond presets' : 'Plantillas rápidas de comisiones y fianza'}
            </h3>
            <p>
              {draft.community.language === 'en'
                ? 'Configure market fees, dev fees, routing limits, and anti-spam bonds in one click without affecting your community identity or payment methods.'
                : 'Ajusta comisiones de mercado, desarrollo, enrutamiento y fianzas anti-spam en un clic sin modificar la identidad ni tus métodos de pago.'}
            </p>
          </div>
          <div className="preset-commissions-grid">
            {COMMISSION_BOND_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className="preset-commission-card-btn"
                onClick={() => applyCommissionBondPreset(p)}
              >
                <strong>{draft.community.language === 'en' ? p.nameEn : p.nameEs}</strong>
                <span>{draft.community.language === 'en' ? p.descEn : p.descEs}</span>
                <span className="preset-apply-label">
                  {draft.community.language === 'en' ? 'Apply fees & bonds →' : 'Aplicar comisiones y bonos →'}
                </span>
              </button>
            ))}
          </div>
        </div>
        {notice && <div className="form-message success" style={{ marginBottom: '14px' }}>{notice}</div>}
        <div className="config-layout">
          <nav className="config-nav" aria-label="Secciones de configuración">
            {configNavSections.map((sec) => (
              <a
                key={sec.id}
                href={`#${sec.id}`}
                className={activeConfigNav === sec.id ? 'active' : ''}
                onClick={(e) => {
                  e.preventDefault();
                  setActiveConfigNav(sec.id);
                  const el = document.getElementById(sec.id);
                  if (el) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }
                }}
              >
                {sec.label}
              </a>
            ))}
          </nav>
          <form className="config-form" onSubmit={saveConfig}>
            <section className="config-section" id="identity"><div className="config-section-head"><span className="section-number">01</span><div><h2>Identidad de la comunidad</h2><p>Esta información ayuda a las personas a reconocer tu instancia.</p></div></div><div className="form-grid"><Field label="Nombre de la comunidad"><input value={draft.community.name} onChange={(e) => updateCommunity('name', e.target.value)} placeholder="Ej. Bitcoin Quito" maxLength={80}/></Field><Field label="Idioma"><select value={draft.community.language} onChange={(e) => updateCommunity('language', e.target.value)}><option value="es">Español</option><option value="en">English</option><option value="pt">Português</option></select></Field><Field label="Sitio web"><input type="url" value={draft.community.website} onChange={(e) => updateCommunity('website', e.target.value)} placeholder="https://tu-comunidad.org"/></Field><Field label="Contacto" hint="Dirección web pública de contacto"><input type="url" value={draft.community.contact} onChange={(e) => updateCommunity('contact', e.target.value)} placeholder="https://tu-comunidad.org/contacto"/></Field><div className="field full-width"><span className="field-label">Acerca de</span><textarea value={draft.community.about} onChange={(e) => updateCommunity('about', e.target.value)} placeholder="Describe brevemente tu comunidad" rows={3} maxLength={500}/><span className="field-hint">{draft.community.about.length}/500 caracteres</span></div></div></section>
            <section className="config-section" id="market"><div className="config-section-head"><span className="section-number">02</span><div><h2>Reglas del mercado</h2><p>Establece límites de operación y comisiones. Los porcentajes se convierten a puntos base al guardar.</p></div></div><div className="form-grid">
              <div className="field full-width">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '6px' }}>
                  <span className="field-label" style={{ margin: 0 }}>
                    {draft.community.language === 'en' ? 'Fiat currencies' : 'Monedas fiat'}
                  </span>
                  <span className="field-hint" style={{ margin: 0 }}>
                    {draft.market.fiat_currencies.length}/30 {draft.community.language === 'en' ? 'selected' : 'seleccionadas'}
                  </span>
                </div>
                <div className="chips currency-selected-chips">
                  {draft.market.fiat_currencies.map((code) => {
                    const displayName = getCurrencyDisplayName(code, draft.community.language);
                    return (
                      <button
                        className="currency-chip-badge"
                        type="button"
                        key={code}
                        onClick={() => toggleCurrency(code)}
                        title={draft.community.language === 'en' ? `Remove ${code} - ${displayName}` : `Eliminar ${code} - ${displayName}`}
                      >
                        <strong>{code}</strong>
                        <span>{displayName}</span>
                        <b>×</b>
                      </button>
                    );
                  })}
                  {draft.market.fiat_currencies.length === 0 && (
                    <span className="empty-hint">
                      {draft.community.language === 'en'
                        ? 'No fiat currencies selected · add at least one to enable trading'
                        : 'Sin monedas seleccionadas · elige una para habilitar operaciones'}
                    </span>
                  )}
                </div>
                <div className="currency-search-wrap" ref={currencyDropdownRef}>
                  <input
                    type="text"
                    className="currency-search-input"
                    value={currencySearchQuery}
                    onChange={(e) => {
                      setCurrencySearchQuery(e.target.value);
                      setIsCurrencyDropdownOpen(true);
                    }}
                    onFocus={() => setIsCurrencyDropdownOpen(true)}
                    onKeyDown={handleCurrencyKeyDown}
                    placeholder={
                      draft.community.language === 'en'
                        ? 'Search currency by code (USD, EUR) or name (Dollar, Peso)...'
                        : 'Buscar moneda por abreviación (USD, EUR) o nombre (Dólar, Peso)...'
                    }
                  />
                  {currencySearchQuery && (
                    <button
                      type="button"
                      className="currency-search-clear"
                      aria-label="Limpiar búsqueda"
                      onClick={() => {
                        setCurrencySearchQuery('');
                        setIsCurrencyDropdownOpen(true);
                      }}
                    >
                      ✕
                    </button>
                  )}
                  {isCurrencyDropdownOpen && (
                    <div className="currency-dropdown-menu">
                      <div className="currency-dropdown-header">
                        <span>
                          {currencySearchQuery.trim()
                            ? draft.community.language === 'en'
                              ? `Results for "${currencySearchQuery}" (${filteredCurrencies.length})`
                              : `Resultados para "${currencySearchQuery}" (${filteredCurrencies.length})`
                            : draft.community.language === 'en'
                            ? 'Select currencies from the ISO 4217 catalog'
                            : 'Selecciona monedas del catálogo oficial ISO 4217'}
                        </span>
                        <button
                          type="button"
                          className="currency-dropdown-close"
                          onClick={() => setIsCurrencyDropdownOpen(false)}
                        >
                          {draft.community.language === 'en' ? 'Close' : 'Cerrar'}
                        </button>
                      </div>
                      <div className="currency-dropdown-list">
                        {filteredCurrencies.length === 0 ? (
                          <div className="currency-dropdown-empty">
                            {draft.community.language === 'en'
                              ? `No currencies found matching "${currencySearchQuery}"`
                              : `No se encontraron monedas que coincidan con "${currencySearchQuery}"`}
                          </div>
                        ) : (
                          filteredCurrencies.map((item) => {
                            const isSelected = draft.market.fiat_currencies.includes(item.code);
                            const isEn = draft.community.language === 'en';
                            const primaryName = isEn ? item.nameEn : item.nameEs;
                            const secondaryName = isEn ? item.nameEs : item.nameEn;
                            return (
                              <div
                                key={item.code}
                                className={`currency-dropdown-item ${isSelected ? 'selected' : ''}`}
                                onClick={() => toggleCurrency(item.code)}
                              >
                                <span className="currency-code-tag">{item.code}</span>
                                <div className="currency-item-names">
                                  <span className="currency-primary-name">{primaryName}</span>
                                  <span className="currency-secondary-name">{secondaryName}</span>
                                </div>
                                <span className={`currency-item-action ${isSelected ? 'is-selected' : ''}`}>
                                  {isSelected
                                    ? isEn
                                      ? '✓ Selected'
                                      : '✓ Seleccionada'
                                    : isEn
                                    ? '+ Add'
                                    : '+ Añadir'}
                                </span>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  )}
                </div>
                <div className="currency-popular-row">
                  <span className="currency-popular-label">
                    {draft.community.language === 'en' ? 'Quick add:' : 'Monedas populares:'}
                  </span>
                  {POPULAR_CURRENCIES.map((code) => {
                    const isSelected = draft.market.fiat_currencies.includes(code);
                    return (
                      <button
                        key={code}
                        type="button"
                        className={`currency-quick-pill ${isSelected ? 'active' : ''}`}
                        onClick={() => toggleCurrency(code)}
                        title={getCurrencyDisplayName(code, draft.community.language)}
                      >
                        {isSelected ? `✓ ${code}` : `+ ${code}`}
                      </button>
                    );
                  })}
                </div>
              </div>
              <Field label="Operación mínima" hint="Valor expresado en satoshis"><input type="number" min="0" value={draft.market.min_trade_sats} onChange={(e) => updateMarket('min_trade_sats', Number(e.target.value))}/></Field><Field label="Operación máxima" hint="Valor expresado en satoshis"><input type="number" min="0" value={draft.market.max_trade_sats} onChange={(e) => updateMarket('max_trade_sats', Number(e.target.value))}/></Field><Field label="Comisión total por operación" hint="Mostro cobra la mitad al comprador y la mitad al vendedor. 0% si no deseas cobrar"><div className="input-suffix"><input type="number" min="0" step="0.01" value={feeInputs.fee} required onChange={(e) => updateFee('fee', 'fee_bps', e.target.value)}/><span>%</span></div></Field><Field label="Aporte al desarrollo de Mostro" hint="Parte de tu comisión que el nodo envía al fondo de desarrollo, solo en mainnet. Entre 10% y 100%"><div className="input-suffix"><input type="number" min="10" max="100" step="0.01" value={feeInputs.devFee} required onChange={(e) => updateFee('devFee', 'dev_fee_bps', e.target.value)}/><span>%</span></div></Field><Field label="Comisión máxima de enrutamiento" hint="Tope que el nodo acepta pagar a la red al enviar los sats al comprador. Con 0% solo salen pagos por rutas gratuitas; Mostro usa 0,2% por defecto"><div className="input-suffix"><input type="number" min="0" step="0.01" value={feeInputs.routingFee} required onChange={(e) => updateFee('routingFee', 'max_routing_fee_bps', e.target.value)}/><span>%</span></div></Field></div></section>
            <section className="config-section" id="safety"><div className="config-section-head"><span className="section-number">03</span><div><h2>Seguridad y garantías</h2><p>Opciones de bonos y prueba de trabajo para reducir el abuso.</p></div></div><Toggle checked={draft.safety.bond_enabled} onChange={(v) => updateSafety('bond_enabled', v)} label="Exigir bono para las operaciones" note="Las personas reservan sats como garantía durante una operación."/>{draft.safety.bond_enabled && <div className="form-grid compact-grid"><Field label="Bono relativo" hint="Porcentaje del valor de la operación. Se aplica el mayor entre este y el bono mínimo"><div className="input-suffix"><input type="number" min="0" step="0.01" value={feeInputs.bond} required onChange={(e) => updateFee('bond', 'bond_bps', e.target.value)}/><span>%</span></div></Field><Field label="Bono mínimo" hint="Suelo en satoshis: no se suma al porcentaje"><input type="number" min="0" value={draft.safety.base_bond_sats} onChange={(e) => updateSafety('base_bond_sats', Number(e.target.value))}/></Field><Field label="Aplicar a"><select value={draft.safety.bond_apply_to} onChange={(e) => updateSafety('bond_apply_to', e.target.value)}><option value="both">Quien publica y quien acepta</option><option value="make">Quien publica</option><option value="take">Quien acepta</option></select></Field></div>}<div className="toggle-divider"/><Toggle checked={draft.safety.automatic_timeout_slash} onChange={(v) => updateSafety('automatic_timeout_slash', v)} label="Penalización automática por vencimiento" note="Penaliza el bond por vencimiento en estados de espera; no se aplica a todos los plazos de una operación."/><div className="form-grid compact-grid pow-grid"><Field label="Prueba de trabajo" hint="Dificultad general"><input type="number" min="0" value={draft.safety.pow} onChange={(e) => updateSafety('pow', Number(e.target.value))}/></Field><Field label="Primera conversación" hint="Dificultad del primer mensaje de cada clave. Si supera la general, las apps que no la calculan no reciben respuesta"><input type="number" min="0" value={draft.safety.pow_first_contact} onChange={(e) => updateSafety('pow_first_contact', Number(e.target.value))}/></Field></div></section>
            <section className="config-section" id="nostr"><div className="config-section-head"><span className="section-number">04</span><div><h2>Relays de Nostr</h2><p>Define los relays que usará tu instancia para publicar y recibir eventos.</p></div></div><div className="chips">{draft.nostr.relays.map((relay) => <button className="chip relay-chip" type="button" key={relay} onClick={() => setDraft((old) => ({ ...old, nostr: { relays: old.nostr.relays.filter((x) => x !== relay) } }))}><span>{relay}</span><b>×</b></button>)}{draft.nostr.relays.length === 0 && <span className="empty-hint">Aún no has añadido relays.</span>}</div><div className="inline-add"><input type="url" value={relayInput} onChange={(e) => setRelayInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addRelay())} placeholder="wss://relay.example.org"/><button type="button" onClick={addRelay}>Añadir relay</button></div></section>
            <section className="config-section" id="payments">
              <div className="config-section-head"><span className="section-number">05</span><div><h2>Métodos de pago</h2><p>Activa las opciones de pago que tu comunidad puede ofrecer.</p></div></div>
              {activeCategories.length > 0 && (
                <div className="payment-summary-bar">
                  <span className="payment-summary-title">Categorías en uso ({activeCategories.length}):</span>
                  <div className="payment-summary-chips">
                    {activeCategories.map((cat) => {
                      const count = draft.payment_methods.filter((m) => m.category.trim().toLowerCase() === cat.toLowerCase()).length;
                      return (
                        <span key={cat} className="payment-summary-badge" title={`${count} método(s) en esta categoría`}>
                          <span className="summary-dot" />
                          {cat} <span className="summary-count">{count}</span>
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}
              {draft.payment_methods.length === 0 && <p className="empty-hint payment-empty">No hay métodos de pago añadidos. Añade solo las opciones que tu comunidad admite.</p>}
              <div className="payment-list">
                {draft.payment_methods.map((method, index) => (
                  <div className="payment-row" key={index}>
                    <span className="payment-mark">{method.label.slice(0, 1) || '·'}</span>
                    <div className="payment-col-main">
                      <div className="payment-edit">
                        <input
                          aria-label="Identificador del método"
                          required
                          value={method.id}
                          placeholder="id"
                          onChange={(e) => {
                            markDirty();
                            setDraft((old) => ({ ...old, payment_methods: old.payment_methods.map((item, i) => i === index ? { ...item, id: e.target.value } : item) }));
                          }}
                        />
                        <input
                          aria-label="Nombre del método"
                          required
                          value={method.label}
                          placeholder="Nombre"
                          onChange={(e) => {
                            markDirty();
                            const newLabel = e.target.value;
                            setDraft((old) => ({
                              ...old,
                              payment_methods: old.payment_methods.map((item, i) => {
                                if (i !== index) return item;
                                const updated = { ...item, label: newLabel };
                                if (!item.id || item.id === item.label.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '')) {
                                  updated.id = newLabel.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '');
                                }
                                return updated;
                              }),
                            }));
                          }}
                        />
                        <input
                          aria-label="Categoría del método"
                          required
                          value={method.category}
                          placeholder="Categoría"
                          onChange={(e) => {
                            markDirty();
                            setDraft((old) => ({ ...old, payment_methods: old.payment_methods.map((item, i) => i === index ? { ...item, category: e.target.value } : item) }));
                          }}
                        />
                      </div>
                      {activeCategories.length > 0 && (
                        <div className="payment-category-tags">
                          <span className="payment-category-label">Tags activos:</span>
                          {activeCategories.map((cat) => {
                            const isSelected = method.category.trim().toLowerCase() === cat.toLowerCase();
                            return (
                              <button
                                type="button"
                                key={cat}
                                className={`category-tag-pill ${isSelected ? 'selected' : ''}`}
                                title={isSelected ? `Categoría asignada: ${cat}` : `Asignar "${cat}" a este método`}
                                onClick={() => {
                                  markDirty();
                                  setDraft((old) => ({
                                    ...old,
                                    payment_methods: old.payment_methods.map((item, i) =>
                                      i === index ? { ...item, category: cat } : item
                                    ),
                                  }));
                                }}
                              >
                                {isSelected ? '✓ ' : '+ '}{cat}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    <span className={`payment-state ${method.active ? 'enabled' : ''}`}>{method.active ? 'Activo' : 'Inactivo'}</span>
                    <button
                      type="button"
                      role="switch"
                      aria-label={`${method.active ? 'Desactivar' : 'Activar'} ${method.label || 'método de pago'}`}
                      aria-checked={method.active}
                      className={`toggle small ${method.active ? 'on' : ''}`}
                      onClick={() => {
                        markDirty();
                        setDraft((old) => ({ ...old, payment_methods: old.payment_methods.map((item, i) => i === index ? { ...item, active: !item.active } : item) }));
                      }}
                    >
                      <i/>
                    </button>
                    <button
                      type="button"
                      className="remove-payment"
                      aria-label={`Eliminar ${method.label || 'método de pago'}`}
                      onClick={() => {
                        markDirty();
                        setDraft((old) => ({ ...old, payment_methods: old.payment_methods.filter((_, i) => i !== index) }));
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="add-payment"
                onClick={() => {
                  markDirty();
                  setDraft((old) => ({ ...old, payment_methods: [...old.payment_methods, { id: '', label: '', category: '', active: true }] }));
                }}
              >
                + Añadir método de pago
              </button>
            </section>
            {(apiError || notice) && <div className={`form-message ${apiError ? 'error' : 'success'}`} role="status">{apiError || notice}</div>}
            <div className="form-footer"><div className="footer-copy"><span className="secure-icon"><Icon name="check" size={13}/></span><span>Los cambios se guardan en el servidor local.</span></div><button className="button button-primary save-button" type="submit" disabled={saving || loading || !communityLoaded}><Icon name="save" size={16}/>{saving ? 'Guardando…' : 'Guardar configuración'}</button></div>
          </form>
        </div>
      </section>}
    </main>
    {generatedIdentity && (
      <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="custody-title">
        <div className="modal-dialog">
          <div className="modal-header">
            <h3 id="custody-title">¡Identidad Mostro Generada con Éxito!</h3>
            <button
              type="button"
              className="modal-close-btn"
              aria-label="Cerrar modal"
              onClick={() => {
                if (!hasBackedUpNsec) {
                  if (window.confirm('¿Seguro que deseas cerrar? Asegúrate de haber copiado y guardado tu clave privada (nsec).')) {
                    setGeneratedIdentity(null);
                  }
                } else {
                  setGeneratedIdentity(null);
                }
              }}
            >
              ✕
            </button>
          </div>
          <div className="modal-body">
            <div className="security-warning-box">
              <strong>⚠ RESGUARDO OBLIGATORIO DE CLAVE PRIVADA (NSEC)</strong>
              Esta clave privada es la credencial maestra de tu nodo Mostro. Cópiala y guárdala ahora mismo en tu gestor de contraseñas seguro. Por motivos de seguridad y soberanía, Mostro Community Manager nunca volverá a mostrarte la clave privada completa.
            </div>

            <div className="key-display-group">
              <label>Clave Privada Nostr (nsec) — ¡Secreto!</label>
              <div className="copy-box">
                <code style={{ color: '#ffd993', fontWeight: 600 }}>{generatedIdentity.nsec}</code>
                <button
                  type="button"
                  className="copy-button"
                  onClick={() => copyText(generatedIdentity.nsec, 'modal_nsec')}
                >
                  {copiedField === 'modal_nsec' ? 'Copiado ✓' : 'Copiar nsec'}
                </button>
              </div>
            </div>

            <div className="key-display-group">
              <label>Clave Pública Nostr (npub) — Identidad Pública</label>
              <div className="copy-box">
                <code>{generatedIdentity.npub}</code>
                <button
                  type="button"
                  className="copy-button"
                  onClick={() => copyText(generatedIdentity.npub, 'modal_npub')}
                >
                  {copiedField === 'modal_npub' ? 'Copiado ✓' : 'Copiar npub'}
                </button>
              </div>
            </div>

            <label className="custody-checklist">
              <input
                type="checkbox"
                checked={hasBackedUpNsec}
                onChange={(e) => setHasBackedUpNsec(e.target.checked)}
              />
              <span>Confirmo que he copiado y guardado mi clave privada (nsec) en mi gestor de contraseñas u otro medio seguro.</span>
            </label>
          </div>
          <div className="modal-footer">
            <button
              type="button"
              className="button button-primary"
              disabled={!hasBackedUpNsec}
              onClick={() => {
                setGeneratedIdentity(null);
                setPage('config');
                setNotice('✓ Identidad lista. Ahora elige una plantilla regional o personaliza las reglas de tu comunidad.');
              }}
            >
              Continuar a Configuración →
            </button>
          </div>
        </div>
      </div>
    )}
    {isImportModalOpen && (
      <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="import-title">
        <div className="modal-dialog">
          <div className="modal-header">
            <h3 id="import-title">Importar Clave Privada Nostr (nsec)</h3>
            <button
              type="button"
              className="modal-close-btn"
              aria-label="Cerrar modal"
              onClick={() => {
                setIsImportModalOpen(false);
                setImportNsec('');
                setImportError('');
              }}
            >
              ✕
            </button>
          </div>
          <form onSubmit={handleImportIdentity}>
            <div className="modal-body">
              <p style={{ margin: 0, fontSize: '13.5px', color: '#a3b4ab', lineHeight: 1.5 }}>
                Ingresa la clave privada (en formato <code>nsec1...</code>) que utilizará tu bot Mostro para firmar eventos, comunicarse con los usuarios y publicar órdenes.
              </p>
              <div className="field">
                <span className="field-label">Clave privada (nsec)</span>
                <div style={{ position: 'relative' }}>
                  <input
                    type={showImportNsec ? 'text' : 'password'}
                    value={importNsec}
                    onChange={(e) => setImportNsec(e.target.value)}
                    placeholder="nsec1..."
                    required
                    style={{ paddingRight: '80px', fontFamily: 'monospace' }}
                  />
                  <button
                    type="button"
                    className="button button-secondary"
                    style={{ position: 'absolute', right: '4px', top: '4px', height: '30px', padding: '0 8px', fontSize: '11px' }}
                    onClick={() => setShowImportNsec(!showImportNsec)}
                  >
                    {showImportNsec ? 'Ocultar' : 'Ver'}
                  </button>
                </div>
              </div>
              {importError && (
                <div className="form-message error" style={{ margin: 0 }}>
                  ⚠ {importError}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-secondary"
                onClick={() => {
                  setIsImportModalOpen(false);
                  setImportNsec('');
                  setImportError('');
                }}
                disabled={isImporting}
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="button button-primary"
                disabled={isImporting || !importNsec.trim()}
              >
                {isImporting ? 'Validando...' : 'Importar y Vincular'}
              </button>
            </div>
          </form>
        </div>
      </div>
    )}
  </div>;
}

export default App;
