#!/usr/bin/env python3
"""Read-only "launcher feed" for the Minimal Home TV launcher.

Summarises Sonarr + Radarr (what airs / releases in the next days, and what is downloading right now) as one small JSON
document, so the TV never needs the (admin-level) API keys: they stay on the server, in this container's environment.

  GET /feed    -> {"generated": ..., "upcoming": [...], "downloading": [...], "errors": [...]}
  GET /health  -> "ok"

Only GET requests are accepted and only GET requests are made upstream. Standard library only. Responses are cached for
CACHE_SECONDS so the TV (or anything else on the LAN) cannot hammer Sonarr/Radarr.
"""
import json
import os
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SONARR_URL = os.environ.get("SONARR_URL", "http://sonarr:8989").rstrip("/")
RADARR_URL = os.environ.get("RADARR_URL", "http://radarr:7878").rstrip("/")
SONARR_KEY = os.environ.get("SONARR_KEY", "")
RADARR_KEY = os.environ.get("RADARR_KEY", "")
PORT = int(os.environ.get("PORT", "8091"))
DAYS = int(os.environ.get("DAYS", "7"))
CACHE_SECONDS = int(os.environ.get("CACHE_SECONDS", "60"))
MAX_UPCOMING, MAX_DOWNLOADING = 8, 6

_cache = {"at": 0.0, "body": b"{}"}
_lock = threading.Lock()


def api(base, key, path, **params):
    url = "%s/api/v3/%s?%s" % (base, path, urllib.parse.urlencode(params))
    req = urllib.request.Request(url, headers={"X-Api-Key": key, "Accept": "application/json"}, method="GET")
    with urllib.request.urlopen(req, timeout=6) as r:
        return json.load(r)


def parse_utc(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build():
    now = datetime.now(timezone.utc)
    start, end = now - timedelta(hours=3), now + timedelta(days=DAYS)
    upcoming, downloading, errors = [], [], []

    def guarded(name, fn):
        try:
            fn()
        except Exception as e:                      # one source failing must not take the whole feed down
            errors.append("%s: %s" % (name, type(e).__name__))

    def sonarr_calendar():
        for e in api(SONARR_URL, SONARR_KEY, "calendar", start=iso(start), end=iso(end), includeSeries="true", unmonitored="false"):
            when = parse_utc(e.get("airDateUtc", ""))
            if not when or e.get("hasFile"):
                continue
            upcoming.append({
                "kind": "episode", "title": (e.get("series") or {}).get("title", "?"),
                "label": "S%02dE%02d" % (e.get("seasonNumber", 0), e.get("episodeNumber", 0)),
                "name": e.get("title", ""), "when": iso(when)})

    def radarr_calendar():
        for m in api(RADARR_URL, RADARR_KEY, "calendar", start=iso(start), end=iso(end), unmonitored="false"):
            if m.get("hasFile"):
                continue
            dates = [parse_utc(m.get(k, "")) for k in ("digitalRelease", "physicalRelease", "inCinemas")]
            dates = [d for d in dates if d and start <= d <= end]
            if dates:
                upcoming.append({"kind": "movie", "title": m.get("title", "?"), "label": "", "name": "", "when": iso(min(dates))})

    def queue(base, key, kind):
        extra = {"includeSeries": "true", "includeEpisode": "true"} if kind == "episode" else {"includeMovie": "true"}
        for q in api(base, key, "queue", page=1, pageSize=20, **extra).get("records", []):
            size, left = q.get("size") or 0, q.get("sizeleft") or 0
            progress = round(1 - left / size, 3) if size else 0
            if kind == "episode":
                ep, ser = q.get("episode") or {}, q.get("series") or {}
                title, label = ser.get("title") or q.get("title", "?"), "S%02dE%02d" % (ep.get("seasonNumber", 0), ep.get("episodeNumber", 0))
            else:
                title, label = (q.get("movie") or {}).get("title") or q.get("title", "?"), ""
            downloading.append({"kind": kind, "title": title, "label": label, "progress": progress,
                                "timeleft": q.get("timeleft", ""), "status": q.get("status", "")})

    if SONARR_KEY:
        guarded("sonarr-calendar", sonarr_calendar)
        guarded("sonarr-queue", lambda: queue(SONARR_URL, SONARR_KEY, "episode"))
    if RADARR_KEY:
        guarded("radarr-calendar", radarr_calendar)
        guarded("radarr-queue", lambda: queue(RADARR_URL, RADARR_KEY, "movie"))

    upcoming.sort(key=lambda x: x["when"])
    downloading.sort(key=lambda x: -x["progress"])
    return {"generated": iso(now), "upcoming": upcoming[:MAX_UPCOMING], "downloading": downloading[:MAX_DOWNLOADING], "errors": errors}


def feed_body():
    with _lock:
        if time.time() - _cache["at"] > CACHE_SECONDS:
            _cache["body"] = json.dumps(build(), ensure_ascii=False).encode("utf-8")
            _cache["at"] = time.time()
        return _cache["body"]


class Handler(BaseHTTPRequestHandler):
    server_version = "launcher-feed"
    sys_version = ""

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")   # read-only, non-sensitive summary
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/feed":
            self._send(200, feed_body())
        elif path == "/health":
            self._send(200, b"ok", "text/plain")
        else:
            self._send(404, b'{"error":"not found"}')

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET")
        self.end_headers()

    def _no(self):
        self._send(405, b'{"error":"read-only"}')
    do_POST = do_PUT = do_DELETE = do_PATCH = _no

    def log_message(self, fmt, *args):                  # keep the container log small, never log query strings
        pass


if __name__ == "__main__":
    print("launcher-feed on :%d (sonarr %s, radarr %s)" % (PORT, "yes" if SONARR_KEY else "no", "yes" if RADARR_KEY else "no"), flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
