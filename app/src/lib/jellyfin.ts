// Small Jellyfin client: Quick Connect sign-in + "continue watching" (resume + next up).
// Credentials live only in this app's localStorage on the TV (never in the source).

// The Jellyfin server: remembered on the TV once chosen. A build can suggest one (VITE_JELLYFIN_URL in app/.env.local,
// git-ignored); otherwise it comes from Jellyfin Native (via the helper) or is typed in on the sign-in card.
export const BUILD_SERVER: string = (import.meta.env.VITE_JELLYFIN_URL as string | undefined) || '';
const SERVER_KEY = 'minihome-server';
export function loadServer (): string {
	try { return localStorage.getItem(SERVER_KEY) || BUILD_SERVER; } catch { return BUILD_SERVER; }
}
export function saveServer (url: string): void {
	try { localStorage.setItem(SERVER_KEY, url); } catch { /* noop */ }
}
// Jellyfin Native, our own client (repo webos-jellyfin-native). {itemId, play: true} plays the item from its resume position;
// leaving the player then closes the app, so Back lands on the launcher again.
export const JELLYFIN_APP_ID = 'tld.my.jfnative';

const SESSION_KEY = 'minihome-jf-v1';
const DEVICE_KEY = 'minihome-device-v1';
const VERSION = '0.4.0';

export interface Session {server: string; token: string; userId: string}

export interface Card {
	id: string;
	title: string;          // series name for episodes, else the item name
	subtitle: string;       // "S5 · E3 — Episode name" / "2019 · Movie"
	meta: string;           // "2019 · TV-MA · 24 min"
	overview: string;
	thumb: string;          // landscape card image
	backdrop: string;       // large hero image
	progress: number;       // 0..1 (0 = not started / next up)
	status: string;         // "12 min left" | "Next up" | "Resume"
}

// --- session ---------------------------------------------------------------

export function loadSession (): Session | null {
	try {
		const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
		return s && s.server && s.token && s.userId ? s as Session : null;
	} catch { return null; }
}
export function saveSession (s: Session): void {
	try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* noop */ }
}
export function clearSession (): void {
	try { localStorage.removeItem(SESSION_KEY); } catch { /* noop */ }
}

function deviceId (): string {
	try {
		let id = localStorage.getItem(DEVICE_KEY);
		if (!id) {
			id = 'minihome-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
			localStorage.setItem(DEVICE_KEY, id);
		}
		return id;
	} catch { return 'minihome-fallback'; }
}

function authHeader (token?: string): string {
	return `MediaBrowser Client="Minimal Home", Device="LG TV", DeviceId="${deviceId()}", Version="${VERSION}"` +
		(token ? `, Token="${token}"` : '');
}

export class AuthError extends Error {}

async function api<T> (server: string, path: string, opts: {token?: string; method?: string; body?: unknown; timeoutMs?: number} = {}): Promise<T> {
	const ctl = new AbortController();
	const timer = window.setTimeout(() => ctl.abort(), opts.timeoutMs ?? 10_000);
	try {
		const res = await fetch(server + path, {
			method: opts.method ?? 'GET',
			headers: {
				'Authorization': authHeader(opts.token),
				...(opts.body ? {'Content-Type': 'application/json'} : {})
			},
			body: opts.body ? JSON.stringify(opts.body) : undefined,
			signal: ctl.signal
		});
		if (res.status === 401) throw new AuthError('unauthorized');
		if (!res.ok) throw new Error(`${path} → ${res.status}`);
		const text = await res.text();
		return (text ? JSON.parse(text) : {}) as T;
	} finally { window.clearTimeout(timer); }
}

// --- Quick Connect ---------------------------------------------------------

export interface QuickConnect {secret: string; code: string}

export async function quickConnectEnabled (server: string): Promise<boolean> {
	try { return (await api<boolean>(server, '/QuickConnect/Enabled')) === true; } catch { return false; }
}

export function quickConnectInitiate (server: string): Promise<QuickConnect> {
	return api<{Secret: string; Code: string}>(server, '/QuickConnect/Initiate', {method: 'POST'})
		.then((r) => ({secret: r.Secret, code: r.Code}));
}

/** Resolves a Session once the code has been approved in another Jellyfin client; null while pending. */
export async function quickConnectPoll (server: string, secret: string): Promise<Session | null> {
	const st = await api<{Authenticated?: boolean}>(server, `/QuickConnect/Connect?secret=${encodeURIComponent(secret)}`);
	if (!st.Authenticated) return null;
	const r = await api<{AccessToken: string; User: {Id: string}}>(server, '/Users/AuthenticateWithQuickConnect', {
		method: 'POST', body: {Secret: secret}
	});
	return {server, token: r.AccessToken, userId: r.User.Id};
}

/** What was typed → a working server URL: as given, else https, http and Jellyfin's port 8096 are tried. */
export async function checkServer (input: string): Promise<string> {
	const t = input.trim().replace(/\/+$/, '');
	if (!t) throw new Error("Enter your server's address first.");
	const tries = /^https?:\/\//.test(t) ? [t] : [`https://${t}`, `http://${t}`, ...(t.includes(':') ? [] : [`http://${t}:8096`])];
	for (const u of tries) {
		try {
			const info = await api<{Id?: string}>(u, '/System/Info/Public', {timeoutMs: 5000});
			if (info && info.Id) return u;
		} catch { /* next candidate */ }
	}
	throw new Error(`No Jellyfin server answered at ${t}.`);
}

// --- items -----------------------------------------------------------------

interface Item {
	Id: string;
	ServerId?: string;
	Name: string;
	Type: string;                   // Movie | Episode | ...
	SeriesName?: string;
	SeriesId?: string;
	ParentIndexNumber?: number;     // season
	IndexNumber?: number;           // episode
	ProductionYear?: number;
	OfficialRating?: string;
	RunTimeTicks?: number;
	Overview?: string;
	ImageTags?: Record<string, string>;
	BackdropImageTags?: string[];
	ParentBackdropItemId?: string;
	ParentBackdropImageTags?: string[];
	ParentThumbItemId?: string;
	ParentThumbImageTag?: string;
	SeriesPrimaryImageTag?: string;
	UserData?: {PlaybackPositionTicks?: number; PlayedPercentage?: number; LastPlayedDate?: string; Played?: boolean};
}

const FIELDS = 'Overview';
const TICKS_PER_MIN = 600_000_000;

function img (server: string, id: string, type: string, tag: string | undefined, width: number): string {
	return `${server}/Items/${id}/Images/${type}?maxWidth=${width}&quality=70${tag ? `&tag=${tag}` : ''}`;
}

function toCard (server: string, it: Item, status: 'resume' | 'next' | 'started'): Card {
	const isEp = it.Type === 'Episode';
	const mins = it.RunTimeTicks ? Math.round(it.RunTimeTicks / TICKS_PER_MIN) : 0;
	const pct = Math.min(1, Math.max(0, (it.UserData?.PlayedPercentage ?? 0) / 100));
	const left = mins && pct ? Math.max(1, Math.round(mins * (1 - pct))) : 0;

	// landscape card image: item's own thumb/still → parent thumb → backdrop
	let thumb = '';
	if (it.ImageTags?.Thumb) thumb = img(server, it.Id, 'Thumb', it.ImageTags.Thumb, 640);
	else if (isEp && it.ImageTags?.Primary) thumb = img(server, it.Id, 'Primary', it.ImageTags.Primary, 640);
	else if (it.ParentThumbItemId) thumb = img(server, it.ParentThumbItemId, 'Thumb', it.ParentThumbImageTag, 640);
	else if (it.BackdropImageTags?.[0]) thumb = img(server, it.Id, 'Backdrop', it.BackdropImageTags[0], 640);
	else if (it.ParentBackdropItemId) thumb = img(server, it.ParentBackdropItemId, 'Backdrop', it.ParentBackdropImageTags?.[0], 640);
	else if (it.ImageTags?.Primary) thumb = img(server, it.Id, 'Primary', it.ImageTags.Primary, 640);

	// hero image: a real backdrop wins
	let backdrop = thumb;
	if (it.BackdropImageTags?.[0]) backdrop = img(server, it.Id, 'Backdrop', it.BackdropImageTags[0], 1600);
	else if (it.ParentBackdropItemId) backdrop = img(server, it.ParentBackdropItemId, 'Backdrop', it.ParentBackdropImageTags?.[0], 1600);

	const season = it.ParentIndexNumber, ep = it.IndexNumber;
	const subtitle = isEp
		? `${season != null ? `S${season} · ` : ''}${ep != null ? `E${ep}` : ''}${it.Name ? ` — ${it.Name}` : ''}`.replace(/^ — /, '')
		: [it.ProductionYear, 'Movie'].filter(Boolean).join(' · ');

	return {
		id: it.Id,
		title: isEp ? (it.SeriesName || it.Name) : it.Name,
		subtitle,
		meta: [it.ProductionYear, it.OfficialRating, mins ? `${mins} min` : ''].filter(Boolean).join('  ·  '),
		overview: (it.Overview || '').replace(/\s+/g, ' ').trim(),
		thumb,
		backdrop,
		progress: status === 'resume' ? pct : 0,
		status: status === 'resume' ? (left ? `${left} min left` : 'Resume') : status === 'started' ? 'Started' : 'Next up'
	};
}

/** Resume items first, then "next up" episodes — what Jellyfin's own home calls Continue Watching. */
export async function fetchContinue (s: Session, limit = 10): Promise<Card[]> {
	const q = `userId=${s.userId}&limit=${limit}&fields=${FIELDS}&enableImageTypes=Primary,Backdrop,Thumb&imageTypeLimit=1`;
	const none = (e: unknown): {Items: Item[]} => { if (e instanceof AuthError) throw e; return {Items: []}; };
	// all three at once: a refresh costs one round trip instead of three
	const [resume, next, started] = await Promise.all([
		api<{Items: Item[]}>(s.server, `/UserItems/Resume?${q}&mediaTypes=Video`, {token: s.token})
			.catch((e) => {
				if (e instanceof AuthError) throw e;
				return api<{Items: Item[]}>(s.server, `/Users/${s.userId}/Items/Resume?${q}&mediaTypes=Video`, {token: s.token});
			}),
		api<{Items: Item[]}>(s.server, `/Shows/NextUp?${q}&enableResumable=false`, {token: s.token}).catch(none),
		// Jellyfin only keeps a resume position after ~5 % of a title (server setting "minimum resume percentage"), so something
		// you just started and stopped early never shows up in Resume. Show those too (played in the last 7 days, not finished).
		api<{Items: Item[]}>(s.server, `/Items?${q}&recursive=true&includeItemTypes=Movie,Episode&filters=IsUnplayed&sortBy=DatePlayed&sortOrder=Descending`, {token: s.token})
			.then((r) => ({Items: (r.Items || []).filter((it) => {
				const at = it.UserData?.LastPlayedDate ? Date.parse(it.UserData.LastPlayedDate) : 0;
				return at > Date.now() - 7 * 86_400_000 && !it.UserData?.Played;
			}).slice(0, 3)}))
			.catch(none)
	]);

	const seen = new Set<string>();
	const cards: Card[] = [];
	for (const [list, status] of [[resume.Items, 'resume'], [started.Items, 'started'], [next.Items, 'next']] as const) {
		for (const it of list || []) {
			if (seen.has(it.Id)) continue;
			seen.add(it.Id);
			cards.push(toCard(s.server, it, status));
		}
	}
	return cards.slice(0, limit);
}
