import {defineConfig} from 'vite';

// The source is written against the React API, but the bundle uses Preact (preact/compat): ~10 KB instead of ~130 KB of
// framework, which matters because the launcher starts cold on every wake from standby. Types still come from @types/react.
const preact = [
	{find: /^react$/, replacement: 'preact/compat'},
	{find: /^react-dom$/, replacement: 'preact/compat'},
	{find: /^react-dom\/client$/, replacement: 'preact/compat/client'},
	{find: /^react\/jsx-runtime$/, replacement: 'preact/jsx-runtime'},
	{find: /^react\/jsx-dev-runtime$/, replacement: 'preact/jsx-dev-runtime'}
];

// RELEASE=1 (a build for publishing): read no .env files, so nothing from app/.env.local (your server, feed, HDMI
// names) is baked in.
const release = process.env.RELEASE === '1';

export default defineConfig({
	base: './', // webOS apps load from a local file path — assets must be relative.
	envDir: release ? './.no-env' : '.',
	resolve: {alias: preact},
	esbuild: {jsx: 'automatic', jsxImportSource: 'preact'},
	build: {
		// The TV's WAM is Chromium 108-class for CSS; keep the output conservative.
		target: 'chrome108',
		cssTarget: 'chrome108',
		outDir: 'dist'
	}
});
