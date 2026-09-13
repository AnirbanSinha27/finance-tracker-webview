"""Local bridge: serves the dashboard, proxies data_source.py, and relays Yahoo's
live tick stream to the browser over SSE (the browser can't decode Yahoo's
protobuf frames itself, so this process does it)."""
import json
import os
import queue
import threading
import time

import requests
from flask import Flask, Response, abort, jsonify, request, send_from_directory

import data_source as ds

app = Flask(__name__, static_folder=None)

# ------------------------------------------------------------ keep-alive ping

# Render's free plan sleeps an instance after 15 minutes with no inbound
# request. Requesting our own public URL is an inbound request, so it resets
# that timer. RENDER_EXTERNAL_URL is injected by Render, so this stays dormant
# during local development.
#
# What this cannot do: wake an instance that already fell asleep — the thread is
# asleep too. Point an external uptime monitor at /healthz if you need that.
KEEPALIVE_URL = os.environ.get("RENDER_EXTERNAL_URL")
KEEPALIVE_SECONDS = int(os.environ.get("KEEPALIVE_SECONDS", "600"))


def _keepalive():
    while True:
        time.sleep(KEEPALIVE_SECONDS)
        try:
            r = requests.get(KEEPALIVE_URL.rstrip("/") + "/healthz", timeout=15)
            print("keepalive %s" % r.status_code, flush=True)
        except Exception as e:
            print("keepalive failed: %s" % e, flush=True)


if KEEPALIVE_URL:
    threading.Thread(target=_keepalive, daemon=True).start()
    print("keepalive: pinging %s every %ss" % (KEEPALIVE_URL, KEEPALIVE_SECONDS), flush=True)

# ------------------------------------------------------ Yahoo tick relay (SSE)

_lock = threading.Lock()
_clients = []          # one Queue per connected browser
_watch = {}            # client id -> symbols that browser's panes want
_ws = None
_thread = None


def _union():
    out = set()
    for syms in _watch.values():
        out |= syms
    return out


def _sync_subscriptions(before, after):
    """Move Yahoo's subscription to match what's actually being watched."""
    if _ws is None:
        return
    try:
        if after - before:
            _ws.subscribe(sorted(after - before))
        if before - after:
            _ws.unsubscribe(sorted(before - after))
    except Exception as e:
        print("subscription sync failed: %s" % e)


def _publish(ev):
    for q in list(_clients):
        try:
            q.put_nowait(ev)
        except queue.Full:
            pass       # a wedged client doesn't get to stall the stream


def _on_msg(m):
    sym, price, t = m.get("id"), m.get("price"), m.get("time")
    if not sym or price is None:
        return
    _publish({"symbol": sym, "price": float(price),
              "time": int(t) // 1000 if t else int(time.time())})


def _run():
    global _ws
    import yfinance as yf
    while True:
        try:
            with _lock:
                syms = sorted(_union())
            if not syms:
                time.sleep(2)
                continue
            _ws = yf.WebSocket(verbose=False)
            _ws.subscribe(syms)
            _ws.listen(_on_msg)                  # blocks until the socket drops
        except Exception as e:
            print("yahoo stream: %s — reconnecting" % e)
        finally:
            try:
                _ws.close()
            except Exception:
                pass
            _ws = None
        time.sleep(3)


def _start():
    global _thread
    if _thread is None:
        _thread = threading.Thread(target=_run, daemon=True)
        _thread.start()


@app.post("/api/watch")
def watch():
    body = request.get_json(force=True)
    cid = str(body.get("client") or "anon")
    syms = {s for s in body.get("symbols", []) if isinstance(s, str)}
    # Watchlists are per browser and the socket subscribes to the union, so one
    # viewer opening a chart can't unsubscribe another viewer's symbols.
    with _lock:
        before = _union()
        if syms:
            _watch[cid] = syms
        else:
            _watch.pop(cid, None)
        after = _union()
    _sync_subscriptions(before, after)
    _start()
    return jsonify(ok=True, watching=sorted(after))


@app.get("/api/stream")
def stream():
    cid = request.args.get("client")
    q = queue.Queue(maxsize=200)
    _clients.append(q)

    def gen():
        try:
            yield "retry: 3000\n\n"
            while True:
                try:
                    yield "data: %s\n\n" % json.dumps(q.get(timeout=15))
                except queue.Empty:
                    yield ": keepalive\n\n"
        finally:
            if q in _clients:
                _clients.remove(q)
            if cid:                              # browser closed the tab
                with _lock:
                    before = _union()
                    _watch.pop(cid, None)
                    after = _union()
                _sync_subscriptions(before, after)

    return Response(gen(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ------------------------------------------------------------------- history

@app.get("/api/sources")
def sources():
    return jsonify({
        "step": ds.STEP,
        "sources": {
            name: {"label": fn.label, "symbols": fn.symbols(), "timeframes": fn.timeframes,
                   "live": fn.live, "freeform": fn.freeform}
            for name, fn in ds.SOURCES.items()
        },
    })


@app.get("/api/candles")
def candles():
    a = request.args
    src, symbol, tf = a.get("source"), a.get("symbol"), a.get("tf")
    fn = ds.SOURCES.get(src)
    if not fn or not symbol or tf not in fn.timeframes:
        return jsonify(error="bad source/symbol/tf"), 400
    try:
        limit = min(max(int(a.get("limit", 300)), 1), 5000)
        before = int(a["before"]) if a.get("before") else None
        return jsonify(ds.candles(src, symbol, tf, limit, before))
    except ValueError:
        return jsonify(error="limit and before must be integers"), 400
    except Exception as e:
        return jsonify(error="%s: %s" % (type(e).__name__, e)), 502


# --------------------------------------------------------------------- pages

@app.get("/healthz")
def healthz():
    with _lock:
        watching = len(_union())
    return jsonify(ok=True, browsers=len(_clients), watching=watching,
                   yahoo_socket=_ws is not None)


@app.get("/")
def index():
    return send_from_directory(".", "index.html")


@app.get("/<path:name>")
def asset(name):
    if not name.endswith((".js", ".css")):       # never hand out app.py or the venv
        abort(404)
    return send_from_directory(".", name)


if __name__ == "__main__":   # local dev; production runs under gunicorn (see render.yaml)
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 5001)),
            threaded=True, use_reloader=False)
