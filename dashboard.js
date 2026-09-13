import * as I from './indicators.js';

const LC = LightweightCharts;
const UP = '#26a69a', DN = '#ef5350', BLUE = '#3aa7ff', GOLD = '#f0b90b', GREY = '#8b949e';

/* ----------------------------------------------------------------- state */
const LS = 'live-charts-v2';
const stored = JSON.parse(localStorage.getItem(LS) || '{}');
const state = { n: stored.n || 4, sync: stored.sync !== false, panes: stored.panes || [] };
const save = () => localStorage.setItem(LS, JSON.stringify(state));

const DEFAULTS = ['crypto:BTC', 'crypto:ETH', 'crypto:SOL', 'yahoo:^NSEI',
                  'crypto:HYPE', 'yahoo:RELIANCE.NS', 'crypto:DOGE', 'yahoo:AAPL'];

let SRC = {}, STEP = {};

/* ------------------------------------------------ live feed: Hyperliquid */
const hlSubs = new Map();                 // "COIN|tf" -> Set<cb>
let hlWs, hlReady = false;

function hlConnect() {
  hlWs = new WebSocket('wss://api.hyperliquid.xyz/ws');
  hlWs.onopen = () => { hlReady = true; setStatus(); hlSubs.forEach((_, k) => hlSend('subscribe', k)); };
  hlWs.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.channel !== 'candle') return;
    const d = m.data, cbs = hlSubs.get(d.s + '|' + d.i);
    if (cbs) cbs.forEach(cb => cb({ time: d.t / 1000, open: +d.o, high: +d.h,
                                    low: +d.l, close: +d.c, volume: +d.v }));
  };
  hlWs.onclose = () => { hlReady = false; setStatus(); setTimeout(hlConnect, 2000); };
  hlWs.onerror = () => hlWs.close();
}

function hlSend(method, key) {
  const [coin, interval] = key.split('|');
  hlWs.send(JSON.stringify({ method, subscription: { type: 'candle', coin, interval } }));
}

function hlSubscribe(coin, tf, cb) {
  const key = coin + '|' + tf;
  if (!hlSubs.has(key)) { hlSubs.set(key, new Set()); if (hlReady) hlSend('subscribe', key); }
  hlSubs.get(key).add(cb);
  return () => {
    const s = hlSubs.get(key);
    s.delete(cb);
    if (!s.size) { hlSubs.delete(key); if (hlReady) hlSend('unsubscribe', key); }
  };
}

/* ------------------------------------ live feed: Yahoo ticks relayed by Flask */
const yhSubs = new Map();                 // symbol -> Set<cb>
let sse, sseOk = false;

function yhConnect() {
  sse = new EventSource('/api/stream');
  sse.onopen = () => { sseOk = true; setStatus(); };
  sse.onerror = () => { sseOk = false; setStatus(); };   // EventSource retries on its own
  sse.onmessage = e => {
    const t = JSON.parse(e.data);
    const cbs = yhSubs.get(t.symbol);
    if (cbs) cbs.forEach(cb => cb(t));
  };
}

function pushWatchlist() {
  fetch('/api/watch', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ symbols: [...yhSubs.keys()] }) }).catch(() => {});
}

function yhSubscribe(symbol, cb) {
  if (!yhSubs.has(symbol)) { yhSubs.set(symbol, new Set()); pushWatchlist(); }
  yhSubs.get(symbol).add(cb);
  return () => {
    const s = yhSubs.get(symbol);
    s.delete(cb);
    if (!s.size) { yhSubs.delete(symbol); pushWatchlist(); }
  };
}

/* ------------------------------------------------------------- indicators */
const line = (color, data, opt = {}) => ({ kind: 'line', color, data, ...opt });

const INDICATORS = {
  vol:    { label: 'Volume', scale: 'vol', build: b => [{ kind: 'histogram', scale: 'vol',
              format: { type: 'volume' },
              data: b.map(x => ({ time: x.time, value: x.volume || 0,
                                  color: x.close >= x.open ? UP + '55' : DN + '55' })) }] },
  ma20:   { label: 'SMA 20',  scale: 'price', build: b => [line(BLUE, I.toLine(b, I.sma(I.closes(b), 20)))] },
  ma50:   { label: 'SMA 50',  scale: 'price', build: b => [line(GOLD, I.toLine(b, I.sma(I.closes(b), 50)))] },
  ema9:   { label: 'EMA 9',   scale: 'price', build: b => [line('#e879f9', I.toLine(b, I.ema(I.closes(b), 9)))] },
  ema200: { label: 'EMA 200', scale: 'price', build: b => [line('#fb923c', I.toLine(b, I.ema(I.closes(b), 200)), { width: 2 })] },
  bb:     { label: 'Bollinger', scale: 'price', build: b => {
              const x = I.bollinger(I.closes(b));
              return [line(GREY, I.toLine(b, x.upper)),
                      line(GREY, I.toLine(b, x.mid), { dashed: true }),
                      line(GREY, I.toLine(b, x.lower))]; } },
  vwap:   { label: 'VWAP', scale: 'price', build: b => [line('#a78bfa', I.toLine(b, I.vwap(b)), { width: 2 })] },
  rsi:    { label: 'RSI 14', scale: 'osc', osc: true, build: b =>
              [line(BLUE, I.toLine(b, I.rsi(I.closes(b))), { scale: 'osc' })] },
  macd:   { label: 'MACD', scale: 'osc', osc: true, build: b => {
              const m = I.macd(I.closes(b)), out = [];
              const hist = [];
              b.forEach((x, i) => { if (m.hist[i] != null) hist.push({ time: x.time, value: m.hist[i],
                                      color: m.hist[i] >= 0 ? UP + '99' : DN + '99' }); });
              out.push({ kind: 'histogram', scale: 'osc', data: hist });
              out.push(line(BLUE, I.toLine(b, m.line), { scale: 'osc' }));
              out.push(line(GOLD, I.toLine(b, m.signal), { scale: 'osc' }));
              return out; } },
  stoch:  { label: 'Stoch 14', scale: 'osc', osc: true, build: b => {
              const s = I.stoch(b);
              return [line(BLUE, I.toLine(b, s.k), { scale: 'osc' }),
                      line(GOLD, I.toLine(b, s.d), { scale: 'osc' })]; } },
  atr:    { label: 'ATR 14', scale: 'osc', osc: true, build: b =>
              [line('#fb923c', I.toLine(b, I.atr(b)), { scale: 'osc' })] },
};

const TYPES = { candles: 'Candles', heikin: 'Heikin Ashi', bars: 'Bars', line: 'Line', area: 'Area' };

/* ------------------------------------------------------------- formatting */
const fmt = p => p == null ? '—' : p.toLocaleString(undefined, {
  minimumFractionDigits: 2, maximumFractionDigits: Math.abs(p) < 1 ? 6 : Math.abs(p) < 100 ? 4 : 2 });
const pct = v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';

function resolveSymbol(text) {
  const t = text.trim().toUpperCase();
  if (!t) return null;
  for (const [name, cfg] of Object.entries(SRC)) if (cfg.symbols.includes(t)) return name + ':' + t;
  const ff = Object.entries(SRC).find(([, c]) => c.freeform);
  return ff ? ff[0] + ':' + t : null;
}

/* ------------------------------------------------------------------ panes */
const grid = document.getElementById('grid');
const statusEl = document.getElementById('status');
let panes = [];
let syncing = false;

function setStatus() {
  const bits = [];
  bits.push((hlReady ? '●' : '○') + ' Hyperliquid');
  bits.push((sseOk ? '●' : '○') + ' Yahoo');
  statusEl.textContent = bits.join('   ');
  statusEl.className = hlReady || sseOk ? 'ok' : 'bad';
}

function buildPane(idx) {
  const c = state.panes[idx] || {};
  const cfg = { sym: c.sym || DEFAULTS[idx % DEFAULTS.length], tf: c.tf || '15m',
                type: c.type || 'candles', ind: c.ind || ['vol'], log: !!c.log,
                lines: c.lines || [] };

  const el = document.createElement('section');
  el.className = 'pane';
  el.innerHTML = `
    <div class="bar">
      <input class="sym" list="symbols" spellcheck="false" aria-label="Symbol">
      <select class="tf" aria-label="Timeframe"></select>
      <button class="ico menu-btn" title="Indicators &amp; tools" aria-label="Indicators and tools">ƒ</button>
      <span class="price">—</span>
      <span class="chg"></span>
      <button class="ico max-btn" title="Maximize" aria-label="Maximize">⛶</button>
    </div>
    <div class="wrap">
      <div class="legend"></div>
      <div class="chart"></div>
      <div class="menu" hidden></div>
      <div class="hint" hidden></div>
    </div>`;
  grid.append(el);

  const $ = s => el.querySelector(s);
  const bar = $('.bar'), symIn = $('.sym'), tfSel = $('.tf'), priceEl = $('.price'),
        chgEl = $('.chg'), legend = $('.legend'), chartEl = $('.chart'),
        menu = $('.menu'), hint = $('.hint');

  const chart = LC.createChart(chartEl, {
    autoSize: true,
    layout: { background: { color: 'transparent' }, textColor: GREY, fontSize: 11 },
    grid: { vertLines: { color: '#1c2128' }, horzLines: { color: '#1c2128' } },
    rightPriceScale: { borderColor: '#30363d' },
    timeScale: { borderColor: '#30363d', timeVisible: true, secondsVisible: false },
    crosshair: { mode: LC.CrosshairMode.Normal },
    localization: { priceFormatter: fmt },
  });

  let bars = [], priceSeries = null, indSeries = [], priceLines = [];
  let stopLive = null, lastT = 0, lastP = null, lastInd = 0;
  let loadingOlder = false, exhausted = false, ha = null, reqId = 0;

  /* ---- price series ---- */
  function makeSeries() {
    if (priceSeries) chart.removeSeries(priceSeries);
    const o = { priceLineVisible: true, lastValueVisible: true };
    priceSeries = cfg.type === 'line' ? chart.addLineSeries({ ...o, color: BLUE, lineWidth: 2 })
      : cfg.type === 'area' ? chart.addAreaSeries({ ...o, lineColor: BLUE, lineWidth: 2,
            topColor: BLUE + '55', bottomColor: BLUE + '00' })
      : cfg.type === 'bars' ? chart.addBarSeries({ ...o, upColor: UP, downColor: DN })
      : chart.addCandlestickSeries({ ...o, upColor: UP, downColor: DN, borderVisible: false,
            wickUpColor: UP, wickDownColor: DN });
    priceLines = [];
    cfg.lines.forEach(drawLine);
  }

  const isOhlc = () => cfg.type !== 'line' && cfg.type !== 'area';

  function priceData() {
    if (!isOhlc()) return bars.map(b => ({ time: b.time, value: b.close }));
    if (cfg.type === 'heikin') {
      const h = I.heikinAshi(bars);
      ha = h.length ? { open: h[h.length - 1].open, close: h[h.length - 1].close,
                        time: h[h.length - 1].time } : null;
      return h;
    }
    return bars;
  }

  /* Heikin Ashi needs the previous HA bar, so tick updates carry their own state. */
  function haPoint(b) {
    if (ha && b.time > ha.time) ha = { ...ha, prevOpen: ha.open, prevClose: ha.close, time: b.time };
    const po = ha && ha.time === b.time && ha.prevOpen != null ? ha.prevOpen : ha ? ha.open : null;
    const pc = ha && ha.time === b.time && ha.prevClose != null ? ha.prevClose : ha ? ha.close : null;
    const close = (b.open + b.high + b.low + b.close) / 4;
    const open = po == null ? (b.open + b.close) / 2 : (po + pc) / 2;
    const pt = { time: b.time, open, close, high: Math.max(b.high, open, close),
                 low: Math.min(b.low, open, close) };
    ha = { ...ha, open, close, time: b.time };
    return pt;
  }

  const toPoint = b => !isOhlc() ? { time: b.time, value: b.close }
                     : cfg.type === 'heikin' ? haPoint(b) : b;

  /* ---- indicators ---- */
  function scaleOf(spec, def) { return spec.scale || (def.scale === 'price' ? 'right' : def.scale); }

  function rebuildIndicators() {
    indSeries.forEach(s => chart.removeSeries(s));
    indSeries = [];
    let hasVol = false, hasOsc = false;
    for (const key of cfg.ind) {
      const def = INDICATORS[key];
      if (!def) continue;
      if (def.scale === 'vol') hasVol = true;
      if (def.osc) hasOsc = true;
      for (const spec of def.build(bars)) {
        const id = scaleOf(spec, def);
        const s = spec.kind === 'histogram'
          ? chart.addHistogramSeries({ priceScaleId: id, priceFormat: spec.format || { type: 'price' },
              lastValueVisible: false, priceLineVisible: false })
          : chart.addLineSeries({ priceScaleId: id, color: spec.color, lineWidth: spec.width || 1,
              lineStyle: spec.dashed ? LC.LineStyle.Dashed : LC.LineStyle.Solid,
              lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
        s.setData(spec.data);
        indSeries.push(s);
      }
    }
    applyScales(hasVol, hasOsc);
    renderLegendIndicators();
  }

  function refreshIndicators() {                 // same series, new data — no flicker
    let k = 0;
    for (const key of cfg.ind) {
      const def = INDICATORS[key];
      if (!def) continue;
      for (const spec of def.build(bars)) if (indSeries[k]) indSeries[k++].setData(spec.data);
    }
  }

  function applyScales(hasVol, hasOsc) {
    chart.priceScale('right').applyOptions({
      scaleMargins: hasOsc ? { top: .04, bottom: .42 } : hasVol ? { top: .06, bottom: .22 }
                                                               : { top: .08, bottom: .08 },
      mode: cfg.log ? LC.PriceScaleMode.Logarithmic : LC.PriceScaleMode.Normal,
    });
    if (hasVol) chart.priceScale('vol').applyOptions({
      scaleMargins: hasOsc ? { top: .58, bottom: .22 } : { top: .80, bottom: 0 } });
    if (hasOsc) chart.priceScale('osc').applyOptions({ scaleMargins: { top: .80, bottom: 0 } });
  }

  /* ---- ticker + legend ---- */
  function dayChange() {
    const last = bars[bars.length - 1];
    if (!last) return null;
    const day = Math.floor(last.time / 86400);
    for (let i = bars.length - 2; i >= 0; i--)
      if (Math.floor(bars[i].time / 86400) < day)
        return ((last.close - bars[i].close) / bars[i].close) * 100;
    return bars.length > 1 ? ((last.close - bars[0].close) / bars[0].close) * 100 : null;
  }

  function setPrice(p) {
    checkAlerts(p);
    const dir = lastP == null || p === lastP ? '' : p > lastP ? 'up' : 'down';
    priceEl.className = 'price ' + dir;
    priceEl.textContent = fmt(p);
    const ch = dayChange();
    chgEl.textContent = ch == null ? '' : pct(ch);
    chgEl.className = 'chg ' + (ch == null ? '' : ch >= 0 ? 'up' : 'down');
    if (dir) {
      bar.classList.remove('up', 'down');
      void bar.offsetWidth;                       // restart the flash
      bar.classList.add(dir);
    }
    lastP = p;
  }

  function renderLegendIndicators() {
    const names = cfg.ind.map(k => INDICATORS[k]?.label).filter(Boolean);
    legend.dataset.ind = names.join(' · ');
    renderLegend(bars[bars.length - 1]);
  }

  function renderLegend(b) {
    const [, sym] = cfg.sym.split(':');
    if (!b) { legend.innerHTML = `<b>${sym}</b> <span class="dim">${cfg.tf}</span>`; return; }
    const cls = b.close >= b.open ? 'up' : 'down';
    legend.innerHTML = `<b>${sym}</b> <span class="dim">${cfg.tf} · ${TYPES[cfg.type]}</span>`
      + `<span class="ohlc ${cls}">O ${fmt(b.open)} H ${fmt(b.high)} L ${fmt(b.low)} C ${fmt(b.close)}</span>`
      + (legend.dataset.ind ? `<span class="dim">${legend.dataset.ind}</span>` : '');
  }

  chart.subscribeCrosshairMove(param => {
    const b = param.time != null && bars.length
      ? bars.find(x => x.time === param.time) || bars[bars.length - 1]
      : bars[bars.length - 1];
    renderLegend(b);
    if (state.sync && param.point) broadcastCross(api, param.time);
    else if (state.sync && !param.point) broadcastCross(api, null);
  });

  /* ---- horizontal lines & alerts ---- */
  function drawLine(l) {
    const pl = priceSeries.createPriceLine({
      price: l.price, color: l.alert ? GOLD : BLUE, lineWidth: 1,
      lineStyle: l.alert ? LC.LineStyle.Dashed : LC.LineStyle.Solid,
      axisLabelVisible: true, title: l.alert ? (l.hit ? '⚑ hit' : 'alert') : '' });
    priceLines.push(pl);
  }

  function addLine(price, alert) {
    cfg.lines.push({ price, alert, hit: false });
    drawLine(cfg.lines[cfg.lines.length - 1]);
    persist();
    if (alert && 'Notification' in window && Notification.permission === 'default')
      Notification.requestPermission();
  }

  function clearLines() {
    priceLines.forEach(pl => priceSeries.removePriceLine(pl));
    priceLines = []; cfg.lines = []; persist();
  }

  function checkAlerts(p) {
    if (lastP == null) return;
    cfg.lines.forEach((l, i) => {
      if (!l.alert || l.hit) return;
      if ((lastP - l.price) * (p - l.price) > 0) return;       // no crossing
      l.hit = true;
      priceLines[i]?.applyOptions({ color: '#facc15', title: '⚑ hit' });
      el.classList.add('alerted');
      setTimeout(() => el.classList.remove('alerted'), 4000);
      const msg = `${cfg.sym.split(':')[1]} crossed ${fmt(l.price)}`;
      if ('Notification' in window && Notification.permission === 'granted')
        new Notification('Price alert', { body: msg });
      persist();
    });
  }

  let armed = null;
  chart.subscribeClick(param => {
    if (!armed || !param.point) return;
    const price = priceSeries.coordinateToPrice(param.point.y);
    if (price != null) addLine(price, armed === 'alert');
    armed = null; hint.hidden = true;
  });

  /* ---- scroll-back history ---- */
  chart.timeScale().subscribeVisibleLogicalRangeChange(r => {
    if (state.sync && r) broadcastRange(api);
    if (!r || r.from > 8 || loadingOlder || exhausted || !bars.length) return;
    loadOlder();
  });

  async function loadOlder() {
    loadingOlder = true;
    legend.classList.add('loading');
    const older = await fetchBars({ before: bars[0].time }).catch(() => []);
    const seen = new Set(bars.map(b => b.time));
    const add = older.filter(b => !seen.has(b.time));
    // Nothing new — either the feed is out of history or it replayed bars we hold.
    // Either way, stop asking, or the range-change handler re-fires the same request.
    if (!add.length) exhausted = true;
    else {
      const range = chart.timeScale().getVisibleLogicalRange();
      bars = add.concat(bars);
      priceSeries.setData(priceData());
      refreshIndicators();
      if (range) chart.timeScale().setVisibleLogicalRange(
        { from: range.from + add.length, to: range.to + add.length });
    }
    legend.classList.remove('loading');
    loadingOlder = false;
  }

  /* ---- loading ---- */
  function query(extra = {}) {
    const [src, symbol] = cfg.sym.split(':');
    const p = new URLSearchParams({ source: src, symbol, tf: cfg.tf, ...extra });
    return '/api/candles?' + p;
  }

  async function fetchBars(extra) {
    const r = await fetch(query(extra));
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
    return r.json();
  }

  function push(b) {
    if (b.time < lastT) return;
    lastT = b.time;
    priceSeries.update(toPoint(b));
    setPrice(b.close);
    if (cfg.ind.length && Date.now() - lastInd > 800) { lastInd = Date.now(); refreshIndicators(); }
  }

  function startLive() {
    const [src, symbol] = cfg.sym.split(':');
    if (SRC[src].live === 'ws') return hlSubscribe(symbol, cfg.tf, b => {
      const last = bars[bars.length - 1];
      if (last && b.time === last.time) Object.assign(last, b); else bars.push(b);
      push(b);
    });

    const step = STEP[cfg.tf];
    const off = yhSubscribe(symbol, t => {
      const bt = Math.floor(t.time / step) * step;
      const last = bars[bars.length - 1];
      if (!last || bt > last.time) {
        const nb = { time: bt, open: t.price, high: t.price, low: t.price, close: t.price, volume: 0 };
        bars.push(nb); push(nb);
      } else if (bt === last.time) {
        last.high = Math.max(last.high, t.price);
        last.low = Math.min(last.low, t.price);
        last.close = t.price;
        push(last);
      } else setPrice(t.price);                   // tick predates our last bar
    });
    // Ticks are price-only, so pull the official bars now and then to fix drift.
    const id = setInterval(async () => {
      const fresh = await fetchBars({ limit: 3 }).catch(() => []);
      if (!fresh.length) return;
      const by = new Map(bars.map(b => [b.time, b]));
      fresh.forEach(b => by.set(b.time, b));
      bars = [...by.values()].sort((a, b) => a.time - b.time);
      priceSeries.setData(priceData());
      refreshIndicators();
    }, 60000);
    return () => { off(); clearInterval(id); };
  }

  async function load() {
    const mine = ++reqId;
    if (stopLive) { stopLive(); stopLive = null; }
    bars = []; lastT = 0; lastP = null; exhausted = false; ha = null;
    priceEl.className = 'price'; priceEl.textContent = '…'; chgEl.textContent = '';
    persist();
    makeSeries();
    try {
      const data = await fetchBars();
      if (mine !== reqId) return;                 // a newer load already started
      bars = data;
      priceSeries.setData(priceData());
      chart.timeScale().fitContent();
      rebuildIndicators();
      if (bars.length) { lastT = bars[bars.length - 1].time; setPrice(bars[bars.length - 1].close); }
      renderLegend(bars[bars.length - 1]);
      stopLive = startLive();
    } catch (err) {
      if (mine !== reqId) return;
      priceEl.className = 'price err';
      priceEl.textContent = String(err.message || err).slice(0, 50);
    }
  }

  /* ---- menu ---- */
  function buildMenu() {
    const chip = (g, k, label, on) =>
      `<button class="chip${on ? ' on' : ''}" data-g="${g}" data-k="${k}">${label}</button>`;
    menu.innerHTML =
      `<div class="sec">Chart type</div><div class="chips">` +
      Object.entries(TYPES).map(([k, v]) => chip('type', k, v, cfg.type === k)).join('') +
      `</div><div class="sec">Indicators</div><div class="chips">` +
      Object.entries(INDICATORS).map(([k, v]) => chip('ind', k, v.label, cfg.ind.includes(k))).join('') +
      `</div><div class="sec">Tools</div><div class="chips">` +
      chip('act', 'line', '＋ Line') + chip('act', 'alert', '⚑ Alert') +
      chip('act', 'clear', 'Clear lines') + chip('act', 'log', 'Log scale', cfg.log) +
      chip('act', 'fit', 'Fit') + `</div>`;
  }

  menu.onclick = e => {
    const b = e.target.closest('.chip');
    if (!b) return;
    const { g, k } = b.dataset;
    if (g === 'type') {
      cfg.type = k; persist();
      makeSeries(); priceSeries.setData(priceData());
      if (bars.length) lastT = bars[bars.length - 1].time;
      buildMenu(); renderLegend(bars[bars.length - 1]);
    } else if (g === 'ind') {
      const def = INDICATORS[k];
      if (cfg.ind.includes(k)) cfg.ind = cfg.ind.filter(x => x !== k);
      else cfg.ind = [...(def.osc ? cfg.ind.filter(x => !INDICATORS[x].osc) : cfg.ind), k];
      persist(); rebuildIndicators(); buildMenu();
    } else if (k === 'clear') { clearLines(); buildMenu(); }
    else if (k === 'log') { cfg.log = !cfg.log; persist(); rebuildIndicators(); buildMenu(); }
    else if (k === 'fit') { chart.timeScale().fitContent(); menu.hidden = true; }
    else { armed = k; menu.hidden = true; hint.hidden = false;
           hint.textContent = k === 'alert' ? 'Click a price to set an alert' : 'Click a price to draw a line'; }
  };

  $('.menu-btn').onclick = () => {
    panes.forEach(p => { if (p !== api) p.closeMenu(); });
    menu.hidden = !menu.hidden;
    if (!menu.hidden) buildMenu();
  };
  $('.max-btn').onclick = () => {
    const on = el.classList.toggle('max');
    document.body.classList.toggle('has-max', on);
    panes.forEach(p => { if (p !== api) p.unmax(); });
  };

  /* ---- wiring ---- */
  function persist() {
    state.panes[idx] = { sym: cfg.sym, tf: cfg.tf, type: cfg.type, ind: cfg.ind,
                         log: cfg.log, lines: cfg.lines };
    save();
  }

  function fillTimeframes() {
    const src = cfg.sym.split(':')[0], tfs = SRC[src].timeframes;
    tfSel.innerHTML = '';
    tfs.forEach(t => tfSel.append(new Option(t, t)));
    if (!tfs.includes(cfg.tf)) cfg.tf = tfs[0];
    tfSel.value = cfg.tf;
  }

  symIn.value = cfg.sym.split(':')[1];
  symIn.onchange = () => {
    const r = resolveSymbol(symIn.value);
    if (!r) { symIn.value = cfg.sym.split(':')[1]; return; }
    cfg.sym = r; symIn.value = r.split(':')[1];
    cfg.lines = []; priceLines = [];
    fillTimeframes(); load();
  };
  tfSel.onchange = () => { cfg.tf = tfSel.value; load(); };
  fillTimeframes();
  load();

  const api = {
    el,
    closeMenu: () => { menu.hidden = true; },
    unmax: () => el.classList.remove('max'),
    getRange: () => chart.timeScale().getVisibleRange(),
    setRange: r => { try { chart.timeScale().setVisibleRange(r); } catch {} },
    setCross: time => {
      if (time == null || !bars.length) return chart.clearCrosshairPosition();
      let best = null, bd = Infinity;             // ponytail: linear scan, ~3k bars is nothing
      for (const b of bars) { const d = Math.abs(b.time - time); if (d < bd) { bd = d; best = b; } }
      if (best) chart.setCrosshairPosition(best.close, best.time, priceSeries);
    },
    destroy: () => { if (stopLive) stopLive(); chart.remove(); el.remove(); },
  };
  return api;
}

/* ------------------------------------------------------- cross-pane sync */
function broadcastRange(src) {
  if (syncing || !state.sync) return;
  const r = src.getRange();
  if (!r) return;
  syncing = true;
  panes.forEach(p => { if (p !== src) p.setRange(r); });
  setTimeout(() => { syncing = false; }, 0);
}

function broadcastCross(src, time) {
  if (syncing || !state.sync) return;
  syncing = true;
  panes.forEach(p => { if (p !== src) p.setCross(time); });
  setTimeout(() => { syncing = false; }, 0);
}

/* ------------------------------------------------------------------ boot */
function layout() {
  panes.forEach(p => p.destroy());
  panes = [];
  document.body.classList.remove('has-max');
  grid.dataset.n = state.n;
  for (let i = 0; i < state.n; i++) panes.push(buildPane(i));
}

document.addEventListener('click', e => {
  if (!e.target.closest('.menu') && !e.target.closest('.menu-btn'))
    panes.forEach(p => p.closeMenu());
});

(async () => {
  const meta = await fetch('/api/sources').then(r => r.json());
  SRC = meta.sources; STEP = meta.step;

  const dl = document.getElementById('symbols');
  for (const cfg of Object.values(SRC))
    for (const s of cfg.symbols) dl.append(new Option(s));

  const count = document.getElementById('count');
  count.value = state.n;
  count.onchange = () => { state.n = +count.value; save(); layout(); };

  const sync = document.getElementById('sync');
  sync.checked = state.sync;
  sync.onchange = () => { state.sync = sync.checked; save(); };

  layout();
  hlConnect();
  yhConnect();
  setStatus();
})();
