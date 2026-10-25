#!/usr/bin/env bash
# Build the cold-boot splash app (tld.my.bootsplash) -> release/tld.my.bootsplash_<version>_arm.ipk
# Needs zig (cross-compiler for the TV's 32-bit ARMv7 soft-float glibc 2.35), Firefox + the launcher's node_modules (the
# picture comes from splash/splash.html), and ares-package. LG's libraries are loaded on the TV at run time - nothing of
# LG's is needed here. Install like any .ipk through Homebrew Channel.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(dirname "$DIR")"
[ -f "$ROOT/config.env" ] && . "$ROOT/config.env"
ZIG="${ZIG:-$(command -v zig || echo "$HOME/.local/share/zig/current/zig")}"
ARES="${ARES_PACKAGE:-ares-package}"
STAGE="$DIR/.stage"; rm -rf "$STAGE"; mkdir -p "$STAGE" "$ROOT/release"

# the full picture (LG shows it if the app is ever started without noSplash) and the name alone, white on black, which the
# app draws from a small grey texture placed where it sits in the full picture
"$ROOT/splash/render.sh" bootsplash >/dev/null
cp "$ROOT/splash/out/bootsplash.png" "$STAGE/splash.png"
PROF=$(mktemp -d); trap 'rm -rf "$PROF"' EXIT
echo 'user_pref("security.fileuri.strict_origin_policy", false);' > "$PROF/user.js"
firefox --headless --no-remote --profile "$PROF" --window-size=1920,1080 \
	--screenshot "$STAGE/wm-full.png" "file://$ROOT/splash/splash.html?app=bootsplash&part=wordmark" >/dev/null 2>&1
read -r WM_X WM_Y < <(python3 -c '
import sys; from PIL import Image
im = Image.open(sys.argv[1]).convert("L")
x0, y0, x1, y1 = im.getbbox()
x0, y0, x1, y1 = x0 - 2, y0 - 2, x1 + 2, y1 + 2      # a little black margin so edge texels stay transparent
im.crop((x0, y0, x1, y1)).save(sys.argv[2], optimize=True)
print(x0, y0)' "$STAGE/wm-full.png" "$STAGE/wordmark.png")
rm "$STAGE/wm-full.png"
echo "wordmark at $WM_X,$WM_Y"

"$ZIG" cc -target arm-linux-gnueabi.2.35 -mcpu=generic+v7a -O2 -Wall -Wextra -DWM_X="$WM_X" -DWM_Y="$WM_Y" \
	-o "$STAGE/bootsplash" "$DIR/main.c" -ldl
cp "$DIR/appinfo.json" "$DIR/icon.png" "$DIR/largeIcon.png" "$STAGE/"
"$ARES" "$STAGE" -o "$ROOT/release" --no-minify >/dev/null
VER=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$DIR/appinfo.json")
echo "package: $ROOT/release/tld.my.bootsplash_${VER}_arm.ipk"
