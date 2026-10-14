// Tiny Chrome DevTools client for the launcher page (webOS dev mode exposes it on port 9998).
// usage: node cdp.mjs eval '<js expression>'   (awaits promises, prints JSON)
//        node cdp.mjs keys '<seq>' <gapMs>       (dispatch key presses: U D L R E B)
if (!process.env.TV_IP) { console.error('set TV_IP (the TV address)'); process.exit(2); }
const TV = 'http://' + process.env.TV_IP + ':9998';
const list = await (await fetch(TV + '/json/list')).json();
const t = list.find((x) => x.description === (process.env.CDP_APP || 'tld.my.minimalhome'));
if (!t) { console.error('launcher page not found (is the app running?)'); process.exit(2); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pend = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({id: i, method, params})); });
const [cmd, arg, arg2] = process.argv.slice(2);
const KEYS = {
	U: {key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38},
	D: {key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40},
	L: {key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37},
	R: {key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39},
	E: {key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13},
	B: {key: 'GoBack', code: 'GoBack', windowsVirtualKeyCode: 461}
};
try {
	if (cmd === 'eval') {
		const r = await send('Runtime.evaluate', {expression: arg, awaitPromise: true, returnByValue: true});
		console.log(JSON.stringify(r.result?.result?.value ?? r.result, null, 1));
	} else if (cmd === 'shot') {
		const r = await send('Page.captureScreenshot', {format: 'png'});
		const {writeFileSync} = await import('node:fs');
		if (r.result?.data) { writeFileSync(arg, Buffer.from(r.result.data, 'base64')); console.log('saved', arg); } else console.log(JSON.stringify(r).slice(0, 300));
	} else if (cmd === 'keys') {
		const gap = Number(arg2 || 400);
		for (const c of arg) {
			if (c === '.') { await new Promise((r) => setTimeout(r, gap)); continue; }
			const k = KEYS[c];
			await send('Input.dispatchKeyEvent', {type: 'rawKeyDown', ...k});
			await new Promise((r) => setTimeout(r, 60));
			await send('Input.dispatchKeyEvent', {type: 'keyUp', ...k});
			await new Promise((r) => setTimeout(r, gap));
		}
		console.log('sent', arg);
	}
} finally { ws.close(); }
