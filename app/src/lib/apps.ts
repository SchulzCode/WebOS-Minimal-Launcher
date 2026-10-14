// The app tiles, in order. Only the ones installed on the TV are shown (the helper lists them). Add your own by webOS
// app id; `icon` is a file in public/icons, otherwise a `glyph` is drawn.
export interface AppDef {
	id: string;       // webOS appId — used for the real luna launch
	title: string;
	icon?: string;    // bundled artwork (public/icons); otherwise `glyph` is drawn
	glyph?: 'hdmi' | 'spotify' | 'youtube';
	input?: string;   // HDMI tile: the TV's input id (com.webos.service.eim), used to show the live plug state
}

// Names for what is plugged into which HDMI port, if you want them (the TV only knows names with CEC/SIMPLINK on).
// A name given to the input on the TV itself (LG input settings -> rename) wins over this list.
// Set at build time in app/.env.local, e.g. VITE_HDMI_NAMES={"HDMI_1":"Game console"}
export const HDMI_NAMES: Record<string, string> = (() => {
	try { return JSON.parse((import.meta.env.VITE_HDMI_NAMES as string | undefined) || '{}') as Record<string, string>; } catch { return {}; }
})();

export const APPS: AppDef[] = [
	{id: 'tld.my.jfnative', title: 'Jellyfin', icon: 'icons/jfnative.png'},
	{id: 'youtube.leanback.v4', title: 'YouTube', glyph: 'youtube'},
	{id: 'twitch.adamffdev.v1', title: 'Twitch', icon: 'icons/twitch.jpg'},
	{id: 'spotify-beehive', title: 'Spotify', glyph: 'spotify'},
	{id: 'netflix', title: 'Netflix', icon: 'icons/netflix.png'},
	{id: 'org.webosbrew.hbchannel', title: 'Homebrew', icon: 'icons/homebrew.png'},
	{id: 'com.webos.app.hdmi1', title: 'HDMI 1', glyph: 'hdmi', input: 'HDMI_1'},
	{id: 'com.webos.app.hdmi2', title: 'HDMI 2', glyph: 'hdmi', input: 'HDMI_2'},
	{id: 'com.palm.app.settings', title: 'Settings', icon: 'icons/settings.png'}
];
