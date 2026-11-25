const LOCALE = 'nl-NL';

const eur = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'EUR' });
const eurBig = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const pct = new Intl.NumberFormat(LOCALE, { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'exceptZero' });
const qtyFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 8 });

export const fmtEur = (n) => (n == null ? '–' : eur.format(n));
export const fmtEurBig = (n) => (n == null ? '–' : Math.abs(n) >= 100000 ? eurBig.format(n) : eur.format(n));
export const fmtSignedEur = (n) => (n == null ? '–' : (n > 0 ? '+' : n < 0 ? '−' : '') + eur.format(Math.abs(n)));
export const fmtPct = (n) => (n == null ? '–' : pct.format(n));
export const fmtQty = (n) => qtyFmt.format(n);

/** Price with more decimals for cheap crypto. */
export function fmtPrice(n) {
  if (n == null) return '–';
  const digits = n < 1 ? 6 : n < 10 ? 4 : 2;
  return new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: digits }).format(n);
}

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function timeAgo(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return fmtDate(iso);
}

export const tone = (n) => (n == null || Math.abs(n) < 1e-9 ? 'flat' : n > 0 ? 'up' : 'down');

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
