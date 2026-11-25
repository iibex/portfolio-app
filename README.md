# Portfolio

A private stock and crypto portfolio tracker for your iPhone.

- Total value, today's change and profit/loss for the whole portfolio and for each holding
- Imports from **DEGIRO** and **Bitvavo** (EquatePlus and Saxo come next), plus manual entry
- Live prices: crypto from Bitvavo, stocks from Finnhub or Yahoo Finance
- **Your data stays on your phone.** There is no server, account or tracking.
- Works offline (shows the last known prices) and has a privacy button that blurs all amounts

It is a web app (PWA). You add it to your home screen from Safari and it opens full screen like a normal app. There's no App Store and no Xcode needed.

---

## 1. Put it online (one-time, ~5 min)

1. On GitHub, open this repository → **Settings** → **Pages**.
2. Under *Build and deployment*, set **Source: Deploy from a branch**, **Branch: `main`**, folder **`/ (root)`**, then **Save**.
3. After about a minute the page shows your URL, e.g. `https://<your-username>.github.io/portfolio-app/`.

The code is public if the repository is public, but your **portfolio data is never in the repository**. It only lives on your phone.

## 2. Install on your iPhone

1. Open the URL in **Safari**.
2. Tap **Share** (square with arrow) → **Add to Home Screen** → **Add**.
3. Open it from the home-screen icon.

## 3. Get stock prices

Crypto prices work right away. For stocks and ETFs choose one source in **Settings**:

| | Finnhub | Yahoo via your own proxy |
|---|---|---|
| Setup | 2 min: free key | ~10 min: free Cloudflare account |
| US stocks/ETFs | ✅ | ✅ |
| Euronext, Xetra, LSE (ASML.AS, VWRL.AS…) | ❌ mostly paid | ✅ |

**Finnhub:** sign up at finnhub.io, copy the API key and paste it in Settings.

**Yahoo proxy (recommended for European stocks):**
1. Create a free account at cloudflare.com → **Workers & Pages** → **Create** → **Create Worker** → name it e.g. `prices` → **Deploy**.
2. **Edit code**: replace everything with the contents of [`worker/price-proxy.js`](worker/price-proxy.js) → **Deploy**.
3. Copy the worker URL (`https://prices.<you>.workers.dev`) into Settings → *Yahoo proxy URL* and pick **Yahoo (proxy)**.
4. Optional: in the Worker's *Settings → Variables*, add `ALLOWED_ORIGIN` = `https://<your-username>.github.io` so only your app can use it.

Tickers use Yahoo style: `ASML.AS` (Amsterdam), `SAP.DE` (Xetra), `SHEL.L` (London), `AAPL` (US).
DEGIRO exports only contain ISIN codes. The app looks up tickers automatically once a price source is set; you can change one in the holding's detail screen.

## 4. Import your trades

**Import** tab → choose the CSV file (from Files / iCloud Drive).

- **DEGIRO**: web version → Inbox → *Transactions* → pick an early start date → Export → CSV
- **Bitvavo**: web version → Account → *Transaction history* → Export CSV
- **Any other broker**: use **Get template**, fill it in Numbers/Excel, export as CSV.

Importing the same file again is safe (duplicates are skipped).

## 5. Backups

Settings → **Backup** saves a JSON file, for example to iCloud Drive. API keys are never included. **Restore** loads it on a new phone.

---

## How it calculates

- **Invested / cost basis**: average-cost method, in EUR, including transaction fees.
- **Result**: current value − invested (unrealised). **Realised**: profit from sales.
- **Today**: change against the previous close (stocks) or the 24-hour open (crypto).
- Foreign prices are converted with daily European Central Bank rates (frankfurter.dev).
- Crypto staking rewards count as extra coins at €0 cost.

## For developers

Plain HTML/CSS/JavaScript (ES modules) with no build step and no dependencies.

```
index.html             app shell
css/app.css            styles (light + dark mode)
js/app.js              screens and interaction
js/portfolio.js        holdings and profit/loss maths (pure)
js/prices.js           price + FX fetching
js/importers/*.js      one parser per broker
worker/price-proxy.js  optional Cloudflare Worker for Yahoo prices
tests/                 unit tests + made-up sample exports
```

```bash
npm test        # run unit tests (Node 20+)
npm start       # serve on http://localhost:8000
```

When you change app files, bump `VERSION` in `sw.js` so phones load the new version.

## Roadmap

1. ✅ MVP: holdings, live prices, DEGIRO / Bitvavo / template import
2. EquatePlus and Saxo importers · value-over-time chart
3. News per holding
4. News & social media "buzz" scanning with sentiment (needs a small backend)
5. Trends, strategies and price alerts
