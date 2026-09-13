import assert from 'node:assert/strict';
import * as I from './indicators.js';

const N = 100;
const flat = Array(N).fill(50);
const up = Array.from({ length: N }, (_, i) => 10 + i);
const down = up.slice().reverse();
const bars = v => v.map((c, i) => ({ time: i * 60, open: c, high: c + 1, low: c - 1, close: c, volume: 10 }));
const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);

// --- exact values, hand-checkable -----------------------------------------
assert.deepEqual(I.sma([1, 2, 3, 4, 5], 3).slice(2), [2, 3, 4]);
assert.equal(I.sma([1, 2, 3], 3)[1], null, 'warm-up must be null');
assert.deepEqual(I.ema([1, 2, 3, 4], 3).slice(2), [2, 3]);   // seed=sma3=2, then 4*.5+2*.5=3

// --- constants in, constants out ------------------------------------------
near(I.sma(flat, 20)[N - 1], 50);
near(I.ema(flat, 20)[N - 1], 50);
const bb = I.bollinger(flat, 20, 2);
near(bb.upper[N - 1], bb.lower[N - 1]);                       // zero volatility => zero width
near(I.macd(flat).line[N - 1], 0);
near(I.macd(flat).hist[N - 1], 0);

// --- RSI: bounded, and pinned at the extremes ------------------------------
assert.equal(I.rsi(up, 14)[N - 1], 100, 'all gains => 100');
near(I.rsi(down, 14)[N - 1], 0);
for (const v of I.rsi(bars(up).map(b => b.close + Math.sin(b.time)), 14))
  if (v != null) assert.ok(v >= 0 && v <= 100, `RSI out of range: ${v}`);

// --- every series stays aligned with its input -----------------------------
for (const [name, a] of Object.entries({
  sma: I.sma(up, 10), ema: I.ema(up, 10), rsi: I.rsi(up), atr: I.atr(bars(up)),
  vwap: I.vwap(bars(up)), macd: I.macd(up).line, signal: I.macd(up).signal,
  stochK: I.stoch(bars(up)).k, stochD: I.stoch(bars(up)).d, bbMid: I.bollinger(up).mid,
})) assert.equal(a.length, N, `${name} length drifted`);

// --- Heikin Ashi candles must be self-consistent ---------------------------
for (const h of I.heikinAshi(bars(up))) {
  assert.ok(h.high >= h.low);
  assert.ok(h.high >= h.open && h.high >= h.close);
  assert.ok(h.low <= h.open && h.low <= h.close);
}

// --- Stochastic bounded; ATR non-negative ----------------------------------
for (const v of I.stoch(bars(up)).k) if (v != null) assert.ok(v >= 0 && v <= 100);
for (const v of I.atr(bars(up))) if (v != null) assert.ok(v >= 0);

// --- VWAP sits inside the day's range, and resets across days --------------
const twoDays = bars(up).map((b, i) => ({ ...b, time: i * 3600 }));  // crosses a UTC midnight
const vw = I.vwap(twoDays);
twoDays.forEach((b, i) => { if (vw[i] != null) assert.ok(vw[i] >= 9 && vw[i] <= 111); });
assert.ok(vw[24] != null && Math.abs(vw[24] - twoDays[24].close) < 1, 'VWAP should reset each day');

// --- toLine drops exactly the warm-up --------------------------------------
assert.equal(I.toLine(bars(up), I.sma(up, 10)).length, N - 9);
assert.equal(I.toLine(bars(up), I.sma(up, 10))[0].time, 9 * 60);

console.log('indicators: all checks pass');
