// All data lives only on this device (localStorage). Use Settings → Backup to keep a copy.
const KEY = 'portfolio.v1';

export const defaultSettings = () => ({
  stockProvider: 'finnhub', // 'finnhub' | 'yahoo'
  finnhubKey: '',
  proxyUrl: '',
  hideValues: false,
  refreshSeconds: 60,
});

export const emptyState = () => ({
  version: 1,
  transactions: [],
  assets: {},
  prices: {},
  fx: null,
  lastRefresh: null,
  settings: defaultSettings(),
});

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyState();
    return normalise(JSON.parse(raw));
  } catch {
    return emptyState();
  }
}

export function save(state) {
  localStorage.setItem(KEY, JSON.stringify(state));
}

export function normalise(data) {
  const base = emptyState();
  return {
    ...base,
    ...data,
    transactions: Array.isArray(data.transactions) ? data.transactions : [],
    assets: data.assets && typeof data.assets === 'object' ? data.assets : {},
    prices: data.prices && typeof data.prices === 'object' ? data.prices : {},
    settings: { ...base.settings, ...(data.settings || {}) },
  };
}

/** Backup without API keys, so the file is safe to store in iCloud Drive. */
export function exportBackup(state) {
  const { finnhubKey, proxyUrl, ...settings } = state.settings;
  return JSON.stringify({ ...state, prices: {}, settings, exportedAt: new Date().toISOString() }, null, 2);
}

export function importBackup(state, text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data.transactions)) throw new Error('Not a portfolio backup file.');
  const next = normalise(data);
  next.settings = { ...next.settings, finnhubKey: state.settings.finnhubKey, proxyUrl: state.settings.proxyUrl };
  return next;
}
