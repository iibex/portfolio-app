// Run with:  node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCSV, parseNum, parseDate } from '../js/csv.js';
import { importText, mergeImport } from '../js/importers/index.js';
import { TEMPLATE_HEADER, TEMPLATE_EXAMPLE } from '../js/importers/generic.js';
import { computeHoldings, totals } from '../js/portfolio.js';
import { refreshPrices, toEur } from '../js/prices.js';
import { emptyState } from '../js/store.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('parseNum handles European and US formats', () => {
  assert.equal(parseNum('1.234,56'), 1234.56);
  assert.equal(parseNum('1,234.56'), 1234.56);
  assert.equal(parseNum('-12,5'), -12.5);
  assert.equal(parseNum('€ 10'), 10);
  assert.equal(parseNum(''), null);
  assert.equal(parseNum('abc'), null);
});

test('parseDate handles DD-MM-YYYY and ISO', () => {
  assert.equal(parseDate('15-03-2024', '10:12'), '2024-03-15T10:12:00');
  assert.equal(parseDate('2024-01-10', '09:05:00'), '2024-01-10T09:05:00');
  assert.equal(parseDate('2024-01-10 09:05:00'), '2024-01-10T09:05:00');
});

test('parseCSV handles quotes, semicolons and BOM', () => {
  assert.deepEqual(parseCSV('﻿a;b\n"1,5";"x ""y"""\n'), [['a', 'b'], ['1,5', 'x "y"']]);
});

test('DEGIRO (Dutch) import', () => {
  const r = importText(fixture('degiro-nl.csv'));
  assert.equal(r.broker, 'DEGIRO');
  assert.equal(r.transactions.length, 4);
  const [buy, apple, sell] = r.transactions;
  assert.equal(buy.type, 'buy');
  assert.equal(buy.totalEur, 1702);
  assert.equal(buy.feeEur, 2);
  assert.equal(apple.currency, 'USD');
  assert.equal(apple.totalEur, 1581);
  assert.equal(sell.type, 'sell');
  assert.equal(sell.quantity, 1);
  assert.equal(sell.totalEur, 898);
  assert.equal(r.assets['isin:IE00BK5BQT80'].type, 'etf');
  assert.equal(r.assets['isin:US0378331005'].currency, 'USD');
});

test('DEGIRO (English, with AutoFX column) import', () => {
  const r = importText(fixture('degiro-en.csv'));
  assert.equal(r.transactions.length, 1);
  assert.equal(r.transactions[0].totalEur, 1702);
  assert.equal(r.transactions[0].feeEur, 2);
});

test('Bitvavo import', () => {
  const r = importText(fixture('bitvavo.csv'));
  assert.equal(r.broker, 'Bitvavo');
  const types = r.transactions.map((t) => `${t.type}:${t.assetId}`);
  assert.deepEqual(types, ['buy:crypto:BTC', 'buy:crypto:ETH', 'reward:crypto:ETH', 'sell:crypto:BTC']);
  assert.equal(r.transactions[0].totalEur, 802); // 800 paid + 2 fee
  assert.equal(r.transactions[3].quantity, 0.01);
  assert.equal(r.transactions[3].totalEur, 598.5); // 600 received − 1.5 fee
  assert.ok(r.skipped.some((s) => /Canceled/i.test(s.reason)));
});

test('template import round-trip', () => {
  const r = importText(`${TEMPLATE_HEADER}\n${TEMPLATE_EXAMPLE}\n`);
  assert.equal(r.transactions.length, 3);
  assert.equal(r.assets['isin:NL0010273215'].symbol, 'ASML.AS');
});

test('importing the same file twice creates no duplicates', () => {
  const state = emptyState();
  const first = mergeImport(state, importText(fixture('degiro-nl.csv')));
  const second = mergeImport(state, importText(fixture('degiro-nl.csv')));
  assert.equal(first.added, 4);
  assert.equal(second.added, 0);
  assert.equal(second.duplicates, 4);
});

test('unknown file gives a helpful error', () => {
  assert.throws(() => importText('foo,bar\n1,2\n'), /Could not recognise/);
});

test('average-cost holdings and P/L', () => {
  const { transactions, assets } = importText(fixture('degiro-nl.csv'));
  const prices = { 'isin:NL0010273215': { priceEur: 1000, prevCloseEur: 990 } };
  const h = computeHoldings(transactions, assets, prices);
  const asml = h.find((x) => x.assetId === 'isin:NL0010273215');
  assert.equal(asml.quantity, 1);
  close(asml.costEur, 851); // 1702 / 2
  close(asml.realizedEur, 898 - 851);
  close(asml.valueEur, 1000);
  close(asml.unrealizedEur, 149);
  close(asml.dayChangeEur, 10);

  const t = totals(h);
  assert.equal(t.openCount, 3);
  assert.equal(t.unpricedCount, 2);
  close(t.valueEur, 1000);
  close(t.dayChangeEur, 10);
});

test('crypto rewards add quantity at zero cost; full sell closes position', () => {
  const tx = [
    { date: '2024-01-01T00:00:00', type: 'buy', assetId: 'crypto:ETH', quantity: 1, totalEur: 2000 },
    { date: '2024-02-01T00:00:00', type: 'reward', assetId: 'crypto:ETH', quantity: 0.1, totalEur: 0 },
    { date: '2024-03-01T00:00:00', type: 'sell', assetId: 'crypto:ETH', quantity: 1.1, totalEur: 3300 },
  ];
  const [eth] = computeHoldings(tx, {}, {});
  assert.equal(eth.closed, true);
  close(eth.realizedEur, 1300);
});

test('manual price overrides fetched price', () => {
  const tx = [{ date: '2024-01-01T00:00:00', type: 'buy', assetId: 'sym:X', quantity: 2, totalEur: 10 }];
  const [x] = computeHoldings(tx, { 'sym:X': { manualPriceEur: 7 } }, { 'sym:X': { priceEur: 99 } });
  assert.equal(x.valueEur, 14);
  assert.equal(x.priceSource, 'manual');
});

test('toEur converts with ECB-style rates', () => {
  close(toEur(108, 'USD', { rates: { USD: 1.08 } }), 100);
  assert.equal(toEur(5, 'EUR', null), 5);
  assert.equal(toEur(5, 'JPY', { rates: {} }), null);
});

test('refreshPrices with mocked APIs (Bitvavo, Finnhub, FX)', async () => {
  const state = emptyState();
  state.settings.finnhubKey = 'demo';
  state.assets = {
    'crypto:BTC': { id: 'crypto:BTC', type: 'crypto', symbol: 'BTC' },
    'isin:US0378331005': { id: 'isin:US0378331005', type: 'stock', symbol: 'AAPL', currency: 'USD' },
    'isin:NL0010273215': { id: 'isin:NL0010273215', type: 'stock', symbol: '', currency: 'EUR', name: 'ASML' },
  };
  const fakeFetch = async (url) => {
    const body =
      url.includes('frankfurter') ? { date: '2024-11-25', rates: { USD: 1.25 } } :
      url.includes('bitvavo') ? [{ market: 'BTC-EUR', last: '50000', open: '49000' }, { market: 'BTC-USDC', last: '1' }] :
      url.includes('finnhub') ? { c: 250, pc: 245 } : null;
    return { ok: !!body, status: body ? 200 : 404, json: async () => body };
  };
  const res = await refreshPrices(state, Object.keys(state.assets), fakeFetch);
  assert.equal(res.prices['crypto:BTC'].priceEur, 50000);
  close(res.prices['isin:US0378331005'].priceEur, 200);
  close(res.prices['isin:US0378331005'].prevCloseEur, 196);
  assert.ok(res.errors.some((e) => /no ticker/.test(e)));
});

test('refreshPrices with mocked Yahoo proxy handles GBp', async () => {
  const state = emptyState();
  Object.assign(state.settings, { stockProvider: 'yahoo', proxyUrl: 'https://proxy.example/' });
  state.assets = { 'sym:SHEL.L': { id: 'sym:SHEL.L', type: 'stock', symbol: 'SHEL.L' } };
  const fakeFetch = async (url) => {
    const body = url.includes('frankfurter') ? { rates: { GBP: 0.8 } }
      : url.startsWith('https://proxy.example/quote') ? { chart: { result: [{ meta: { regularMarketPrice: 2400, previousClose: 2380, currency: 'GBp' } }] } }
      : null;
    return { ok: !!body, status: body ? 200 : 404, json: async () => body };
  };
  const res = await refreshPrices(state, ['sym:SHEL.L'], fakeFetch);
  close(res.prices['sym:SHEL.L'].priceEur, 30); // 24 GBP / 0.8
  assert.deepEqual(res.errors, []);
});

test('findTicker via Finnhub marks US listings as USD', async () => {
  const { findTicker } = await import('../js/prices.js');
  const fakeFetch = async () => ({ ok: true, json: async () => ({ result: [{ symbol: 'ASML' }] }) });
  const r = await findTicker({ isin: 'NL0010273215', currency: 'EUR' }, { finnhubKey: 'x' }, fakeFetch);
  assert.deepEqual(r, { symbol: 'ASML', currency: 'USD' });
});

test('Saxo positions import', async () => {
  const { saxoToTicker } = await import('../js/importers/saxo.js');
  assert.equal(saxoToTicker('ANT:xnas'), 'ANT');
  assert.equal(saxoToTicker('ASML:xams'), 'ASML.AS');
  assert.equal(saxoToTicker('SAP:xetr'), 'SAP.DE');

  const r = importText(fixture('saxo-posities.csv'));
  assert.equal(r.broker, 'Saxo');
  assert.equal(r.transactions.length, 3); // subtotal rows skipped
  assert.ok(r.skipped.some((s) => /short/.test(s.reason)));

  const apple = r.transactions.find((t) => t.assetId === 'isin:US0378331005');
  assert.equal(apple.quantity, 10);
  assert.equal(apple.date, '2025-03-03T15:31:02');
  close(apple.totalEur, 1840 * (200.5 / 200)); // cost incl. trading costs
  assert.equal(r.assets['isin:US0378331005'].symbol, 'AAPL');
  assert.equal(r.assets['isin:US0378331005'].currency, 'USD');
  assert.equal(r.assets['isin:NL0010273215'].symbol, 'ASML.AS');
  assert.equal(r.assets['isin:IE00B4L5Y983'].type, 'etf');
  assert.equal(r.transactions.find((t) => t.assetId === 'isin:IE00B4L5Y983').date, '2024-05-01T10:00:00');

  // export prices give a value straight away
  close(r.prices['isin:US0378331005'].priceEur, 210);
  close(r.prices['isin:US0378331005'].prevCloseEur, (2100 - 24.5) / 10);
});

test('re-importing Saxo positions replaces the previous snapshot', () => {
  const state = emptyState();
  mergeImport(state, importText(fixture('saxo-posities.csv')));
  // newer export: Apple position grew to 15 shares, ASML sold
  const newer = fixture('saxo-posities.csv')
    .replace('"Apple Inc.","Long","USD","10"', '"Apple Inc.","Long","USD","15"')
    .split('\n').filter((l) => !l.startsWith('"ASML')).join('\n');
  const res = mergeImport(state, importText(newer));
  assert.equal(res.replaced, 3);
  assert.equal(res.added, 2);
  const h = computeHoldings(state.transactions, state.assets, state.prices);
  assert.equal(h.find((x) => x.assetId === 'isin:US0378331005').quantity, 15);
  assert.equal(h.find((x) => x.assetId === 'isin:NL0010273215'), undefined);
});

test('xlsx reader + EquatePlus import', async () => {
  const { readXlsx, excelDate } = await import('../js/xlsx.js');
  const { importRows } = await import('../js/importers/index.js');
  assert.equal(excelDate(44837), '2022-10-03T00:00:00');

  const rows = await readXlsx(readFileSync(new URL('./fixtures/equate-portfolio.xlsx', import.meta.url)));
  assert.equal(rows[6][0], 'Allocatiedatum'); // header on row 7
  const r = importRows(rows);
  assert.equal(r.broker, 'EquatePlus');
  assert.equal(r.transactions.length, 3); // 2 share lots + 1 outstanding RSU lot
  assert.equal(r.skipped.length, 2); // lots with nothing outstanding

  const shares = r.transactions.filter((t) => t.assetId === 'isin:NL0010273215');
  assert.equal(shares.length, 2);
  assert.equal(shares[0].date, '2022-10-03T00:00:00');
  close(shares[0].totalEur + shares[1].totalEur, 12 * 500 + 4 * 550.25);
  assert.equal(r.assets['isin:NL0010273215'].symbol, 'ASML.AS');

  const rsu = r.transactions.find((t) => t.assetId.startsWith('unvested:'));
  assert.equal(rsu.quantity, 30);
  assert.equal(rsu.totalEur, 0);
  assert.equal(r.assets[rsu.assetId].unvested, true);
  assert.equal(r.assets[rsu.assetId].symbol, 'ASML.AS'); // RSUs linked to the employer's stock

  // totals exclude unvested units
  const state = emptyState();
  mergeImport(state, r);
  const t = totals(computeHoldings(state.transactions, state.assets, state.prices));
  close(t.valueEur, 16 * 700);
  close(t.unvestedEur, 30 * 700);

  // re-import replaces, never doubles
  const again = mergeImport(state, importRows(rows));
  assert.equal(again.replaced, 3);
  assert.equal(state.transactions.length, 3);
});

test('header row is found below a title block in CSV too', () => {
  const csv = 'My export\n\n' + fixture('degiro-nl.csv');
  assert.equal(importText(csv).transactions.length, 4);
});
