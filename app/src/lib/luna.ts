// Minimal luna-service2 bridge for webOS web apps — no webOSTV.js dependency.
// webOS injects window.PalmServiceBridge into every web app; each call is a
// fresh bridge whose single response arrives on `onservicecallback`.

type Params = Record<string, unknown>;

interface PalmBridge {
	onservicecallback: ((msg: string) => void) | null;
	call (uri: string, params: string): void;
	cancel? (): void;
}
declare global {
	interface Window {
		PalmServiceBridge?: {new (): PalmBridge};
	}
}

export function isWebOS (): boolean {
	return typeof window !== 'undefined' && typeof window.PalmServiceBridge === 'function';
}

/** One-shot luna call. Resolves the parsed response, rejects on returnValue:false,
 *  bad JSON, a thrown bridge error, or timeout. */
export function lunaCall<T = unknown> (service: string, method: string, params: Params = {}, timeoutMs = 4000): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const Bridge = typeof window !== 'undefined' ? window.PalmServiceBridge : undefined;
		if (!Bridge) { reject(new Error('PalmServiceBridge unavailable (not on webOS)')); return; }

		const bridge = new Bridge();
		let done = false;
		let timer = 0;
		const finish = (fn: () => void) => {
			if (done) return;
			done = true;
			window.clearTimeout(timer);
			try { bridge.cancel?.(); } catch { /* noop */ }
			fn();
		};

		bridge.onservicecallback = (msg) => {
			let data: unknown;
			try { data = JSON.parse(msg); }
			catch (e) { finish(() => reject(e as Error)); return; }
			const rv = (data as {returnValue?: boolean}).returnValue;
			if (rv === false) {
				const err = (data as {errorText?: string}).errorText || `luna ${service}/${method} failed`;
				finish(() => reject(new Error(err)));
			} else {
				finish(() => resolve(data as T));
			}
		};

		try { bridge.call(`luna://${service}/${method}`, JSON.stringify(params)); }
		catch (e) { finish(() => reject(e as Error)); return; }

		timer = window.setTimeout(() => finish(() => reject(new Error(`luna ${service}/${method} timeout`))), timeoutMs);
	});
}

/** Launch (or switch input to) an app by webOS appId. */
export function launchApp (id: string, params: Params = {}): Promise<unknown> {
	return lunaCall('com.webos.applicationManager', 'launch', {id, params});
}

/** Ids of the apps installed on this TV (from the helper, which may list them). */
export function installedApps (): Promise<string[]> {
	return lunaCall<{ids?: string[]}>('tld.my.minimalhome.service', 'installedApps', {}, 5000).then((r) => r.ids || []);
}

/** The server Jellyfin Native is signed in to (only the address - the helper never hands out its token). */
export function jellyfinServerFromNative (): Promise<string> {
	return lunaCall<{server?: string}>('tld.my.minimalhome.service', 'jellyfinServer', {}, 3000).then((r) => r.server || '');
}

/** Open a Jellyfin item in Jellyfin Native and resume it. Goes through the helper, which first closes a copy of the app that
 *  is still running in the background (the native app reads launch parameters only at start); without the helper, a plain
 *  launch still works whenever the app isn't running. */
export function openJellyfinItem (appId: string, itemId: string): Promise<unknown> {
	return lunaCall('tld.my.minimalhome.service', 'openItem', {itemId, play: true}, 6000)
		.catch(() => launchApp(appId, {itemId, play: true}));
}

/**
 * Ask the helper service to switch the panel off (OLED care after a long idle). The helper only does it while the launcher is
 * in front and the TV is Active. Best effort; any remote key brings the picture back.
 */
export function panelOff (): Promise<unknown> {
	return lunaCall('tld.my.minimalhome.service', 'screenOff', {});
}

/** One HDMI port as the TV's external-input manager sees it. */
export interface InputPort {id: string; appId: string; label: string; renamed: boolean; plugged: boolean}

interface EimDevice {id?: string; appId?: string; label?: string; modified?: boolean; hdmiPlugIn?: boolean}

function toPorts (msg: string): InputPort[] | null {
	try {
		const d = JSON.parse(msg) as {returnValue?: boolean; devices?: EimDevice[]};
		if (d.returnValue === false || !Array.isArray(d.devices)) return null;
		return d.devices.filter((x) => x.id && x.appId).map((x) => ({
			id: x.id!, appId: x.appId!, label: x.label || x.id!, renamed: x.modified === true, plugged: x.hdmiPlugIn === true
		}));
	} catch { return null; }
}

/**
 * Live HDMI plug state (com.webos.service.eim/getAllInputStatus; `hdmiPlugIn` = a powered device on the cable). Subscribes,
 * and also re-reads whenever `refresh()` is called (the launcher does that on return and every few seconds while shown,
 * because a push on plug/unplug isn't verified on this firmware). Returns {refresh, cancel}; no-op off webOS.
 */
export function watchInputs (onPorts: (ports: InputPort[]) => void): {refresh: () => void; cancel: () => void} {
	const Bridge = typeof window !== 'undefined' ? window.PalmServiceBridge : undefined;
	if (!Bridge) return {refresh: () => { /* not on webOS */ }, cancel: () => { /* not on webOS */ }};
	const sub = new Bridge();
	sub.onservicecallback = (msg) => { const p = toPorts(msg); if (p) onPorts(p); };
	try { sub.call('luna://com.webos.service.eim/getAllInputStatus', JSON.stringify({subscribe: true})); } catch { /* noop */ }
	return {
		refresh: () => {
			lunaCall('com.webos.service.eim', 'getAllInputStatus', {})
				.then((d) => { const p = toPorts(JSON.stringify(d)); if (p) onPorts(p); })
				.catch(() => { /* keep the last known state */ });
		},
		cancel: () => { try { sub.cancel?.(); } catch { /* noop */ } }
	};
}
