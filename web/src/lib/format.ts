export const percent = (bps: number) => (bps / 100).toString();

/** A duration in the unit a person would say it in: 45 s, 12 min, 3 h, 2 d. */
export const formatAge = (secs: number) =>
  secs < 90 ? `${secs} s` : secs < 5400 ? `${Math.round(secs / 60)} min` : secs < 172800 ? `${Math.round(secs / 3600)} h` : `${Math.round(secs / 86400)} d`;

const dateTime = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const dateOnly = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', year: 'numeric' });
const timeOnly = new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

const stamp = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

const toDate = (value: number | Date) => (value instanceof Date ? value : new Date(value * 1000));

/** `4 oct 2026, 17:08`. Unix seconds or a Date. */
export const formatDateTime = (value?: number | Date | null) => (value ? dateTime.format(toDate(value)) : '—');
export const formatDate = (value?: number | Date | null) => (value ? dateOnly.format(toDate(value)) : '—');
/** `17:08:04`, 24 hours. */
export const formatTime = (value?: number | Date | null) => (value ? timeOnly.format(toDate(value)) : '—');

/** `4 oct, 17:08:04`: for a timeline, where the second matters and the year does not. */
export const formatStamp = (value?: number | Date | null) => (value ? stamp.format(toDate(value)) : '—');

/** `hace 3 min`, from a unix timestamp. */
export const formatAgo = (unixSecs: number, nowSecs = Date.now() / 1000) => `hace ${formatAge(Math.max(0, Math.round(nowSecs - unixSecs)))}`;

const dayTime = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

/** For table cells: `hace 12 min` within a day, then `4 oct, 17:08`, and only the date once the year is another one. */
export const formatWhen = (unixSecs?: number | null, nowSecs = Date.now() / 1000) => {
  if (!unixSecs) return '—';
  const age = nowSecs - unixSecs;
  if (age >= 0 && age < 86400) return formatAgo(unixSecs, nowSecs);
  const date = new Date(unixSecs * 1000);
  return date.getFullYear() === new Date(nowSecs * 1000).getFullYear() ? dayTime.format(date) : dateOnly.format(date);
};

/**
 * Groups thousands with a thin space: `35 186`. Unlike a dot or a comma it
 * cannot be read as a decimal mark, which matters for amounts of money.
 */
export const formatNumber = (value: number | string | bigint) => {
  const text = typeof value === 'number' ? Math.trunc(value).toString() : value.toString();
  return /^-?\d+$/.test(text) ? text.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : text;
};
export const formatSats = (value: number | string | bigint) => `${formatNumber(value)} sats`;

/** `0,6 %` from a fraction such as `0.006`. Keeps what basis points can express, and half of one. */
export const formatFraction = (fraction: number) => `${Number((fraction * 100).toFixed(4)).toString().replace('.', ',')} %`;
/** `0,6 %` from basis points. */
export const formatBps = (bps: number) => `${(bps / 100).toString().replace('.', ',')} %`;

export const shortId = (value: string, head = 8) => (value.length > head ? `${value.slice(0, head)}…` : value);
export const shortKey = (value: string, head = 12, tail = 6) => (value.length > head + tail + 1 ? `${value.slice(0, head)}…${tail > 0 ? value.slice(-tail) : ''}` : value);
