import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent} from 'react';
import {APPS, HDMI_NAMES, type AppDef} from './lib/apps';
import {
	AuthError, JELLYFIN_APP_ID, checkServer, clearSession, loadServer, saveServer, fetchContinue, loadSession, quickConnectEnabled,
	quickConnectInitiate, quickConnectPoll, saveSession, type Card, type Session
} from './lib/jellyfin';
import {installedApps, isWebOS, jellyfinServerFromNative, launchApp, openJellyfinItem, panelOff, watchInputs, type InputPort} from './lib/luna';
import {downloadsActive, feedLines, fetchFeed, type Feed, type Line} from './lib/feed';

// Layout constants (CSS px at 1920×1080) — keep in sync with styles.css.
const CARD_W = 296;
const GAP = 20;
const VISIBLE = 5;          // wide cards fully visible at once
const JITTER_MS = 150_000;  // OLED guard: nudge the whole UI by ±2px this often
const IDLE_MS = 60_000;         // no input for this long → idle screen (true black + dim drifting clock)
const IDLE_DEEP_MS = 600_000;   // …after this much more idle time the clock dims further
const IDLE_MOVE_MS = 60_000;    // the idle clock drifts to a new spot this often (fades out, jumps, fades in) - the info line changes then too
const IDLE_OFF_MS = 1_800_000;  // …and after this much idle time in total the panel is switched off (any remote key brings it back)
const LONG_PRESS_MS = 550;      // holding OK (or the pointer button) on an app tile this long picks it up to move it
const ORDER_KEY = 'minihome-app-order';

type Link = 'loading' | 'ready' | 'connect' | 'offline';

declare global {
	interface KeyNote {t: number; what: string; up: number; hidden: boolean; idle: boolean}
	interface Window {__keyLog?: KeyNote[];__hoverLog?: {sinceVisible: number; toFrame: number}[]; __MOCK__?: {cards?: Card[]; link?: Link; code?: string; idleMs?: number; feed?: Omit<Feed, 'at'>; ports?: InputPort[]}}
}

/** The current time, updated right on each minute change (and when the launcher is shown again: timers sleep while hidden). */
function useClock () {
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		let timer = 0;
		const tick = () => {
			const d = new Date();
			setNow(d);
			timer = window.setTimeout(tick, 60_000 - (d.getSeconds() * 1000 + d.getMilliseconds()) + 30);
		};
		timer = window.setTimeout(tick, 60_000 - (Date.now() % 60_000) + 30);
		const onVis = () => { if (!document.hidden) { window.clearTimeout(timer); tick(); } };
		document.addEventListener('visibilitychange', onVis);
		return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVis); };
	}, []);
	return now;
}

/** A fresh resting place for the idle clock, always away from the last one and clear of the screen edges. */
function randomSpot (prev?: {x: number; y: number}): {x: number; y: number} {
	let next = {x: 120, y: 160};
	for (let i = 0; i < 8; i++) {
		next = {x: 120 + Math.round(Math.random() * 960), y: 120 + Math.round(Math.random() * 500)};
		if (!prev || Math.hypot(next.x - prev.x, next.y - prev.y) > 260) break;
	}
	return next;
}

function greeting (h: number): string {
	if (h < 5) return 'Good night';
	if (h < 12) return 'Good morning';
	if (h < 18) return 'Good afternoon';
	return 'Good evening';
}

/** Two stacked images; the new one fades in once decoded, so the hero never flashes. */
function Backdrop ({url}: {url: string}) {
	const [layers, setLayers] = useState<[string, string]>([url, '']);
	const [active, setActive] = useState<0 | 1>(0);
	const activeRef = useRef<0 | 1>(0);

	useEffect(() => {
		const current = layers[activeRef.current];
		if (url === current) return;
		let cancelled = false;
		const flip = () => {
			if (cancelled) return;
			const next = (1 - activeRef.current) as 0 | 1;
			setLayers((l) => (next === 0 ? [url, l[1]] : [l[0], url]));
			// swap on the next frame, after the new layer has its src
			requestAnimationFrame(() => { if (!cancelled) { activeRef.current = next; setActive(next); } });
		};
		if (!url) { flip(); return () => { cancelled = true; }; }
		const probe = new Image();
		probe.src = url;
		(probe.decode ? probe.decode() : Promise.resolve()).then(flip, flip);
		return () => { cancelled = true; };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [url]);

	return (
		<div className="backdrop" aria-hidden>
			{[0, 1].map((i) => (
				<div key={i} className="backdrop-layer" style={{opacity: active === i && layers[i] ? 1 : 0}}>
					{layers[i] ? <img src={layers[i]} alt="" decoding="async" /> : null}
				</div>
			))}
		</div>
	);
}

function HdmiGlyph () {
	return (
		<svg viewBox="0 0 48 48" width="52" height="52" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round">
			<path d="M8 14h32v14l-5 6H13l-5-6V14z" />
			<path d="M16 21h16M16 26h16" />
		</svg>
	);
}

function SpotifyGlyph () {
	return (
		<svg viewBox="0 0 56 56" width="56" height="56">
			<circle cx="28" cy="28" r="28" fill="#1db954" />
			<g fill="none" stroke="#07080c" strokeLinecap="round">
				<path d="M13 21.5c9.5-2.8 20.5-2 29 3" strokeWidth="4.6" />
				<path d="M14.5 29.5c8-2.3 17-1.6 24 2.6" strokeWidth="3.8" />
				<path d="M16 36.8c6.5-1.8 13.5-1.2 19 2" strokeWidth="3.2" />
			</g>
		</svg>
	);
}

function YoutubeGlyph () {
	return (
		<svg viewBox="0 0 56 56" width="56" height="56">
			<rect x="2" y="10" width="52" height="36" rx="11" fill="#ff0000" />
			<path d="M23 20v16l14-8z" fill="#ffffff" />
		</svg>
	);
}

function AppIcon ({app}: {app: AppDef}) {
	if (app.icon) return <img className="app-icon" src={app.icon} alt="" />;
	const g = app.glyph === 'spotify' ? <SpotifyGlyph /> : app.glyph === 'youtube' ? <YoutubeGlyph /> : <HdmiGlyph />;
	return <span className="app-glyph">{g}</span>;
}

/** The app order the user arranged (tile ids), [] = the default order from lib/apps.ts. */
function loadOrder (): string[] {
	try { const v = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}
function saveOrder (ids: string[]) {
	try { localStorage.setItem(ORDER_KEY, JSON.stringify(ids)); } catch { /* noop */ }
}

/** Tiles in the user's order; tiles the order doesn't know yet (apps installed later, HDMI 3/4) keep their default spot. */
function applyOrder<T extends {id: string}> (tiles: T[], order: string[]): T[] {
	if (!order.length) return tiles;
	const out = order.map((id) => tiles.find((t) => t.id === id)).filter((t): t is T => !!t);
	tiles.forEach((t, i) => { if (!order.includes(t.id)) out.splice(Math.min(i, out.length), 0, t); });
	return out;
}

/** An app tile as shown: HDMI tiles carry the plugged-in device's name, the port as a second line, and dim when nothing is on. */
type Tile = AppDef & {sub?: string; dim?: boolean};

function buildTiles (ports: InputPort[] | null, installed: Set<string> | null): Tile[] {
	// only apps that are on this TV (HDMI inputs are system apps and always there); unknown yet: all
	const list = installed ? APPS.filter((a) => a.input || installed.has(a.id)) : APPS;
	if (!ports) return list;   // plug state unknown (yet): plain tiles
	const name = (p: InputPort | undefined, input: string, fallback: string) => (p?.renamed ? p.label : HDMI_NAMES[input]) || fallback;
	const tiles: Tile[] = list.map((a) => {
		if (!a.input) return a;
		const p = ports.find((x) => x.id === a.input);
		const title = name(p, a.input, a.title);
		return {...a, title, sub: title !== a.title ? a.title : undefined, dim: p ? !p.plugged : false};
	});
	// ports without a fixed tile (HDMI 3/4) only show up while something is plugged in, in front of Settings
	const extra: Tile[] = ports.filter((p) => p.plugged && !APPS.some((a) => a.input === p.id)).map((p) => {
		const port = p.id.replace('_', ' ');   // "HDMI 3"
		const title = name(p, p.id, port);
		return {id: p.appId, title, glyph: 'hdmi', input: p.id, sub: title !== port ? port : undefined};
	});
	const at = tiles.findIndex((t) => t.id === 'com.palm.app.settings');
	if (extra.length) tiles.splice(at < 0 ? tiles.length : at, 0, ...extra);
	return tiles;
}

export default function App () {
	const now = useClock();
	const [link, setLink] = useState<Link>('loading');
	const [cards, setCards] = useState<Card[]>([]);
	const [code, setCode] = useState('');
	// sign-in: the server in use, and whether the card asks for one (none known yet, or it didn't answer)
	const [server, setServer] = useState('');
	const [askServer, setAskServer] = useState(false);
	const [serverError, setServerError] = useState('');
	const [serverTick, setServerTick] = useState(0);
	const serverInput = useRef<HTMLInputElement | null>(null);
	const [row, setRow] = useState<0 | 1>(1);     // 0 = continue watching, 1 = apps
	const [col, setCol] = useState(0);
	const [heroIdx, setHeroIdx] = useState(0);
	const [toast, setToast] = useState('');
	const [jitter, setJitter] = useState<[number, number]>([0, 0]);
	const toastTimer = useRef(0);
	const sessionRef = useRef<Session | null>(null);
	const [idle, setIdle] = useState(false);
	const [feed, setFeed] = useState<Feed | null>(null);
	const [stripIdx, setStripIdx] = useState(0);
	const [deep, setDeep] = useState(false);
	const [spot, setSpot] = useState(() => randomSpot());
	const [spotOn, setSpotOn] = useState(true);
	const [infoIdx, setInfoIdx] = useState(0);
	const idleRef = useRef(false);
	const idleSince = useRef(0);
	const lastInput = useRef(Date.now());

	const hasWatch = cards.length > 0;

	// --- HDMI tiles: live plug state ---------------------------------------------------------
	const [ports, setPorts] = useState<InputPort[] | null>(null);
	useEffect(() => {
		const mock = import.meta.env.DEV ? window.__MOCK__?.ports : undefined;
		if (mock) { setPorts(mock); return; }
		const w = watchInputs((p) => setPorts((prev) => (JSON.stringify(prev) === JSON.stringify(p) ? prev : p)));
		w.refresh();
		const onVis = () => { if (!document.hidden) w.refresh(); };
		document.addEventListener('visibilitychange', onVis);
		const every = window.setInterval(() => { if (!document.hidden && !idleRef.current) w.refresh(); }, 15_000);
		return () => { w.cancel(); window.clearInterval(every); document.removeEventListener('visibilitychange', onVis); };
	}, []);
	const [installed, setInstalled] = useState<Set<string> | null>(null);
	useEffect(() => {
		if (!isWebOS()) return;
		const read = () => { installedApps().then((ids) => { if (ids.length) setInstalled(new Set(ids)); }).catch(() => { /* helper missing: show all tiles */ }); };
		read();
		const onVis = () => { if (!document.hidden) read(); };   // apps may have been installed/removed meanwhile
		document.addEventListener('visibilitychange', onVis);
		return () => document.removeEventListener('visibilitychange', onVis);
	}, []);
	const [order, setOrder] = useState<string[]>(loadOrder);
	const apps = useMemo(() => applyOrder(buildTiles(ports, installed), order), [ports, installed, order]);
	// a tile can disappear (HDMI 3/4 unplugged) while it has focus
	useEffect(() => { if (row === 1) setCol((c) => Math.min(c, apps.length - 1)); }, [apps.length]);   // eslint-disable-line react-hooks/exhaustive-deps

	// --- Jellyfin: load / sign in ---------------------------------------------
	const load = useCallback(async () => {
		const mock = import.meta.env.DEV ? window.__MOCK__ : undefined;
		if (mock) { setCards(mock.cards ?? []); setCode(mock.code ?? ''); setLink(mock.link ?? 'ready'); return; }

		const s = sessionRef.current ?? loadSession();
		sessionRef.current = s;
		if (!s) { setLink('connect'); return; }
		try {
			const list = await fetchContinue(s);
			// same cards as before (the usual case when coming back): keep the old array, so nothing re-renders while the user is already pointing
			setCards((prev) => (JSON.stringify(prev) === JSON.stringify(list) ? prev : list));
			setLink('ready');
		} catch (e) {
			if (e instanceof AuthError) { clearSession(); sessionRef.current = null; setCards([]); setLink('connect'); }
			else setLink((prev) => (prev === 'ready' ? prev : 'offline'));   // keep showing the last good data
		}
	}, []);

	useEffect(() => { void load(); }, [load]);

	// Refresh whenever the launcher comes back to the foreground (e.g. after watching something).
	useEffect(() => {
		const onVis = () => { if (!document.hidden) void load(); };
		document.addEventListener('visibilitychange', onVis);
		return () => document.removeEventListener('visibilitychange', onVis);
	}, [load]);

	// Offline → retry slowly.
	useEffect(() => {
		if (link !== 'offline' || import.meta.env.DEV) return;
		const id = window.setTimeout(() => { void load(); }, 30_000);
		return () => window.clearTimeout(id);
	}, [link, load]);

	// Not signed in → Quick Connect: show a code, approve it once in any Jellyfin client.
	useEffect(() => {
		if (link !== 'connect' || import.meta.env.DEV) return;
		let stop = false;
		let timer = 0;
		(async () => {
			let srv = loadServer();
			if (!srv && isWebOS()) srv = await jellyfinServerFromNative().catch(() => '');
			if (stop) return;
			if (!srv) { setAskServer(true); return; }
			setServer(srv);
			try {
				let enabled = false;
				try { enabled = await quickConnectEnabled(srv); }
				catch { if (!stop) { setServerError(`${srv} didn't answer.`); setAskServer(true); } return; }
				if (!enabled) { setServerError('Quick Connect is turned off on this server (Dashboard → General).'); setAskServer(true); return; }
				saveServer(srv);
				setAskServer(false);
				const qc = await quickConnectInitiate(srv);
				if (stop) return;
				setCode(qc.code);
				const started = Date.now();
				const tick = async () => {
					if (stop) return;
					try {
						const s = await quickConnectPoll(srv, qc.secret);
						if (s) { saveSession(s); sessionRef.current = s; setCode(''); void load(); return; }
					} catch { /* keep polling until the code expires */ }
					if (Date.now() - started > 4 * 60_000) { setCode(''); setLink('offline'); return; }   // expired → retry via offline timer
					timer = window.setTimeout(tick, 3000);
				};
				timer = window.setTimeout(tick, 3000);
			} catch { if (!stop) setLink('offline'); }
		})();
		return () => { stop = true; window.clearTimeout(timer); };
	}, [link, load, serverTick]);

	/** The address typed on the sign-in card: check it, remember it, start Quick Connect with it. */
	const submitServer = useCallback(async () => {
		const v = serverInput.current?.value ?? '';
		setServerError('Checking…');
		try {
			const url = await checkServer(v);
			saveServer(url);
			setServerError('');
			setAskServer(false);
			serverInput.current?.blur();
			setServerTick((t) => t + 1);
		} catch (e) { setServerError((e as Error).message); }
	}, []);

	// --- OLED idle screen -------------------------------------------------------
	// After IDLE_MS without input the UI fades to true black (pixels off) and only a dim clock stays,
	// drifting to a new spot every minute. The first key press / pointer move just wakes it: the key is
	// swallowed in the capture phase so it can't also move focus or launch something.
	useEffect(() => {
		const idleMs = (import.meta.env.DEV && window.__MOCK__?.idleMs) || IDLE_MS;
		const deepMs = (import.meta.env.DEV && window.__MOCK__?.idleMs) ? idleMs * 2 : IDLE_MS + IDLE_DEEP_MS;
		let offAsked = false;
		const wake = (): boolean => {
			lastInput.current = Date.now();
			offAsked = false;
			if (!idleRef.current) return false;
			idleRef.current = false;
			setIdle(false);
			setDeep(false);
			if (Date.now() - idleSince.current > 5 * 60_000) void load();   // back after a while → refresh the watch row
			return true;
		};
		const onKey = (e: KeyboardEvent) => { if (wake()) { e.preventDefault(); e.stopPropagation(); } };
		let lastP = {x: -1, y: -1};
		const onPointer = (e: Event) => {
			if (e.type === 'pointermove') {   // ignore remote jitter: only a real movement wakes the screen
				const m = e as PointerEvent;
				const moved = Math.abs(m.clientX - lastP.x) + Math.abs(m.clientY - lastP.y);
				lastP = {x: m.clientX, y: m.clientY};
				if (moved < 8) return;
			}
			wake();
		};
		window.addEventListener('keydown', onKey, true);
		window.addEventListener('pointermove', onPointer, true);
		window.addEventListener('mousedown', onPointer, true);
		window.addEventListener('wheel', onPointer, true);
		const onVis = () => { if (!document.hidden) wake(); };   // returning from another app counts as activity
		document.addEventListener('visibilitychange', onVis);
		// HOME while the launcher is already in front (and idle) is only a "relaunch" for the app: wake on that too
		document.addEventListener('webOSRelaunch', onVis);
		document.addEventListener('webOSLaunch', onVis);
		window.addEventListener('focus', onVis);
		const iv = window.setInterval(() => {
			const idleFor = Date.now() - lastInput.current;
			if (!idleRef.current && idleFor >= idleMs) {
				idleRef.current = true;
				idleSince.current = Date.now();
				setSpot((prev) => randomSpot(prev));
				setSpotOn(true);
				setIdle(true);
			}
			if (idleRef.current && idleFor >= deepMs) setDeep(true);
			if (idleRef.current && !offAsked && !document.hidden && !import.meta.env.DEV && idleFor >= IDLE_OFF_MS) {
				offAsked = true;   // once per idle spell; the helper checks that we are still in front and the TV is Active
				void panelOff().catch(() => { /* helper missing: the idle screen simply stays */ });
			}
		}, 1000);
		return () => {
			window.removeEventListener('keydown', onKey, true);
			window.removeEventListener('pointermove', onPointer, true);
			window.removeEventListener('mousedown', onPointer, true);
			window.removeEventListener('wheel', onPointer, true);
			document.removeEventListener('visibilitychange', onVis);
			document.removeEventListener('webOSRelaunch', onVis);
			document.removeEventListener('webOSLaunch', onVis);
			window.removeEventListener('focus', onVis);
			window.clearInterval(iv);
		};
	}, [load]);

	// While idle: fade the clock out, hop to a new spot while it is invisible, fade it back in.
	useEffect(() => {
		if (!idle) return;
		const everyMs = (import.meta.env.DEV && window.__MOCK__?.idleMs) ? 4000 : IDLE_MOVE_MS;
		let hop = 0;
		const id = window.setInterval(() => {
			setSpotOn(false);
			hop = window.setTimeout(() => { setSpot((prev) => randomSpot(prev)); setInfoIdx((i) => i + 1); setSpotOn(true); }, 1800);
		}, everyMs);
		return () => { window.clearInterval(id); window.clearTimeout(hop); };
	}, [idle]);

	// --- coming up / downloading strip ----------------------------------------------------
	// Data comes from the read-only feed service on the server (Sonarr + Radarr summary). Refreshed when the launcher is
	// shown again, every 20 s while something is downloading (once a minute behind the idle screen), otherwise every
	// 2 minutes so a new download shows up soon (the feed answers from a 10 s cache); between requests the strip counts
	// down by itself (feedLines). Any failure simply hides the strip.
	useEffect(() => {
		const mock = import.meta.env.DEV ? window.__MOCK__?.feed : undefined;
		if (mock) { setFeed({...mock, at: Date.now()}); return; }
		if (!isWebOS()) return;
		let last = 0, timer = 0, active = false, alive = true;
		const schedule = () => {
			window.clearTimeout(timer);
			timer = window.setTimeout(refresh, active ? (idleRef.current ? 60_000 : 20_000) : 2 * 60_000);
		};
		const refresh = () => {
			if (document.hidden || Date.now() - last < 15_000) { schedule(); return; }
			last = Date.now();
			void fetchFeed().then((f) => { if (!alive) return; active = downloadsActive(f); setFeed(f); schedule(); });
		};
		refresh();
		document.addEventListener('visibilitychange', refresh);
		return () => { alive = false; window.clearTimeout(timer); document.removeEventListener('visibilitychange', refresh); };
	}, []);

	// OLED guard.
	useEffect(() => {
		const id = window.setInterval(() => {
			setJitter([Math.round(Math.random() * 4) - 2, Math.round(Math.random() * 4) - 2]);
		}, JITTER_MS);
		return () => window.clearInterval(id);
	}, []);

	// --- focus --------------------------------------------------------------
	// Start on the first continue-watching card when there is one, otherwise on the apps.
	const startedOnWatch = useRef(false);
	useEffect(() => {
		if (hasWatch && !startedOnWatch.current) { startedOnWatch.current = true; setRow(0); setCol(0); setHeroIdx(0); }
		if (!hasWatch) { startedOnWatch.current = false; setRow(1); }
		if (hasWatch) setCol((c) => (row === 0 ? Math.min(c, cards.length - 1) : c));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [hasWatch, cards.length]);

	const showToast = useCallback((msg: string) => {
		setToast(msg);
		window.clearTimeout(toastTimer.current);
		toastTimer.current = window.setTimeout(() => setToast(''), 2600);
	}, []);

	const launch = useCallback((id: string, title: string, params: Record<string, unknown> = {}) => {
		if (!isWebOS()) { console.log('launch (stub, not on webOS):', id); return; }   // eslint-disable-line no-console
		launchApp(id, params).catch(() => showToast(`Couldn't launch ${title}`));
	}, [showToast]);

	const nav = useRef({row, col, hasWatch, count: cards.length, cards, launch, heroIdx, apps});
	nav.current = {row, col, hasWatch, count: cards.length, cards, launch, heroIdx, apps};

	// --- pointer (Magic Remote) support -------------------------------------------
	const lastPointer = useRef({x: -1, y: -1});
	const visibleAt = useRef(0);   // performance.now() when the launcher last became visible (diagnostics only)
	useEffect(() => {
		const onVis = () => { if (!document.hidden) visibleAt.current = performance.now(); };
		document.addEventListener('visibilitychange', onVis);
		return () => document.removeEventListener('visibilitychange', onVis);
	}, []);
	const lastActivate = useRef(0);

	/** Launch whatever sits at (row, col): a watch card resumes that item, an app card opens the app. */
	const activate = useCallback((r: number, c: number) => {
		const now = Date.now();
		if (now - lastActivate.current < 800) return;   // OK can arrive as a key press AND a click
		lastActivate.current = now;
		const n = nav.current;
		if (r === 0) {
			const card = n.cards[Math.min(c, n.cards.length - 1)];
			if (!card) n.launch(JELLYFIN_APP_ID, 'Jellyfin');
			else if (isWebOS()) openJellyfinItem(JELLYFIN_APP_ID, card.id).catch(() => showToast("Couldn't open Jellyfin"));   // play from the resume position
		} else {
			const a = n.apps[Math.min(c, n.apps.length - 1)];
			n.launch(a.id, a.title);
		}
	}, []);

	/** Pointer over a card focuses it, but only for REAL pointer movement - a card that slides under a
	 *  still pointer (the row scrolls) must not steal focus. */
	const hover = useCallback((r: 0 | 1, c: number, e: ReactMouseEvent) => {
		const p = lastPointer.current;
		if (Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y) < 6) return;
		lastPointer.current = {x: e.clientX, y: e.clientY};
		if (movingRef.current) { if (r === 1) moveTo(c); return; }
		setRow(r);
		setCol(c);
		// diagnostics for real Magic-Remote use (read later over DevTools: window.__hoverLog): how long from the system's
		// pointer event to the painted frame, and how soon after the launcher came back the first pointer event arrived
		const born = e.nativeEvent.timeStamp;
		window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
			const log = (window.__hoverLog ||= []);
			log.push({sinceVisible: Math.round(born - visibleAt.current), toFrame: Math.round(performance.now() - born)});
			if (log.length > 40) log.shift();
		}));
	}, []);

	// --- arranging app tiles ----------------------------------------------------------
	// Long-press OK (or hold the pointer button) on an app tile to pick it up. Then ◀ ▶ (or dragging with the button still
	// held) moves it, OK / releasing after a drag places it, Back puts everything back as it was. The order is kept in
	// localStorage; tiles it doesn't know (apps installed later) keep their default spot.
	const [moving, setMoving] = useState<string | null>(null);   // id of the tile being moved
	const movingRef = useRef<string | null>(null);
	const moveFrom = useRef<string[]>([]);       // the order shown when the tile was picked up (Back restores it)
	const moveByPointer = useRef(false);         // picked up with the pointer button: releasing after a drag places it
	const moved = useRef(false);                 // the tile has changed place since it was picked up
	const press = useRef({timer: 0, fired: false});

	const pickUp = useCallback((i: number, byPointer: boolean) => {
		const ids = nav.current.apps.map((a) => a.id);
		if (!ids[i]) return;
		moveFrom.current = ids;
		moveByPointer.current = byPointer;
		moved.current = false;
		movingRef.current = ids[i];
		setRow(1); setCol(i); setMoving(ids[i]);
	}, []);
	const moveTo = useCallback((to: number) => {
		const id = movingRef.current;
		if (!id) return;
		const ids = nav.current.apps.map((a) => a.id);
		const from = ids.indexOf(id), t = Math.max(0, Math.min(ids.length - 1, to));
		if (from < 0 || t === from) return;
		ids.splice(from, 1); ids.splice(t, 0, id);
		moved.current = true;
		setOrder(ids); setCol(t);
	}, []);
	const place = useCallback((keep: boolean) => {
		const id = movingRef.current;
		if (!id) return;
		if (keep) saveOrder(nav.current.apps.map((a) => a.id));
		else { setOrder(loadOrder()); setCol(Math.max(0, moveFrom.current.indexOf(id))); }
		movingRef.current = null; moveByPointer.current = false;
		setMoving(null);
	}, []);
	/** A press on an app tile starts the long-press timer (OK can arrive as a key press AND a pointer press: one timer). */
	const pressStart = useCallback((i: number, byPointer: boolean) => {
		if (press.current.timer || movingRef.current) return;
		press.current.fired = false;
		press.current.timer = window.setTimeout(() => { press.current.timer = 0; press.current.fired = true; pickUp(i, byPointer); }, LONG_PRESS_MS);
	}, [pickUp]);
	/** The press ended: true if it was a short one (= open the app). */
	const pressEnd = useCallback(() => {
		if (!press.current.timer) return false;
		window.clearTimeout(press.current.timer); press.current.timer = 0;
		return true;
	}, []);
	useEffect(() => {
		// releasing the pointer button after dragging a tile places it; a plain long press without dragging keeps it
		// picked up, so it can still be moved with ◀ ▶ or the pointer
		const onUp = () => { if (movingRef.current && moveByPointer.current && moved.current) place(true); else pressEnd(); };
		window.addEventListener('mouseup', onUp);
		return () => window.removeEventListener('mouseup', onUp);
	}, [place, pressEnd]);

	// tiles glide to their new place (FLIP: measure where each one was, start it there, let it slide in)
	const tileEls = useRef(new Map<string, HTMLDivElement>());
	const tileX = useRef(new Map<string, number>());
	useLayoutEffect(() => {
		const next = new Map<string, number>();
		tileEls.current.forEach((el, id) => {
			const x = el.offsetLeft, was = tileX.current.get(id);
			next.set(id, x);
			if (was !== undefined && was !== x) {
				el.animate([{translate: `${was - x}px 0`}, {translate: '0 0'}], {duration: 300, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)'});
			}
		});
		tileX.current = next;
	}, [apps]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			// typing the server address: the field (and the TV's keyboard) get the keys; Down leaves it
			if (document.activeElement === serverInput.current && serverInput.current) {
				if (e.key === 'ArrowDown') { e.preventDefault(); serverInput.current.blur(); setRow(1); }
				else if (e.key === 'Enter') { e.preventDefault(); void submitServer(); }
				return;
			}
			const n = nav.current;
			if (movingRef.current) {
				e.preventDefault();
				if (e.key === 'ArrowLeft') moveTo(n.col - 1);
				else if (e.key === 'ArrowRight') moveTo(n.col + 1);
				else if (e.key === 'Enter' && !e.repeat) place(true);
				else if (e.keyCode === 461 || e.key === 'GoBack' || e.key === 'Escape' || e.key === 'Backspace') { e.stopPropagation(); place(false); }
				return;
			}
			if (e.key === 'ArrowUp' && n.row === 1 && !n.hasWatch && serverInput.current) { e.preventDefault(); serverInput.current.focus(); return; }
			const rowLen = n.row === 0 ? n.count : n.apps.length;
			switch (e.key) {
				case 'ArrowLeft': e.preventDefault(); setCol((c) => Math.max(0, c - 1)); break;
				case 'ArrowRight': e.preventDefault(); setCol((c) => Math.min(rowLen - 1, c + 1)); break;
				case 'ArrowUp':
					e.preventDefault();
					if (n.row === 1 && n.hasWatch) { setRow(0); setCol(Math.min(n.heroIdx, n.count - 1)); }
					break;
				case 'ArrowDown':
					e.preventDefault();
					if (n.row === 0) { setRow(1); setCol((c) => Math.min(c, n.apps.length - 1)); }
					break;
				case 'Enter':
					e.preventDefault();
					if (e.repeat) return;
					if (n.row === 1) pressStart(n.col, false);   // apps open on release, a long press picks the tile up
					else activate(n.row, n.col);
					break;
				default: break;   // Back etc. fall through to webOS
			}
		};
		const onKeyUp = (e: KeyboardEvent) => {
			if (e.key !== 'Enter' || document.activeElement === serverInput.current) return;
			const n = nav.current;
			if (pressEnd() && n.row === 1) activate(1, n.col);
		};
		window.addEventListener('keydown', onKey);
		window.addEventListener('keyup', onKeyUp);
		return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKeyUp); };
	}, [submitServer, moveTo, place, pressStart, pressEnd]);

	// Hero follows the focused continue-watching card; it stays put while you browse apps.
	useEffect(() => { if (row === 0) setHeroIdx(col); }, [row, col]);

	const strip = feedLines(feed);
	// what the idle screen shows under the clock, one item per minute: what to watch next, then the feed lines
	const idleInfo: Line[] = [
		...(cards[0] ? [{tag: 'Up next', text: [cards[0].title, cards[0].subtitle].filter(Boolean).join(' · ')}] : []),
		...strip
	];
	const info = idleInfo.length ? idleInfo[infoIdx % idleInfo.length] : null;
	const hero = hasWatch ? cards[Math.min(heroIdx, cards.length - 1)] : null;
	const maxOffset = Math.max(0, (cards.length - VISIBLE) * (CARD_W + GAP));
	const watchCol = row === 0 ? col : Math.min(heroIdx, Math.max(0, cards.length - 1));   // the watch row keeps its own position while you browse apps
	const offset = Math.min(maxOffset, Math.max(0, watchCol - 2) * (CARD_W + GAP));

	const hh = String(now.getHours()).padStart(2, '0');
	const mm = String(now.getMinutes()).padStart(2, '0');
	const date = now.toLocaleDateString('en-GB', {weekday: 'long', day: 'numeric', month: 'long'});

	return (
		<div className="root" style={{transform: `translate(${jitter[0]}px, ${jitter[1]}px)`}}>
			<div className={'ui' + (idle ? ' ui-off' : '')}>
			<div className="wash" />
			<Backdrop url={hero?.backdrop ?? ''} />
			<div className="shade-left" />
			<div className="shade-bottom" />
			<div className="shade-top" />

			<header className="top">
				<div>
					<div className="greeting">{greeting(now.getHours())}</div>
					<div className="date">{date}</div>
				</div>
				<div className="clock">{hh}:{mm}</div>
			</header>

			{/* not while idle: the hidden UI would otherwise keep animating and re-render every 8 s */}
			{strip.length > 0 && !idle ? (
				<div className="strip" aria-hidden>
					<div className="line" key={stripIdx % strip.length} onAnimationIteration={() => setStripIdx((i) => i + 1)}>
						<b>{strip[stripIdx % strip.length].tag}</b>{strip[stripIdx % strip.length].text}
					</div>
				</div>
			) : null}

			{hero ? (
				<section className="hero" key={hero.id}>
					<div className="pill"><i />{hero.status}</div>
					<h1>{hero.title}</h1>
					{hero.subtitle ? <div className="sub">{hero.subtitle}</div> : null}
					{hero.meta ? <div className="meta">{hero.meta}</div> : null}
					{hero.overview ? <p className="overview">{hero.overview}</p> : null}
				</section>
			) : null}

			{!hero && (link === 'ready' || link === 'offline') ? (
				<section className="hero solo">
					<div className="pill"><i />Jellyfin</div>
					<h1>{link === 'ready' ? 'Nothing in progress' : 'Jellyfin unreachable'}</h1>
					<div className="meta">{link === 'ready' ? 'What you start watching in Jellyfin shows up here.' : 'Trying again in a moment — your apps still work.'}</div>
				</section>
			) : null}

			{hasWatch ? (
				<section className="block watch">
					<div className="label">Continue watching</div>
					<div className="clip">
						<div className="track" style={{transform: `translate3d(${-offset}px,0,0)`}}>
							{cards.map((c, i) => (
								<div key={c.id} className={'card wide' + (row === 0 && col === i ? ' on' : '')}
									onMouseMove={(e) => hover(0, i, e)} onClick={() => { setRow(0); setCol(i); activate(0, i); }}>
									<div className="thumb">
										{c.thumb ? <img src={c.thumb} alt="" decoding="async" /> : <span className="ph">{c.title.slice(0, 1)}</span>}
										{c.progress > 0 ? <div className="bar"><i style={{width: `${Math.round(c.progress * 100)}%`}} /></div> : null}
									</div>
									<div className="cap">
										<div className="t">{c.title}</div>
										<div className="s">{c.subtitle}</div>
									</div>
									<div className="ring" />
								</div>
							))}
						</div>
					</div>
				</section>
			) : link === 'connect' ? (
				<section className="block watch">
					<div className="label">Jellyfin</div>
					{askServer ? (
						<div className="connect">
							<div className="cx-text">
								<div className="cx-title">Connect your Jellyfin</div>
								<div className="cx-help">{serverError || "Your server's address, e.g. 192.168.1.20:8096 or jellyfin.example.com (▲ to type, OK to connect)."}</div>
							</div>
							<input ref={serverInput} className="cx-input" type="url" placeholder="jellyfin.example.com" defaultValue={server}
								spellCheck={false} autoCapitalize="off" autoCorrect="off" />
						</div>
					) : (
						<div className="connect">
							<div className="cx-text">
								<div className="cx-title">Connect your Jellyfin</div>
								<div className="cx-help">Open Jellyfin on your phone or PC → Settings → Quick Connect, then enter this code.</div>
							</div>
							<div className="cx-code">{code ? `${code.slice(0, 3)} ${code.slice(3)}`.trim() : '······'}</div>
						</div>
					)}
				</section>
			) : null}

			<section className="block apps">
				<div className="label">Apps{moving ? <span className="hint">◀ ▶ move · OK place · Back cancel</span> : null}</div>
				{/* 9 tiles fill the row; with extra HDMI tiles they narrow so Settings stays on screen */}
				<div className={'approw' + (moving ? ' sorting' : '')} style={apps.length > 9 ? {['--tile-w' as string]: `${Math.floor((1920 - 2 * 96 - 16 * (apps.length - 1)) / apps.length)}px`} : undefined}>
					{apps.map((a, i) => (
						<div key={a.id} className={'card app' + (row === 1 && col === i ? ' on' : '') + (a.dim ? ' dim' : '') + (moving === a.id ? ' moving' : '')}
							ref={(el) => { if (el) tileEls.current.set(a.id, el); else tileEls.current.delete(a.id); }}
							onMouseMove={(e) => hover(1, i, e)}
							onMouseDown={(e) => { if (e.button === 0) pressStart(i, true); }}
							onClick={() => {
								if (press.current.fired) { press.current.fired = false; return; }   // the long press that picked it up
								if (movingRef.current) { place(true); return; }
								setRow(1); setCol(i); activate(1, i);
							}}>
							<AppIcon app={a} />
							<div className="app-title">{a.title}</div>
							{a.sub ? <div className="app-sub">{a.sub}</div> : null}
							<div className="ring" />
							{moving === a.id && i > 0 ? <i className="nudge l" /> : null}
							{moving === a.id && i < apps.length - 1 ? <i className="nudge r" /> : null}
						</div>
					))}
				</div>
			</section>

			</div>

			<div className={'idle' + (idle ? ' on' : '') + (deep ? ' deep' : '')} aria-hidden>
				<div className={'idle-clock' + (spotOn ? ' on' : '')} style={{transform: `translate3d(${spot.x}px, ${spot.y}px, 0)`}}>
					<div className="ic-time">{hh}:{mm}</div>
					<div className="ic-date">{date}</div>
					{info ? <div className="ic-info"><b>{info.tag}</b>{info.text}</div> : null}
				</div>
			</div>

			<div className={'toast' + (toast ? ' show' : '')}>{toast}</div>
		</div>
	);
}
