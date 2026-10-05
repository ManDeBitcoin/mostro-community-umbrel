import type { Configuration, CommissionBondPreset } from '../types';

export const COMMISSION_BOND_PRESETS: CommissionBondPreset[] = [
  {
    id: 'standard',
    nameEs: 'Equilibrado / Recomendado (0.5% com. · 3% fianza)',
    nameEn: 'Balanced / Recommended (0.5% fee · 3% bond)',
    descEs: 'Comisión de mercado 0.5%, fianza del 3% (mínimo 5,000 sats). Ideal para comunidades activas.',
    descEn: '0.5% market fee, 3% bond (5,000 sats minimum). Ideal for active communities.',
    feeBps: 50,
    devFeeBps: 1000,
    maxRoutingFeeBps: 10,
    bondEnabled: true,
    bondBps: 300,
    baseBondSats: 5000,
    bondApplyTo: 'both',
    automaticTimeoutSlash: true,
  },
  {
    id: 'safe',
    nameEs: 'Bajo Riesgo / Fianza Alta (0.8% com. · 5% fianza)',
    nameEn: 'Low Risk / High Bond (0.8% fee · 5% bond)',
    descEs: 'Fianza reforzada del 5% (mínimo 10,000 sats) y comisión 0.8%. Recomendado para nuevos mercados.',
    descEn: 'Reinforced 5% bond (10,000 sats minimum) and 0.8% fee. Recommended for new markets.',
    feeBps: 80,
    devFeeBps: 1000,
    maxRoutingFeeBps: 10,
    bondEnabled: true,
    bondBps: 500,
    baseBondSats: 10000,
    bondApplyTo: 'both',
    automaticTimeoutSlash: true,
  },
  {
    id: 'zero',
    nameEs: 'Cero Comisión / Fianza Comunitaria (0.0% com. · 2% fianza)',
    nameEn: 'Zero Fee / Community Bond (0.0% fee · 2% bond)',
    descEs: 'Sin comisión de mercado para fomentar adopción; fianza del 2% (mínimo 2,000 sats) contra spam.',
    descEn: 'No market fee to foster adoption; 2% bond (2,000 sats minimum) to deter spam.',
    feeBps: 0,
    devFeeBps: 1000,
    maxRoutingFeeBps: 10,
    bondEnabled: true,
    bondBps: 200,
    baseBondSats: 2000,
    bondApplyTo: 'both',
    automaticTimeoutSlash: true,
  },
];

export const POPULAR_CURRENCIES = ['USD', 'EUR', 'ARS', 'VES', 'COP', 'BRL', 'MXN', 'CLP', 'PEN', 'GBP', 'CHF'];

export const blankConfig = (): Configuration => ({
  community: { name: '', about: '', website: '', contact: '', language: 'es' },
  market: { fiat_currencies: [], min_trade_sats: 1000, max_trade_sats: 1000000, fee_bps: 0, dev_fee_bps: 3000, max_routing_fee_bps: 20 },
  safety: { bond_enabled: false, bond_bps: 0, base_bond_sats: 0, bond_apply_to: 'both', automatic_timeout_slash: false, pow: 0, pow_first_contact: 0 },
  nostr: { relays: [] },
  payment_methods: [],
});

// Statuses mostrod publishes in kind 38383. The tag is coarse: a taken order
// is usually `in-progress` until it closes, but a sell order taken with the
// invoice attached stays `pending`. Disputes are announced in kind 38386.
export const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: 'Pendiente',
  'in-progress': 'En curso',
  success: 'Completada',
  canceled: 'Cancelada',
  'completed-by-admin': 'Resuelta por mediador',
};
export const CLOSED_ORDER_STATUSES = ['success', 'canceled', 'completed-by-admin', 'canceled-by-admin', 'cooperatively-canceled', 'settled-by-admin', 'completed', 'failed', 'expired'];
export const DISPUTE_STATUS_LABELS: Record<string, string> = {
  initiated: 'Abierta, sin mediador',
  'in-progress': 'En mediación',
  settled: 'Resuelta: pago al comprador',
  'seller-refunded': 'Resuelta: devolución al vendedor',
  released: 'Cerrada: el vendedor liberó',
  'cooperatively-canceled': 'Cerrada: cancelación de mutuo acuerdo',
};
export const isOpenDispute = (status: string) => status === 'initiated' || status === 'in-progress';

export const configNavSections: { id: 'identity' | 'market' | 'safety' | 'nostr' | 'payments'; label: string }[] = [
  { id: 'identity', label: 'Identidad' },
  { id: 'market', label: 'Mercado' },
  { id: 'safety', label: 'Seguridad' },
  { id: 'nostr', label: 'Nostr' },
  { id: 'payments', label: 'Métodos de pago' },
];
