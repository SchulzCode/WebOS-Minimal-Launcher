# Minimal Home

A clean, one-page home screen for rooted LG webOS TVs: Jellyfin "continue watching" with big artwork, tiles for the
apps you actually use, an OLED-friendly idle screen, and a small helper that makes the Home key, Back and power-on go
straight to it (no flash of LG's own launcher).

It pairs with [Jellyfin Native](https://github.com/SchulzCode/WebOS-Jellyfin-Native), a native Jellyfin client: a press on a card plays the
episode there, from where you left off.

Unofficial; not affiliated with LG or the Jellyfin project. Tested on an LG OLED B4 (webOS 25).

## Features

- **Continue watching** from Jellyfin (resume, recently started, next up). OK on a card plays it in Jellyfin Native at
  the resume position.
- **App tiles** for the apps installed on the TV (YouTube, Netflix, Spotify, Twitch, Homebrew, Settings, …) and the
  HDMI inputs, which show the input name and dim when nothing is switched on.
- **OLED idle screen** after 60 s without input: true black with a thin, dim clock that moves every minute; panel off
  after 30 minutes. LG's own screensaver is switched off only while the launcher is in front.
- **Boots straight onto the launcher** and is the system Home: the Home key and Back from an app land on it.
- Magic Remote pointer support.
- Optional: a "coming up / downloading" line from Sonarr + Radarr, through a small read-only feed service on your
  server (`server/launcher-feed/`).

## Requirements

- An LG webOS TV that is **rooted**, with the [Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel)
  and SSH enabled in its settings. Making it the system Home and starting at boot needs root.
- A Jellyfin server with Quick Connect enabled (Dashboard → General), and [Jellyfin Native](https://github.com/SchulzCode/WebOS-Jellyfin-Native)
  installed for playback.
- A Linux/macOS computer on the same network with SSH key access to the TV (for the one-time setup).

## Install

```sh
cp config.example.env config.env        # the TV's address and your SSH key
# 1. install the app: the release .ipk via the Homebrew Channel / ares-install, or build it: scripts/rebuild-all.sh
# 2. one-time setup on the TV (helper, boot hook, Home default):
scripts/rebuild-all.sh --setup
```

On first start the launcher asks for your Jellyfin server (taken over from Jellyfin Native automatically if that is
already signed in), then shows a Quick Connect code to approve in any signed-in Jellyfin app.

Building from source: Node 20+ and `ares-package` (`npm i -g @webos-tools/cli`). `scripts/rebuild-all.sh` builds,
packages, installs and sets everything up; `--help` lists the steps. A server to suggest at sign-in and the optional
feed URL can be set at build time in `app/.env.local` (git-ignored; `RELEASE=1 scripts/rebuild-all.sh --only build`
ignores it, for packages you publish):

```sh
VITE_JELLYFIN_URL=https://jellyfin.example.com
VITE_FEED_URL=http://192.168.1.20:8091/feed
VITE_HDMI_NAMES={"HDMI_1":"Game console"}   # or rename the input on the TV itself, which wins
```

## Updating

Install the new `.ipk`, then run `scripts/rebuild-all.sh --setup` again: the installer stops the helper, and its
root-only copy has to be refreshed from the new package. (A full `scripts/rebuild-all.sh` does both.)

## Uninstall

`scripts/uninstall.sh` shows what it would undo; `scripts/uninstall.sh --yes` does it: Home default back to LG's Home,
LG's screensaver on, boot hook and helper removed, app uninstalled. Don't just delete the app without it: the Home key
would do nothing until the helper's safeguard notices (it resets the Home default within a few minutes).

## What it changes on the TV

| what | why | undone by |
|---|---|---|
| `general.defaultApps.home` → the launcher | Home key opens it directly | `uninstall.sh` |
| `general.screenSaverEnabled` off while the launcher is in front, on otherwise | its own idle screen replaces LG's | `uninstall.sh` / any other app in front |
| `general.lastInputApp` / `physicalLastInputApp` kept on the launcher | power-on lands on it, not on HDMI | next input change |
| `/var/lib/webosbrew/init.d/50-minimalhome` + `/var/lib/webosbrew/minimalhome-helper/` | starts the helper at boot | `uninstall.sh` |

Optional (`--with-telemetry-block`): a boot hook that blocks LG's ad and telemetry hosts (`tv-hooks/`).

## Security

- The helper runs as root (it reads the remote's input device and changes system settings). It runs from a root-only
  copy in `/var/lib/webosbrew/minimalhome-helper/` and refuses to start from anywhere writable by others: app folders
  on webOS are world-writable, so running root code from there would let any app take over the TV.
- The helper's bus methods only do fixed things (status, launch Jellyfin Native with a validated item id, list
  installed app ids, turn the panel off while the launcher is in front, report Jellyfin Native's server address - never
  its token). No shell is ever involved.
- The Jellyfin access token lives in the launcher's own storage on the TV; no password is entered or stored. The feed
  service holds the Sonarr/Radarr keys on the server; the TV never sees them.

## Layout

| path | what |
|---|---|
| `app/` | the launcher (Vite, React API bundled with Preact), `tld.my.minimalhome` |
| `app/service/` | the helper service `tld.my.minimalhome.service` (Node, runs as root) + its boot script |
| `scripts/` | `rebuild-all.sh` (build/install/setup), `uninstall.sh` |
| `server/launcher-feed/` | optional read-only Sonarr/Radarr feed (Docker) |
| `tv-hooks/` | optional telemetry host block |
| `tools/` | SSH wrappers (`tv`, `tvt`) and a DevTools client (`cdp.mjs`) for development |

## License

[0BSD](LICENSE): do anything you like with it, no attribution needed. The app logos in `app/public/icons/` (Netflix,
Twitch, Jellyfin, …) belong to their owners and are not covered by this license; they are only there so the tiles look
like the apps they open. Inter is under the SIL Open Font License.
