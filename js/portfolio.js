// Pure portfolio maths (no DOM, no network) so it can be unit-tested.
// Cost basis uses the average-cost method, which is what most Dutch brokers show.

const DUST = 1e-9;

/**
 * @param transactions list of { date, type, assetId, quantity, totalEur, feeEur }
 * @param assets       map assetId -> asset metadata
 * @param prices       map assetId -> { priceEur, prevCloseEur, time }
 */
export function computeHoldings(transactions, assets = {}, prices = {}) {
  const byAsset = new Map();
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));

  for (const t of sorted) {
    let h = byAsset.get(t.assetId);
    if (!h) {
      h = { assetId: t.assetId, quantity: 0, costEur: 0, realizedEur: 0, feesEur: 0, txCount: 0, brokers: new Set(), incomplete: false };
      byAsset.set(t.assetId, h);
    }
    const q = Math.abs(t.quantity || 0);
    const total = Math.abs(t.totalEur || 0);
    const avg = h.quantity > DUST ? h.costEur / h.quantity : 0;
    h.txCount++;
    h.feesEur += t.feeEur || 0;
    if (t.broker) h.brokers.add(t.broker);

    switch (t.type) {
      case 'buy':
      case 'reward':
      case 'transfer_in':
        h.quantity += q;
        h.costEur += t.type === 'buy' ? total : 0;
        break;
      case 'sell': {
        const sold = Math.min(q, h.quantity);
        if (q - h.quantity > DUST) h.incomplete = true; // selling more than we know was bought
        h.realizedEur += total - avg * sold;
        h.costEur -= avg * sold;
        h.quantity -= sold;
        break;
      }
      case 'transfer_out': {
        const moved = Math.min(q, h.quantity);
        h.costEur -= avg * moved;
        h.quantity -= moved;
        break;
      }
      default:
        break;
    }
    if (h.quantity < DUST) { h.quantity = 0; h.costEur = 0; }
  }

  const holdings = [];
  for (const h of byAsset.values()) {
    const asset = assets[h.assetId] || { id: h.assetId, name: h.assetId };
    const p = effectivePrice(asset, prices[h.assetId]);
    const valueEur = p.priceEur != null ? h.quantity * p.priceEur : null;
    const unrealizedEur = valueEur != null ? valueEur - h.costEur : null;
    holdings.push({
      ...h,
      brokers: [...h.brokers],
      asset,
      priceEur: p.priceEur,
      priceTime: p.time,
      priceSource: p.source,
      valueEur,
      unrealizedEur,
      unrealizedPct: unrealizedEur != null && h.costEur > 0 ? unrealizedEur / h.costEur : null,
      dayChangeEur: p.priceEur != null && p.prevCloseEur != null ? h.quantity * (p.priceEur - p.prevCloseEur) : null,
      dayChangePct: p.priceEur != null && p.prevCloseEur ? p.priceEur / p.prevCloseEur - 1 : null,
      closed: h.quantity === 0,
    });
  }
  holdings.sort((a, b) => (b.valueEur ?? -1) - (a.valueEur ?? -1) || b.costEur - a.costEur);
  return holdings;
}

/** A manual price (set by the user) wins over a fetched price. */
function effectivePrice(asset, cached) {
  if (asset.manualPriceEur != null && asset.manualPriceEur !== '') {
    return { priceEur: Number(asset.manualPriceEur), prevCloseEur: null, time: asset.manualPriceTime, source: 'manual' };
  }
  if (cached && cached.priceEur != null) return { ...cached, source: cached.source || 'live' };
  return { priceEur: null, prevCloseEur: null };
}

export function totals(holdings) {
  const open = holdings.filter((h) => !h.closed && !h.asset?.unvested);
  const sum = (arr, k) => arr.reduce((s, h) => s + (h[k] ?? 0), 0);
  const valueEur = sum(open, 'valueEur');
  const costEur = sum(open, 'costEur');
  const priced = open.filter((h) => h.valueEur != null);
  const pricedCost = sum(priced, 'costEur');
  const unrealizedEur = sum(priced, 'unrealizedEur');
  const withDay = open.filter((h) => h.dayChangeEur != null);
  const dayChangeEur = withDay.length ? sum(withDay, 'dayChangeEur') : null;
  const dayBase = sum(withDay, 'valueEur') - (dayChangeEur ?? 0);
  return {
    valueEur,
    costEur,
    unrealizedEur,
    unrealizedPct: pricedCost > 0 ? unrealizedEur / pricedCost : null,
    realizedEur: sum(holdings, 'realizedEur'),
    unvestedEur: sum(holdings.filter((h) => !h.closed && h.asset?.unvested), 'valueEur'),
    dayChangeEur,
    dayChangePct: dayChangeEur != null && dayBase > 0 ? dayChangeEur / dayBase : null,
    openCount: open.length,
    unpricedCount: open.length - priced.length,
  };
}
