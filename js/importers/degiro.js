// DEGIRO "Transactions" CSV export (Dutch or English headers).
// Typical header (NL): Datum,Tijd,Product,ISIN,Beurs,Uitvoeringsplaats,Aantal,Koers,,Lokale waarde,,
//                      Waarde,,Wisselkoers,Transactiekosten en/of kosten van derden,,Totaal,,Order-ID
// The unnamed columns hold the currency of the column before them.
import { col, parseDate, parseNum, hash } from '../csv.js';

export const id = 'degiro';
export const label = 'DEGIRO';

export function detect(headers) {
  return col(headers, 'isin') !== -1 && col(headers, 'product') !== -1 &&
    col(headers, 'aantal', 'quantity', 'number') !== -1;
}

const ETF = /\b(etf|ucits|ishares|vanguard|xtrackers|spdr|amundi|lyxor|vaneck|invesco|wisdomtree)\b/i;

export function parse(headers, rows) {
  const c = {
    date: col(headers, 'datum', 'date'),
    time: col(headers, 'tijd', 'time'),
    product: col(headers, 'product'),
    isin: col(headers, 'isin'),
    exchange: col(headers, 'beurs', 'reference exchange', 'exchange'),
    qty: col(headers, 'aantal', 'quantity', 'number'),
    price: col(headers, 'koers', 'price'),
    value: col(headers, 'waarde', 'value'),
    fee: col(headers, 'transactiekosten', 'transaction and/or third', 'transaction costs', 'transaction'),
    total: col(headers, 'totaal', 'total'),
    order: col(headers, 'order-id', 'order id'),
  };

  const transactions = [];
  const assets = {};
  const skipped = [];

  rows.forEach((r, i) => {
    const line = i + 2;
    const isin = (r[c.isin] || '').trim().toUpperCase();
    const qtySigned = parseNum(r[c.qty]);
    if (!isin || !qtySigned) return skipped.push({ line, reason: 'no ISIN or quantity' });

    const date = parseDate(r[c.date], c.time >= 0 ? r[c.time] : '');
    if (!date) return skipped.push({ line, reason: 'unreadable date' });

    const price = parseNum(r[c.price]);
    const priceCur = ((c.price >= 0 && r[c.price + 1]) || 'EUR').trim().toUpperCase();
    const feeEur = Math.abs(parseNum(r[c.fee]) ?? 0);

    // Prefer the "Totaal" column (EUR, incl. fees and FX costs); otherwise value (EUR) ± fees.
    let totalEur = null;
    const total = c.total >= 0 ? parseNum(r[c.total]) : null;
    const totalCur = c.total >= 0 ? (r[c.total + 1] || 'EUR').trim().toUpperCase() : '';
    if (total != null && totalCur === 'EUR') totalEur = Math.abs(total);
    else {
      const value = parseNum(r[c.value]);
      if (value == null) return skipped.push({ line, reason: 'no EUR value' });
      totalEur = qtySigned > 0 ? Math.abs(value) + feeEur : Math.abs(value) - feeEur;
    }

    const name = (r[c.product] || isin).trim();
    const assetId = `isin:${isin}`;
    assets[assetId] ??= {
      id: assetId, type: ETF.test(name) ? 'etf' : 'stock', symbol: '', name, isin,
      currency: priceCur, exchange: c.exchange >= 0 ? (r[c.exchange] || '').trim() : '',
    };

    transactions.push({
      id: 'dg-' + hash(r.join('|')),
      externalId: c.order >= 0 ? r[c.order] : undefined,
      date, broker: 'DEGIRO', source: 'degiro',
      type: qtySigned > 0 ? 'buy' : 'sell', assetId,
      quantity: Math.abs(qtySigned), price, currency: priceCur, totalEur, feeEur,
    });
  });

  return { transactions, assets, skipped };
}
