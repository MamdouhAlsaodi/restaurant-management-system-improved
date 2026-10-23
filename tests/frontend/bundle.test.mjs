import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (p) => readFileSync(path.join(root, p), 'utf8');

// ---- Source index.html must not reference CDN-blocked external assets ----

test('source index.html has no external scripts, fonts, or importmap', () => {
  const html = read('./index.html');
  assert.ok(!html.includes('cdn.tailwindcss.com'), 'Tailwind CDN must be removed (CSP default-src self)');
  assert.ok(!html.includes('fonts.googleapis.com'), 'Google Fonts must be removed');
  assert.ok(!html.includes('esm.sh'), 'esm.sh importmap must be removed');
  assert.ok(!html.includes('type="importmap"'), 'no importmap');
  assert.ok(!/src="https?:\/\//.test(html), 'no remote script src');
  assert.ok(!/href="https?:\/\//.test(html), 'no remote link href');
});

// ---- Tailwind is bundled locally with content scanning of TSX classes ----

test('tailwind.config content scans existing TSX class usage', () => {
  const cfg = read('./tailwind.config.js');
  for (const glob of ['App.tsx', 'components/**/*.{ts,tsx}', 'index.tsx', 'index.html']) {
    assert.ok(cfg.includes(glob), `content must include ${glob}`);
  }
});

test('index.css compiles Tailwind and index.tsx imports it', () => {
  const css = read('./index.css');
  assert.ok(css.includes('@tailwind base'), 'index.css must include @tailwind base');
  assert.ok(css.includes('@tailwind utilities'), 'index.css must include @tailwind utilities');
  const tsx = read('./index.tsx');
  assert.ok(/import\s+['"]\.\/index\.css['"]/.test(tsx), 'index.tsx must import compiled CSS');
});

// ---- Built output: self-hosted only, CSS exists and covers admin classes ----

test('dist/index.html exists with no external scripts/fonts and built CSS exists', () => {
  assert.ok(existsSync(root + '/dist/index.html'), 'run npm run build first');
  const html = read('./dist/index.html');
  assert.ok(!/src="https?:\/\//.test(html), 'dist html must not load remote scripts');
  assert.ok(!/href="https?:\/\//.test(html), 'dist html must not load remote fonts/styles');
  assert.ok(!html.includes('esm.sh'), 'dist html must not reference esm.sh');
  const assetsDir = root + '/dist/assets';
  assert.ok(existsSync(assetsDir));
  const cssFiles = readdirSync(assetsDir).filter((f) => f.endsWith('.css'));
  assert.ok(cssFiles.length > 0, 'built CSS must exist in dist/assets');

  // Content scanning: utilities actually used by existing admin TSX appear in built CSS.
  const builtCss = read('./dist/assets/' + cssFiles[0]).replace(/\\/g, '');
  const appTsx = read('./App.tsx');
  const classMatches = [...appTsx.matchAll(/className=["'`]([^"'`]+)["'`]/g)].flatMap((m) =>
    m[1].trim().split(/\s+/),
  );
  const utilities = [...new Set(classMatches)].filter((c) => /^[a-z0-9:.\[\]\/#%-]+$/i.test(c));
  assert.ok(utilities.length > 10, 'sanity: App.tsx uses Tailwind utilities');
  for (const cls of utilities) {
    assert.ok(
      builtCss.includes(cls) || cls.includes('hover-lift') || cls.includes('glass-effect'),
      `built CSS must include .${cls}`,
    );
  }
});
