/* Pure indicator math. No DOM, no charts — so `node test_indicators.js` can check it.
   Every function returns an array the same length as its input, with null during warm-up. */

export const closes = b => b.map(x => x.close);

export function sma(v, p) {
  const out = new Array(v.length).fill(null);
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i];
    if (i >= p) sum -= v[i - p];
    if (i >= p - 1) out[i] = sum / p;
  }
  return out;
}

export function ema(v, p) {
  const out = new Array(v.length).fill(null), a = 2 / (p + 1);
  let prev = null, sum = 0;
  for (let i = 0; i < v.length; i++) {
    if (i < p - 1) { sum += v[i]; continue; }
    if (i === p - 1) { sum += v[i]; prev = sum / p; }          // seed with an SMA
    else prev = v[i] * a + prev * (1 - a);
    out[i] = prev;
  }
  return out;
}

/* Wilder's smoothing, same as TradingView's default RSI. */
export function rsi(c, p = 14) {
  const out = new Array(c.length).fill(null);
  if (c.length <= p) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) {
    const d = c[i] - c[i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  g /= p; l /= p;
  out[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = p + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (p - 1) + Math.max(d, 0)) / p;
    l = (l * (p - 1) + Math.max(-d, 0)) / p;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

/* Re-align an array computed over only the non-null slice of `src`. */
function realign(src, vals) {
  const out = new Array(src.length).fill(null);
  const off = src.findIndex(x => x != null);
  if (off >= 0) vals.forEach((x, i) => { if (x != null) out[off + i] = x; });
  return out;
}

export function macd(c, f = 12, s = 26, sig = 9) {
  const ef = ema(c, f), es = ema(c, s);
  const line = c.map((_, i) => (ef[i] == null || es[i] == null ? null : ef[i] - es[i]));
  const signal = realign(line, ema(line.filter(x => x != null), sig));
  const hist = line.map((x, i) => (x == null || signal[i] == null ? null : x - signal[i]));
  return { line, signal, hist };
}

export function bollinger(c, p = 20, k = 2) {
  const mid = sma(c, p), upper = [], lower = [];
  for (let i = 0; i < c.length; i++) {
    if (mid[i] == null) { upper.push(null); lower.push(null); continue; }
    let s = 0;                                  // ponytail: O(n*p); fine to ~10k bars
    for (let j = i - p + 1; j <= i; j++) s += (c[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / p);
    upper.push(mid[i] + k * sd); lower.push(mid[i] - k * sd);
  }
  return { upper, mid, lower };
}

export function atr(bars, p = 14) {
  const out = new Array(bars.length).fill(null);
  if (bars.length <= p) return out;
  const tr = bars.map((b, i) => (i === 0 ? b.high - b.low : Math.max(
    b.high - b.low,
    Math.abs(b.high - bars[i - 1].close),
    Math.abs(b.low - bars[i - 1].close))));
  let a = 0;
  for (let i = 1; i <= p; i++) a += tr[i];
  out[p] = a /= p;
  for (let i = p + 1; i < bars.length; i++) out[i] = a = (a * (p - 1) + tr[i]) / p;
  return out;
}

export function stoch(bars, kp = 14, dp = 3) {
  const k = new Array(bars.length).fill(null);
  for (let i = kp - 1; i < bars.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - kp + 1; j <= i; j++) {
      hh = Math.max(hh, bars[j].high); ll = Math.min(ll, bars[j].low);
    }
    k[i] = hh === ll ? 50 : (100 * (bars[i].close - ll)) / (hh - ll);
  }
  return { k, d: realign(k, sma(k.filter(x => x != null), dp)) };
}

/* Session-anchored: resets every UTC day, like an intraday VWAP. */
export function vwap(bars) {
  let pv = 0, v = 0, day = null;
  return bars.map(b => {
    const d = Math.floor(b.time / 86400);
    if (d !== day) { day = d; pv = 0; v = 0; }
    const vol = b.volume || 0;
    pv += ((b.high + b.low + b.close) / 3) * vol;
    v += vol;
    return v ? pv / v : null;
  });
}

export function heikinAshi(bars) {
  let po = null, pc = null;
  return bars.map(b => {
    const close = (b.open + b.high + b.low + b.close) / 4;
    const open = po === null ? (b.open + b.close) / 2 : (po + pc) / 2;
    po = open; pc = close;
    return { time: b.time, open, close,
             high: Math.max(b.high, open, close), low: Math.min(b.low, open, close) };
  });
}

/* Drop warm-up nulls and pair with bar times, ready for a Lightweight Charts line series. */
export const toLine = (bars, vals) => {
  const out = [];
  for (let i = 0; i < bars.length; i++)
    if (vals[i] != null && isFinite(vals[i])) out.push({ time: bars[i].time, value: vals[i] });
  return out;
};
