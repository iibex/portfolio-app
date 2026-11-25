// Fetches live prices straight from the phone. No server of our own is needed:
//  - crypto:  Bitvavo public API (EUR prices, no key), CoinGecko as fallback
//  - stocks:  Finnhub (free key, best for US tickers) or Yahoo Finance through your own
//             tiny Cloudflare Worker (covers Euronext, Xetra, etc. — see worker/price-proxy.js)
//  - FX:      Frankfurter (European Central Bank rates, no key)

const FX_URLS = ['https://api.frankfurter.dev/v1/latest?base=EUR', 'https://api.frankfurter.app/latest?from=EUR'];

async function getJSON(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function toEur(amount, currency, fx) {
  if (amount == null) return null;
  if (!currency || currency === 'EUR') return amount;
  const rate = fx?.rates?.[currency];
  return rate ? amount / rate : null;
}

async function fetchFx(fetchImpl) {
  for (const url of FX_URLS) {
    try {
      const data = await getJSON(fetchImpl, url);
      if (data?.rates) return { rates: { ...data.rates, EUR: 1 }, date: data.date };
    } catch { /* try next */ }
  }
  throw new Error('exchange rates unavailable');
}

async function fetchCrypto(fetchImpl, symbols) {
  const out = {};
  const missing = new Set(symbols);
  try {
    const list = await getJSON(fetchImpl, 'https://api.bitvavo.com/v2/ticker/24h');
    for (const t of list) {
      const [base, quote] = String(t.market).split('-');
      if (quote === 'EUR' && missing.has(base) && t.last != null) {
        out[base] = { priceEur: Number(t.last), prevCloseEur: t.open != null ? Number(t.open) : null, source: 'Bitvavo' };
        missing.delete(base);
      }
    }
  } catch { /* fall back to CoinGecko */ }

  for (const sym of missing) {
    try {
      const search = await getJSON(fetchImpl, `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(sym)}`);
      const coin = (search.coins || []).find((c) => c.symbol?.toUpperCase() === sym);
      if (!coin) continue;
      const p = await getJSON(fetchImpl, `https://api.coingecko.com/api/v3/simple/price?ids=${coin.id}&vs_currencies=eur&include_24hr_change=true`);
      const d = p[coin.id];
      if (d?.eur != null) {
        const chg = d.eur_24h_change;
        out[sym] = { priceEur: d.eur, prevCloseEur: chg != null ? d.eur / (1 + chg / 100) : null, source: 'CoinGecko' };
      }
    } catch { /* leave unpriced */ }
  }
  return out;
}

async function fetchStockFinnhub(fetchImpl, symbol, key) {
  const q = await getJSON(fetchImpl, `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`);
  if (!q || !q.c) throw new Error('no price (Finnhub free plan covers mainly US tickers)');
  return { price: q.c, prevClose: q.pc || null, currency: null, source: 'Finnhub' };
}

async function fetchStockYahoo(fetchImpl, symbol, proxyUrl) {
  const base = proxyUrl.replace(/\/+$/, '');
  const data = await getJSON(fetchImpl, `${base}/quote?symbol=${encodeURIComponent(symbol)}`);
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta || meta.regularMarketPrice == null) throw new Error('symbol not found');
  let price = meta.regularMarketPrice;
  let prevClose = meta.previousClose ?? meta.chartPreviousClose ?? null;
  let currency = meta.currency || null;
  if (currency === 'GBp' || currency === 'GBX') { price /= 100; prevClose = prevClose != null ? prevClose / 100 : null; currency = 'GBP'; }
  return { price, prevClose, currency, source: 'Yahoo' };
}

/**
 * Look up a ticker for an ISIN (DEGIRO exports only contain ISINs).
 * Returns { symbol, currency } — currency is set when the listing's currency is known to differ
 * (e.g. Finnhub often returns the US listing, which is priced in USD).
 */
export async function findTicker(asset, settings, fetchImpl = fetch) {
  const q = asset.isin || asset.name;
  if (!q) return null;
  if (settings.stockProvider === 'yahoo' && settings.proxyUrl) {
    const data = await getJSON(fetchImpl, `${settings.proxyUrl.replace(/\/+$/, '')}/search?q=${encodeURIComponent(q)}`);
    const quotes = (data.quotes || []).filter((x) => x.symbol);
    // Prefer a European listing in the asset's own currency region when there are several.
    const eu = quotes.find((x) => /\.(AS|DE|PA|BR|MI|MC|L|SW|F)$/.test(x.symbol));
    const symbol = (asset.currency !== 'USD' && eu ? eu : quotes[0])?.symbol;
    return symbol ? { symbol, currency: null } : null; // Yahoo quotes report their own currency
  }
  if (settings.finnhubKey) {
    const data = await getJSON(fetchImpl, `https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&token=${encodeURIComponent(settings.finnhubKey)}`);
    const symbol = data?.result?.[0]?.symbol;
    if (!symbol) return null;
    // Finnhub symbols without an exchange suffix are US listings, quoted in USD.
    return { symbol, currency: symbol.includes('.') ? null : 'USD' };
  }
  return null;
}

/**
 * Refresh prices for every open asset. Returns { prices, fx, errors }.
 * Existing cached prices are kept when a fetch fails, so the app still shows the last known value.
 */
export async function refreshPrices(state, assetIds, fetchImpl = fetch) {
  const { settings } = state;
  const prices = { ...state.prices };
  const errors = [];
  let fx = state.fx;

  try { fx = await fetchFx(fetchImpl); } catch (e) { errors.push(`FX: ${e.message}`); }

  const assets = assetIds.map((id) => state.assets[id]).filter(Boolean);
  const now = new Date().toISOString();

  // Crypto: one request for everything.
  const crypto = assets.filter((a) => a.type === 'crypto');
  if (crypto.length) {
    const res = await fetchCrypto(fetchImpl, crypto.map((a) => a.symbol.toUpperCase()));
    for (const a of crypto) {
      const r = res[a.symbol.toUpperCase()];
      if (r) prices[a.id] = { ...r, time: now };
      else errors.push(`${a.symbol}: no crypto price found`);
    }
  }

  // Stocks / ETFs: one request each, a few at a time (free API rate limits).
  const stocks = assets.filter((a) => a.type !== 'crypto' && a.manualPriceEur == null);
  const useYahoo = settings.stockProvider === 'yahoo' && settings.proxyUrl;
  if (stocks.length && !useYahoo && !settings.finnhubKey) {
    errors.push('Stocks: add a Finnhub key or a Yahoo proxy URL in Settings');
  } else {
    for (let i = 0; i < stocks.length; i += 4) {
      await Promise.all(stocks.slice(i, i + 4).map(async (a) => {
        if (!a.symbol) { errors.push(`${a.name}: no ticker set`); return; }
        try {
          const r = useYahoo
            ? await fetchStockYahoo(fetchImpl, a.symbol, settings.proxyUrl)
            : await fetchStockFinnhub(fetchImpl, a.symbol, settings.finnhubKey);
          const currency = r.currency || a.currency || 'USD';
          const priceEur = toEur(r.price, currency, fx);
          if (priceEur == null) throw new Error(`no exchange rate for ${currency}`);
          prices[a.id] = {
            price: r.price, currency, priceEur,
            prevCloseEur: toEur(r.prevClose, currency, fx),
            source: r.source, time: now,
          };
        } catch (e) {
          errors.push(`${a.symbol}: ${e.message}`);
        }
      }));
    }
  }

  return { prices, fx, errors };
}
