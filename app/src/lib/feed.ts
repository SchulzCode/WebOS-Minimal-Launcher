// Optional "Coming up / Downloading" strip: reads the small read-only feed service (server/launcher-feed), which
// summarises Sonarr + Radarr. The TV never holds the arr API keys. Off unless a feed URL is set at build time
// (VITE_FEED_URL in app/.env.local, git-ignored). Everything here fails soft: no feed -> no strip.

const DEFAULT_FEED_URL: string = (import.meta.env.VITE_FEED_URL as string | undefined) || '';

export interface Upcoming {kind: 'episode' | 'movie'; title: string; label: string; name: string; when: string}
export interface Download {kind: 'episode' | 'movie'; title: string; label: string; progress: number; timeleft: string; status: string}
export interface Feed {upcoming: Upcoming[]; downloading: Download[]}

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
		return {upcoming: Array.isArray(j.upcoming) ? j.upcoming : [], downloading: Array.isArray(j.downloading) ? j.downloading : []};
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

/** What the strip rotates through: running downloads first (most actionable), then what is coming up. */
export function feedLines (feed: Feed | null, now: Date = new Date()): Line[] {
	if (!feed) return [];
	const out: Line[] = [];
	for (const d of feed.downloading) {
		if (d.progress >= 0.999 || /completed|import/i.test(d.status)) continue;   // finished, waiting for import: not interesting
		const pct = `${Math.round(d.progress * 100)}%`;
		out.push({tag: 'Downloading', text: `${[d.title, d.label].filter(Boolean).join(' ')} · ${pct}${d.timeleft && d.timeleft !== '00:00:00' ? ` · ${d.timeleft}` : ''}`});
	}
	for (const u of feed.upcoming.slice(0, 4)) {
		const when = whenLabel(u.when, now);
		if (!when) continue;
		out.push({tag: 'Coming up', text: `${when} · ${[u.title, u.label].filter(Boolean).join(' ')}`});
	}
	return out;
}
