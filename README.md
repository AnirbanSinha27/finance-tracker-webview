# Live Charts

Multi-pane live trading charts that run entirely on your machine. No deployment,
no API keys, no accounts.

    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
    .venv/bin/python app.py          # http://127.0.0.1:5001

## What's in it

- **1/2/4/6/8 panes**, each with its own symbol, timeframe, chart type and indicators.
- **Two live feeds.** Crypto candles stream straight from Hyperliquid's websocket
  into the browser. Stocks/FX/commodities stream from Yahoo — Flask decodes their
  protobuf frames and relays ticks over SSE, since the browser can't.
- **Symbols.** 234 Hyperliquid perps, plus *any* Yahoo ticker typed into the box
  (`AAPL`, `TSM`, `RELIANCE.NS`, `^NSEI`, `EURUSD=X`, `GC=F`, `BTC-USD`, …).
- **Chart types.** Candles, Heikin Ashi, bars, line, area.
- **Indicators.** Volume, SMA 20/50, EMA 9/200, Bollinger, VWAP, RSI, MACD,
  Stochastic, ATR. Oscillators get their own band under the price.
- **Tools.** Horizontal lines, price alerts (desktop notification on cross),
  log scale, fit, maximize a pane, crosshair + zoom synced across panes.
- **Scroll back** past the initial window and older candles load on demand.
- Everything persists in localStorage.

## Deploy

One-click via the Render blueprint in `render.yaml`:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/AnirbanSinha27/finance-tracker-webview)

Or: Render dashboard -> New -> Blueprint -> pick this repo. Free plan sleeps
after 15 minutes idle, so the first hit after a nap takes ~50s to wake.

**Not Vercel/Netlify.** This needs a process that stays alive — a background
thread holding Yahoo's websocket and an SSE connection held open per browser.
Serverless functions are stateless and short-lived and can host neither. Any
host that runs a normal long-lived process works: Render, Railway, Fly.

## Testing

    node test_indicators.js     # indicator math
    python data_source.py       # both feeds, every timeframe, history paging

## Adding a broker

One function in `data_source.py`:

```python
@source("binance", label="Binance", symbols=lambda: ["BTCUSDT"],
        timeframes=list(STEP), live="poll", freeform=False)
def binance(symbol, tf, limit, before=None):
    return [{"time": ..., "open": ..., "high": ..., "low": ...,
             "close": ..., "volume": ...}]      # oldest first
```

`live` is `"ws"` (browser opens its own socket), `"stream"` (server relays over
SSE) or `"poll"`. `before` powers scroll-back; return `[]` when history runs out.

## Known limits

- Yahoo data is delayed (~15 min for NSE) — that's their free feed, not the app.
- `yfinance` scrapes an unofficial endpoint; it rate-limits and occasionally breaks.
- Indices (`^NSEI`, `^GSPC`) report no volume, so Volume and VWAP stay blank there.
- No drawing tools beyond horizontal lines, and no Pine Script / backtesting.
