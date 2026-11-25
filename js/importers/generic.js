// Generic CSV in this app's own format. Use it for any broker that has no importer yet:
// fill the template in Numbers/Excel and import it.
import { col, parseDate, parseNum, hash } from '../csv.js';

export const id = 'generic';
export const label = 'Portfolio template';

export const TEMPLATE_HEADER = 'date,type,broker,asset_type,symbol,name,isin,quantity,price,currency,total_eur,fee_eur';
export const TEMPLATE_EXAMPLE = [
  '2024-03-01,buy,Saxo,stock,ASML.AS,ASML Holding,NL0010273215,2,850.00,EUR,1702.00,2.00',
  '2024-05-10,buy,Bitvavo,crypto,BTC,Bitcoin,,0.01,58000,EUR,581.45,1.45',
  '2024-06-20,sell,Saxo,stock,ASML.AS,ASML Holding,NL0010273215,1,900.00,EUR,898.00,2.00',
].join('\n');

export function detect(headers) {
  return col(headers, 'asset_type') !== -1 && col(headers, 'total_eur') !== -1;
}

const TYPES = new Set(['buy', 'sell', 'reward', 'transfer_in', 'transfer_out']);

export function parse(headers, rows) {
  const g = (r, name) => { const i = col(headers, name); return i >= 0 ? (r[i] || '').trim() : ''; };
  const transactions = [];
  const assets = {};
  const skipped = [];

  rows.forEach((r, i) => {
    const line = i + 2;
    const type = g(r, 'type').toLowerCase();
    if (!TYPES.has(type)) return skipped.push({ line, reason: `type "${type}"` });
    const date = parseDate(g(r, 'date'));
    const quantity = Math.abs(parseNum(g(r, 'quantity')) ?? 0);
    if (!date || !quantity) return skipped.push({ line, reason: 'missing date or quantity' });

    const assetType = (g(r, 'asset_type') || 'stock').toLowerCase();
    const symbol = g(r, 'symbol').toUpperCase();
    const isin = g(r, 'isin').toUpperCase();
    const currency = (g(r, 'currency') || 'EUR').toUpperCase();
    const price = parseNum(g(r, 'price'));
    const feeEur = Math.abs(parseNum(g(r, 'fee_eur')) ?? 0);
    let totalEur = parseNum(g(r, 'total_eur'));
    if (totalEur == null) {
      if (currency !== 'EUR' || price == null) return skipped.push({ line, reason: 'total_eur missing' });
      totalEur = type === 'sell' ? quantity * price - feeEur : quantity * price + feeEur;
    }

    const assetId = assetType === 'crypto' ? `crypto:${symbol}` : isin ? `isin:${isin}` : `sym:${symbol}`;
    if (assetId.endsWith(':')) return skipped.push({ line, reason: 'symbol or isin required' });
    assets[assetId] ??= {
      id: assetId, type: assetType, symbol, name: g(r, 'name') || symbol || isin, isin,
      currency: assetType === 'crypto' ? 'EUR' : currency,
    };

    transactions.push({
      id: 'gn-' + hash(r.join('|')),
      date, broker: g(r, 'broker') || 'Other', source: 'generic', type, assetId,
      quantity, price, currency, totalEur: Math.abs(totalEur), feeEur,
    });
  });

  return { transactions, assets, skipped };
}
