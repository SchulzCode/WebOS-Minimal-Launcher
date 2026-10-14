#!/bin/sh
# Boot hook (Homebrew Channel runs /var/lib/webosbrew/init.d/* as root at every cold boot). Starts the launcher's
# helper service with --boot, which brings Minimal Home to the foreground, and --watch (HOME key, wake, Back).
# Backgrounds the daemon and returns at once, so boot isn't blocked.
#
# SECURITY: this runs as root, so it only ever runs from a root-owned copy that nobody else can write
# (scripts/rebuild-all.sh "post" step: /var/lib/webosbrew/minimalhome-helper). App folders under /media/developer are
# world-writable on webOS - running the helper from there would let any app replace it and get root.
# Disable: remove /var/lib/webosbrew/init.d/50-minimalhome.
SVCDIR=$(dirname "$(readlink -f "$0")")
case "$SVCDIR" in /media/*) echo "minimalhome: refusing to run from the world-writable app folder ($SVCDIR)" >&2; exit 1;; esac
[ -f "$SVCDIR/service.js" ] || exit 0
# refuse if the folder or any file in it could have been changed by anyone but root
if [ "$(stat -c '%u' "$SVCDIR")" != 0 ] || [ -n "$(find "$SVCDIR" -maxdepth 1 \( ! -user root -o -perm -020 -o -perm -002 \) -print 2>/dev/null)" ]; then
	echo "minimalhome: $SVCDIR is not root-only, not starting" >&2; exit 1
fi
# stop a previous watcher - only if the recorded PID still IS one (a stale PID file may point at another process by now)
OLD=$(cat /tmp/home-svc.pid 2>/dev/null)
if [ -n "$OLD" ] && [ -r "/proc/$OLD/cmdline" ] && tr '\0' ' ' < "/proc/$OLD/cmdline" 2>/dev/null | grep -q 'service.js\|minimalhome.service'; then
	for C in $(pgrep -P "$OLD" 2>/dev/null); do kill "$C" 2>/dev/null; done   # its luna-send watchers
	kill -9 "$OLD" 2>/dev/null
fi
# orphaned luna-send watchers of a helper that was killed elsewhere (e.g. by the installer)
for C in $(pgrep -P 1 -f 'luna-send -i .*(getForegroundAppInfo|getPowerState)' 2>/dev/null); do kill "$C" 2>/dev/null; done
export NODE_PATH=/usr/lib/node_modules:/usr/lib/nodejs
cd "$SVCDIR"
setsid /usr/bin/node service.js ${HELPER_ARGS:---boot --watch} </dev/null >/tmp/home-svc.stdout 2>&1 &
exit 0
