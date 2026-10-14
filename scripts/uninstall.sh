#!/usr/bin/env bash
# Undo everything Minimal Home changes on the TV, then remove it. Prints what it would do unless --yes is given.
#   - system "home" default (general.defaultApps.home/idleApp) back to LG's own Home
#   - LG's screensaver back on (the helper only turns it off while the launcher is in front)
#   - boot hook + the helper's root-only copy removed, helper stopped
#   - the app removed (Homebrew Channel / app manager)
# LG Home itself is never touched by the launcher, so nothing has to be restored there.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$ROOT/config.env" ] && . "$ROOT/config.env"
: "${TV_IP:?set TV_IP in config.env}"
YES=0; [ "${1:-}" = "--yes" ] && YES=1
TVT() { "$ROOT/tools/tvt" "$@"; }
step() { echo "== $*"; }
do_tv() { if [ "$YES" = 1 ]; then TVT "$1"; else echo "   would run: $1"; fi; }

step "home default -> LG Home"
cur="$(TVT "luna-send -n 1 -f luna://com.webos.settingsservice/getSystemSettings '{\"category\":\"general\",\"keys\":[\"defaultApps\"]}'" 2>/dev/null)"
payload="$(printf '%s' "$cur" | python3 -c '
import sys, json
t = sys.stdin.read(); d = json.loads(t[t.find("{"):t.rfind("}") + 1])
m = d.get("settings", {}).get("defaultApps", {}) or {}
m = {k: v for k, v in m.items() if v != "tld.my.minimalhome"}
print(json.dumps({"category": "general", "settings": {"defaultApps": m}}))')"
do_tv "luna-send -n 1 luna://com.webos.settingsservice/setSystemSettings '$payload'"
step "LG screensaver on"
do_tv "luna-send -n 1 luna://com.webos.settingsservice/setSystemSettings '{\"category\":\"general\",\"settings\":{\"screenSaverEnabled\":\"on\"}}'"
step "boot hook + helper"
do_tv "rm -f /var/lib/webosbrew/init.d/50-minimalhome; P=\$(cat /tmp/home-svc.pid 2>/dev/null); [ -n \"\$P\" ] && kill \$P; rm -rf /var/lib/webosbrew/minimalhome-helper; echo done"
step "remove the app"
do_tv "luna-send -n 1 -w 30000 luna://com.webos.appInstallService/remove '{\"id\":\"tld.my.minimalhome\"}'"
[ "$YES" = 1 ] || echo "(dry run - run with --yes to apply)"
