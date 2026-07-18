/**
 * Build the static site into dist/:
 *   dist/index.html  — the landing page with the live sandbox (embeds the app)
 *   dist/app.html    — the standalone app (single self-contained file)
 *   dist/.well-known/nostr.json — NIP-05 (fill in the brand key's hex to activate)
 *
 * Expects dist/.bundle.js to exist (npm run build:app runs first).
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';

const read = (p) => readFileSync(p, 'utf8');

const shell = read('demo/shell.html');
const fonts = read('demo/fonts.css');
const bundle = read('dist/.bundle.js');

// 1. standalone app — fonts + bundle inlined, zero external requests
const app = shell
  .replace('<style>/*FONTS*/</style>', () => '<style>' + fonts + '</style>')
  .replace('<script>/*BUNDLE*/</script>', () => '<script>' + bundle + '<\/scr' + 'ipt>');

// 2. landing — embeds the full app as a blob-URL sandbox inside the iPhone frame.
//    The embedded copy gets a safe-area shim so the app header clears the island.
const embedded = app + '\n<style>.brand{padding-top:58px}</style>\n';
const escaped = embedded.replaceAll('</script', '%%SCRIPT_END%%');
const landing = read('demo/landing.html')
  .replace('<style>/*FONTS*/</style>', () => '<style>' + fonts + '</style>')
  .replace('%%APPSRC%%', () => escaped);

mkdirSync('dist/.well-known', { recursive: true });
writeFileSync('dist/index.html', landing);
writeFileSync('dist/app.html', app);
cpSync('static/.well-known/nostr.json', 'dist/.well-known/nostr.json');
rmSync('dist/.bundle.js');

console.log('dist/ ready: index.html (landing+sandbox), app.html (standalone), .well-known/nostr.json');
