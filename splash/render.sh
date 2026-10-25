#!/usr/bin/env bash
# Render the launch splashes (1920x1080 PNG) for every app in splash.html's APPS list into splash/out/.
# Needs Firefox and the launcher's node_modules (Inter font). Then copy them where they belong:
#   minimalhome -> app/public/splash.png     bootsplash -> bootsplash/splash.png (bootsplash/build.sh does it)
#   jfnative -> webos-jellyfin-native/pkg/splash.png
#   youtube / twitch / moonlight / homebrew  -> the file named by splashBackground in that app's appinfo.json
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
PROF=$(mktemp -d); trap 'rm -rf "$PROF"' EXIT
# file:// pages may only load the font from another folder with this switched off
echo 'user_pref("security.fileuri.strict_origin_policy", false);' > "$PROF/user.js"
mkdir -p "$DIR/out"
for app in ${*:-jfnative youtube twitch moonlight homebrew minimalhome}; do
	firefox --headless --no-remote --profile "$PROF" --window-size=1920,1080 \
		--screenshot "$DIR/out/$app.rgba.png" "file://$DIR/splash.html?app=$app" >/dev/null 2>&1
	python3 -c 'import sys; from PIL import Image; Image.open(sys.argv[1]).convert("RGB").save(sys.argv[2], optimize=True)' \
		"$DIR/out/$app.rgba.png" "$DIR/out/$app.png"
	rm "$DIR/out/$app.rgba.png"
	echo "splash/out/$app.png"
done
