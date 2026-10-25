// Minimal Home helper service (registered dev-mode webOS service, so
// applicationManager/launch is permitted — a bare script isn't). Lives entirely in the
// app package; touches no OS files and never grabs input (reads only).
//
// Flags:
//   --boot   on start, launch the app, retrying until the app manager is ready. Used by
//            the webosbrew autostart script so the TV boots straight into the launcher.
//   --watch  also read the remote (no grab) and launch the app when HOME is pressed.
// Size the libuv threadpool BEFORE anything uses it: every watched input device parks one
// blocking read on a pool thread (see watchAll). libuv reads this once, on first use.
var MAX_DEVICES = 32;
if (!process.env.UV_THREADPOOL_SIZE) { process.env.UV_THREADPOOL_SIZE = String(MAX_DEVICES + 4); }

var Service = require('webos-service');
var fs = require('fs');

// MAIN launcher: everything (boot, wake, Back out of an app; HOME via the system default) lands here.
var APP_ID = 'tld.my.minimalhome';
// Safety net: if the main launcher can't be launched (uninstalled/broken) fall back to LG's own Home
// rather than leaving the user with nothing.
var FALLBACK_ID = 'com.webos.app.home';
var HOME_CODE = 773;          // HOME on this TV's Magic Remote
var EV_KEY = 1;
var EVENT_SIZE = 16;          // 32-bit input_event
var LOG = '/tmp/home-svc.log';
// every key press from a remote, with the time it happened (kernel event time), to compare with when the launcher page
// got it (window.__keyLog) - for "the remote takes long to react" reports. Small: kept under ~100 KB.
var KEYLOG = '/tmp/home-keys.log';
function logKey(code, id, evMs) {
	try {
		if (fs.existsSync(KEYLOG) && fs.statSync(KEYLOG).size > 100000) fs.renameSync(KEYLOG, KEYLOG + '.1');
		fs.appendFileSync(KEYLOG, evMs + ' key ' + code + ' ' + id + ' seen+' + (Date.now() - evMs) + 'ms fg=' + (fgApp || 'none') + ' power=' + (powerState || '?') + '\n');
	} catch (e) { /* ignore */ }
}
var ARGS = process.argv.slice(2);

// each line carries wall-clock ms and seconds since kernel boot (boot timing; the wall clock
// may not be NTP-synced yet early in a cold boot)
function uptime() { try { return fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]; } catch (e) { return '?'; } }
function log(msg) { try { fs.appendFileSync(LOG, '[' + Date.now() + ' up=' + uptime() + '] ' + msg + '\n'); } catch (e) { /* ignore */ } }

// webos-service idle-exits in ~5s unless timeouts are disabled (its own flag, read when the
// ActivityManager is built inside `new Service`). Push it first so we stay resident.
if (process.argv.indexOf('--disable-timeouts') === -1) { process.argv.push('--disable-timeouts'); }

// clear a predecessor's orphaned luna-send first (it may still hold our bus name), and give
// the hub a moment to drop that connection before we register
if (reapOrphanWatchers()) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
var service = new Service('tld.my.minimalhome.service');
try { fs.writeFileSync('/tmp/home-svc.pid', String(process.pid)); } catch (e) { /* ignore */ }
log('start pid=' + process.pid + ' args=[' + ARGS.join(' ') + ']');

service.register('status', function (m) { m.respond({ returnValue: true, running: true, pid: process.pid }); });

function launchId(id, reason, onFail) {
	service.call('luna://com.webos.applicationManager/launch', { id: id }, function (m) {
		log('launch ' + id + ' (' + reason + '): ' + JSON.stringify(m && m.payload));
		if (onFail && !(m && m.payload && m.payload.returnValue === true)) { onFail(); }
	});
}

// Launch the main launcher; if the app manager rejects it, bring up the fallback instead.
function launchMain(reason) {
	launchId(APP_ID, reason, function () {
		log('main launcher ' + APP_ID + ' failed — falling back to ' + FALLBACK_ID);
		launchId(FALLBACK_ID, reason + ' (fallback)');
	});
}

// Foreground watcher — the primary mechanism. Whenever LG's stock launcher becomes the
// foreground app — HOME pressed, Back out of an app, boot, wake — bring our launcher forward
// at once. Reacting to the actual switch is faster than any fixed delay after the key, and
// covers the paths the key watch can't see (Back to LG Home). LG Home is not disabled or
// replaced; it just doesn't stay in front. A loop guard stops bouncing if something keeps
// pushing LG Home back (e.g. a system flow that needs it).
var STOCK_HOME = 'com.webos.app.home';
var fgApp = '', fgLive = false, bounces = [];

function bounceHome() {
	var now = Date.now();
	bounces = bounces.filter(function (t) { return now - t < 10000; });
	if (bounces.length >= 8) { log('foreground: LG Home keeps returning — leaving it (loop guard)'); return; }
	bounces.push(now);
	launchMain('stock-home-foreground');
}

// Backing out of the last app leaves the TV with no foreground app for ~1.05 s, after which the system itself launches
// LG Home (and we then bounce it). If still nothing is in front after NONE_GRACE_MS, bring our launcher up first so the
// system's timer finds a fullscreen app already there. Short enough to beat that timer, long enough not to fight a real
// app / input switch (which reaches the foreground well within this window). Shares the loop guard with bounceHome.
var NONE_GRACE_MS = 350;   // was 600: every ms here is a remote press that goes nowhere (measured 2026-10-22)
var noneTimer = null;
var powerState = '';   // last tvpower state (Active / Screen Saver / Active Standby / Suspend ...), '' until the first push
function noneForeground(isNone) {
	if (noneTimer) { clearTimeout(noneTimer); noneTimer = null; }
	if (!isNone) return;
	noneTimer = setTimeout(function () {
		noneTimer = null;
		if (fgApp !== '') return;   // something took the foreground meanwhile
		if (powerState !== '' && powerState !== 'Active') { log('foreground: nothing in front, TV power state is ' + powerState + ' - not launching'); return; }
		var now = Date.now();
		bounces = bounces.filter(function (t) { return now - t < 10000; });
		if (bounces.length >= 8) { log('foreground: nothing in front, but loop guard is active — leaving it'); return; }
		bounces.push(now);
		launchMain('foreground-none');
	}, NONE_GRACE_MS);
}

// The dev service's own bus identity is denied getForegroundAppInfo, so the subscription runs
// through the system luna-send tool as a child process (this helper already runs as root);
// the service itself is NOT elevated. One JSON response per line; restarted if it exits.
var spawn = require('child_process').spawn;

// A helper killed hard (kill -9 on re-arm, or the app installer) can't take its luna-send
// child with it; reap such orphans (re-parented to init). Runs before we register on the bus.
function reapOrphanWatchers() {
	var n = 0;
	try {
		fs.readdirSync('/proc').forEach(function (pid) {
			if (!/^\d+$/.test(pid)) return;
			try {
				var cmd = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8');
				if (cmd.indexOf('luna-send') === -1 || !/getForegroundAppInfo|getPowerState/.test(cmd)) return;
				var ppid = fs.readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ')[1].split(' ')[1];
				if (ppid === '1') { process.kill(+pid); n++; log('reaped orphan luna-send watcher ' + pid); }
			} catch (e) { /* process gone */ }
		});
	} catch (e) { /* ignore */ }
	return n;
}

// Run `luna-send -i <uri> <params>` as a child and call onMsg(payload) for each JSON line;
// restarted (after 5s) if it exits. Started via sh, closing every inherited fd above stderr
// first: the bus library's sockets are not close-on-exec, and a luna-send outliving us would
// otherwise keep our service name registered — the next helper then fails with "name
// already exists".
function lunaWatch(name, uri, params, onMsg) {
	var child, buf = '';
	var q = function (x) { return "'" + x.replace(/'/g, "'\\''") + "'"; };
	try {
		child = spawn('/bin/sh', ['-c',
			'for f in /proc/$$/fd/*; do n=${f##*/}; [ "$n" -gt 2 ] && eval "exec $n>&-"; done; ' +
			'exec /usr/bin/luna-send -i ' + q(uri) + ' ' + q(JSON.stringify(params))],
			{ stdio: ['ignore', 'pipe', 'ignore'] });
	} catch (e) { log(name + ' watch spawn failed: ' + e); setTimeout(function () { lunaWatch(name, uri, params, onMsg); }, 10000); return null; }
	child.stdout.on('data', function (chunk) {
		buf += chunk;
		var lines = buf.split('\n');
		buf = lines.pop();
		lines.forEach(function (line) {
			var p;
			try { p = JSON.parse(line); } catch (e) { return; }
			onMsg(p, child.pid);
		});
	});
	child.on('error', function (e) { log(name + ' watch error: ' + e.message); });
	child.on('exit', function (code) {
		log(name + ' watch exited (' + code + '); restart in 5000ms');
		onMsg(null);
		setTimeout(function () { lunaWatch(name, uri, params, onMsg); }, 5000);
	});
	return child;
}

function watchForeground() {
	lunaWatch('foreground', 'luna://com.webos.applicationManager/getForegroundAppInfo', { subscribe: true }, function (p, pid) {
		if (!p) { fgLive = false; return; }
		if (p.appId === undefined) return;
		if (p.returnValue === false) { log('foreground watch refused: ' + JSON.stringify(p)); return; }
		if (!fgLive) log('foreground watch active (luna-send pid ' + pid + ')');
		fgLive = true;
		var id = p.appId || '';
		if (id === fgApp) return;
		fgApp = id;
		log('foreground: ' + (id || '(none)'));
		noneForeground(id === '');
		if (id === APP_ID) keepLastInputApp();
		if (id !== '') setSaver(id === APP_ID || id === JF_NATIVE_ID);   // '' = transition: leave as is
		if (id === STOCK_HOME) bounceHome();
	});
}

// SAFEGUARD for the system-wide "home" default (settingsservice general.defaultApps.home -> this launcher). If the launcher
// were uninstalled, that default would point at nothing and HOME would do nothing. So: check it exists; if the app manager
// answers definitively "no such app", remove ONLY the entries pointing at it (others are kept) so LG Home takes over again.
// Inconclusive answers (bus busy, timeouts) never change anything.
var execFile = require('child_process').execFile;
function lunaOnce(uri, params, cb) {
	execFile('/usr/bin/luna-send', ['-n', '1', '-f', uri, JSON.stringify(params)], { timeout: 8000, maxBuffer: 16 * 1024 * 1024 }, function (err, stdout) {
		var out = null;
		try { out = JSON.parse(stdout); } catch (e) { /* inconclusive */ }
		cb(err, out);
	});
}
var guardLogged = false;

// BOOT LANDING: the boot daemon picks its first app from general.physicalLastInputApp (the last physical input, e.g.
// HDMI 1) - that is what flashed HDMI 1 for ~20 s at every cold boot before the launcher took over. While our launcher is in
// front keep that setting (and general.lastInputApp, used by Back/closing policies) pointing at it, so the next boot starts
// straight on the launcher (~19 s sooner, no HDMI picture). Opening an HDMI/TV app overwrites it; it is restored when we are
// back in front - and powering off WHILE on an HDMI input deliberately still boots back to that input.
// COLD-BOOT SPLASH: at a cold boot LG's web runtime holds the launcher's page back for ~10 s (black screen). The native
// splash app (bootsplash/) draws at once and starts the launcher itself, so while it is installed the BOOT app
// (physicalLastInputApp) points at it; lastInputApp stays on the launcher. Not installed (or removed later): straight to
// the launcher as before. Checked at start and with the home-guard.
var SPLASH_ID = 'tld.my.bootsplash';
var bootAppId = null;   // unknown until checkSplash answers - the boot setting isn't touched before that
function checkSplash() {
	lunaOnce('luna://com.webos.applicationManager/getAppInfo', { id: SPLASH_ID }, function (err, out) {
		if (!out || typeof out.returnValue !== 'boolean') { if (bootAppId === null) setTimeout(checkSplash, 10000); return; }   // inconclusive: keep what we have
		var id = out.returnValue === true ? SPLASH_ID : APP_ID;
		if (id === bootAppId) return;
		log('boot app -> ' + id);
		bootAppId = id;
		lastInputCheckedAt = 0;
		if (fgApp === APP_ID) keepLastInputApp();
	});
}
var lastInputCheckedAt = 0;
function keepLastInputApp() {
	if (bootAppId === null) return;   // checkSplash calls back once it knows
	var now = Date.now();
	if (now - lastInputCheckedAt < 3000) return;
	lastInputCheckedAt = now;
	lunaOnce('luna://com.webos.settingsservice/getSystemSettings', { category: 'general', keys: ['lastInputApp', 'physicalLastInputApp'] }, function (e, cur) {
		var st = cur && cur.settings;
		if (!st || (st.lastInputApp === APP_ID && st.physicalLastInputApp === bootAppId)) return;
		lunaOnce('luna://com.webos.settingsservice/setSystemSettings', { category: 'general', settings: { lastInputApp: APP_ID, physicalLastInputApp: bootAppId } }, function (e2, r) {
			log('lastInputApp ' + st.lastInputApp + ' / physicalLastInputApp ' + st.physicalLastInputApp + ' -> ' + APP_ID + ' / ' + bootAppId + ': ' + JSON.stringify(r));
		});
	});
}
function guardHomeDefault() {
	lunaOnce('luna://com.webos.applicationManager/getAppInfo', { id: APP_ID }, function (err, out) {
		if (!out || typeof out.returnValue !== 'boolean') { log('home-guard: inconclusive, leaving settings alone'); return; }
		if (out.returnValue === true) { if (!guardLogged) { guardLogged = true; log('home-guard: ' + APP_ID + ' is installed - ok'); } return; }
		lunaOnce('luna://com.webos.settingsservice/getSystemSettings', { category: 'general', keys: ['defaultApps'] }, function (e2, cur) {
			var map = cur && cur.settings && cur.settings.defaultApps;
			if (!map) return;
			// "home" is ours; "idleApp" is filled in by the app manager itself (it follows the home default) - drop both if they
			// point at the missing launcher, keep every other entry
			var gone = ['home', 'idleApp'].filter(function (k) { return map[k] === APP_ID; });
			if (!gone.length) return;
			gone.forEach(function (k) { delete map[k]; });
			log('home-guard: ' + APP_ID + ' is NOT installed - removing the ' + gone.join('/') + ' default(s) so LG Home works again');
			lunaOnce('luna://com.webos.settingsservice/setSystemSettings', { category: 'general', settings: { defaultApps: map } }, function (e3, r) {
				log('home-guard: restore -> ' + JSON.stringify(r));
			});
		});
	});
}
setTimeout(guardHomeDefault, 45000);
setInterval(guardHomeDefault, 10 * 60 * 1000);
setTimeout(checkSplash, 5000);
setInterval(checkSplash, 10 * 60 * 1000);

// Diagnostics for boot/wake timing: log TV power-state transitions.
function watchPower() {
	var last = '';
	lunaWatch('power', 'luna://com.webos.service.tvpower/power/getPowerState', { subscribe: true }, function (p) {
		if (!p || p.returnValue === false) return;
		var st = (p.state || '') + (p.processing ? ' / ' + p.processing : '') + (p.reason ? ' (' + p.reason + ')' : '');
		if (p.state) powerState = p.state;
		if (st && st !== last) { last = st; log('power: ' + st); }
		// Switching on from standby / deep sleep: LG closed every app when it went off, and its own relaunch of the launcher
		// comes ~1.4 s after the screen is on - remote presses until then reach no app. Launch at once instead (a second
		// launch from LG or wakeRelaunch then just finds it running). Not for Screen Off -> on: the launcher is still there.
		// (A device that switched the TV on over HDMI-CEC wants its input in front: left to LG.)
		if (p.processing === 'Screen On' && p.state !== 'Screen Off' && !/cec|hdmi/i.test(p.reason || '') &&
			(fgApp === '' || fgApp === STOCK_HOME)) launchMain('power-on');
	});
}

// LG's own screensaver (com.webos.app.screensaver: pictures + analog clock) starts 3 minutes after the launcher came up and
// would cover the launcher's own OLED idle screen (true black + dim drifting clock/info) - two idle screens on top of each other.
// Same for Jellyfin Native: it has its own idle screen (menus, paused video), and LG's saver over a paused video meant two
// screens to click away (LG's key press never reaches the app).
// (tvpower's veto call, registerScreenSaverRequest ack:false, is accepted but ignored by this firmware - tested.) So the setting
// itself is switched: general.screenSaverEnabled is "off" ONLY while the launcher or Jellyfin Native is in front and "on" (the TV's factory value,
// also what it was here) again as soon as any other app/input is in front, so HDMI and apps keep LG's burn-in protection.
// Stateless on purpose: a restarted helper (or a reboot) can never leave the saver stuck off - the next non-launcher
// foreground app turns it back on.
// The real setting is read on every foreground change (one cheap call), so a value changed behind our back is corrected too.
function setSaver(wantOff) {
	var target = wantOff ? 'off' : 'on';
	lunaOnce('luna://com.webos.settingsservice/getSystemSettings', { category: 'general', keys: ['screenSaverEnabled'] }, function (e, cur) {
		var v = cur && cur.settings && cur.settings.screenSaverEnabled;
		if (!v || v === target) return;   // inconclusive (try again on the next foreground change) or already right
		lunaOnce('luna://com.webos.settingsservice/setSystemSettings', { category: 'general', settings: { screenSaverEnabled: target } }, function (e2, r) {
			log('screensaver setting -> ' + target + ': ' + JSON.stringify(r));
		});
	});
}

// Panel off (OLED care) - asked for by the launcher after a long time without any input. Only honoured while the launcher is in
// front and the TV is Active, so it can never blank a video that is playing in another app. Any remote key brings the picture back.
service.register('screenOff', function (m) {
	var ok = fgApp === APP_ID && (powerState === '' || powerState === 'Active');
	log('screenOff requested: ' + (ok ? 'turning the panel off' : 'ignored (foreground ' + (fgApp || 'none') + ', power ' + powerState + ')'));
	if (ok) lunaOnce('luna://com.webos.service.tvpower/power/turnOffScreen', {}, function () { /* best effort */ });
	m.respond({ returnValue: true, done: ok });
});

// Jellyfin cards: open the item in Jellyfin Native and resume it. The native app only reads launch parameters when it starts
// (LG's SDL has no relaunch hook), so a copy still running in the background is closed first; it reports its playback
// position when it goes to the background, and a cold start takes ~0.3 s.
var JF_NATIVE_ID = 'tld.my.jfnative';
service.register('openItem', function (m) {
	var itemId = m.payload && m.payload.itemId;
	if (typeof itemId !== 'string' || !/^[0-9a-f]{32}$/i.test(itemId)) { m.respond({ returnValue: false, errorText: 'itemId missing' }); return; }
	var params = { itemId: itemId, play: m.payload.play !== false };
	var launch = function (why) {
		service.call('luna://com.webos.applicationManager/launch', { id: JF_NATIVE_ID, params: params }, function (r) {
			var ok = !!(r && r.payload && r.payload.returnValue === true);
			log('openItem ' + itemId + ' (' + why + '): ' + (ok ? 'launched' : JSON.stringify(r && r.payload)));
			m.respond({ returnValue: ok });
		});
	};
	lunaOnce('luna://com.webos.applicationManager/running', {}, function (e, out) {
		var running = !!(out && out.running && out.running.some(function (a) { return a.id === JF_NATIVE_ID; }));
		if (!running) { launch('cold'); return; }
		lunaOnce('luna://com.webos.applicationManager/closeByAppId', { id: JF_NATIVE_ID }, function () {
			// wait until the app manager has really let it go, else the launch only brings the old copy back
			var tries = 0;
			(function wait() {
				lunaOnce('luna://com.webos.applicationManager/running', {}, function (e2, o2) {
					var still = !!(o2 && o2.running && o2.running.some(function (a) { return a.id === JF_NATIVE_ID; }));
					if (still && ++tries < 20) { setTimeout(wait, 100); return; }
					launch('after close, ' + tries + ' checks');
				});
			})();
		});
	});
});

// Which apps are installed, so the launcher only shows tiles for those (ids only).
service.register('installedApps', function (m) {
	lunaOnce('luna://com.webos.applicationManager/listApps', {}, function (e, out) {
		var ids = (out && out.apps || []).map(function (a) { return a.id; }).filter(Boolean);
		m.respond({ returnValue: ids.length > 0, ids: ids });
	});
});

// The server Jellyfin Native is signed in to, so the launcher's sign-in needn't ask for it again. Only the address
// is returned: the access token in Jellyfin Native's session file never leaves this process.
service.register('jellyfinServer', function (m) {
	var dir = '/media/developer/jfnative/';
	var server = '';
	try { server = fs.readFileSync(dir + 'last-server', 'utf8').trim(); } catch (e) { /* older Jellyfin Native */ }
	if (!server) { try { server = String(JSON.parse(fs.readFileSync(dir + 'session.json', 'utf8')).server || ''); } catch (e) { /* not signed in */ } }
	if (!/^https?:\/\/[^\s"'<>]+$/.test(server)) server = '';
	m.respond({ returnValue: true, server: server });
});

// HOME key — fallback only. With the foreground watcher live, the switch to LG Home itself
// triggers the launch; the key just arms a late check in case that push never arrives.
// Without the watcher: launch 450ms after release (900ms key-down fallback), giving LG time
// to finish handling HOME so it can't take focus back afterwards.
var homeTimer = null;
function scheduleHome(delay) {
	if (homeTimer) clearTimeout(homeTimer);
	homeTimer = setTimeout(function () {
		homeTimer = null;
		if (fgLive) {
			if (fgApp !== APP_ID) launchApp('home-key-check (' + (fgApp || 'none') + ')');
			return;
		}
		launchApp('home-key-after-stock');
	}, fgLive ? 1500 : delay);
}

var launching = false;
function launchApp(reason) {
	if (launching) return;
	launching = true;
	setTimeout(function () { launching = false; }, 800);
	launchMain(reason);
}

// Cold boot: the app manager isn't ready the instant we start, so retry until it accepts
// the launch (returnValue:true), or give up after ~60s.
function bootLaunch(attempt) {
	attempt = attempt || 1;
	// noSplash like the boot manager: LG's launch screen would otherwise cover the boot splash app (bootsplash/) until the page paints
	service.call('luna://com.webos.applicationManager/launch', { id: APP_ID, noSplash: true }, function (m) {
		var ok = m && m.payload && m.payload.returnValue === true;
		log('bootLaunch #' + attempt + ': ' + JSON.stringify(m && m.payload));
		if (!ok && attempt === 8) { log('bootLaunch: main launcher still refused after 8 tries — launching fallback ' + FALLBACK_ID); launchId(FALLBACK_ID, 'boot fallback'); }
		if (!ok && attempt < 30) { setTimeout(function () { bootLaunch(attempt + 1); }, 2000); }
	});
}

// Read every input device (no grab). Robust to device renumbering across reboots — we
// don't hardcode an eventN; whichever device carries HOME, we'll see it.
//
// Event-driven: each device gets ONE blocking fs.read parked on a libuv pool thread, which
// sleeps in the kernel until the device has events — zero CPU while idle. (The previous
// non-blocking poll read every device every 16ms and threw EAGAIN for each idle one, ~7% of a
// core on this TV.) The pool is sized for this up front (MAX_DEVICES + 4 spare threads), so
// parked reads can never starve the device that actually carries HOME — the failure mode of
// blocking reads on the default 4-thread pool. Devices that disappear error out of their
// read and are dropped; a cheap rescan picks up new or reconnected ones.
var watched = {};   // 'eventN' -> {fd, name}

function deviceNames() {
	var names = {};
	try {
		fs.readFileSync('/proc/bus/input/devices', 'utf8').split(/\n\s*\n/).forEach(function (blk) {
			var h = /^H: Handlers=.*?\b(event\d+)\b/m.exec(blk);
			var n = /^N: Name="(.*)"$/m.exec(blk);
			if (h) names[h[1]] = n ? n[1] : h[1];
		});
	} catch (e) { /* fall back to /dev/input listing */ }
	return names;
}

function readLoop(dev, id) {
	var buf = Buffer.alloc(EVENT_SIZE * 64);
	(function next() {
		fs.read(dev.fd, buf, 0, buf.length, null, function (err, bytes) {
			if (watched[id] !== dev) return;
			if (err && err.code === 'EINTR') { next(); return; }
			if (err || !bytes) {
				log('input ' + id + ' (' + dev.name + ') closed: ' + (err ? err.code : 'eof'));
				delete watched[id];
				try { fs.closeSync(dev.fd); } catch (e) { /* ignore */ }
				return;
			}
			for (var off = 0; off + EVENT_SIZE <= bytes; off += EVENT_SIZE) {
				if (buf.readUInt16LE(off + 8) === EV_KEY && buf.readInt32LE(off + 12) === 1) {
					logKey(buf.readUInt16LE(off + 10), id, buf.readUInt32LE(off) * 1000 + Math.round(buf.readUInt32LE(off + 4) / 1000));
				}
				if (buf.readUInt16LE(off + 8) === EV_KEY && buf.readUInt16LE(off + 10) === HOME_CODE) {
					var value = buf.readInt32LE(off + 12);
					if (value === 1) { log('HOME down (' + id + ')'); scheduleHome(900); }
					else if (value === 0) { log('HOME release (' + id + ')'); scheduleHome(450); }
				}
			}
			next();
		});
	})();
}

function scanInputs(reason) {
	var names = deviceNames();
	var ids = Object.keys(names);
	if (!ids.length) {
		try { ids = fs.readdirSync('/dev/input').filter(function (f) { return f.indexOf('event') === 0; }); }
		catch (e) { log('readdir /dev/input: ' + e.message); return; }
	}
	var added = [];
	ids.forEach(function (id) {
		if (watched[id] || Object.keys(watched).length >= MAX_DEVICES) return;
		var fd;
		try { fd = fs.openSync('/dev/input/' + id, fs.constants.O_RDONLY); }
		catch (e) { return; }   // phantom/unreadable node — skip
		var dev = { fd: fd, name: names[id] || id };
		watched[id] = dev;
		added.push(id);
		readLoop(dev, id);
	});
	if (added.length || reason === 'start') {
		log('watching ' + Object.keys(watched).length + ' input devices (' + reason + ', +' + added.join(',') + ')');
	}
}

function watchAll() {
	scanInputs('start');
	setInterval(function () { scanInputs('rescan'); }, 5000);
}

// Command hook (used by tools/): launch whatever appId is written to /tmp/home-svc-cmd (consumed once).
setInterval(function () {
	try {
		if (fs.existsSync('/tmp/home-svc-cmd')) {
			var id = ('' + fs.readFileSync('/tmp/home-svc-cmd')).trim();
			fs.unlinkSync('/tmp/home-svc-cmd');
			if (id) { launchId(id, 'cmd'); }
		}
	} catch (e) { /* ignore */ }
}, 250);

if (ARGS.indexOf('--boot') !== -1) {
	bootLaunch(1);   // retries every 2s until the app manager accepts it
}
if (ARGS.indexOf('--watch') !== -1) { watchAll(); watchForeground(); watchPower(); }

// Wake-from-standby relaunch. webosbrew init.d autostart only runs on COLD boot, not on
// standby-resume ("rest"). But this process is merely FROZEN during rest, so a 1s heartbeat
// fires seconds/minutes late on resume — a big wall-clock gap means the panel just woke, so
// we relaunch the app a few times (the app manager + compositor take a moment to come back).
// Stops as soon as the launcher - or any other real app the user already opened - is in front, so a quick app choice
// right after switching on is never pulled back to the launcher (LG Home itself is handled by bounceHome).
function wakeRelaunch () {
	var tries = 0;
	var attempt = function () {
		if (fgLive && fgApp !== '' && fgApp !== STOCK_HOME) { log('wake: ' + fgApp + ' in front - no more relaunches'); clearInterval(iv); return; }
		tries++;
		service.call('luna://com.webos.applicationManager/launch', { id: APP_ID }, function (m) { log('wake launch ' + tries + ': ' + JSON.stringify(m && m.payload)); });
		if (tries >= 4) clearInterval(iv);   // fire at once, then 1.5 / 3 / 4.5 s after wake at most
	};
	var iv = setInterval(attempt, 1500);
	attempt();
}
var lastBeat = Date.now();
setInterval(function () {
	var now = Date.now(), gap = now - lastBeat; lastBeat = now;
	if (gap > 10000) {
		log('WAKE detected (slept ~' + Math.round(gap / 1000) + 's) -> relaunch');
		wakeRelaunch();
	}
}, 1000); // also serves as the keep-alive
