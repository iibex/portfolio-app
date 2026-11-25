import { parseCSV } from '../csv.js';
import * as bitvavo from './bitvavo.js';
import * as degiro from './degiro.js';
import * as generic from './generic.js';

export const importers = [generic, degiro, bitvavo];

// Shown in the UI so it is clear what is coming next.
export const planned = ['EquatePlus', 'Saxo'];

/**
 * Parse an export file. Returns { broker, transactions, assets, skipped }.
 * `forced` lets the user pick the broker when auto-detect fails.
 */
export function importText(text, forced) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('The file has no data rows.');
  const [headers, ...data] = rows;
  const imp = forced ? importers.find((i) => i.id === forced) : importers.find((i) => i.detect(headers));
  if (!imp) {
    throw new Error('Could not recognise this file. Supported: DEGIRO Transactions, Bitvavo transaction history, or the portfolio template.');
  }
  return { broker: imp.label, ...imp.parse(headers, data) };
}

/** Merge parsed results into state without creating duplicates. Returns counts. */
export function mergeImport(state, result) {
  const existing = new Set(state.transactions.map((t) => t.id));
  let added = 0;
  let duplicates = 0;
  for (const t of result.transactions) {
    if (existing.has(t.id)) { duplicates++; continue; }
    state.transactions.push(t);
    existing.add(t.id);
    added++;
  }
  for (const [id, asset] of Object.entries(result.assets)) {
    const cur = state.assets[id];
    if (!cur) state.assets[id] = asset;
    else for (const [k, v] of Object.entries(asset)) if (cur[k] == null || cur[k] === '') cur[k] = v;
  }
  return { added, duplicates };
}
