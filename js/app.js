import * as store from './store.js';
import { computeHoldings, totals } from './portfolio.js';
import { refreshPrices, findTicker } from './prices.js';
import { importFile, mergeImport, planned } from './importers/index.js';
import { TEMPLATE_HEADER, TEMPLATE_EXAMPLE } from './importers/generic.js';
import { fmtEur, fmtEurBig, fmtSignedEur, fmtPct, fmtQty, fmtPrice, fmtDate, timeAgo, tone, esc } from './format.js';

let state = store.load();
let currentView = 'portfolio';
let refreshing = false;
let lastErrors = [];

const $ = (sel, root = document) => root.querySelector(sel);
const sheet = $('#sheet');
const persist = () => store.save(state);

// ---------------------------------------------------------------- helpers
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), ms);
}

function openSheet(title, bodyHtml, onReady) {
  sheet.innerHTML = `
    <div class="sheet-head"><h2>${esc(title)}</h2><button type="button" data-close>Done</button></div>
    <div class="sheet-body">${bodyHtml}</div>`;
  $('[data-close]', sheet).onclick = () => sheet.close();
  sheet.showModal();
  onReady?.(sheet);
}
sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); }); // tap backdrop

function initials(asset) {
  const s = (asset.symbol || asset.name || '?').replace(/\..*$/, '');
  return esc(s.slice(0, 4).toUpperCase());
}

function download(filename, text, type = 'text/plain') {
  const file = new File([text], filename, { type });
  if (navigator.canShare?.({ files: [file] })) {
    navigator.share({ files: [file] }).catch(() => {});
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

const holdingsNow = () => computeHoldings(state.transactions, state.assets, state.prices);

// ---------------------------------------------------------------- navigation
function show(view) {
  currentView = view;
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${view}`; });
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('#title').textContent = { portfolio: 'Portfolio', transactions: 'Trades', import: 'Import', settings: 'Settings' }[view];
  render();
  window.scrollTo(0, 0);
}
document.querySelectorAll('.tabbar button').forEach((b) => (b.onclick = () => show(b.dataset.view)));

function render() {
  document.body.classList.toggle('privacy', !!state.settings.hideValues);
  ({ portfolio: renderPortfolio, transactions: renderTransactions, import: renderImport, settings: renderSettings })[currentView]();
}

// ---------------------------------------------------------------- portfolio view
function renderPortfolio() {
  const el = $('#view-portfolio');
  const holdings = holdingsNow();
  const open = holdings.filter((h) => !h.closed && !h.asset.unvested);
  const unvested = holdings.filter((h) => !h.closed && h.asset.unvested);
  const closed = holdings.filter((h) => h.closed);

  const cash = state.cash || [];
  const cashEur = cash.reduce((s, c) => s + (Number(c.amountEur) || 0), 0);

  if (!holdings.length && !cash.length) {
    el.innerHTML = `
      <div class="empty">
        <div class="glyph">📈</div>
        <h2>No holdings yet</h2>
        <p>Import an export from your broker, or add a purchase by hand.</p>
        <div class="btn-row">
          <button class="btn" data-go="import">Import file</button>
          <button class="btn secondary" data-add>Add manually</button>
        </div>
        <div class="btn-row"><button class="btn secondary" data-cash>Add cash to invest</button></div>
      </div>`;
    $('[data-go]', el).onclick = () => show('import');
    $('[data-add]', el).onclick = () => openTransactionForm();
    $('[data-cash]', el).onclick = () => openCashForm();
    return;
  }

  const t = totals(holdings);

  // allocation by type
  const byType = { stock: 0, etf: 0, crypto: 0, cash: cashEur };
  open.forEach((h) => { byType[h.asset.type in byType ? h.asset.type : 'stock'] += h.valueEur ?? 0; });
  const typeLabels = { stock: 'Stocks', etf: 'ETFs', crypto: 'Crypto', cash: 'Cash' };
  const allocTotal = Object.values(byType).reduce((a, b) => a + b, 0);
  const alloc = allocTotal > 0
    ? `<div class="alloc">
        <div class="alloc-bar">${Object.entries(byType).filter(([, v]) => v > 0)
          .map(([k, v]) => `<span style="width:${(v / allocTotal) * 100}%;background:var(--${k})"></span>`).join('')}</div>
        <div class="alloc-legend">${Object.entries(byType).filter(([, v]) => v > 0)
          .map(([k, v]) => `<span><i style="background:var(--${k})"></i>${typeLabels[k]} ${Math.round((v / allocTotal) * 100)}%</span>`).join('')}</div>
      </div>`
    : '';

  const notice = lastErrors.length
    ? `<div class="notice"><strong>Some prices could not be loaded</strong><ul>${lastErrors.slice(0, 5).map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`
    : '';

  el.innerHTML = `
    <div class="hero">
      <div class="label">Total value</div>
      <div class="big money">${fmtEurBig(t.valueEur)}</div>
      <div class="chips">
        <span class="chip ${tone(t.dayChangeEur)}"><small>Today</small><span class="money">${fmtSignedEur(t.dayChangeEur)}</span> ${fmtPct(t.dayChangePct)}</span>
        <span class="chip ${tone(t.unrealizedEur)}"><small>Total</small><span class="money">${fmtSignedEur(t.unrealizedEur)}</span> ${fmtPct(t.unrealizedPct)}</span>
      </div>
      <div class="meta">
        Invested <span class="money">${fmtEur(t.costEur)}</span>
        ${Math.abs(t.realizedEur) > 0.005 ? ` · Realised <span class="money ${tone(t.realizedEur)}">${fmtSignedEur(t.realizedEur)}</span>` : ''}
        ${cash.length ? `<br>Cash to invest <span class="money">${fmtEur(cashEur)}</span> · Total incl. cash <strong class="money">${fmtEur(t.valueEur + cashEur)}</strong>` : ''}
        <br>Prices updated ${timeAgo(state.lastRefresh)}
        ${t.unpricedCount ? ` · <span class="warn">${t.unpricedCount} without price</span>` : ''}
      </div>
    </div>
    ${notice}
    ${alloc}
    <ul class="list">${open.map(holdingRow).join('')}</ul>
    <div class="section-title">Cash to invest${cash.length ? ` · <span class="money">${fmtEur(cashEur)}</span>` : ''}</div>
    <ul class="list">
      ${cash.map((c) => `<li><button class="row" data-cash="${esc(c.id)}">
        <span class="avatar cash">€</span>
        <span class="grow"><div class="name">${esc(c.name)}</div><div class="sub">Updated ${fmtDate(c.updated)}</div></span>
        <span class="right"><div class="v money">${fmtEur(Number(c.amountEur) || 0)}</div></span>
      </button></li>`).join('')}
      <li><button class="row add-row" data-cash-add>+ Add cash account</button></li>
    </ul>
    ${unvested.length ? `<div class="section-title">Unvested · not in total · <span class="money">${fmtEur(t.unvestedEur)}</span></div><ul class="list">${unvested.map(holdingRow).join('')}</ul>` : ''}
    ${closed.length ? `<details class="closed"><summary>Closed positions (${closed.length})</summary><ul class="list">${closed.map(holdingRow).join('')}</ul></details>` : ''}
  `;
  el.querySelectorAll('[data-asset]').forEach((b) => (b.onclick = () => openHolding(b.dataset.asset)));
  el.querySelectorAll('[data-cash]').forEach((b) => (b.onclick = () => openCashForm(b.dataset.cash)));
  $('[data-cash-add]', el).onclick = () => openCashForm();
}

/** Add or edit a cash account (bank or broker money available to invest). */
function openCashForm(id) {
  const existing = (state.cash || []).find((c) => c.id === id);
  openSheet(existing ? existing.name : 'Add cash', `
    <form id="cash-form">
      <label class="field"><span>Name</span><input name="name" required value="${esc(existing?.name || '')}" placeholder="e.g. ING savings, Saxo cash"></label>
      <label class="field"><span>Amount (EUR)</span><input name="amount" inputmode="decimal" required value="${existing ? String(existing.amountEur).replace('.', ',') : ''}" placeholder="0,00"></label>
      <p class="hint">Money available to invest. Update it whenever your balance changes.</p>
      <button class="btn block">${existing ? 'Save' : 'Add'}</button>
      ${existing ? '<div class="btn-row"><button type="button" class="btn danger" data-del>Delete</button></div>' : ''}
    </form>
  `, (root) => {
    const form = $('#cash-form', root);
    form.onsubmit = (e) => {
      e.preventDefault();
      const name = form.elements.name.value.trim();
      const raw = form.elements.amount.value.trim().replace(/[€\s]/g, '');
      // accept 1.234,56 / 1234,56 / 1234.56
      const dutchThousands = /^-?\d{1,3}(\.\d{3})+$/.test(raw); // "1.234" = 1234
      const amount = Number(raw.includes(',') || dutchThousands ? raw.replace(/\./g, '').replace(',', '.') : raw);
      if (!name || !Number.isFinite(amount)) return toast('Enter a name and an amount');
      state.cash ??= [];
      const entry = { id: existing?.id || 'cash-' + Date.now().toString(36), name, amountEur: amount, updated: new Date().toISOString() };
      state.cash = existing ? state.cash.map((c) => (c.id === existing.id ? entry : c)) : [...state.cash, entry];
      persist();
      sheet.close();
      render();
      toast('Saved');
    };
    const del = $('[data-del]', root);
    if (del) del.onclick = () => {
      if (!confirm(`Delete ${existing.name}?`)) return;
      state.cash = state.cash.filter((c) => c.id !== existing.id);
      persist();
      sheet.close();
      render();
    };
  });
}

function holdingRow(h) {
  const a = h.asset;
  const subtitle = h.closed
    ? `Closed · realised ${fmtSignedEur(h.realizedEur)}`
    : `${fmtQty(h.quantity)} · ${h.priceEur != null ? fmtPrice(h.priceEur) : '<span class="warn">no price</span>'}`;
  return `<li><button class="row" data-asset="${esc(h.assetId)}">
    <span class="avatar ${esc(a.type || 'stock')}">${initials(a)}</span>
    <span class="grow"><div class="name">${esc(a.name || a.symbol)}</div><div class="sub money">${subtitle}</div></span>
    <span class="right">
      <div class="v money">${h.closed ? fmtSignedEur(h.realizedEur) : fmtEur(h.valueEur)}</div>
      <div class="sub ${a.unvested ? 'flat' : tone(h.closed ? h.realizedEur : h.unrealizedEur)}">${h.closed ? '' : a.unvested ? 'vesting' : fmtPct(h.unrealizedPct)}</div>
    </span>
  </button></li>`;
}

function openHolding(assetId) {
  const h = holdingsNow().find((x) => x.assetId === assetId);
  if (!h) return;
  const a = state.assets[assetId] || h.asset;
  const txs = state.transactions.filter((t) => t.assetId === assetId).sort((x, y) => y.date.localeCompare(x.date));
  const isCrypto = a.type === 'crypto';

  openSheet(a.name || a.symbol, `
    <dl class="stats">
      <div><dt>Value</dt><dd class="money">${fmtEur(h.valueEur)}</dd></div>
      <div><dt>Price</dt><dd>${fmtPrice(h.priceEur)}${h.priceSource === 'manual' ? ' <span class="badge">manual</span>' : /export/.test(h.priceSource || '') ? ' <span class="badge">from export</span>' : ''}</dd></div>
      <div><dt>Quantity</dt><dd class="money">${fmtQty(h.quantity)}</dd></div>
      <div><dt>Avg. cost</dt><dd>${h.quantity ? fmtPrice(h.costEur / h.quantity) : '–'}</dd></div>
      <div><dt>Invested</dt><dd class="money">${fmtEur(h.costEur)}</dd></div>
      <div><dt>Result</dt><dd class="${tone(h.unrealizedEur)}"><span class="money">${fmtSignedEur(h.unrealizedEur)}</span> ${fmtPct(h.unrealizedPct)}</dd></div>
      <div><dt>Today</dt><dd class="${tone(h.dayChangeEur)}"><span class="money">${fmtSignedEur(h.dayChangeEur)}</span> ${fmtPct(h.dayChangePct)}</dd></div>
      <div><dt>Realised</dt><dd class="money ${tone(h.realizedEur)}">${fmtSignedEur(h.realizedEur)}</dd></div>
    </dl>
    ${h.incomplete ? '<div class="notice">More was sold than bought in the imported history. An older export may be missing.</div>' : ''}

    <div class="section-title">Details</div>
    <form class="card" id="asset-form">
      <label class="field"><span>Name</span><input name="name" value="${esc(a.name)}"></label>
      <div class="grid2">
        <label class="field"><span>${isCrypto ? 'Coin symbol' : 'Ticker'}</span><input name="symbol" value="${esc(a.symbol)}" autocapitalize="characters" placeholder="${isCrypto ? 'BTC' : 'ASML.AS or AAPL'}"></label>
        <label class="field"><span>Type</span><select name="type">
          ${['stock', 'etf', 'crypto'].map((x) => `<option value="${x}" ${a.type === x ? 'selected' : ''}>${x === 'etf' ? 'ETF' : x[0].toUpperCase() + x.slice(1)}</option>`).join('')}
        </select></label>
      </div>
      ${a.isin ? `<p class="hint">ISIN ${esc(a.isin)}${a.exchange ? ` · exchange ${esc(a.exchange)}` : ''} · quoted in ${esc(a.currency || '?')}</p>` : ''}
      ${!isCrypto ? `<div class="grid2">
        <label class="field"><span>Price currency</span><input name="currency" value="${esc(a.currency || 'EUR')}" autocapitalize="characters" maxlength="3"></label>
        <label class="field"><span>Manual price (EUR)</span><input name="manualPriceEur" inputmode="decimal" value="${a.manualPriceEur ?? ''}" placeholder="auto"></label>
      </div>` : ''}
      <div class="btn-row">
        ${!isCrypto && (a.isin || a.lookup) ? '<button type="button" class="btn secondary" data-find>Find ticker</button>' : ''}
        <button class="btn">Save</button>
      </div>
    </form>

    <div class="section-title">Transactions (${txs.length})</div>
    <ul class="list">${txs.map(txRow).join('')}</ul>
  `, (root) => {
    const form = $('#asset-form', root);
    form.onsubmit = (e) => {
      e.preventDefault();
      const f = new FormData(form);
      const cur = state.assets[assetId] || { id: assetId };
      cur.name = f.get('name').trim();
      cur.symbol = f.get('symbol').trim().toUpperCase();
      cur.type = f.get('type');
      if (f.has('currency')) cur.currency = f.get('currency').trim().toUpperCase() || 'EUR';
      const mp = f.get('manualPriceEur');
      cur.manualPriceEur = mp != null && String(mp).trim() !== '' ? Number(String(mp).replace(',', '.')) : null;
      cur.manualPriceTime = cur.manualPriceEur != null ? new Date().toISOString() : null;
      state.assets[assetId] = cur;
      delete state.prices[assetId];
      persist();
      sheet.close();
      render();
      toast('Saved');
      doRefresh();
    };
    const find = $('[data-find]', root);
    if (find) find.onclick = async () => {
      find.textContent = 'Searching…';
      try {
        const found = await findTicker(a, state.settings);
        if (found) {
          form.elements.symbol.value = found.symbol;
          if (found.currency && form.elements.currency) form.elements.currency.value = found.currency;
          toast(`Found ${found.symbol}. Tap Save to keep it.`);
        }
        else toast('No ticker found. Check Settings → price source.');
      } catch (err) { toast(`Lookup failed: ${err.message}`); }
      find.textContent = 'Find ticker';
    };
    root.querySelectorAll('[data-tx]').forEach((b) => (b.onclick = () => openTxDetail(b.dataset.tx)));
  });
}

// ---------------------------------------------------------------- transactions view
const TYPE_LABEL = { buy: 'Buy', sell: 'Sell', reward: 'Reward', transfer_in: 'Transfer in', transfer_out: 'Transfer out' };

function txRow(t) {
  const a = state.assets[t.assetId] || { name: t.assetId };
  const sign = t.type === 'buy' ? '−' : t.type === 'sell' ? '+' : '';
  return `<li><button class="row" data-tx="${esc(t.id)}">
    <span class="grow">
      <div class="name">${TYPE_LABEL[t.type] || t.type} · ${esc(a.symbol || a.name)}</div>
      <div class="sub">${fmtDate(t.date)} · ${esc(t.broker || '')} · <span class="money">${fmtQty(t.quantity)}</span></div>
    </span>
    <span class="right"><div class="v money ${t.type === 'sell' ? 'up' : ''}">${t.totalEur ? sign + fmtEur(t.totalEur) : '–'}</div></span>
  </button></li>`;
}

function renderTransactions() {
  const el = $('#view-transactions');
  const txs = [...state.transactions].sort((a, b) => b.date.localeCompare(a.date));
  el.innerHTML = `
    <div class="btn-row" style="margin:4px 0 14px"><button class="btn" data-add>+ Add transaction</button></div>
    ${txs.length ? `<ul class="list">${txs.map(txRow).join('')}</ul>` : '<p class="empty">No transactions yet.</p>'}`;
  $('[data-add]', el).onclick = () => openTransactionForm();
  el.querySelectorAll('[data-tx]').forEach((b) => (b.onclick = () => openTxDetail(b.dataset.tx)));
}

function openTxDetail(id) {
  const t = state.transactions.find((x) => x.id === id);
  if (!t) return;
  const a = state.assets[t.assetId] || {};
  openSheet(`${TYPE_LABEL[t.type] || t.type} ${a.symbol || a.name || ''}`, `
    <dl class="stats">
      <div><dt>Date</dt><dd>${fmtDate(t.date)}</dd></div>
      <div><dt>Broker</dt><dd>${esc(t.broker || '–')}</dd></div>
      <div><dt>Quantity</dt><dd>${fmtQty(t.quantity)}</dd></div>
      <div><dt>Price</dt><dd>${t.price != null ? `${t.price} ${esc(t.currency || '')}` : '–'}</dd></div>
      <div><dt>Total (EUR)</dt><dd>${fmtEur(t.totalEur)}</dd></div>
      <div><dt>Fees (EUR)</dt><dd>${fmtEur(t.feeEur || 0)}</dd></div>
    </dl>
    <p class="hint">Source: ${esc(t.source || 'manual')}${t.note ? ` · ${esc(t.note)}` : ''}</p>
    <button class="btn danger block" data-del>Delete transaction</button>
  `, (root) => {
    $('[data-del]', root).onclick = () => {
      if (!confirm('Delete this transaction?')) return;
      state.transactions = state.transactions.filter((x) => x.id !== id);
      persist();
      sheet.close();
      render();
      toast('Deleted');
    };
  });
}

function openTransactionForm() {
  const today = new Date().toISOString().slice(0, 10);
  const known = Object.values(state.assets);
  openSheet('Add transaction', `
    <form id="tx-form">
      <div class="seg">
        <label><input type="radio" name="type" value="buy" checked>Buy</label>
        <label><input type="radio" name="type" value="sell">Sell</label>
        <label><input type="radio" name="type" value="reward">Reward</label>
      </div>
      <div class="seg">
        <label><input type="radio" name="assetType" value="stock" checked>Stock</label>
        <label><input type="radio" name="assetType" value="etf">ETF</label>
        <label><input type="radio" name="assetType" value="crypto">Crypto</label>
      </div>
      <div class="grid2">
        <label class="field"><span>Ticker / coin</span><input name="symbol" list="known-assets" required autocapitalize="characters" placeholder="AAPL, ASML.AS, BTC"></label>
        <label class="field"><span>Date</span><input name="date" type="date" value="${today}" required></label>
      </div>
      <datalist id="known-assets">${known.filter((a) => a.symbol).map((a) => `<option value="${esc(a.symbol)}">${esc(a.name)}</option>`).join('')}</datalist>
      <label class="field"><span>Name (optional)</span><input name="name" placeholder="e.g. ASML Holding"></label>
      <div class="grid2">
        <label class="field"><span>Quantity</span><input name="quantity" inputmode="decimal" required></label>
        <label class="field"><span>Price per unit</span><input name="price" inputmode="decimal"></label>
      </div>
      <div class="grid2">
        <label class="field"><span>Currency</span><select name="currency">${['EUR', 'USD', 'GBP', 'CHF', 'DKK', 'SEK', 'NOK'].map((c) => `<option>${c}</option>`).join('')}</select></label>
        <label class="field"><span>Broker</span><input name="broker" list="brokers" placeholder="Saxo"></label>
      </div>
      <datalist id="brokers"><option>Bitvavo</option><option>DEGIRO</option><option>EquatePlus</option><option>Saxo</option></datalist>
      <div class="grid2">
        <label class="field"><span>Fees (EUR)</span><input name="fee" inputmode="decimal" placeholder="0"></label>
        <label class="field"><span>Total in EUR</span><input name="total" inputmode="decimal" placeholder="auto"></label>
      </div>
      <p class="hint">Total = what you paid incl. fees (buy) or received after fees (sell). Required when the price is not in EUR.</p>
      <button class="btn block">Add</button>
    </form>
  `, (root) => {
    const form = $('#tx-form', root);
    const num = (v) => { const n = Number(String(v || '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
    form.elements.symbol.addEventListener('change', () => {
      const match = known.find((a) => a.symbol === form.elements.symbol.value.trim().toUpperCase());
      if (match) {
        form.elements.name.value = match.name || '';
        form.querySelector(`input[name=assetType][value=${match.type}]`)?.click();
        if (match.currency) form.elements.currency.value = match.currency;
      }
    });
    form.onsubmit = (e) => {
      e.preventDefault();
      const f = new FormData(form);
      const type = f.get('type');
      const assetType = f.get('assetType');
      const symbol = f.get('symbol').trim().toUpperCase();
      const quantity = num(f.get('quantity'));
      const price = num(f.get('price'));
      const currency = assetType === 'crypto' ? 'EUR' : f.get('currency');
      const fee = num(f.get('fee')) ?? 0;
      let total = num(f.get('total'));
      if (!quantity) return toast('Enter a quantity');
      if (total == null) {
        if (type === 'reward') total = 0;
        else if (currency === 'EUR' && price != null) total = type === 'sell' ? quantity * price - fee : quantity * price + fee;
        else return toast('Enter the total in EUR');
      }
      const existing = known.find((a) => a.symbol === symbol && (a.type === 'crypto') === (assetType === 'crypto'));
      const assetId = existing?.id || (assetType === 'crypto' ? `crypto:${symbol}` : `sym:${symbol}`);
      if (!state.assets[assetId]) {
        state.assets[assetId] = { id: assetId, type: assetType, symbol, name: f.get('name').trim() || symbol, currency };
      }
      state.transactions.push({
        id: 'mn-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        date: `${f.get('date')}T12:00:00`, broker: f.get('broker').trim() || 'Manual', source: 'manual',
        type, assetId, quantity, price, currency, totalEur: Math.abs(total), feeEur: fee,
      });
      persist();
      sheet.close();
      render();
      toast('Transaction added');
      doRefresh();
    };
  });
}

// ---------------------------------------------------------------- import view
const BROKER_HELP = [
  { name: 'DEGIRO', steps: ['Open DEGIRO in a browser (the web version)', 'Inbox → Transactions', 'Choose a start date far in the past', 'Export → CSV'] },
  { name: 'Bitvavo', steps: ['Open Bitvavo in a browser', 'Account → Transaction history', 'Export → CSV (all time)'] },
  { name: 'EquatePlus', steps: ['Log in at equateplus.com → Portfolio', 'Download / export the portfolio details (Excel)', 'Import the .xlsx here. Unvested RSUs are shown separately and not counted in your total'] },
  { name: 'Saxo', steps: ['Open Saxo (web or app) → Portfolio → Posities', 'Export the positions list as CSV', 'Import it here. Re-import a newer file any time: your Saxo positions are replaced, not added twice'] },
];

function renderImport() {
  const el = $('#view-import');
  el.innerHTML = `
    <div class="card">
      <h3>Import a broker export</h3>
      <p>The file is read on this phone only. Importing the same file twice is safe: duplicates are skipped.</p>
      <label class="field" style="margin-top:12px"><span>Broker</span>
        <select id="imp-broker">
          <option value="">Detect automatically</option>
          <option value="degiro">DEGIRO</option>
          <option value="bitvavo">Bitvavo</option>
          <option value="saxo">Saxo (positions)</option>
          <option value="equate">EquatePlus</option>
          <option value="generic">Portfolio template</option>
        </select>
      </label>
      <label class="btn block" for="imp-file">Choose file (CSV or Excel)</label>
      <input type="file" id="imp-file" accept=".csv,.xlsx,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden>
      <div id="imp-result"></div>
    </div>

    <div class="section-title">How to export</div>
    ${BROKER_HELP.map((b) => `<div class="card"><h3>${b.name}</h3><ol>${b.steps.map((s) => `<li>${s}</li>`).join('')}</ol></div>`).join('')}
    ${planned.map((p) => `<div class="card"><h3>${p}<span class="badge">coming next</span></h3><p>Until then, use the template below, or add trades by hand.</p></div>`).join('')}
    <div class="card">
      <h3>Portfolio template</h3>
      <p>A simple CSV for any broker. Fill it in Numbers or Excel, export it as CSV and import it here.</p>
      <div class="btn-row"><button class="btn secondary" data-template>Get template</button></div>
    </div>`;

  $('[data-template]', el).onclick = () => download('portfolio-template.csv', `${TEMPLATE_HEADER}\n${TEMPLATE_EXAMPLE}\n`, 'text/csv');
  $('#imp-file', el).onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const out = $('#imp-result', el);
    try {
      const result = await importFile(file, $('#imp-broker', el).value || undefined);
      const { added, duplicates, replaced } = mergeImport(state, result);
      persist();
      out.innerHTML = `
        <div class="notice" style="margin:14px 0 0;background:var(--up-bg)">
          <strong>${esc(result.broker)}: ${result.snapshot
            ? `${added} position${added === 1 ? '' : 's'} imported`
            : `${added} transaction${added === 1 ? '' : 's'} imported`}</strong>
          ${replaced ? '<br>Replaced your previous Saxo positions with this newer export' : ''}
          ${duplicates ? `<br>${duplicates} already imported earlier (skipped)` : ''}
          ${result.skipped.length ? `<details><summary>${result.skipped.length} row(s) ignored</summary><ul>${result.skipped.slice(0, 50).map((s) => `<li>Line ${s.line}: ${esc(s.reason)}</li>`).join('')}</ul></details>` : ''}
        </div>`;
      e.target.value = '';
      await autoFindTickers();
      doRefresh();
    } catch (err) {
      out.innerHTML = `<div class="notice" style="margin:14px 0 0;background:var(--down-bg)">${esc(err.message)}</div>`;
    }
  };
}

/** DEGIRO only gives ISINs: try to find tickers automatically when a price source is set up. */
async function autoFindTickers() {
  const s = state.settings;
  if (!(s.finnhubKey || (s.stockProvider === 'yahoo' && s.proxyUrl))) return;
  const todo = Object.values(state.assets).filter((a) => a.type !== 'crypto' && !a.symbol && (a.isin || a.lookup));
  for (const a of todo) {
    try {
      const found = await findTicker(a, s);
      if (found) { a.symbol = found.symbol; if (found.currency) a.currency = found.currency; }
    } catch { /* user can set it by hand */ }
  }
  if (todo.length) persist();
}

// ---------------------------------------------------------------- settings view
function renderSettings() {
  const el = $('#view-settings');
  const s = state.settings;
  el.innerHTML = `
    <div class="section-title">Stock prices</div>
    <form class="card" id="set-form">
      <div class="seg">
        <label><input type="radio" name="stockProvider" value="finnhub" ${s.stockProvider !== 'yahoo' ? 'checked' : ''}>Finnhub</label>
        <label><input type="radio" name="stockProvider" value="yahoo" ${s.stockProvider === 'yahoo' ? 'checked' : ''}>Yahoo (proxy)</label>
      </div>
      <label class="field"><span>Finnhub API key</span><input name="finnhubKey" value="${esc(s.finnhubKey)}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="free at finnhub.io"></label>
      <p class="hint">Free and quick to set up. Covers US-listed stocks and ETFs well; European listings often need a paid plan.</p>
      <label class="field"><span>Yahoo proxy URL</span><input name="proxyUrl" value="${esc(s.proxyUrl)}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://prices.yourname.workers.dev"></label>
      <p class="hint">Your own free Cloudflare Worker (see the README). Covers Euronext, Xetra, LSE and US.</p>
      <label class="field"><span>Auto-refresh while open</span>
        <select name="refreshSeconds">${[[0, 'Off'], [30, 'Every 30 s'], [60, 'Every minute'], [300, 'Every 5 minutes']].map(([v, l]) => `<option value="${v}" ${Number(s.refreshSeconds) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </label>
      <p class="hint">Crypto prices come from Bitvavo and need no setup.</p>
      <button class="btn block">Save</button>
    </form>

    <div class="section-title">Your data</div>
    <div class="card">
      <p>Everything is stored on this device only: ${state.transactions.length} transactions, ${Object.keys(state.assets).length} assets, ${(state.cash || []).length} cash accounts. Make a backup now and then (it never includes your API keys).</p>
      <div class="btn-row">
        <button class="btn secondary" data-backup>Backup</button>
        <label class="btn secondary" for="restore-file">Restore</label>
        <input type="file" id="restore-file" accept=".json,application/json" hidden>
      </div>
      <div class="btn-row"><button class="btn danger" data-wipe>Delete all data</button></div>
    </div>
    <p class="hint" style="text-align:center;margin-top:18px">Portfolio · v0.4.1</p>`;

  $('#set-form', el).onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    Object.assign(state.settings, {
      stockProvider: f.get('stockProvider'),
      finnhubKey: f.get('finnhubKey').trim(),
      proxyUrl: f.get('proxyUrl').trim(),
      refreshSeconds: Number(f.get('refreshSeconds')),
    });
    persist();
    startAutoRefresh();
    toast('Settings saved');
    autoFindTickers().then(doRefresh);
  };
  $('[data-backup]', el).onclick = () => download(`portfolio-backup-${new Date().toISOString().slice(0, 10)}.json`, store.exportBackup(state), 'application/json');
  $('#restore-file', el).onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const next = store.importBackup(state, await file.text());
      if (!confirm(`Replace current data with this backup (${next.transactions.length} transactions)?`)) return;
      state = next;
      persist();
      render();
      toast('Backup restored');
      doRefresh();
    } catch (err) { toast(`Restore failed: ${err.message}`); }
    e.target.value = '';
  };
  $('[data-wipe]', el).onclick = () => {
    if (!confirm('Delete ALL transactions and settings from this device?')) return;
    state = store.emptyState();
    persist();
    render();
    toast('All data deleted');
  };
}

// ---------------------------------------------------------------- refreshing
async function doRefresh({ quiet = true } = {}) {
  if (refreshing) return;
  const ids = holdingsNow().filter((h) => !h.closed).map((h) => h.assetId);
  if (!ids.length) return;
  refreshing = true;
  $('#btn-refresh').classList.add('spinning');
  try {
    const res = await refreshPrices(state, ids);
    state.prices = res.prices;
    state.fx = res.fx;
    state.lastRefresh = new Date().toISOString();
    lastErrors = res.errors;
    persist();
    if (!quiet) toast(res.errors.length ? `Updated, ${res.errors.length} issue(s)` : 'Prices updated');
  } catch (err) {
    toast(`Refresh failed: ${err.message}`);
  } finally {
    refreshing = false;
    $('#btn-refresh').classList.remove('spinning');
    if (currentView === 'portfolio') render();
  }
}

let timer;
function startAutoRefresh() {
  clearInterval(timer);
  const sec = Number(state.settings.refreshSeconds);
  if (sec > 0) timer = setInterval(() => { if (document.visibilityState === 'visible') doRefresh(); }, sec * 1000);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const age = state.lastRefresh ? Date.now() - new Date(state.lastRefresh).getTime() : Infinity;
  if (age > 30_000) doRefresh();
});

$('#btn-refresh').onclick = () => doRefresh({ quiet: false });
$('#btn-privacy').onclick = () => {
  state.settings.hideValues = !state.settings.hideValues;
  persist();
  render();
};

// ---------------------------------------------------------------- start
render();
startAutoRefresh();
doRefresh();

// Updates: check for a new version on start and whenever the app comes back to the foreground,
// and reload automatically once the new version has taken over.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return; // first install: nothing to refresh
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(() => {});
}
