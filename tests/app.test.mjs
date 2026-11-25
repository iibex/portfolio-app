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
