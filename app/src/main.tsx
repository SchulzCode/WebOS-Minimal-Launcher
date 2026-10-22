import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import './fonts.css';
import App from './App';
import './styles.css';

// Diagnostics for "the remote takes long to react": when keys and lifecycle events reach this page, compared later with the
// helper's /tmp/home-keys.log (when the remote sent them). Registered before React so even a cold start is covered; kept
// in localStorage so a restarted launcher still shows what the previous one saw. Read over DevTools: window.__keyLog.
const KEYLOG_KEY = 'minihome-keylog';
const keyLog: KeyNote[] = (() => { try { return JSON.parse(localStorage.getItem(KEYLOG_KEY) || '[]') as KeyNote[]; } catch { return []; } })();
window.__keyLog = keyLog;
const note = (what: string) => {
	keyLog.push({t: Date.now(), what, up: Math.round(performance.now()), hidden: document.hidden, idle: !!document.querySelector('.ui-off')});
	if (keyLog.length > 150) keyLog.splice(0, keyLog.length - 150);
	try { localStorage.setItem(KEYLOG_KEY, JSON.stringify(keyLog)); } catch { /* noop */ }
};
window.addEventListener('keydown', (e) => note('key ' + e.keyCode + (e.repeat ? ' repeat' : '')), true);
window.addEventListener('mousedown', () => note('mousedown'), true);
document.addEventListener('visibilitychange', () => note(document.hidden ? 'hidden' : 'visible'));
document.addEventListener('webOSRelaunch', () => note('relaunch'));
window.addEventListener('focus', () => note('focus'));
window.addEventListener('blur', () => note('blur'));
note('start');

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<App />
	</StrictMode>
);
