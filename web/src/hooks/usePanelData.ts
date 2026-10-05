import { useCallback, useEffect, useRef, useState } from 'react';
import type { AutoBackupState, ConnectionInfo, DaemonReport, Dashboard, NotificationItem, OrdersSnapshot } from '../types';
import { api } from '../lib/api';

export type Health = { status: string; version?: string; mode?: string; mostro_pinned_version?: string };

/** How often the live state is read again while the panel is visible. */
const LIVE_INTERVAL_MS = 20_000;

/** The server keeps this many alerts, and so does the panel. */
const ALERT_LOG_SIZE = 50;

/**
 * Everything the panel reads from its API that more than one page uses: the
 * state of the services, the daemon report, the connection data, the alerts,
 * the backups and the public orders of the node.
 *
 * A value that is still `null` has not been read: the pages say so instead of
 * showing it as empty. `settled` tells a first read in progress from one that
 * failed.
 */
export function usePanelData() {
  const [health, setHealth] = useState<Health | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [daemon, setDaemon] = useState<DaemonReport | null>(null);
  const [connection, setConnection] = useState<ConnectionInfo | null>(null);
  const [notifications, setNotifications] = useState<NotificationItem[] | null>(null);
  const [backups, setBackups] = useState<AutoBackupState | null>(null);
  const [orders, setOrders] = useState<OrdersSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [settled, setSettled] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  // Answers can come back out of order: only the latest request of each kind is kept.
  const liveRequest = useRef(0);
  const restRequest = useRef(0);
  // What has never been read is asked again by the timer until it is.
  const missing = useRef({ connection: true, backups: true });

  // What changes on its own: asked again on a timer without touching the rest.
  const refreshLive = useCallback(async () => {
    const request = ++liveRequest.current;
    const latest = () => request === liveRequest.current;
    const keep = <T,>(apply: (value: T) => void) => (value: T) => { if (latest()) apply(value); };
    const online = await Promise.all([
      api<Health>('/api/health').then((value) => { keep(setHealth)(value); return true; }).catch(() => { keep(setHealth)(null); return false; }),
      api<Dashboard>('/api/dashboard').then(keep(setDashboard)).catch(() => {}),
      api<DaemonReport>('/api/daemon/status').then(keep(setDaemon)).catch(() => {}),
      api<OrdersSnapshot>('/api/orders').then(keep(setOrders)).catch(() => {}),
    ]);
    // The time on screen is the last time the server answered, not the last attempt.
    if (latest() && online[0]) setUpdatedAt(new Date());
  }, []);

  // The stream brings an alert at once, but it can end for good (a restart of
  // the application answers it with an error) and what was published meanwhile
  // is never sent again. So the log is also read on every tick.
  const alertsRequest = useRef(0);
  /** When the stream delivered each alert, by id. */
  const streamedAt = useRef(new Map<string, number>());
  const refreshAlerts = useCallback(async () => {
    const request = ++alertsRequest.current;
    const sentAt = Date.now();
    await api<NotificationItem[]>('/api/notifications')
      .then((log) => {
        if (request !== alertsRequest.current) return;
        // The log is what the server holds. Only an alert the stream delivered
        // while this read was on its way can be missing from it.
        const inLog = new Set(log.map((item) => item.id));
        const arrived = streamedAt.current;
        for (const [id, at] of arrived) if (at < sentAt) arrived.delete(id);
        const sinceSent = new Set(arrived.keys());
        setNotifications((previous) => [...(previous ?? []).filter((item) => sinceSent.has(item.id) && !inLog.has(item.id)), ...log].slice(0, ALERT_LOG_SIZE));
      })
      .catch(() => {});
  }, []);

  const refreshBackups = useCallback(async () => {
    await api<AutoBackupState>('/api/backup/status').then((value) => { missing.current.backups = false; setBackups(value); }).catch(() => {});
  }, []);

  // What only changes when the operator does something.
  const refreshRest = useCallback(async () => {
    const request = ++restRequest.current;
    const latest = () => request === restRequest.current;
    await Promise.all([
      refreshBackups(),
      refreshAlerts(),
      api<ConnectionInfo>('/api/connection').then((value) => { if (latest()) { missing.current.connection = false; setConnection(value); } }).catch(() => {}),
    ]);
  }, [refreshBackups, refreshAlerts]);

  const refresh = useCallback(async () => {
    setLoading(true);
    await Promise.all([refreshLive(), refreshRest()]);
    setLoading(false);
    setSettled(true);
  }, [refreshLive, refreshRest]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Alerts arrive as they happen. The browser reconnects a stream that drops,
  // but gives one up for good when the server answers it with an error.
  const alertStream = useRef<EventSource | null>(null);
  const openAlertStream = useCallback(() => {
    if (alertStream.current && alertStream.current.readyState !== EventSource.CLOSED) return;
    try {
      const source = new EventSource('/api/notifications/sse');
      source.addEventListener('notification', (event) => {
        try {
          const item: NotificationItem = JSON.parse((event as MessageEvent).data);
          streamedAt.current.set(item.id, Date.now());
          setNotifications((previous) => [item, ...(previous ?? []).filter((other) => other.id !== item.id)].slice(0, ALERT_LOG_SIZE));
        } catch {
          // A malformed event is not worth breaking the stream for.
        }
      });
      alertStream.current = source;
    } catch {
      // Without the stream the log is still read on every tick.
    }
  }, []);

  useEffect(() => {
    openAlertStream();
    return () => { alertStream.current?.close(); alertStream.current = null; };
  }, [openAlertStream]);

  useEffect(() => {
    const tick = () => {
      // A hidden tab does not need fresh numbers.
      if (document.visibilityState !== 'visible') return;
      void refreshLive();
      const { connection: noConnection, backups: noBackups } = missing.current;
      // Reading everything else again reads the alerts too.
      if (noConnection || noBackups) void refreshRest();
      else void refreshAlerts();
      openAlertStream();
    };
    const timer = setInterval(tick, LIVE_INTERVAL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [refreshLive, refreshRest, refreshAlerts, openAlertStream]);

  return {
    health,
    apiOnline: health?.status === 'ok',
    dashboard,
    daemon,
    connection,
    /** Empty until read; `notificationsRead` tells an empty log from an unread one. */
    notifications: notifications ?? [],
    notificationsRead: notifications !== null,
    backups,
    orders,
    loading,
    settled,
    updatedAt,
    refresh,
    refreshLive,
    refreshBackups,
  };
}

export type PanelData = ReturnType<typeof usePanelData>;
