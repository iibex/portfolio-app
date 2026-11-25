import { parseCSV } from '../csv.js';
import { readXlsx } from '../xlsx.js';
import * as bitvavo from './bitvavo.js';
import * as degiro from './degiro.js';
import * as generic from './generic.js';
import * as saxo from './saxo.js';
import * as equate from './equate.js';

export const importers = [generic, equate, saxo, degiro, bitvavo];

// Shown in the UI so it is clear what is coming next.
export const planned = [];

/**
 * Parse an export file's text (CSV). Returns { broker, transactions, assets, skipped, ... }.
 * `forced` lets the user pick the broker when auto-detect fails.
 */
export function importText(text, forced) {
  return importRows(parseCSV(text), forced);
}

/** Parse a File from an <input type=file>: CSV or Excel (.xlsx). */
export async function importFile(file, forced) {
  const isXlsx = /\.xlsx$/i.test(file.name) || /spreadsheetml/.test(file.type);
  if (isXlsx) return importRows(await readXlsx(await file.arrayBuffer()), forced);
  return importText(await file.text(), forced);
}

/** Rows → result. The header row is searched in the first lines (Excel exports often start with a title block). */
export function importRows(rows, forced) {
  for (let h = 0; h < Math.min(rows.length, 20); h++) {
    const headers = rows[h];
    if (!headers || headers.filter((x) => String(x).trim()).length < 3) continue;
    const imp = forced ? importers.find((i) => i.id === forced && (h === 0 || i.detect(headers)))
      : importers.find((i) => i.detect(headers));
    if (!imp) continue;
    const data = rows.slice(h + 1).filter((r) => r.some((x) => String(x ?? '').trim() !== ''));
    if (!data.length) throw new Error('The file has no data rows.');
    return { broker: imp.label, ...imp.parse(headers, data) };
  }
  throw new Error('Could not recognise this file. Supported: DEGIRO Transactions, Bitvavo transaction history, Saxo positions, EquatePlus portfolio details, or the portfolio template.');
}

/** Merge parsed results into state without creating duplicates. Returns counts. */
export function mergeImport(state, result) {
  // Snapshot imports (Saxo positions) replace the earlier snapshot of the same account(s).
  let replaced = 0;
  if (result.snapshot) {
    const { source, accounts } = result.snapshot;
    const before = state.transactions.length;
    state.transactions = state.transactions.filter((t) => !(t.source === source && accounts.includes(t.account)));
    replaced = before - state.transactions.length;
  }

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
  // Prices included in the export: use them unless a newer live price is already known.
  for (const [id, p] of Object.entries(result.prices || {})) {
    const cur = state.prices[id];
    if (!cur || !cur.time || cur.time < p.time) state.prices[id] = p;
  }
  return { added, duplicates, replaced };
}
