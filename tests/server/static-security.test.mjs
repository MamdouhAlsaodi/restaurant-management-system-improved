import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../server/app.mjs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

async function startWithDist() {
  const dir = mkdtempSync(join(tmpdir(), 'qr-static-'));
  const dist = join(dir, 'dist');
  const assets = join(dist, 'assets');
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title><div id=app></div>');
  writeFileSync(join(assets, 'index-abc123.js'), 'console.log("bundle")');
  // secret lives OUTSIDE the served root
  writeFileSync(join(dir, 'secret.txt'), 'TOP SECRET');
  const app = createApp({
    adminPassword: randomBytes(24).toString('base64url'),
    dbPath: join(dir, 'db.sqlite'),
    host: '127.0.0.1',
    port: 0,
    staticDir: dist,
  });
  const address = await app.listen();
  return { app, base: `http://127.0.0.1:${address.port}`, dir, close: () => app.close() };
}

test('serves index bundle and assets', async () => {
  const s = await startWithDist();
  try {
    const index = await fetch(`${s.base}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /id=app/);
    const asset = await fetch(`${s.base}/assets/index-abc123.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /javascript/);
  } finally {
    await s.close();
  }
});

test('SPA routes /q/:token and /login serve the app', async () => {
  const s = await startWithDist();
  try {
    for (const path of ['/q/some-table-token', '/login']) {
      const res = await fetch(`${s.base}${path}`);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type'), /text\/html/);
      assert.match(await res.text(), /id=app/);
    }
  } finally {
    await s.close();
  }
});

test('blocks directory traversal', async () => {
  const s = await startWithDist();
  try {
    for (const path of [
      // encoded traversal escaping the static root
      '/..%2fsecret.txt',
      '/%2e%2e/secret.txt',
      '/assets/..%2f..%2fsecret.txt',
      '/..%2f..%2fetc%2fpasswd',
      '/%2e%2e/%2e%2e/etc/passwd',
    ]) {
      const res = await fetch(`${s.base}${path}`);
      assert.notEqual(res.status, 200, path);
      assert.ok(res.status >= 400, path);
      assert.ok(!(await res.text()).includes('TOP SECRET'), path);
    }
  } finally {
    await s.close();
  }
});

test('security headers present and no stack traces on errors', async () => {
  const s = await startWithDist();
  try {
    const res = await fetch(`${s.base}/`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(res.headers.get('content-security-policy'));
    assert.equal(res.headers.get('x-frame-options'), 'DENY');

    const err = await fetch(`${s.base}/api/gust/typo/menu`); // unknown API route
    const text = await err.text();
    assert.ok(!text.includes('at '), 'no stack trace');
    assert.ok(!text.includes(join(tmpdir(), '')), 'no internal paths');
  } finally {
    await s.close();
  }
});

test('startup fails closed without ADMIN_PASSWORD', async () => {
  const { createApp } = await import('../../server/app.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'qr-nopass-'));
  assert.throws(
    () => createApp({ adminPassword: '', dbPath: join(dir, 'db.sqlite'), port: 0, staticDir: dir }),
    /ADMIN_PASSWORD/
  );
});
