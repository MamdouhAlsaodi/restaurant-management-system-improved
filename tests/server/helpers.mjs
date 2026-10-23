import { createApp } from '../../server/app.mjs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'qr-test-'));
}

// Never printed or logged anywhere.
export function randomPassword() {
  return randomBytes(24).toString('base64url');
}

export async function startTestServer({ staticDir, secureCookies = false } = {}) {
  const dir = tmpDir();
  const dbPath = join(dir, 'test.sqlite');
  const adminPassword = randomPassword();
  const app = createApp({
    adminPassword,
    dbPath,
    host: '127.0.0.1',
    port: 0,
    staticDir: staticDir ?? dir, // empty dir: static tests write their own files
    secureCookies,
  });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;

  const state = {
    dir,
    dbPath,
    adminPassword,
    base,
    app,
    async stop() {
      await app.close();
    },
  };

  state.login = async function login() {
    const res = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ password: adminPassword }),
    });
    const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
    return cookie;
  };

  state.adminFetch = async function adminFetch(path, opts = {}) {
    const cookie = await loginCookieCache(state);
    const headers = {
      'Content-Type': 'application/json',
      Origin: base,
      Cookie: cookie,
      ...(opts.headers ?? {}),
    };
    return fetch(`${base}${path}`, { ...opts, headers });
  };

  return state;
}

const cookieCaches = new WeakMap();
async function loginCookieCache(state) {
  let c = cookieCaches.get(state);
  if (!c) {
    c = await state.login();
    cookieCaches.set(state, c);
  }
  return c;
}

export function makeDist(dir, indexHtml = '<!doctype html><title>app</title>') {
  const assets = join(dir, 'assets');
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(dir, 'index.html'), indexHtml);
  writeFileSync(join(assets, 'index-abc123.js'), 'console.log("bundle")');
  return dir;
}

export async function publishMenu(state, items) {
  const res = await state.adminFetch('/api/admin/menu', {
    method: 'PUT',
    body: JSON.stringify({ items }),
  });
  if (res.status !== 200) throw new Error(`menu publish failed: ${res.status}`);
  return res.json();
}
