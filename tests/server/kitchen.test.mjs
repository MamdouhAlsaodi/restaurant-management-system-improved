import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startTestServer, publishMenu } from './helpers.mjs';
import { createApp } from '../../server/app.mjs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

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

async function submitOrder(s, table) {
  const res = await fetch(`${s.base}/api/guest/${table.token}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: s.base },
    body: JSON.stringify({ items: [{ id: 'pizza', quantity: 1 }], guestName: 'Guest', requestId: randomUUID() }),
  });
  assert.equal(res.status, 201);
  return (await res.json()).order;
}

async function accept(s, orderId) {
  const res = await s.adminFetch(`/api/admin/orders/${orderId}/accept`, { method: 'POST' });
  assert.equal(res.status, 200);
  return (await res.json()).order;
}

async function setPrep(s, orderId, status) {
  return s.adminFetch(`/api/admin/orders/${orderId}/preparation`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  });
}

test('accepted order defaults to prepStatus waiting in admin order list', async () => {
  const s = await startTestServer();
  try {
    const table = await setupTableAndMenu(s);
    const order = await submitOrder(s, table);
    const { orders } = await (await s.adminFetch('/api/admin/orders')).json();
    assert.equal(orders[0].prepStatus, undefined, 'pending orders carry no kitchen state');
    const accepted = await accept(s, order.id);
    assert.equal(accepted.prepStatus, 'waiting');
  } finally {
    await s.stop();
  }
});

test('full sequential kitchen flow waiting->preparing->ready->served', async () => {
  const s = await startTestServer();
  try {
    const table = await setupTableAndMenu(s);
    const order = await accept(s, (await submitOrder(s, table)).id);
    for (const status of ['preparing', 'ready', 'served']) {
      const res = await setPrep(s, order.id, status);
      assert.equal(res.status, 200, `transition to ${status}`);
      assert.equal((await res.json()).order.prepStatus, status);
    }
  } finally {
    await s.stop();
  }
});

test('kitchen transitions cannot skip steps', async () => {
  const s = await startTestServer();
  try {
    const table = await setupTableAndMenu(s);
    const order = await accept(s, (await submitOrder(s, table)).id);
    const skip = await setPrep(s, order.id, 'ready');
    assert.equal(skip.status, 409);
    const ok = await setPrep(s, order.id, 'preparing');
    assert.equal(ok.status, 200);
    const skip2 = await setPrep(s, order.id, 'served');
    assert.equal(skip2.status, 409);
  } finally {
    await s.stop();
  }
});

test('served is terminal except for idempotent repeats', async () => {
  const s = await startTestServer();
  try {
    const table = await setupTableAndMenu(s);
    const order = await accept(s, (await submitOrder(s, table)).id);
    for (const status of ['preparing', 'ready', 'served']) {
      assert.equal((await setPrep(s, order.id, status)).status, 200);
    }
    const back = await setPrep(s, order.id, 'preparing');
    assert.equal(back.status, 409, 'served cannot go back');
    const again = await setPrep(s, order.id, 'served');
    assert.equal(again.status, 200, 'same state is idempotent');
  } finally {
    await s.stop();
  }
});

test('same-state repeat is idempotent (200, unchanged)', async () => {
  const s = await startTestServer();
  try {
    const table = await setupTableAndMenu(s);
    const order = await accept(s, (await submitOrder(s, table)).id);
    const first = await setPrep(s, order.id, 'preparing');
    assert.equal(first.status, 200);
    const second = await setPrep(s, order.id, 'preparing');
    assert.equal(second.status, 200);
    assert.equal((await second.json()).order.prepStatus, 'preparing');
  } finally {
    await s.stop();
  }
});

test('pending and rejected orders are rejected for kitchen updates', async () => {
  const s = await startTestServer();
  try {
    const table = await setupTableAndMenu(s);
    const pending = await submitOrder(s, table);
    assert.equal((await setPrep(s, pending.id, 'preparing')).status, 409);
    await s.adminFetch(`/api/admin/orders/${pending.id}/reject`, { method: 'POST' });
    assert.equal((await setPrep(s, pending.id, 'preparing')).status, 409);
  } finally {
    await s.stop();
  }
});

test('payment does not break the kitchen flow (paid orders still transition)', async () => {
  const s = await startTestServer();
  try {
    const table = await setupTableAndMenu(s);
    const order = await accept(s, (await submitOrder(s, table)).id);
    assert.equal((await setPrep(s, order.id, 'preparing')).status, 200);
    const checkout = await s.adminFetch(`/api/admin/orders/${order.id}/checkout`, {
      method: 'POST',
      body: JSON.stringify({ paymentMethod: 'cash' }),
    });
    assert.equal(checkout.status, 200);
    assert.equal((await checkout.json()).order.prepStatus, 'preparing', 'checkout preserves prep state');
    const ready = await setPrep(s, order.id, 'ready');
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).order.prepStatus, 'ready');
  } finally {
    await s.stop();
  }
});

test('invalid status values and unknown orders are rejected', async () => {
  const s = await startTestServer();
  try {
    const table = await setupTableAndMenu(s);
    const order = await accept(s, (await submitOrder(s, table)).id);
    assert.equal((await setPrep(s, order.id, 'waiting')).status, 400, 'waiting is implicit, not a body status');
    assert.equal((await setPrep(s, order.id, 'done')).status, 400);
    assert.equal((await setPrep(s, randomUUID(), 'preparing')).status, 404);
  } finally {
    await s.stop();
  }
});

test('kitchen endpoint requires admin authentication', async () => {
  const s = await startTestServer();
  try {
    const res = await fetch(`${s.base}/api/admin/orders/${randomUUID()}/preparation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: s.base },
      body: JSON.stringify({ status: 'preparing' }),
    });
    assert.equal(res.status, 401);
  } finally {
    await s.stop();
  }
});

async function withApp(dbPath, adminPassword, fn) {
  const app = createApp({
    adminPassword,
    dbPath,
    host: '127.0.0.1',
    port: 0,
    staticDir: mkdtempSync(join(tmpdir(), 'qr-kitchen-static-')),
  });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const state = {
    base,
    adminFetch: async (path, opts = {}) => {
      const login = await fetch(`${base}/api/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify({ password: adminPassword }),
      });
      const cookie = login.headers.get('set-cookie').split(';')[0];
      return fetch(`${base}${path}`, {
        ...opts,
        headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie, ...(opts.headers ?? {}) },
      });
    },
  };
  try {
    return await fn(state);
  } finally {
    await app.close();
  }
}

test('prep state survives a restart', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'qr-kitchen-')), 'test.sqlite');
  const password = (await import('./helpers.mjs')).randomPassword();
  const orderId = await withApp(dbPath, password, async (s) => {
    const table = await setupTableAndMenu(s);
    const order = await submitOrder(s, table);
    await accept(s, order.id);
    assert.equal((await setPrep(s, order.id, 'preparing')).status, 200);
    return order.id;
  });
  await withApp(dbPath, password, async (s) => {
    const { orders } = await (await s.adminFetch('/api/admin/orders')).json();
    assert.equal(orders.length, 1, 'no orders lost across restart');
    assert.equal(orders[0].id, orderId);
    assert.equal(orders[0].prepStatus, 'preparing');
  });
});

test('additive migration: pre-kitchen databases keep all orders and gain prep_status', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qr-kitchen-mig-'));
  const dbPath = join(dir, 'legacy.sqlite');
  // Build a pre-kitchen (current main) database by hand.
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE orders (
      id TEXT PRIMARY KEY,
      table_id INTEGER,
      table_label TEXT NOT NULL,
      guest_name TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'guest' CHECK (source IN ('guest','cashier')),
      notes TEXT,
      total_cents INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected','paid')),
      created_at TEXT NOT NULL,
      request_id TEXT NOT NULL,
      last_request_id TEXT,
      paid_at TEXT,
      payment_method TEXT CHECK (payment_method IN ('cash','pix','cartao','ifood_card'))
    );
    INSERT INTO orders (id, table_id, table_label, guest_name, source, notes, total_cents, status, created_at, request_id)
    VALUES ('11111111-1111-1111-1111-111111111111', NULL, 'T1', 'Ali', 'guest', '', 900, 'accepted', '2024-01-01T00:00:00Z', '${randomUUID()}');
  `);
  legacy.close();

  await withApp(dbPath, (await import('./helpers.mjs')).randomPassword(), async (s) => {
    const { orders } = await (await s.adminFetch('/api/admin/orders')).json();
    assert.equal(orders.length, 1, 'existing order must survive the migration');
    assert.equal(orders[0].id, '11111111-1111-1111-1111-111111111111');
    // Legacy accepted order is treated as waiting and can enter the kitchen flow.
    assert.equal(orders[0].prepStatus, 'waiting');
    const res = await setPrep(s, orders[0].id, 'preparing');
    assert.equal(res.status, 200);
  });
});
