#!/usr/bin/env bash
# Rebuild and (re)install everything on the TV from scratch:
#   build      build Minimal Home (app + helper service) and package it -> release/  (RELEASE=1: for publishing)
#   install    install the package through Homebrew Channel
#              (Jellyfin Native, which the cards open, has its own repo + scripts/deploy.sh: webos-jellyfin-native)
#   post       copy the helper to a root-only folder ($HELPER_DIR) + boot hook (/var/lib/webosbrew/init.d/50-minimalhome)
#   settings   make Minimal Home the system "home" default (defaultApps.home) - the helper keeps the boot-landing settings
#   feed       (opt-in) deploy/update the read-only Sonarr/Radarr feed on the server
#   arm        (re)start the helper service now
#   verify     print a health summary (never changes anything)
# Optional: --with-telemetry-block (+ reapply the LG ad/telemetry host block hook)
#           --with-no-voice (+ boot hook that switches off voice input / the remote's microphone)
#           --with-feed (+ deploy/update the read-only Sonarr/Radarr feed on the server, see server/launcher-feed)
# Everything is idempotent. Settings come from config.env (copy config.example.env); nothing secret is stored here.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$ROOT/config.env" ] && . "$ROOT/config.env"
: "${TV_IP:?set TV_IP in config.env (copy config.example.env)}" "${TV_SSH_KEY:=$HOME/.ssh/id_rsa}" "${TV_KNOWN_HOSTS:=}" "${PC_HTTP_PORT:=1759}"
# this computer as the TV sees it (the TV downloads the package from here)
: "${PC_IP:=$(ip route get "$TV_IP" 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')}"
ARES="${ARES_PACKAGE:-ares-package}"
SCP_KH=(); [ -n "$TV_KNOWN_HOSTS" ] && SCP_KH=(-o "UserKnownHostsFile=$TV_KNOWN_HOSTS")
REL="$ROOT/release"
APP_ID=tld.my.minimalhome
SVC_DIR=/media/developer/apps/usr/palm/services/$APP_ID.service
# the helper runs as root at boot, so it runs from a root-only copy (the app folder is world-writable on webOS)
HELPER_DIR=/var/lib/webosbrew/minimalhome-helper
export TV_IP TV_SSH_KEY TV_KNOWN_HOSTS

DRY=0; ONLY=""; WITH_TELEMETRY=0; WITH_FEED=0; WITH_NOVOICE=0
usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; cat <<'EOF'

Usage: scripts/rebuild-all.sh [--dry-run] [--only STEP] [--with-telemetry-block] [--with-no-voice]
  --dry-run               print what would happen, change nothing
  --only STEP             run just one step (build, install, post, settings, arm, verify)
  --setup                 only the TV setup (post, settings, arm, verify) - after installing a release .ipk
  --with-telemetry-block  also (re)install the telemetry host-block boot hook (tv-hooks/)
  --with-no-voice         also (re)install the boot hook that switches off voice input (tv-hooks/61-no-voice)
  --with-feed             also deploy/update the launcher feed on the server (needs SERVER_* in config.env)
EOF
}
while [ $# -gt 0 ]; do case "$1" in
	--dry-run) DRY=1;; --only) ONLY="${2:-}"; shift;; --setup) ONLY=setup;;
	--with-telemetry-block) WITH_TELEMETRY=1;; --with-no-voice) WITH_NOVOICE=1;; --with-feed) WITH_FEED=1;; -h|--help) usage; exit 0;;
	*) echo "unknown option: $1" >&2; usage >&2; exit 2;; esac; shift; done

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then echo "   [dry-run] $*"; else "$@"; fi; }
TV()  { "$ROOT/tools/tv" "$@"; }      # ssh, non-interactive
TVT() { "$ROOT/tools/tvt" "$@"; }     # ssh -tt (luna-send needs a tty)
want() { if [ "$ONLY" = setup ]; then case "$1" in post|settings|arm|verify) return 0;; *) return 1;; esac; fi; [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

ensure_ares() {
	command -v "$ARES" >/dev/null 2>&1 && return
	ARES="$ROOT/tools/ares/node_modules/.bin/ares-package"
	[ -x "$ARES" ] && return
	echo "ares-package not found - installing @webos-tools/cli into tools/ares"
	run npm i --no-audit --no-fund --prefix "$ROOT/tools/ares" @webos-tools/cli
}

install_ipk() {   # install one .ipk through the Homebrew Channel install service
	local ipk="$1" name hash srv out; name="$(basename "$ipk")"; hash="$(sha256sum "$ipk" | cut -d' ' -f1)"
	echo "   installing $name"
	[ "$DRY" = 1 ] && return
	python3 -m http.server "$PC_HTTP_PORT" --bind "$PC_IP" --directory "$(dirname "$ipk")" >/dev/null 2>&1 & srv=$!
	sleep 1
	out="$(TVT "timeout 150 luna-send -i -f luna://org.webosbrew.hbchannel.service/install '{\"ipkUrl\":\"http://$PC_IP:$PC_HTTP_PORT/$name\",\"ipkHash\":\"$hash\",\"subscribe\":true}'" 2>&1 || true)"
	kill "$srv" 2>/dev/null || true; wait "$srv" 2>/dev/null || true
	echo "$out" | grep -q '"finished": true' || { echo "   INSTALL FAILED for $name:"; echo "$out" | tail -5; exit 1; }
}

latest_ipk() { ls -t "$REL"/"$1"_*_all.ipk 2>/dev/null | head -1; }

# ------------------------------------------------------------------------------------------------ steps
step_build() {
	say "build Minimal Home (app + helper service)"
	ensure_ares
	run mkdir -p "$REL"
	( cd "$ROOT/app" && run npm ci --no-audit --no-fund && run npm run typecheck && run npm run build )
	run "$ARES" "$ROOT/app/dist" "$ROOT/app/service" -o "$REL" --no-minify
	if [ "$DRY" = 0 ]; then echo "   -> $(latest_ipk $APP_ID)$([ "${RELEASE:-0}" = 1 ] && echo '  (RELEASE: no local .env baked in)')"; fi
	return 0
}

step_install() {
	say "install packages on the TV ($TV_IP)"
	if [ "$DRY" = 1 ]; then
		echo "   [dry-run] install latest $APP_ID ipk"
		return 0
	fi
	TV true >/dev/null 2>&1 || { echo "TV not reachable over SSH (config.env: TV_IP / TV_SSH_KEY)"; exit 1; }
	install_ipk "$(latest_ipk $APP_ID)"
	return 0
}

step_post() {
	say "permissions + boot hook"
	run TV "set -e; rm -rf $HELPER_DIR.new; mkdir -p $HELPER_DIR.new; cp $SVC_DIR/service.js $SVC_DIR/package.json $SVC_DIR/services.json $SVC_DIR/autostart.sh $HELPER_DIR.new/; chown -R root:root $HELPER_DIR.new; chmod 755 $HELPER_DIR.new $HELPER_DIR.new/autostart.sh; chmod 644 $HELPER_DIR.new/service.js $HELPER_DIR.new/package.json $HELPER_DIR.new/services.json; rm -rf $HELPER_DIR; mv $HELPER_DIR.new $HELPER_DIR; mkdir -p /var/lib/webosbrew/init.d; ln -sfn $HELPER_DIR/autostart.sh /var/lib/webosbrew/init.d/50-minimalhome; ls -l /var/lib/webosbrew/init.d | tail -n +2"
	if [ "$WITH_TELEMETRY" = 1 ]; then
		say "telemetry host-block hook"
		run TV "mkdir -p /var/lib/webosbrew/telemetry-block"
		run scp -O -q -i "$TV_SSH_KEY" -o BatchMode=yes "${SCP_KH[@]}" "$ROOT/tv-hooks/telemetry-block/hosts.txt" "root@$TV_IP:/var/lib/webosbrew/telemetry-block/hosts.txt"
		run scp -O -q -i "$TV_SSH_KEY" -o BatchMode=yes "${SCP_KH[@]}" "$ROOT/tv-hooks/60-telemetry-block" "root@$TV_IP:/var/lib/webosbrew/init.d/60-telemetry-block"
		run TV "chmod 755 /var/lib/webosbrew/init.d/60-telemetry-block; chown root:root /var/lib/webosbrew/init.d/60-telemetry-block /var/lib/webosbrew/telemetry-block/hosts.txt; sh /var/lib/webosbrew/init.d/60-telemetry-block"
	fi
	if [ "$WITH_NOVOICE" = 1 ]; then
		say "no-voice hook (voice input / remote microphone off)"
		run scp -O -q -i "$TV_SSH_KEY" -o BatchMode=yes "${SCP_KH[@]}" "$ROOT/tv-hooks/61-no-voice" "root@$TV_IP:/var/lib/webosbrew/init.d/61-no-voice"
		run TV "chmod 755 /var/lib/webosbrew/init.d/61-no-voice; chown root:root /var/lib/webosbrew/init.d/61-no-voice; sh /var/lib/webosbrew/init.d/61-no-voice"
	fi
}

step_settings() {
	say "system 'home' default -> $APP_ID (keeps every other defaultApps entry)"
	[ "$DRY" = 1 ] && { echo "   [dry-run] read general.defaultApps, add home=$APP_ID, write back"; return; }
	local payload
	payload="$(TVT "luna-send -n 1 -f luna://com.webos.settingsservice/getSystemSettings '{\"category\":\"general\",\"keys\":[\"defaultApps\"]}'" 2>/dev/null | python3 -c '
import sys, json
t = sys.stdin.read(); d = json.loads(t[t.find("{"):t.rfind("}") + 1])
m = d.get("settings", {}).get("defaultApps", {}) or {}
m["home"] = "tld.my.minimalhome"
print(json.dumps({"category": "general", "settings": {"defaultApps": m}}))')"
	TVT "luna-send -n 1 -f luna://com.webos.settingsservice/setSystemSettings '$payload'" 2>/dev/null | grep -q '"returnValue": true' && echo "   ok: $payload" || { echo "   FAILED to set the home default"; exit 1; }
}

step_feed() {
	say "launcher feed on the server (Sonarr/Radarr summary for the coming-up strip)"
	run "$ROOT/server/launcher-feed/deploy.sh"
	return 0
}

step_arm() {
	say "(re)start the helper service"
	run TV "sh $HELPER_DIR/autostart.sh; echo armed-rc=\$?"
	[ "$DRY" = 1 ] || sleep 10
}

step_verify() {
	say "verify (read-only)"
	TV 'P=$(cat /tmp/home-svc.pid 2>/dev/null); echo "helper: pid=$P  cmd=$(tr "\0" " " < /proc/$P/cmdline 2>/dev/null)"; echo "watcher children: $(ps -eo ppid,args | grep -c "^ *$P .*luna-send -i")  (expect 2)"; echo "boot hooks: $(ls /var/lib/webosbrew/init.d | tr "\n" " ")"; tail -3 /tmp/home-svc.log | cut -c1-140' 2>&1 | grep -v -E "post-quantum|store now|server may need" || true
	echo "installed apps:"
	TVT 'luna-send -n 1 -f luna://com.webos.applicationManager/listApps "{}"' 2>/dev/null | python3 -c '
import sys, json
t = sys.stdin.read(); d = json.loads(t[t.find("{"):t.rfind("}") + 1])
for a in d["apps"]:
    if a["id"] in ("tld.my.minimalhome", "tld.my.jfnative"): print("  ", a["id"], a.get("version"), "category:", a.get("appCategory"))' || true
	echo "system settings:"
	TVT 'luna-send -n 1 -f luna://com.webos.settingsservice/getSystemSettings "{\"category\":\"general\",\"keys\":[\"defaultApps\",\"lastInputApp\",\"physicalLastInputApp\"]}"' 2>/dev/null | tr -s ' \n' ' ' | sed 's/^/   /'; echo
}

for s in build install post settings feed arm verify; do
	if [ "$s" = feed ] && [ "$WITH_FEED" = 0 ] && [ "$ONLY" != feed ]; then continue; fi
	if want "$s"; then "step_$s"; fi
done
say "done"
