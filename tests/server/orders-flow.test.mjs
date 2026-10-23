import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startTestServer, makeDist, publishMenu } from './helpers.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function submitOrder(s, table) {
  const res = await fetch(`${s.base}/api/guest/${table.token}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: s.base },
    body: JSON.stringify({ items: [{ id: 'pizza', quantity: 1 }], requestId: randomUUID() }),
  });
  assert.equal(res.status, 201);
  return (await res.json()).order;
}

async function setupTableAndMenu(s) {
  const { table } = await (
    await s.adminFetch('/api/admin/tables', {
      method: 'POST',
      body: JSON.stringify({ label: 'T9' }),
    })
  ).json();
  await publishMenu(s, [{ id: 'pizza', name: 'Margherita', price: 900 }]);
  return table;
}

test('accept transitions pending->accepted; conflict otherwise', async () => {
  const s = await startTestServer();
  try {
    const table = await setupTableAndMenu(s);
    const order = await submitOrder(s, table);
    const ok = await s.adminFetch(`/api/admin/orders/${order.id}/accept`, { method: 'POST' });
    assert.equal(ok.status, 200);
    const accepted = (await ok.json()).order;
    assert.equal(accepted.status, 'accepted');

    const conflict = await s.adminFetch(`/api/admin/orders/${order.id}/reject`, { method: 'POST' });
    assert.equal(conflict.status, 409);
  } finally {
    await s.stop();
  }
});

test('reject transitions pending->rejected; conflict otherwise', async () => {
  const s = await startTestServer();
  try {
    const table = await setupTableAndMenu(s);
    const order = await submitOrder(s, table);
    const ok = await s.adminFetch(`/api/admin/orders/${order.id}/reject`, { method: 'POST' });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).order.status, 'rejected');

    const conflict = await s.adminFetch(`/api/admin/orders/${order.id}/accept`, { method: 'POST' });
    assert.equal(conflict.status, 409);
  } finally {
    await s.stop();
  }
});

test('orders are listed newest first', async () => {
  const s = await startTestServer();
  try {
    const table = await setupTableAndMenu(s);
    const a = await submitOrder(s, table);
    await new Promise((r) => setTimeout(r, 20));
    const b = await submitOrder(s, table);
    const { orders } = await (await s.adminFetch('/api/admin/orders')).json();
    assert.deepEqual(orders.map((o) => o.id), [b.id, a.id]);
    assert.deepEqual(Object.keys(orders[0]).sort(), [
      'createdAt', 'id', 'items', 'notes', 'status', 'tableLabel', 'total',
    ]);
  } finally {
    await s.stop();
  }
});

test('restart persists tables, menu and orders', async () => {
  const first = await startTestServer();
  const { table } = await (
    await first.adminFetch('/api/admin/tables', {
      method: 'POST',
      body: JSON.stringify({ label: 'Persist' }),
    })
  ).json();
  await publishMenu(first, [{ id: 'pizza', name: 'Margherita', price: 900 }]);
  const order = await submitOrder(first, table);
  const dbPath = first.dbPath;
  await first.stop();

  const second = await startTestServerRelaunch({ dbPath, password: first.adminPassword });
  try {
    const { tables } = await (await second.adminFetch('/api/admin/tables')).json();
    assert.equal(tables.length, 1);
    assert.equal(tables[0].label, 'Persist');
    const { items } = await (await second.adminFetch('/api/admin/menu')).json();
    assert.equal(items.length, 1);
    const { orders } = await (await second.adminFetch('/api/admin/orders')).json();
    assert.equal(orders.length, 1);
    assert.equal(orders[0].id, order.id);
  } finally {
    await second.stop();
  }
});

async function startTestServerRelaunch({ dbPath, password }) {
  const { createApp } = await import('../../server/app.mjs');
  const app = createApp({
    adminPassword: password,
    dbPath,
    host: '127.0.0.1',
    port: 0,
    staticDir: dbPath.slice(0, dbPath.lastIndexOf('/')),
  });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const res = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ password }),
  });
  const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
  return {
    base,
    stop: () => app.close(),
    adminFetch: (path, opts = {}) =>
      fetch(`${base}${path}`, {
        ...opts,
        headers: {
          'Content-Type': 'application/json',
          Origin: base,
          Cookie: cookie,
          ...(opts.headers ?? {}),
        },
      }),
  };
}

test('mutations require same-origin JSON content type', async () => {
  const s = await startTestServer();
  try {
    const cookie = await s.login();
    // wrong content type
    let res = await fetch(`${s.base}/api/admin/tables`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: s.base, Cookie: cookie },
      body: JSON.stringify({ label: 'X' }),
    });
    assert.equal(res.status, 415);
    // missing content type on JSON body endpoint
    res = await fetch(`${s.base}/api/admin/tables`, {
      method: 'POST',
      headers: { Origin: s.base, Cookie: cookie },
      body: JSON.stringify({ label: 'X' }),
    });
    assert.equal(res.status, 415);
    // cross origin guest mutation
    const table = await setupTableAndMenu(s);
    res = await fetch(`${s.base}/api/guest/${table.token}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
      body: JSON.stringify({ items: [{ id: 'pizza', quantity: 1 }], requestId: randomUUID() }),
    });
    assert.equal(res.status, 403);
  } finally {
    await s.stop();
  }
});
