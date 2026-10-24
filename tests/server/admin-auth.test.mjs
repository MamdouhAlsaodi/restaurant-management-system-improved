import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, tmpDir, makeDist } from './helpers.mjs';

test('login with correct password sets HttpOnly SameSite=Strict cookie', async () => {
  const s = await startTestServer();
  try {
    const res = await fetch(`${s.base}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: s.base },
      body: JSON.stringify({ password: s.adminPassword }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { authenticated: true, actor: { kind: 'owner', role: 'owner' } });
    const setCookie = res.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
  } finally {
    await s.stop();
  }
});

test('secure cookie mode marks both login and logout cookies Secure', async () => {
  const s = await startTestServer({ secureCookies: true });
  try {
    const res = await fetch(`${s.base}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: s.base },
      body: JSON.stringify({ password: s.adminPassword }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie') ?? '', /(?:^|; )Secure(?:;|$)/);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const logout = await fetch(`${s.base}/api/admin/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: s.base, Cookie: cookie },
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie') ?? '', /(?:^|; )Secure(?:;|$)/);
  } finally {
    await s.stop();
  }
});

test('login with wrong password fails and does not set cookie', async () => {
  const s = await startTestServer();
  try {
    const res = await fetch(`${s.base}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: s.base },
      body: JSON.stringify({ password: 'nope' }),
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('set-cookie'), null);
  } finally {
    await s.stop();
  }
});

test('session endpoint reports unauthenticated without cookie', async () => {
  const s = await startTestServer();
  try {
    const res = await fetch(`${s.base}/api/admin/session`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { authenticated: false });
  } finally {
    await s.stop();
  }
});

test('session endpoint reports authenticated with cookie; logout clears', async () => {
  const s = await startTestServer();
  try {
    const cookie = await s.login();
    let res = await fetch(`${s.base}/api/admin/session`, {
      headers: { Cookie: cookie },
    });
    assert.deepEqual(await res.json(), { authenticated: true, actor: { kind: 'owner', role: 'owner' } });

    res = await fetch(`${s.base}/api/admin/logout`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: s.base, 'Content-Type': 'application/json' },
    });
    assert.equal(res.status, 200);
    const clearCookie = res.headers.get('set-cookie') ?? '';
    assert.match(clearCookie, /Max-Age=0/i);

    res = await fetch(`${s.base}/api/admin/session`, {
      headers: { Cookie: cookie },
    });
    assert.deepEqual(await res.json(), { authenticated: false });
  } finally {
    await s.stop();
  }
});

test('admin APIs reject unauthenticated requests', async () => {
  const s = await startTestServer();
  try {
    for (const [path, method] of [
      ['/api/admin/tables', 'GET'],
      ['/api/admin/tables', 'POST'],
      ['/api/admin/menu', 'GET'],
      ['/api/admin/menu', 'PUT'],
      ['/api/admin/orders', 'GET'],
    ]) {
      const res = await fetch(`${s.base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Origin: s.base },
        body: method === 'GET' ? undefined : '{}',
      });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  } finally {
    await s.stop();
  }
});

test('login failures are delayed and rate limited', async () => {
  const s = await startTestServer();
  try {
    const attempt = () =>
      fetch(`${s.base}/api/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: s.base },
        body: JSON.stringify({ password: 'nope' }),
      });
    const t0 = Date.now();
    await attempt();
    assert.ok(Date.now() - t0 >= 200, 'fixed delay applied on failure');
    let last;
    for (let i = 0; i < 10; i++) last = await attempt();
    assert.equal(last.status, 429, 'rate limited after repeated failures');
  } finally {
    await s.stop();
  }
});

test('no CORS: cross-origin admin request is rejected', async () => {
  const s = await startTestServer();
  try {
    const cookie = await s.login();
    const res = await fetch(`${s.base}/api/admin/tables`, {
      headers: { Cookie: cookie, Origin: 'http://evil.example' },
    });
    assert.equal(res.status, 403);
  } finally {
    await s.stop();
  }
});
