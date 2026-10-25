#!/usr/bin/env python3
"""Read-only "launcher feed" for the Minimal Home TV launcher (and Jellyfin Native's "Downloading" row).

Summarises Sonarr + Radarr (what airs / releases in the next days, and what is downloading right now) as one small JSON
document, so the TV never needs the (admin-level) API keys: they stay on the server, in this container's environment.

  GET /feed                       -> {"generated": ..., "upcoming": [...], "downloading": [...], "errors": [...]}
  GET /art/<sonarr|radarr>/<id>/<fanart|fanart-360|poster-500|clearlogo>
                                  -> that series'/film's picture as Sonarr/Radarr cached it (for the download cards)
  GET /storage                    -> {"volumes": [{"path", "free", "total"}], "delete": bool}: the disks holding the media
                                     (bytes), and whether the optional delete below is switched on
  GET /health                     -> "ok"

Optional, off unless ALLOW_DELETE=1 - Jellyfin Native's "Delete" button for a film or a whole series:
  GET  /manage/item?id=<Jellyfin item id>    -> what would be deleted (Sonarr's/Radarr's id and title, size, episode
                                                files) + free space
  POST /manage/delete?id=<Jellyfin item id>&expect=<that Sonarr/Radarr id>
                                             -> deletes it through Sonarr/Radarr (files included, and they stop
                                                downloading it), then removes it from Jellyfin. `expect` must be the id
                                                the preview showed, so nothing else is ever deleted.
Both need the caller's own Jellyfin sign-in (the "Authorization: MediaBrowser ... Token=..." header Jellyfin clients send);
it is checked with Jellyfin and must belong to an administrator. Every delete is logged to the container log.

Downloads: one entry per download (a season pack is one entry, not one per episode). Sonarr/Radarr only ask the download
client for news about once a minute (and right after a grab they don't have any numbers yet), so with QBIT_URL/QBIT_USER/
QBIT_PASS set the feed reads progress, speed and time left straight from qBittorrent (matched by the torrent hash, which
is Sonarr's/Radarr's downloadId). Without it, "progress" is estimated for the moment of the request from their last
numbers and the expected finish time. "eta" is the seconds left from now (null = no estimate yet, e.g. a download that is
just starting) - clients can count down between requests without showing frozen numbers.

Apart from that optional delete, only GET requests are accepted, and only GET requests are made upstream (plus the
qBittorrent sign-in, a POST; the feed only ever reads the torrent list). Standard library only. Responses are cached for
CACHE_SECONDS so the TV (or anything else on the LAN) cannot hammer Sonarr/Radarr/qBittorrent.
"""
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SONARR_URL = os.environ.get("SONARR_URL", "http://sonarr:8989").rstrip("/")
RADARR_URL = os.environ.get("RADARR_URL", "http://radarr:7878").rstrip("/")
SONARR_KEY = os.environ.get("SONARR_KEY", "")
RADARR_KEY = os.environ.get("RADARR_KEY", "")
JELLYFIN_URL = os.environ.get("JELLYFIN_URL", "http://jellyfin:8096").rstrip("/")
ALLOW_DELETE = os.environ.get("ALLOW_DELETE", "0") == "1"
QBIT_URL = os.environ.get("QBIT_URL", "").rstrip("/")
QBIT_USER = os.environ.get("QBIT_USER", "")
QBIT_PASS = os.environ.get("QBIT_PASS", "")
PORT = int(os.environ.get("PORT", "8091"))
DAYS = int(os.environ.get("DAYS", "7"))
CACHE_SECONDS = int(os.environ.get("CACHE_SECONDS", "10"))
MAX_UPCOMING, MAX_DOWNLOADING = 8, 6
# how far past Sonarr's/Radarr's last look at the download client the progress may be extrapolated (they look every ~60 s)
MAX_EXTRAPOLATE = 120
# a torrent without peers yet in its first minutes is starting, not stalled
STARTING_SECONDS = 180

_cache = {"at": 0.0, "body": b"{}"}
_lock = threading.Lock()
ART_PATH = re.compile(r"^/art/(sonarr|radarr)/(\d{1,9})/(fanart|fanart-360|poster-500|clearlogo)$")


def request(base, key, path, **params):
    url = "%s/api/v3/%s" % (base, path) + ("?" + urllib.parse.urlencode(params) if params else "")
    return urllib.request.Request(url, headers={"X-Api-Key": key, "Accept": "application/json"}, method="GET")


def api(base, key, path, **params):
    with urllib.request.urlopen(request(base, key, path, **params), timeout=6) as r:
        return json.load(r)


def parse_utc(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def span_seconds(s):
    """Sonarr/Radarr time spans: "01:03:46" or "1.02:03:04" (days.hours:minutes:seconds)."""
    m = re.match(r"^(?:(\d+)\.)?(\d+):(\d+):(\d+)", s or "")
    if not m:
        return None
    d, h, mi, se = (int(x or 0) for x in m.groups())
    return ((d * 24 + h) * 60 + mi) * 60 + se


def state_of(q):
    """One word a client can show: downloading, queued, paused, stalled, importing, blocked, failed, warning, done."""
    tracked, status = q.get("trackedDownloadState", ""), (q.get("status") or "").lower()
    if tracked == "importBlocked" or (tracked == "importPending" and q.get("trackedDownloadStatus") == "warning"):
        return "blocked"                            # finished but Sonarr/Radarr won't import it (e.g. a fake .exe release)
    if tracked in ("importPending", "importing", "imported"):
        return "importing"
    if tracked in ("failed", "failedPending") or status == "failed":
        return "failed"
    if status in ("queued", "delay"):
        return "queued"
    if status == "paused":
        return "paused"
    if status == "completed":
        return "done"
    if q.get("trackedDownloadStatus") == "warning" or status == "warning":
        msgs = " ".join(m for sm in q.get("statusMessages") or [] for m in sm.get("messages") or [])
        return "stalled" if "stall" in msgs.lower() else "warning"
    return "downloading"


# ---- qBittorrent (optional): live numbers for the downloads ----
_qb = {"sid": "", "failed_at": 0.0}             # sid = the session cookie, "name=value"
_qb_lock = threading.Lock()


def qb_login():
    """Sign in once and keep the session; after a failure wait a minute (qBittorrent bans IPs after repeated failures)."""
    if time.time() - _qb["failed_at"] < 60:
        return False
    body = urllib.parse.urlencode({"username": QBIT_USER, "password": QBIT_PASS}).encode()
    req = urllib.request.Request(QBIT_URL + "/api/v2/auth/login", data=body, method="POST",
                                 headers={"Referer": QBIT_URL, "Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=6) as r:
            # the session cookie: "SID" up to qBittorrent 4, "QBT_SID_<port>" (and an empty 204 answer) since 5
            m = re.search(r"((?:QBT_)?SID(?:_\d+)?=[^;]+)", r.headers.get("Set-Cookie", ""))
            if m and (r.status == 204 or r.read().strip() == b"Ok."):
                _qb["sid"] = m.group(1)
                return True
    except Exception:
        pass
    _qb["sid"], _qb["failed_at"] = "", time.time()
    return False


def qb_torrents(hashes):
    """{lower-case hash: torrent} for these hashes, {} when qBittorrent isn't set up or doesn't answer."""
    if not (QBIT_URL and QBIT_USER and hashes):
        return {}
    url = QBIT_URL + "/api/v2/torrents/info?" + urllib.parse.urlencode({"hashes": "|".join(sorted(hashes))})
    with _qb_lock:
        for _ in range(2):                          # once more after signing in again (the session expired)
            if not _qb["sid"] and not qb_login():
                return {}
            req = urllib.request.Request(url, headers={"Cookie": _qb["sid"], "Referer": QBIT_URL})
            try:
                with urllib.request.urlopen(req, timeout=6) as r:
                    return {t.get("hash", "").lower(): t for t in json.load(r)}
            except urllib.error.HTTPError as e:
                if e.code != 403:
                    return {}
                _qb["sid"] = ""
            except Exception:
                return {}
    return {}


def qb_live(t, now):
    """(state, progress, eta) from a qBittorrent torrent, or None to keep Sonarr's/Radarr's view."""
    st, progress = t.get("state", ""), float(t.get("progress") or 0)
    speed, eta = t.get("dlspeed") or 0, t.get("eta")
    eta = int(eta) if speed > 0 and isinstance(eta, int) and 0 <= eta < 8640000 else None   # 8640000 = qBittorrent's "infinite"
    young = now.timestamp() - (t.get("added_on") or 0) < STARTING_SECONDS
    if progress >= 1 or st in ("uploading", "stalledUP", "queuedUP", "forcedUP", "pausedUP", "stoppedUP", "checkingUP"):
        return "importing", 1.0, 0                  # downloaded; Sonarr/Radarr pick it up within a minute
    if st in ("downloading", "forcedDL"):
        return "downloading", progress, eta
    if st in ("metaDL", "forcedMetaDL", "allocating", "checkingDL", "checkingResumeData", "moving") or (st == "stalledDL" and young):
        return "downloading", progress, None        # starting: no numbers yet
    if st == "stalledDL":
        return "stalled", progress, None
    if st == "queuedDL":
        return "queued", progress, None
    if st in ("pausedDL", "stoppedDL"):
        return "paused", progress, None
    return None                                     # error, missingFiles, unknown: Sonarr's/Radarr's message says more


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
        groups = {}                                 # downloadId -> records (a season pack is many records, one download)
        for q in api(base, key, "queue", page=1, pageSize=250, **extra).get("records", []):   # a season pack is one record per episode
            groups.setdefault(q.get("downloadId") or str(q.get("id")), []).append(q)
        torrents = qb_torrents({did.lower() for did in groups if re.fullmatch(r"[0-9a-fA-F]{40}", did)})   # torrent hashes
        for did, recs in groups.items():
            q = recs[0]
            size, left = q.get("size") or 0, q.get("sizeleft") or 0
            progress = 1 - left / size if size else 0.0
            state = state_of(q)
            secs, done_at = span_seconds(q.get("timeleft", "")), parse_utc(q.get("estimatedCompletionTime") or "")
            eta = None
            t = torrents.get(did.lower())
            live = qb_live(t, now) if t and state in ("downloading", "queued", "stalled", "warning", "paused") else None
            if live:                                # qBittorrent's own numbers, as of now
                state, progress, eta = live
                size = t.get("size") or size
            elif state == "downloading" and secs and done_at:
                # Sonarr/Radarr computed timeleft when they last asked the download client: done_at - timeleft is that
                # moment. Carry the progress forward at the same rate to now (bounded), and give the time left from now.
                looked = done_at - timedelta(seconds=secs)
                since = min(max((now - looked).total_seconds(), 0), MAX_EXTRAPOLATE)
                progress += (1 - progress) * min(since / secs, 1.0)
                eta = max(int((done_at - now).total_seconds()), 0)
            if kind == "episode":
                ser = q.get("series") or {}
                eps = sorted({((r.get("episode") or {}).get("seasonNumber", 0), (r.get("episode") or {}).get("episodeNumber", 0)) for r in recs})
                seasons = sorted({s for s, _ in eps})
                if len(eps) == 1:
                    label = "S%02dE%02d" % eps[0]
                elif len(seasons) == 1:
                    label = "S%02d · %d episodes" % (seasons[0], len(eps))
                else:
                    label = "%d episodes" % len(eps)
                title, item, sid = ser.get("title") or q.get("title", "?"), ser, q.get("seriesId")
                name = (q.get("episode") or {}).get("title", "") if len(eps) == 1 else ""
                art_kind = "sonarr"
            else:
                item = q.get("movie") or {}
                title, label, sid, name, art_kind = item.get("title") or q.get("title", "?"), "", q.get("movieId"), "", "radarr"
            covers = {i.get("coverType") for i in item.get("images") or []}
            art = lambda t: "/art/%s/%d/%s" % (art_kind, sid, t) if sid else ""
            downloading.append({
                "id": did.lower()[:16], "kind": kind, "title": title, "label": label, "name": name,
                "progress": round(min(progress, 1.0), 4), "eta": eta, "state": state, "size": size,
                # kept for older launcher builds
                "timeleft": q.get("timeleft", ""), "status": q.get("status", ""),
                "year": item.get("year") or None, "overview": (item.get("overview") or "")[:600],
                "fanart": art("fanart"), "thumb": art("fanart-360"), "poster": art("poster-500"),
                "logo": art("clearlogo") if "clearlogo" in covers else ""})

    if SONARR_KEY:
        guarded("sonarr-calendar", sonarr_calendar)
        guarded("sonarr-queue", lambda: queue(SONARR_URL, SONARR_KEY, "episode"))
    if RADARR_KEY:
        guarded("radarr-calendar", radarr_calendar)
        guarded("radarr-queue", lambda: queue(RADARR_URL, RADARR_KEY, "movie"))

    upcoming.sort(key=lambda x: x["when"])
    downloading.sort(key=lambda x: -x["progress"])
    return {"generated": iso(now), "upcoming": upcoming[:MAX_UPCOMING], "downloading": downloading[:MAX_DOWNLOADING], "errors": errors}


_storage = {"at": 0.0, "body": b"{}"}


def storage():
    """The disks behind Sonarr's/Radarr's root folders (the media library), from their own disk-space report."""
    vols, roots = {}, []
    for base, key in ((SONARR_URL, SONARR_KEY), (RADARR_URL, RADARR_KEY)):
        if not key:
            continue
        roots += [r.get("path", "") for r in api(base, key, "rootfolder")]
        for d in api(base, key, "diskspace"):
            vols[d.get("path", "")] = d
    out = {}
    for root in roots:
        # the most specific mount that contains this root folder
        best = max((p for p in vols if p and (root == p or root.startswith(p.rstrip("/") + "/"))), key=len, default=None)
        if best and best not in out:
            out[best] = {"path": best, "free": vols[best].get("freeSpace", 0), "total": vols[best].get("totalSpace", 0)}
    return {"volumes": list(out.values()), "delete": ALLOW_DELETE}


def storage_body():
    with _lock:
        if time.time() - _storage["at"] > 30:
            try:
                _storage["body"] = json.dumps(storage()).encode("utf-8")
            except Exception as e:
                _storage["body"] = json.dumps({"volumes": [], "delete": ALLOW_DELETE, "error": type(e).__name__}).encode("utf-8")
            _storage["at"] = time.time()
        return _storage["body"]


# ---- optional delete (ALLOW_DELETE=1) ----
class Refused(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code, self.msg = code, msg


def jellyfin(path, auth, method="GET", body=None):
    req = urllib.request.Request(JELLYFIN_URL + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": auth, "Accept": "application/json", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=8) as r:
        raw = r.read()
        return json.loads(raw) if raw else None


def arr_call(base, key, method, path, **params):
    req = request(base, key, path, **params)
    req.method = method
    with urllib.request.urlopen(req, timeout=120) as r:       # a big series takes a while to delete
        raw = r.read()
        return json.loads(raw) if raw else None


def resolve(item_id, auth):
    """(user name, Jellyfin item, "sonarr"|"radarr", the arr's record) - or Refused."""
    if not ALLOW_DELETE:
        raise Refused(403, "deleting is switched off on the server (ALLOW_DELETE)")
    if not re.fullmatch(r"[0-9a-fA-F-]{32,36}", item_id or ""):
        raise Refused(400, "bad item id")
    if not auth or "Token=" not in auth:
        raise Refused(401, "sign-in missing")
    try:
        me = jellyfin("/Users/Me", auth)
    except urllib.error.HTTPError:
        raise Refused(401, "Jellyfin didn't accept this sign-in")
    if not (me.get("Policy") or {}).get("IsAdministrator"):
        raise Refused(403, "only a Jellyfin administrator can delete")
    item = jellyfin("/Items/%s?userId=%s&fields=Path,ProviderIds" % (item_id, me["Id"]), auth)
    kind, path, ids = item.get("Type"), (item.get("Path") or "").rstrip("/"), {k.lower(): v for k, v in (item.get("ProviderIds") or {}).items()}
    # the same folder is the surest match; the TVDB/TMDB id only when no folder matches (Jellyfin and Sonarr/Radarr
    # seeing the media under different paths)
    if kind == "Series" and SONARR_KEY:
        app, recs, folder, idkey, ours = "sonarr", api(SONARR_URL, SONARR_KEY, "series"), path, "tvdbId", ids.get("tvdb")
    elif kind == "Movie" and RADARR_KEY:
        app, recs, folder, idkey, ours = "radarr", api(RADARR_URL, RADARR_KEY, "movie"), os.path.dirname(path), "tmdbId", ids.get("tmdb")
    else:
        raise Refused(400, "only a film or a whole series can be deleted")
    found = [r for r in recs if folder and (r.get("path") or "").rstrip("/") == folder]
    if not found and ours:
        found = [r for r in recs if str(r.get(idkey)) == ours]
    if len(found) != 1:
        raise Refused(404, "Sonarr/Radarr don't manage this title" if not found else "more than one Sonarr/Radarr title matches - delete it there")
    return me.get("Name", "?"), item, app, found[0]


def summary(app, rec):
    st = rec.get("statistics") or {}
    if app == "sonarr":
        size, files = st.get("sizeOnDisk", 0), st.get("episodeFileCount", 0)
        seasons = len([x for x in rec.get("seasons") or [] if (x.get("statistics") or {}).get("episodeFileCount")])
    else:
        size, files, seasons = rec.get("sizeOnDisk") or (rec.get("movieFile") or {}).get("size", 0), 1 if rec.get("hasFile") else 0, 0
    return {"app": app, "id": rec.get("id"), "title": rec.get("title", "?"), "year": rec.get("year"), "size": size, "files": files, "seasons": seasons}


def manage(action, item_id, auth, expect=""):
    try:
        user, item, app, rec = resolve(item_id, auth)
        out = summary(app, rec)
        if action == "item":
            out["volumes"] = json.loads(storage_body()).get("volumes", [])
            return 200, out
        if expect != str(rec.get("id")):
            raise Refused(409, "what would be deleted has changed - open the title again")
        base, key = (SONARR_URL, SONARR_KEY) if app == "sonarr" else (RADARR_URL, RADARR_KEY)
        excl = "addImportListExclusion" if app == "sonarr" else "addImportExclusion"
        arr_call(base, key, "DELETE", "%s/%d" % ("series" if app == "sonarr" else "movie", rec["id"]), deleteFiles="true", **{excl: "false"})
        print("delete: %s deleted %s %r (%s id %d, %.1f GB)" % (user, item.get("Type"), out["title"], app, rec["id"], out["size"] / 1e9), flush=True)
        # Jellyfin notices the folder vanishing by itself, but only after its library monitor delay (~1 min) - until then
        # clients still list it. The files are gone now, so removing the item from Jellyfin's library is immediate and
        # deletes nothing more (Jellyfin usually has the media read-only anyway). If that fails, report the path instead.
        try:
            jellyfin("/Items/%s" % item_id, auth, "DELETE")
        except Exception as e:
            print("delete: jellyfin item removal failed (%s), reporting the path instead" % type(e).__name__, flush=True)
            try:
                gone = (rec.get("path") or "").rstrip("/")
                jellyfin("/Library/Media/Updated", auth, "POST", {"Updates": [{"Path": gone, "UpdateType": "Deleted"}]})
            except Exception as e2:
                print("delete: jellyfin notify failed: %s" % type(e2).__name__, flush=True)
        with _lock:
            _storage["at"] = 0.0
            _cache["at"] = 0.0
        return 200, out
    except Refused as r:
        return r.code, {"error": r.msg}
    except Exception as e:
        print("manage %s: %s" % (action, type(e).__name__), flush=True)
        return 502, {"error": "the server couldn't do that (%s)" % type(e).__name__}


def feed_body():
    with _lock:
        if time.time() - _cache["at"] > CACHE_SECONDS:
            _cache["body"] = json.dumps(build(), ensure_ascii=False).encode("utf-8")
            _cache["at"] = time.time()
        return _cache["body"]


def art(app, item_id, name):
    """(status, body, content type) of a cached cover from Sonarr/Radarr. The path was matched by ART_PATH."""
    base, key = (SONARR_URL, SONARR_KEY) if app == "sonarr" else (RADARR_URL, RADARR_KEY)
    if not key:
        return 404, b'{"error":"not found"}', "application/json"
    ext = "png" if name == "clearlogo" else "jpg"
    try:
        with urllib.request.urlopen(request(base, key, "mediacover/%s/%s.%s" % (item_id, name, ext)), timeout=8) as r:
            ctype = r.headers.get("Content-Type", "")
            if not ctype.startswith("image/"):
                return 404, b'{"error":"not found"}', "application/json"
            return 200, r.read(8 << 20), ctype
    except urllib.error.HTTPError:
        return 404, b'{"error":"not found"}', "application/json"
    except Exception:
        return 502, b'{"error":"upstream"}', "application/json"


class Handler(BaseHTTPRequestHandler):
    server_version = "launcher-feed"
    sys_version = ""

    def _send(self, code, body, ctype="application/json; charset=utf-8", cache="no-store"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("Access-Control-Allow-Origin", "*")   # read-only, non-sensitive summary
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        m = ART_PATH.match(path)
        if path == "/feed":
            self._send(200, feed_body())
        elif path == "/storage":
            self._send(200, storage_body())
        elif path == "/manage/item":
            self._manage("item")
        elif m:
            code, body, ctype = art(*m.groups())
            self._send(code, body, ctype, "max-age=3600" if code == 200 else "no-store")
        elif path == "/health":
            self._send(200, b"ok", "text/plain")
        else:
            self._send(404, b'{"error":"not found"}')

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET")
        self.end_headers()

    def _manage(self, action):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        code, out = manage(action, (q.get("id") or [""])[0], self.headers.get("Authorization", ""), (q.get("expect") or [""])[0])
        self._send(code, json.dumps(out, ensure_ascii=False).encode("utf-8"))

    def do_POST(self):
        if urllib.parse.urlparse(self.path).path == "/manage/delete":
            self._manage("delete")
        else:
            self._no()

    def _no(self):
        self._send(405, b'{"error":"read-only"}')
    do_PUT = do_DELETE = do_PATCH = _no

    def log_message(self, fmt, *args):                  # keep the container log small, never log query strings
        pass


if __name__ == "__main__":
    print("launcher-feed on :%d (sonarr %s, radarr %s, qbittorrent %s, delete %s)" % (PORT, "yes" if SONARR_KEY else "no", "yes" if RADARR_KEY else "no",
          "yes" if QBIT_URL and QBIT_USER else "no", "on" if ALLOW_DELETE else "off"), flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
