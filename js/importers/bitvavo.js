// Bitvavo "Transaction history" CSV export.
// Bitvavo has changed its export format over the years, so columns are matched by name.
import { col, parseDate, parseNum, hash } from '../csv.js';

export const id = 'bitvavo';
export const label = 'Bitvavo';

export function detect(headers) {
  const has = (...a) => col(headers, ...a) !== -1;
  return has('currency') && has('amount') && has('type') &&
    (has('transaction id') || has('received / paid amount') || has('eur received / paid') || has('fee currency'));
}

const REWARD = /stak|reward|rebate|affiliate|airdrop|bonus|interest|earn|campaign/i;

export function parse(headers, rows) {
  const c = {
    date: col(headers, 'date', 'time'),
    time: col(headers, 'time'),
    type: col(headers, 'type'),
    currency: col(headers, 'currency'),
    amount: col(headers, 'amount'),
    price: col(headers, 'quote price', 'price (eur)', 'price'),
    paid: col(headers, 'received / paid amount', 'eur received / paid', 'received / paid'),
    paidCur: col(headers, 'received / paid currency'),
    feeCur: col(headers, 'fee currency'),
    fee: col(headers, 'fee amount', 'fee'),
    status: col(headers, 'status'),
    txid: col(headers, 'transaction id'),
  };

  const transactions = [];
  const assets = {};
  const skipped = [];

  rows.forEach((r, i) => {
    const line = i + 2;
    const status = c.status >= 0 ? r[c.status] : '';
    if (status && !/complet|success|done/i.test(status)) return skipped.push({ line, reason: `status "${status}"` });

    const currency = (r[c.currency] || '').trim().toUpperCase();
    const rawType = (r[c.type] || '').trim().toLowerCase();
    if (!currency || currency === 'EUR') return; // cash deposits/withdrawals: not a holding

    const quantity = Math.abs(parseNum(r[c.amount]) ?? 0);
    if (!quantity) return skipped.push({ line, reason: 'zero amount' });

    const paidCur = c.paidCur >= 0 ? (r[c.paidCur] || 'EUR').trim().toUpperCase() : 'EUR';
    const paid = Math.abs(parseNum(r[c.paid]) ?? 0);
    const feeCur = c.feeCur >= 0 ? (r[c.feeCur] || '').trim().toUpperCase() : 'EUR';
    const feeEur = feeCur === 'EUR' ? Math.abs(parseNum(r[c.fee]) ?? 0) : 0;

    let type;
    let totalEur = 0;
    if (rawType === 'buy') {
      if (paidCur !== 'EUR') return skipped.push({ line, reason: `paid in ${paidCur}, only EUR supported` });
      type = 'buy'; totalEur = paid + feeEur;
    } else if (rawType === 'sell') {
      if (paidCur !== 'EUR') return skipped.push({ line, reason: `paid in ${paidCur}, only EUR supported` });
      type = 'sell'; totalEur = paid - feeEur;
    } else if (REWARD.test(rawType)) {
      type = 'reward';
    } else if (rawType === 'deposit') {
      type = 'transfer_in';
    } else if (rawType === 'withdrawal') {
      type = 'transfer_out';
    } else {
      return skipped.push({ line, reason: `type "${rawType}" not supported` });
    }

    const date = parseDate(r[c.date], c.time >= 0 && c.time !== c.date ? r[c.time] : '');
    if (!date) return skipped.push({ line, reason: 'unreadable date' });

    const assetId = `crypto:${currency}`;
    assets[assetId] ??= { id: assetId, type: 'crypto', symbol: currency, name: currency, currency: 'EUR' };

    const price = parseNum(r[c.price]) ?? (type === 'buy' || type === 'sell' ? paid / quantity : null);
    transactions.push({
      id: 'bv-' + hash(r.join('|')),
      externalId: c.txid >= 0 ? r[c.txid] : undefined,
      date, broker: 'Bitvavo', source: 'bitvavo', type, assetId,
      quantity, price, currency: 'EUR', totalEur, feeEur,
    });
  });

  return { transactions, assets, skipped };
}
