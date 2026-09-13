"""Pluggable market data.

To swap in another broker, write ONE function and decorate it:

    @source("binance", label="Binance", symbols=lambda: ["BTCUSDT"],
            timeframes=list(STEP), live="poll", freeform=False)
    def binance(symbol, tf, limit, before=None):
        return [{"time": <utc epoch seconds>, "open": f, "high": f,
                 "low": f, "close": f, "volume": f}, ...]      # oldest first

`live`     — how the browser gets updates: "ws" (browser opens its own socket),
             "stream" (this server relays ticks over SSE) or "poll".
`freeform` — True if any typed symbol is valid, not just the listed ones.
`before`   — return bars strictly older than this epoch second (scroll-back paging);
             return [] when you run out and the frontend stops asking.
"""
import time
from datetime import datetime, timedelta, timezone
from functools import lru_cache

import requests

STEP = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}

SOURCES = {}


def source(name, label, symbols, timeframes, live, freeform=False):
    def deco(fn):
        fn.label, fn.symbols, fn.timeframes = label, symbols, timeframes
        fn.live, fn.freeform = live, freeform
        SOURCES[name] = fn
        return fn
    return deco


# ---------------------------------------------------------------- Hyperliquid

HL = "https://api.hyperliquid.xyz/info"


@lru_cache(maxsize=1)
def _hl_coins():
    meta = requests.post(HL, json={"type": "meta"}, timeout=15).json()
    return sorted(a["name"] for a in meta["universe"])


@source("crypto", "Crypto (Hyperliquid)", _hl_coins, list(STEP), live="ws")
def hyperliquid(symbol, tf, limit, before=None):
    end = int(before * 1000) - 1 if before else int(time.time() * 1000)
    start = end - STEP[tf] * 1000 * limit
    req = {"coin": symbol, "interval": tf, "startTime": start, "endTime": end}
    r = requests.post(HL, json={"type": "candleSnapshot", "req": req}, timeout=15)
    r.raise_for_status()
    return [
        {"time": c["t"] // 1000, "open": float(c["o"]), "high": float(c["h"]),
         "low": float(c["l"]), "close": float(c["c"]), "volume": float(c["v"])}
        for c in r.json() or []
    ]


# ------------------------------------------------------- yfinance (any ticker)

# Yahoo caps intraday history, so each timeframe gets its own initial period.
YF_PERIOD = {"1m": "5d", "5m": "1mo", "15m": "1mo", "1h": "3mo", "4h": "6mo", "1d": "2y"}

# Scroll-back window: an equity session is ~6.5h of a 24h day and markets close
# on weekends, so reaching N intraday bars needs a far wider calendar window.
YF_SPREAD = {"1d": 1.55, "_intraday": 5.7}

SYMBOLS = [
    # NSE indices + large caps
    "^NSEI", "^NSEBANK", "RELIANCE.NS", "TCS.NS", "HDFCBANK.NS", "ICICIBANK.NS",
    "INFY.NS", "SBIN.NS", "BHARTIARTL.NS", "ITC.NS", "LT.NS", "KOTAKBANK.NS",
    "AXISBANK.NS", "HINDUNILVR.NS", "BAJFINANCE.NS", "MARUTI.NS", "SUNPHARMA.NS",
    "TITAN.NS", "WIPRO.NS", "HCLTECH.NS", "ADANIENT.NS", "TATAMOTORS.NS",
    "TATASTEEL.NS", "ASIANPAINT.NS", "ZOMATO.NS",
    # US indices + mega caps
    "^GSPC", "^IXIC", "^DJI", "^VIX", "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN",
    "META", "TSLA", "AMD", "NFLX", "COIN", "SPY", "QQQ",
    # FX, commodities, spot crypto
    "EURUSD=X", "USDINR=X", "GBPUSD=X", "JPY=X", "GC=F", "CL=F", "SI=F",
    "BTC-USD", "ETH-USD",
]


@source("yahoo", "Stocks · FX · Commodities (Yahoo)", lambda: SYMBOLS, list(STEP),
        live="stream", freeform=True)
def yahoo(symbol, tf, limit, before=None):
    import yfinance as yf

    interval = "1h" if tf == "4h" else tf          # Yahoo has no 4h bar
    t = yf.Ticker(symbol)
    if before:
        spread = YF_SPREAD.get(tf, YF_SPREAD["_intraday"])
        end = datetime.fromtimestamp(before, timezone.utc)
        df = t.history(start=end - timedelta(seconds=STEP[tf] * limit * spread),
                       end=end, interval=interval)
    else:
        df = t.history(period=YF_PERIOD[tf], interval=interval)
    if df.empty:
        return []
    if tf == "4h":
        df = df.resample("4h").agg({"Open": "first", "High": "max", "Low": "min",
                                    "Close": "last", "Volume": "sum"}).dropna()
    out = []
    for ts, row in df.tail(limit).iterrows():
        if ts.tzinfo is None:
            ts = ts.tz_localize("UTC")
        out.append({"time": int(ts.timestamp()), "open": float(row.Open),
                    "high": float(row.High), "low": float(row.Low),
                    "close": float(row.Close), "volume": float(row.Volume or 0)})
    return out


# ----------------------------------------------------------------------------

CACHE_TTL = 5  # seconds; 8 panes polling the same symbol shouldn't be 8 requests
_cache = {}    # ponytail: unbounded dict, swap for cachetools.TTLCache if it grows


def candles(src, symbol, tf, limit=300, before=None):
    key = (src, symbol, tf, limit, before)
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_TTL:
        return hit[1]
    data = SOURCES[src](symbol, tf, limit, before)
    _cache[key] = (time.time(), data)
    return data


if __name__ == "__main__":  # python data_source.py
    FIELDS = {"time", "open", "high", "low", "close", "volume"}
    for name, fn in SOURCES.items():
        syms = fn.symbols()
        assert syms, name
        sym = "RELIANCE.NS" if name == "yahoo" else syms[0]
        for tf in fn.timeframes:
            page1 = candles(name, sym, tf, 120)
            assert page1, "%s/%s returned no candles" % (name, tf)
            times = [b["time"] for b in page1]
            assert times == sorted(times), "%s/%s unsorted" % (name, tf)
            assert len(set(times)) == len(times), "%s/%s duplicate bars" % (name, tf)
            for b in page1:
                assert set(b) == FIELDS, b
                assert b["low"] <= min(b["open"], b["close"]), b
                assert b["high"] >= max(b["open"], b["close"]), b
                assert b["volume"] >= 0, b
            # scroll-back paging must hand back strictly older, non-overlapping bars
            page0 = candles(name, sym, tf, 120, before=times[0])
            assert all(b["time"] < times[0] for b in page0), "%s/%s page overlap" % (name, tf)
            print("ok %-7s %-3s %4d bars  back-page %4d  last close %s"
                  % (name, tf, len(page1), len(page0), page1[-1]["close"]))
