#!/usr/bin/env bash
# Deploy (or update) the launcher feed on the server. Safe to re-run.
#   server/launcher-feed/deploy.sh
# Needs SSH access to the server (config.env: SERVER_SSH, SERVER_KEY). The Sonarr/Radarr API keys are read on the server from
# their own config.xml straight into feed.env (mode 0600) - they are never printed and never leave the server.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
[ -f "$ROOT/config.env" ] && . "$ROOT/config.env"
: "${SERVER_SSH:?set SERVER_SSH (user@server) in config.env}" "${SERVER_KEY:=$HOME/.ssh/id_ed25519}" "${SERVER_DIR:?set SERVER_DIR (a folder on the server) in config.env}"
: "${FEED_BIND:?set FEED_BIND (the server LAN address) in config.env}" "${ARR_NETWORK:?set ARR_NETWORK in config.env}"
SSH=(ssh -i "$SERVER_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o LogLevel=ERROR "$SERVER_SSH")
DEST="$SERVER_DIR"

"${SSH[@]}" "mkdir -p '$DEST'"
scp -q -i "$SERVER_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o LogLevel=ERROR "$HERE/feed.py" "$HERE/docker-compose.yml" "$SERVER_SSH:$DEST/"

"${SSH[@]}" FEED_BIND="$FEED_BIND" ARR_NETWORK="$ARR_NETWORK" FEED_ALLOW_DELETE="${FEED_ALLOW_DELETE:-0}" bash -s "$DEST" <<'REMOTE'
set -euo pipefail
DEST="$1"; cd "$DEST"
umask 077
key() { docker exec "$1" sh -c "grep -o '<ApiKey>[^<]*' /config/config.xml | cut -d'>' -f2"; }
if [ ! -s feed.env ]; then
	S="$(key sonarr)"; R="$(key radarr)"
	[ -n "$S" ] && [ -n "$R" ] || { echo "could not read the arr API keys"; exit 1; }
	printf 'SONARR_KEY=%s\nRADARR_KEY=%s\n' "$S" "$R" > feed.env
	echo "feed.env created (keys: sonarr ${#S} chars, radarr ${#R} chars - not shown)"
fi
# the optional delete for Jellyfin Native (FEED_ALLOW_DELETE=1 in config.env; admins only, see feed.py)
grep -v '^ALLOW_DELETE=' feed.env > feed.env.new || true
echo "ALLOW_DELETE=$FEED_ALLOW_DELETE" >> feed.env.new
mv feed.env.new feed.env
chmod 600 feed.env
docker compose up -d --force-recreate 2>&1 | tail -3
sleep 4
echo "container: $(docker inspect launcher-feed --format '{{.State.Status}}')"
echo "health:    $(curl -s -m 5 http://$FEED_BIND:8091/health)"
REMOTE
