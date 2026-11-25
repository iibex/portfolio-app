// Cloudflare Worker: a tiny, private price proxy for Yahoo Finance.
//
// Why: Yahoo Finance has prices for practically every exchange (Euronext Amsterdam, Xetra, LSE, US...)
// for free, but browsers are not allowed to call it directly (CORS). This worker forwards ONLY the
// two Yahoo endpoints the app needs, and adds the header that lets your app read the answer.
//
// Setup (free, ~10 minutes): see "Yahoo proxy" in README.md.
//
// Optional: set an environment variable ALLOWED_ORIGIN (e.g. https://yourname.github.io) in the
// Worker settings so only your app can use it.

const SYMBOL = /^[A-Za-z0-9.\-^=]{1,20}$/;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = env?.ALLOWED_ORIGIN;
    const cors = {
      'Access-Control-Allow-Origin': allowed || '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      Vary: 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (allowed && origin && origin !== allowed) return new Response('Forbidden', { status: 403, headers: cors });

    const url = new URL(request.url);
    let target;
    if (url.pathname === '/quote') {
      const symbol = url.searchParams.get('symbol') || '';
      if (!SYMBOL.test(symbol)) return json({ error: 'bad symbol' }, 400, cors);
      target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
    } else if (url.pathname === '/search') {
      const q = (url.searchParams.get('q') || '').slice(0, 60);
      if (!q) return json({ error: 'missing q' }, 400, cors);
      target = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`;
    } else {
      return json({ ok: true, usage: ['/quote?symbol=ASML.AS', '/search?q=NL0010273215'] }, 200, cors);
    }

    const res = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0 (portfolio-app price proxy)', Accept: 'application/json' },
      cf: { cacheTtl: 30, cacheEverything: true },
    });
    return new Response(res.body, {
      status: res.status,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'max-age=30' },
    });
  },
};

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}
