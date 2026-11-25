// Saxo / Binck "Posities" (positions) CSV export.
//
// This export is a SNAPSHOT of what you hold right now, not a list of trades. So each position is
// stored as one opening transaction (quantity + cost), and importing a newer positions file
// REPLACES the earlier Saxo positions of the same account instead of adding to them.
//
// Header (NL): "Instrument","Long/Short","Valuta","Aantal","Hist. koers","Actuele koers",...,
//   "Huidige waarde (EUR)",...,"Hist. waarde (EUR)","Kostprijs",...,"Symbool",...,"Rekening",
//   ...,"Open tijd",...,"ISIN",...,"Soort belegging","Dagresultaat (EUR)",...
// Rows without Long/Short (e.g. "Aandelen (1)") are category subtotals and are skipped.
import { col, parseDate, parseNum, hash } from '../csv.js';

export const id = 'saxo';
export const label = 'Saxo';

export function detect(headers) {
  const has = (...a) => col(headers, ...a) !== -1;
  return has('instrument') && has('symbool', 'symbol') && has('long/short', 'l/s') &&
    has('hist. waarde (eur)', 'huidige waarde (eur)', 'market value (eur)', 'current value (eur)');
}

// Saxo symbol suffix (exchange MIC) → Yahoo/Finnhub ticker suffix.
const EXCHANGE_SUFFIX = {
  xnas: '', xnys: '', arcx: '', bats: '', xase: '', xams: '.AS', xetr: '.DE', xfra: '.F',
  xpar: '.PA', xbru: '.BR', xlis: '.LS', xdub: '.IR', xlon: '.L', xmil: '.MI', xmad: '.MC',
  xswx: '.SW', xvtx: '.SW', xcse: '.CO', xsto: '.ST', xhel: '.HE', xosl: '.OL', xwbo: '.VI',
  xtse: '.TO', xhkg: '.HK', xasx: '.AX',
};

/** "ANT:xnas" → "ANT", "ASML:xams" → "ASML.AS". Unknown exchange → just the ticker. */
export function saxoToTicker(saxoSymbol) {
  const [ticker, exchange] = String(saxoSymbol || '').trim().split(':');
  if (!ticker) return '';
  const suffix = EXCHANGE_SUFFIX[(exchange || '').toLowerCase()];
  return ticker.toUpperCase() + (suffix ?? '');
}

const ETF = /etf|tracker|etp|fonds|fund/i;

export function parse(headers, rows) {
  const c = {
    name: col(headers, 'instrument'),
    side: col(headers, 'long/short', 'l/s'),
    currency: col(headers, 'valuta', 'currency'),
    qty: col(headers, 'aantal', 'quantity', 'amount'),
    openPrice: col(headers, 'hist. koers', 'open price'),
    costPrice: col(headers, 'kostprijs', 'cost price'),
    costEur: col(headers, 'hist. waarde (eur)', 'open value (eur)'),
    valueEur: col(headers, 'huidige waarde (eur)', 'market value (eur)', 'current value (eur)'),
    dayEur: col(headers, 'dagresultaat (eur)', 'day p/l (eur)'),
    symbol: col(headers, 'symbool', 'symbol'),
    account: col(headers, 'rekening', 'account'),
    openTime: col(headers, 'open tijd', 'open time'),
    isin: col(headers, 'isin'),
    kind: col(headers, 'soort belegging', 'asset type'),
  };
  const get = (r, i) => (i >= 0 ? (r[i] || '').trim() : '');

  const transactions = [];
  const assets = {};
  const prices = {};
  const skipped = [];
  const accounts = new Set();
  const now = new Date().toISOString();

  rows.forEach((r, i) => {
    const line = i + 2;
    const side = get(r, c.side).toLowerCase();
    if (!side) return; // category subtotal row such as "Aandelen (1)"
    if (side !== 'long') return skipped.push({ line, reason: `${get(r, c.name)}: short positions not supported` });

    const quantity = Math.abs(parseNum(get(r, c.qty)) ?? 0);
    if (!quantity) return skipped.push({ line, reason: 'no quantity' });

    const name = get(r, c.name);
    const isin = get(r, c.isin).toUpperCase();
    const saxoSymbol = get(r, c.symbol);
    const currency = (get(r, c.currency) || 'EUR').toUpperCase();
    const account = get(r, c.account) || 'Saxo';
    accounts.add(account);

    // Cost in EUR. "Hist. waarde (EUR)" is quantity × open price; "Kostprijs" is the open price
    // including trading costs, so scale by that ratio to include fees.
    const histEur = parseNum(get(r, c.costEur));
    const openPrice = parseNum(get(r, c.openPrice));
    const costPrice = parseNum(get(r, c.costPrice));
    if (histEur == null) return skipped.push({ line, reason: `${name}: no cost value (EUR)` });
    const feeFactor = openPrice && costPrice && costPrice >= openPrice ? costPrice / openPrice : 1;
    const totalEur = Math.abs(histEur) * feeFactor;

    const assetId = isin ? `isin:${isin}` : `sym:${saxoToTicker(saxoSymbol) || name}`;
    assets[assetId] ??= {
      id: assetId,
      type: ETF.test(get(r, c.kind)) || ETF.test(name) ? 'etf' : 'stock',
      symbol: saxoToTicker(saxoSymbol), name, isin, currency, exchange: (saxoSymbol.split(':')[1] || '').toUpperCase(),
    };

    // The export also contains the current value: use it as a starting price until live prices load.
    const valueEur = parseNum(get(r, c.valueEur));
    const dayEur = parseNum(get(r, c.dayEur));
    if (valueEur != null) {
      prices[assetId] = {
        priceEur: valueEur / quantity,
        prevCloseEur: dayEur != null ? (valueEur - dayEur) / quantity : null,
        source: 'Saxo export', time: now,
      };
    }

    transactions.push({
      id: 'sx-' + hash(`${account}|${assetId}`),
      date: parseDate(get(r, c.openTime)) || now.slice(0, 19),
      broker: 'Saxo', account, source: 'saxo-positions', type: 'buy', assetId,
      quantity, price: costPrice ?? openPrice, currency, totalEur, feeEur: totalEur - Math.abs(histEur),
      note: 'Position from Saxo export (snapshot)',
    });
  });

  return { transactions, assets, prices, skipped, snapshot: { source: 'saxo-positions', accounts: [...accounts] } };
}
