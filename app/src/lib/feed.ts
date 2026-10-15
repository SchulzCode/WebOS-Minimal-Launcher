// Optional "Coming up / Downloading" strip: reads the small read-only feed service (server/launcher-feed), which
// summarises Sonarr + Radarr. The TV never holds the arr API keys. Off unless a feed URL is set at build time
// (VITE_FEED_URL in app/.env.local, git-ignored). Everything here fails soft: no feed -> no strip.

const DEFAULT_FEED_URL: string = (import.meta.env.VITE_FEED_URL as string | undefined) || '';

export interface Upcoming {kind: 'episode' | 'movie'; title: string; label: string; name: string; when: string}
/** `progress` is the feed's estimate for the moment it answered and `eta` the seconds left from then (newer feeds;
 * older ones only have Sonarr's/Radarr's `timeleft`, which they update about once a minute). */
export interface Download {kind: 'episode' | 'movie'; title: string; label: string; progress: number; timeleft: string; status: string; eta?: number | null; state?: string}
export interface Feed {upcoming: Upcoming[]; downloading: Download[]; /** Date.now() when it arrived */ at: number}

export function feedUrl (): string {
	try { return localStorage.getItem('minihome-feed-url') || DEFAULT_FEED_URL; } catch { return DEFAULT_FEED_URL; }
}

export async function fetchFeed (): Promise<Feed | null> {
	const url = feedUrl();
	if (!url) return null;
	const ctl = new AbortController();
	const timer = window.setTimeout(() => ctl.abort(), 7000);
	try {
		const res = await fetch(url, {signal: ctl.signal});
		if (!res.ok) return null;
		const j = await res.json();
		return {upcoming: Array.isArray(j.upcoming) ? j.upcoming : [], downloading: Array.isArray(j.downloading) ? j.downloading : [], at: Date.now()};
	} catch { return null; } finally { window.clearTimeout(timer); }
}

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "Today 21:00", "Tomorrow 04:00", "Fri 16 Oct" (local time; the time of day only for today/tomorrow) */
export function whenLabel (iso: string, now: Date = new Date()): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return '';
	const time = d.toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'});
	const days = Math.round((dayStart(d) - dayStart(now)) / 86_400_000);
	if (days <= 0) return `Today ${time}`;
	if (days === 1) return `Tomorrow ${time}`;
	return d.toLocaleDateString('en-GB', {weekday: 'short', day: 'numeric', month: 'short'});
}

export interface Line {tag: string; text: string}

/** Something is actually moving (or about to): worth polling the feed often. */
export function downloadsActive (feed: Feed | null): boolean {
	return !!feed && feed.downloading.some((d) => d.state ? d.state === 'downloading' || d.state === 'queued' : d.progress < 0.999 && !/completed|import/i.test(d.status));
}

/** "under a minute", "7 min", "1 h 12 min" */
export function durationLabel (s: number): string {
	const m = Math.round(s / 60);
	if (m < 1) return 'under a minute';
	return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Progress and seconds left right now: carried forward from the feed's numbers at the feed's rate, so the strip keeps
 * moving between requests (capped at 2 minutes past the last answer, in case the download stalled meanwhile). */
export function liveDownload (d: Download, at: number, now = Date.now()): {progress: number; left: number | null} {
	if (typeof d.eta !== 'number') return {progress: d.progress, left: null};
	const dt = Math.min(Math.max((now - at) / 1000, 0), 120);
	if (d.eta <= 0 || d.state !== 'downloading') return {progress: d.progress, left: Math.max(d.eta - dt, 0)};
	return {progress: Math.min(d.progress + (1 - d.progress) * Math.min(dt / d.eta, 1), 1), left: Math.max(d.eta - dt, 0)};
}

/** What the strip rotates through: running downloads first (most actionable), then what is coming up. */
export function feedLines (feed: Feed | null, now: Date = new Date()): Line[] {
	if (!feed) return [];
	const out: Line[] = [];
	for (const d of feed.downloading) {
		const name = [d.title, d.label].filter(Boolean).join(' ');
		if (d.state === 'blocked' || d.state === 'failed') { out.push({tag: 'Download problem', text: `${name} · ${d.state === 'blocked' ? 'not imported - check Sonarr/Radarr' : 'failed'}`}); continue; }
		if (d.state ? !['downloading', 'queued', 'paused', 'stalled'].includes(d.state) : d.progress >= 0.999 || /completed|import/i.test(d.status)) continue;   // finished, being imported: not interesting
		const {progress, left} = liveDownload(d, feed.at);
		const pct = `${Math.floor(progress * 100)}%`;
		const rest = d.state && d.state !== 'downloading' ? d.state
			: left !== null ? (left > 0 ? `${durationLabel(left)} left` : '')
				: d.timeleft && d.timeleft !== '00:00:00' ? d.timeleft : '';
		out.push({tag: 'Downloading', text: `${name} · ${pct}${rest ? ` · ${rest}` : ''}`});
	}
	for (const u of feed.upcoming.slice(0, 4)) {
		const when = whenLabel(u.when, now);
		if (!when) continue;
		out.push({tag: 'Coming up', text: `${when} · ${[u.title, u.label].filter(Boolean).join(' ')}`});
	}
	return out;
}
