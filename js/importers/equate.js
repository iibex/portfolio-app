// EquatePlus "Portefeuillegegevens" / "Portfolio details" export (.xlsx, or the same table as CSV).
//
// A SNAPSHOT of your employee share plans. Columns (NL): Allocatiedatum, Plan, Instrumenttype,
// Instrument, Bijdragetype, Uitoefenprijs / Kostenbasis, Marktprijs, Beschikbaar vanaf, Vervaldatum,
// Toegekend aantal, Uitstaande hoeveelheid, Beschikbare hoeveelheid, Geschatte uitstaande waarde, ...
//
// - "aandelen" (shares) are yours: imported as holdings with the cost basis from the file.
// - Restricted / performance stock units are not yours yet: imported as "unvested", shown
//   separately and NOT counted in the portfolio total.
// - Re-importing a newer export replaces the previous EquatePlus snapshot.
import { col, parseDate, parseNum, hash } from '../csv.js';
import { excelDate } from '../xlsx.js';

export const id = 'equate';
export const label = 'EquatePlus';

export function detect(headers) {
  const has = (...a) => col(headers, ...a) !== -1;
  return has('allocatiedatum', 'allocation date') && has('instrumenttype', 'instrument type') &&
    has('uitstaande hoeveelheid', 'outstanding quantity', 'outstanding');
}

// Well-known EquatePlus employers → ticker + ISIN (others are looked up by name).
const KNOWN = [
  [/^asml\b/i, 'ASML', 'ASML.AS', 'NL0010273215'],
  [/^(koninklijke )?philips\b/i, 'Philips', 'PHIA.AS', 'NL0000009538'],
  [/^shell\b/i, 'Shell', 'SHELL.AS', 'GB00BP6MXD84'],
  [/^heineken\b/i, 'Heineken', 'HEIA.AS', 'NL0000009165'],
  [/^ing\b/i, 'ING Groep', 'INGA.AS', 'NL0011821202'],
  [/^ahold/i, 'Ahold Delhaize', 'AD.AS', 'NL0011794037'],
  [/^unilever\b/i, 'Unilever', 'UNA.AS', 'GB00B10RZP78'],
];

const UNVESTED = /restricted|voorwaardelijk|\brsu|\bpsu|performance|deferred/i;
const OPTION = /optie|option/i;

/** "ASML Share" → { name, symbol, isin, lookup } */
function identify(instrument) {
  const clean = instrument.replace(/\s*\((ord|ordinary)\)\s*$/i, '').replace(/\s+(share|shares|aandeel|aandelen)$/i, '').trim();
  const known = KNOWN.find(([re]) => re.test(clean));
  if (known) return { name: known[1], symbol: known[2], isin: known[3], lookup: known[1] };
  return { name: clean || instrument, symbol: '', isin: '', lookup: clean };
}

function date(v) {
  if (v == null || v === '') return null;
  return /^\d+(\.\d+)?$/.test(String(v).trim()) ? excelDate(v) : parseDate(v);
}

export function parse(headers, rows) {
  const c = {
    date: col(headers, 'allocatiedatum', 'allocation date'),
    plan: col(headers, 'plan'),
    type: col(headers, 'instrumenttype', 'instrument type'),
    instrument: col(headers, 'instrument'),
    contribution: col(headers, 'bijdragetype', 'contribution type'),
    cost: col(headers, 'uitoefenprijs / kostenbasis', 'strike price / cost basis', 'uitoefenprijs', 'cost basis'),
    price: col(headers, 'marktprijs', 'market price'),
    outstanding: col(headers, 'uitstaande hoeveelheid', 'outstanding quantity', 'outstanding'),
    available: col(headers, 'beschikbare hoeveelheid', 'available quantity'),
    availableFrom: col(headers, 'beschikbaar vanaf', 'available from'),
  };
  const get = (r, i) => (i >= 0 ? String(r[i] ?? '').trim() : '');

  const transactions = [];
  const assets = {};
  const prices = {};
  const skipped = [];
  const now = new Date().toISOString();

  // RSU rows name the plan, not the company. If all share rows are one company, use that one.
  const companies = new Set(rows.filter((r) => !UNVESTED.test(get(r, c.type)) && get(r, c.instrument))
    .map((r) => identify(get(r, c.instrument)).name));
  const employer = companies.size === 1 ? identify(rows.find((r) => !UNVESTED.test(get(r, c.type)) && get(r, c.instrument))[c.instrument]) : null;

  rows.forEach((r, i) => {
    const line = i + 1;
    const instrument = get(r, c.instrument);
    const type = get(r, c.type);
    if (!instrument && !type) return; // empty row
    const plan = get(r, c.plan);
    const quantity = Math.abs(parseNum(get(r, c.outstanding)) ?? 0);
    if (!quantity) return skipped.push({ line, reason: `${plan || instrument}: nothing outstanding` });
    if (OPTION.test(type)) return skipped.push({ line, reason: `${plan}: options not supported yet` });

    const unvested = UNVESTED.test(type);
    const who = unvested && employer ? employer : identify(instrument);
    const baseId = who.isin ? `isin:${who.isin}` : `sym:${who.symbol || who.name.toUpperCase()}`;
    const assetId = unvested ? `unvested:${baseId}` : baseId;

    assets[assetId] ??= {
      id: assetId, type: 'stock', currency: 'EUR',
      name: unvested ? `${who.name} (unvested)` : who.name,
      symbol: who.symbol, isin: unvested ? '' : who.isin, lookup: who.lookup,
      ...(unvested ? { unvested: true } : {}),
    };

    const costPerShare = unvested ? 0 : parseNum(get(r, c.cost)) ?? 0;
    const marketPrice = parseNum(get(r, c.price));
    if (marketPrice != null) prices[assetId] = { priceEur: marketPrice, prevCloseEur: null, source: 'EquatePlus export', time: now };

    transactions.push({
      id: 'eq-' + hash(`${i}|${get(r, c.date)}|${plan}|${instrument}|${get(r, c.contribution)}`),
      date: date(get(r, c.date)) || now.slice(0, 19),
      broker: 'EquatePlus', account: 'EquatePlus', source: 'equate-positions',
      type: unvested ? 'reward' : 'buy', assetId,
      quantity, price: costPerShare, currency: 'EUR', totalEur: quantity * costPerShare, feeEur: 0,
      note: [plan, get(r, c.contribution), unvested && get(r, c.availableFrom) ? `vests ${date(get(r, c.availableFrom))?.slice(0, 10)}` : '']
        .filter(Boolean).join(' · '),
    });
  });

  return { transactions, assets, prices, skipped, snapshot: { source: 'equate-positions', accounts: ['EquatePlus'] } };
}
