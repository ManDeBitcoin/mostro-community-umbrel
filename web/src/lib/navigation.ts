import { type MouseEvent, useCallback, useEffect, useState } from 'react';

export type PageId = 'home' | 'orders' | 'disputes' | 'node' | 'lightning' | 'connect' | 'config' | 'backups' | 'alerts' | 'simulator';

export type NavItem = {
  id: PageId;
  label: string;
  icon: string;
  /** One sentence: the question this page answers. */
  description: string;
};
export type NavGroup = { id: string; label: string; items: NavItem[] };

/**
 * The panel is organised by what the operator comes to do: see how the
 * community is doing, follow the market, look after the node, change the
 * rules, and try things out.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'overview',
    label: 'Inicio',
    items: [{ id: 'home', label: 'Resumen', icon: 'home', description: 'Cómo está tu comunidad ahora y qué requiere tu atención.' }],
  },
  {
    id: 'market',
    label: 'Mercado',
    items: [
      { id: 'orders', label: 'Órdenes', icon: 'list', description: 'Las órdenes que tu nodo anuncia en los relays.' },
      { id: 'disputes', label: 'Disputas', icon: 'shield', description: 'Las disputas abiertas y el historial de mensajes de cada orden.' },
    ],
  },
  {
    id: 'node',
    label: 'Nodo',
    items: [
      { id: 'node', label: 'Nodo Mostro', icon: 'server', description: 'Enciende o apaga el mercado y comprueba qué anuncia tu nodo.' },
      { id: 'lightning', label: 'Lightning', icon: 'bolt', description: 'Canales y liquidez del nodo Lightning que mueve los fondos.' },
      { id: 'connect', label: 'Conexión de apps', icon: 'qr', description: 'Lo que una app necesita para operar con tu comunidad.' },
    ],
  },
  {
    id: 'settings',
    label: 'Ajustes',
    items: [
      { id: 'config', label: 'Configuración', icon: 'sliders', description: 'Las reglas de tu comunidad: monedas, límites, comisiones y garantías.' },
      { id: 'backups', label: 'Respaldos', icon: 'save', description: 'Copias cifradas de la identidad y la configuración.' },
      { id: 'alerts', label: 'Alertas', icon: 'bell', description: 'Los avisos que el panel ha registrado.' },
    ],
  },
  {
    id: 'tools',
    label: 'Herramientas',
    items: [{ id: 'simulator', label: 'Simulador', icon: 'play', description: 'Recorre una operación con tus reglas, sin mover fondos.' }],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);
export const navItem = (id: PageId): NavItem => NAV_ITEMS.find((item) => item.id === id) ?? NAV_ITEMS[0];
export const navGroupOf = (id: PageId): NavGroup => NAV_GROUPS.find((group) => group.items.some((item) => item.id === id)) ?? NAV_GROUPS[0];

const SLUGS: Record<PageId, string> = {
  home: '',
  orders: 'ordenes',
  disputes: 'disputas',
  node: 'nodo',
  lightning: 'lightning',
  connect: 'conexion',
  config: 'configuracion',
  backups: 'respaldos',
  alerts: 'alertas',
  simulator: 'simulador',
};

export type Route = { page: PageId; param: string };

const decodeParam = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    // A stray `%` typed in the address is not worth a blank page.
    return '';
  }
};

/** `#/disputas/<id>` is the disputes page with an order selected. */
export function parseHash(hash: string): Route {
  const [slug = '', ...rest] = hash.replace(/^#\/?/, '').split('/');
  const match = (Object.keys(SLUGS) as PageId[]).find((id) => SLUGS[id] === slug);
  // An unknown address opens the summary rather than an empty page.
  return match ? { page: match, param: decodeParam(rest.join('/')) } : { page: 'home', param: '' };
}

/** Addresses of the panel start with `#/`. Any other fragment is an anchor inside the page. */
const isRoute = (hash: string) => hash === '' || hash === '#' || hash.startsWith('#/');

export const toHash = (page: PageId, param = '') => `#/${SLUGS[page]}${param ? `/${encodeURIComponent(param)}` : ''}`;

/** `replace` swaps the current history entry instead of adding one: for a redirect, so that Back does not bounce. */
export type Navigate = (page: PageId, param?: string, options?: { replace?: boolean }) => void;

/**
 * Props for an `<a>` that opens a page of the panel. The address stays in the
 * link, so it can be opened in another tab. A plain click goes through
 * `navigate`, which starts the new page at the top instead of at whatever
 * scroll position the previous one was left in.
 */
export function pageLink(navigate: Navigate, page: PageId, param = '') {
  const href = toHash(page, param);
  return {
    href,
    onClick: (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (window.location.hash === href) window.scrollTo({ top: 0 });
      else navigate(page, param);
    },
  };
}

/**
 * The current page lives in the address, so a reload stays where it was, the
 * browser's back button works and a page can be bookmarked.
 */
export function useRoute(): [Route, Navigate] {
  const [route, setRoute] = useState<Route>(() => parseHash(isRoute(window.location.hash) ? window.location.hash : ''));
  useEffect(() => {
    const onChange = () => {
      if (isRoute(window.location.hash)) setRoute(parseHash(window.location.hash));
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const navigate = useCallback<Navigate>((page, param = '', options) => {
    const next = toHash(page, param);
    if (window.location.hash === next) return;
    const pageChanged = parseHash(window.location.hash).page !== page;
    if (options?.replace) window.location.replace(next);
    else window.location.hash = next;
    if (pageChanged) window.scrollTo({ top: 0 });
  }, []);
  return [route, navigate];
}
