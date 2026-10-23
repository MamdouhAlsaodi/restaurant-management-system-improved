import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startTestServer, publishMenu } from './helpers.mjs';

async function setupTableAndMenu(s) {
  const { table } = await (
    await s.adminFetch('/api/admin/tables', {
      method: 'POST',
      body: JSON.stringify({ label: 'T5' }),
    })
  ).json();
  await publishMenu(s, [
    { id: 'pizza', name: 'Margherita', price: 900 },
    { id: 'cola', name: 'Cola', price: 250 },
  ]);
  return table;
}

async function guestOrder(s, table, overrides = {}) {
  const res = await fetch(`${s.base}/api/guest/${table.token}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: s.base },
    body: JSON.stringify({
      requestId: randomUUID(),
      guestName: 'أحمد',
      items: [{ id: 'pizza', quantity: 1 }],
      ...overrides,
    }),
  });
  return { res, body: res.headers.get('content-type') ? await res.json() : null };
}

test('guest order requires non-empty guestName <= 80 chars', async () => {
  const s = await startTestServer();
  try {
    const table = await setupTableAndMenu(s);
    assert.equal((await guestOrder(s, table, { guestName: undefined })).res.status, 400);
    assert.equal((await guestOrder(s, table, { guestName: '' })).res.status, 400);
    assert.equal((await guestOrder(s, table, { guestName: '   ' })).res.status, 400);
    assert.equal((await guestOrder(s, table, { guestName: 'x'.repeat(81) })).res.status, 400);
    const ok = await guestOrder(s, table, { guestName: 'x'.repeat(80) });
    assert.equal(ok.res.status, 201);
  } finally {
    await s.stop();
  }
});

test('guest order response includes guestName/source and no payment fields', async () => {
  const s = await startTestServer();
  try {
    const table = await setupTableAndMenu(s);
    const { res, body } = await guestOrder(s, table);
    assert.equal(res.status, 201);
    assert.equal(body.order.guestName, 'أحمد');
    assert.equal(body.order.source, 'guest');
    assert.equal(body.order.tableId, table.id);
    assert.equal(body.order.items[0].source, 'guest');
    assert.equal(body.order.paymentMethod, undefined);
    assert.equal(body.order.paidAt, undefined);
  } finally {
    await s.stop();
  }
});

test('two guests at same table get distinct orders', async () => {
  const s = await startTestServer();
  try {
    const table = await setupTableAndMenu(s);
    const a = await guestOrder(s, table, { guestName: 'A' });
    const b = await guestOrder(s, table, { guestName: 'B' });
    assert.equal(a.res.status, 201);
    assert.equal(b.res.status, 201);
    assert.notEqual(a.body.order.id, b.body.order.id);
    const { orders } = await (await s.adminFetch('/api/admin/orders')).json();
    assert.equal(orders.length, 2);
  } finally {
    await s.stop();
  }
});

test('admin list exposes full contract fields and paid orders', async () => {
  const s = await startTestServer();
  try {
    const table = await setupTableAndMenu(s);
    const { body } = await guestOrder(s, table);
    const manual = await s.adminFetch('/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({ requestId: randomUUID(), guestName: 'كاشير' }),
    });
    assert.equal(manual.status, 201);
    const moId = (await manual.json()).order.id;
    const { orders } = await (await s.adminFetch('/api/admin/orders')).json();
    const g = orders.find((o) => o.id === body.order.id);
    assert.equal(g.source, 'guest');
    assert.equal(g.tableId, table.id);
    assert.equal(typeof g.total, 'number');
    assert.ok(Array.isArray(g.items));
    const mo = orders.find((o) => o.id === moId);
    assert.equal(mo.source, 'cashier');
    assert.equal(mo.status, 'accepted');
  } finally {
    await s.stop();
  }
});

test('manual order creation: 201 then requestId replay 200 same order', async () => {
  const s = await startTestServer();
  try {
    await setupTableAndMenu(s);
    const requestId = randomUUID();
    const first = await s.adminFetch('/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({ requestId, guestName: 'زبون' }),
    });
    assert.equal(first.status, 201);
    const o1 = (await first.json()).order;
    assert.equal(o1.status, 'accepted');
    assert.equal(o1.source, 'cashier');
    assert.equal(o1.tableLabel, 'كاشير');
    assert.equal(o1.tableId, null);
    assert.deepEqual(o1.items, []);
    const second = await s.adminFetch('/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({ requestId, guestName: 'زبون' }),
    });
    assert.equal(second.status, 200);
    assert.equal((await second.json()).order.id, o1.id);
  } finally {
    await s.stop();
  }
});

test('manual order with optional active table uses its label', async () => {
  const s = await startTestServer();
  try {
    const table = await setupTableAndMenu(s);
    const res = await s.adminFetch('/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({ requestId: randomUUID(), guestName: 'زبون', tableId: table.id }),
    });
    assert.equal(res.status, 201);
    const order = (await res.json()).order;
    assert.equal(order.tableId, table.id);
    assert.equal(order.tableLabel, 'T5');
    const bad = await s.adminFetch('/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({ requestId: randomUUID(), guestName: 'زبون', tableId: 99999 }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await s.stop();
  }
});

test('manual order validation', async () => {
  const s = await startTestServer();
  try {
    await setupTableAndMenu(s);
    assert.equal(
      (
        await s.adminFetch('/api/admin/orders', {
          method: 'POST',
          body: JSON.stringify({ requestId: randomUUID() }),
        })
      ).status,
      400,
      'missing guestName'
    );
    assert.equal(
      (
        await s.adminFetch('/api/admin/orders', {
          method: 'POST',
          body: JSON.stringify({ requestId: 'nope', guestName: 'x' }),
        })
      ).status,
      400,
      'bad requestId'
    );
    const noAuth = await fetch(`${s.base}/api/admin/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: s.base },
      body: JSON.stringify({ requestId: randomUUID(), guestName: 'x' }),
    });
    assert.equal(noAuth.status, 401, 'requires auth');
  } finally {
    await s.stop();
  }
});

test('add items to accepted manual order with requestId dedupe', async () => {
  const s = await startTestServer();
  try {
    await setupTableAndMenu(s);
    const created = await s.adminFetch('/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({ requestId: randomUUID(), guestName: 'زبون' }),
    });
    const order = (await created.json()).order;
    const requestId = randomUUID();
    const add = () =>
      s.adminFetch(`/api/admin/orders/${order.id}/items`, {
        method: 'POST',
        body: JSON.stringify({ requestId, items: [{ id: 'pizza', quantity: 2 }] }),
      });
    const first = await add();
    assert.equal(first.status, 200);
    const o1 = (await first.json()).order;
    assert.equal(o1.total, 1800);
    assert.equal(o1.items.length, 1);
    assert.equal(o1.items[0].source, 'cashier');
    assert.equal(o1.items[0].price, 900);
    const retry = await add();
    assert.equal(retry.status, 200);
    const o2 = (await retry.json()).order;
    assert.equal(o2.total, 1800, 'no duplicate addition on retry');
    assert.equal(o2.items.length, 1);
  } finally {
    await s.stop();
  }
});

test('non-adjacent replay of an item addition never adds it twice', async () => {
  const s = await startTestServer();
  try {
    await setupTableAndMenu(s);
    const created = await s.adminFetch('/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({ requestId: randomUUID(), guestName: 'منى' }),
    });
    const { order } = await created.json();
    const a = randomUUID();
    const b = randomUUID();
    const add = (requestId, id) => s.adminFetch(`/api/admin/orders/${order.id}/items`, {
      method: 'POST',
      body: JSON.stringify({ requestId, items: [{ id, quantity: 1 }] }),
    });
    assert.equal((await add(a, 'pizza')).status, 200);
    assert.equal((await add(b, 'cola')).status, 200);
    const replay = await add(a, 'pizza');
    assert.equal(replay.status, 200);
    const latest = (await replay.json()).order;
    assert.equal(latest.total, 1150);
    assert.equal(latest.items.length, 2);
  } finally {
    await s.stop();
  }
});

test('add items rejects invalid targets and items', async () => {
  const s = await startTestServer();
  try {
    const table = await setupTableAndMenu(s);
    const created = await s.adminFetch('/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({ requestId: randomUUID(), guestName: 'زبون' }),
    });
    const order = (await created.json()).order;
    const add = (body) =>
      s.adminFetch(`/api/admin/orders/${order.id}/items`, {
        method: 'POST',
        body: JSON.stringify({ requestId: randomUUID(), ...body }),
      });
    assert.equal((await add({ items: [] })).status, 400, 'empty items');
    assert.equal((await add({ items: [{ id: 'ghost', quantity: 1 }] })).status, 400, 'unknown item');
    assert.equal((await add({ items: [{ id: 'pizza', quantity: 0 }] })).status, 400, 'bad quantity');
    assert.equal((await add({ items: [{ id: 'pizza', quantity: 1 }], requestId: 'bad' })).status, 400);
    // pending guest order cannot be modified
    const { body } = await guestOrder(s, table);
    const res = await s.adminFetch(`/api/admin/orders/${body.order.id}/items`, {
      method: 'POST',
      body: JSON.stringify({ requestId: randomUUID(), items: [{ id: 'pizza', quantity: 1 }] }),
    });
    assert.equal(res.status, 409);
    assert.equal(
      (
        await s.adminFetch(`/api/admin/orders/${randomUUID()}/items`, {
          method: 'POST',
          body: JSON.stringify({ requestId: randomUUID(), items: [{ id: 'pizza', quantity: 1 }] }),
        })
      ).status,
      404
    );
  } finally {
    await s.stop();
  }
});

test('checkout pays accepted order atomically and is idempotent', async () => {
  const s = await startTestServer();
  try {
    const table = await setupTableAndMenu(s);
    const { body } = await guestOrder(s, table, { items: [{ id: 'pizza', quantity: 2 }] });
    const id = body.order.id;
    await s.adminFetch(`/api/admin/orders/${id}/accept`, { method: 'POST' });
    const res = await s.adminFetch(`/api/admin/orders/${id}/checkout`, {
      method: 'POST',
      body: JSON.stringify({ paymentMethod: 'pix' }),
    });
    assert.equal(res.status, 200);
    const paid = (await res.json()).order;
    assert.equal(paid.status, 'paid');
    assert.equal(paid.paymentMethod, 'pix');
    assert.equal(typeof paid.paidAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(paid.paidAt)));
    // idempotent same method
    const again = await s.adminFetch(`/api/admin/orders/${id}/checkout`, {
      method: 'POST',
      body: JSON.stringify({ paymentMethod: 'pix' }),
    });
    assert.equal(again.status, 200);
    const a2 = (await again.json()).order;
    assert.equal(a2.status, 'paid');
    assert.equal(a2.paidAt, paid.paidAt);
    // conflicting method
    const conflict = await s.adminFetch(`/api/admin/orders/${id}/checkout`, {
      method: 'POST',
      body: JSON.stringify({ paymentMethod: 'cash' }),
    });
    assert.equal(conflict.status, 409);
    // paid cannot be accepted/rejected
    assert.equal(
      (await s.adminFetch(`/api/admin/orders/${id}/accept`, { method: 'POST' })).status,
      409
    );
    assert.equal(
      (await s.adminFetch(`/api/admin/orders/${id}/reject`, { method: 'POST' })).status,
      409
    );
    // paid order cannot receive items
    assert.equal(
      (
        await s.adminFetch(`/api/admin/orders/${id}/items`, {
          method: 'POST',
          body: JSON.stringify({ requestId: randomUUID(), items: [{ id: 'pizza', quantity: 1 }] }),
        })
      ).status,
      409
    );
  } finally {
    await s.stop();
  }
});

test('checkout rejects invalid input and non-accepted orders', async () => {
  const s = await startTestServer();
  try {
    const table = await setupTableAndMenu(s);
    const { body } = await guestOrder(s, table);
    const id = body.order.id;
    const checkout = (pm) =>
      s.adminFetch(`/api/admin/orders/${id}/checkout`, {
        method: 'POST',
        body: JSON.stringify({ paymentMethod: pm }),
      });
    assert.equal((await checkout('paypal')).status, 400);
    assert.equal((await checkout(undefined)).status, 400);
    assert.equal((await checkout('cash')).status, 409, 'pending cannot be paid');
    // empty manual order cannot be paid
    const created = await s.adminFetch('/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({ requestId: randomUUID(), guestName: 'زبون' }),
    });
    const mid = (await created.json()).order.id;
    assert.equal(
      (
        await s.adminFetch(`/api/admin/orders/${mid}/checkout`, {
          method: 'POST',
          body: JSON.stringify({ paymentMethod: 'cash' }),
        })
      ).status,
      400,
      'empty order cannot be paid'
    );
    assert.equal(
      (
        await s.adminFetch(`/api/admin/orders/${randomUUID()}/checkout`, {
          method: 'POST',
          body: JSON.stringify({ paymentMethod: 'cash' }),
        })
      ).status,
      404
    );
  } finally {
    await s.stop();
  }
});

test('paid orders persist across restart with payment fields', async () => {
  const first = await startTestServer();
  const table = await setupTableAndMenu(first);
  const { body } = await guestOrder(first, table);
  await first.adminFetch(`/api/admin/orders/${body.order.id}/accept`, { method: 'POST' });
  await first.adminFetch(`/api/admin/orders/${body.order.id}/checkout`, {
    method: 'POST',
    body: JSON.stringify({ paymentMethod: 'cartao' }),
  });
  const dbPath = first.dbPath;
  await first.stop();

  const { createApp } = await import('../../server/app.mjs');
  const app = createApp({
    adminPassword: first.adminPassword,
    dbPath,
    host: '127.0.0.1',
    port: 0,
    staticDir: dbPath.slice(0, dbPath.lastIndexOf('/')),
  });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ password: first.adminPassword }),
  });
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  try {
    const res = await fetch(`${base}/api/admin/orders`, {
      headers: { Cookie: cookie, Origin: base },
    });
    const { orders } = await res.json();
    const paid = orders.find((o) => o.id === body.order.id);
    assert.equal(paid.status, 'paid');
    assert.equal(paid.paymentMethod, 'cartao');
    assert.equal(typeof paid.paidAt, 'string');
  } finally {
    await app.close();
  }
});

test('legacy order rows survive migration and keep their data', async () => {
  // Create a database with the OLD schema, insert a legacy row, then open with the app.
  const { DatabaseSync } = await import('node:sqlite');
  const s0 = await startTestServer();
  const dir = s0.dir;
  await s0.stop();
  const dbPath = `${dir}/legacy.sqlite`;
  const old = new DatabaseSync(dbPath);
  old.exec(`
    CREATE TABLE restaurant_tables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE menu_items (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, price_cents INTEGER NOT NULL,
      image TEXT, category TEXT, description TEXT
    );
    CREATE TABLE orders (
      id TEXT PRIMARY KEY,
      table_id INTEGER NOT NULL,
      table_label TEXT NOT NULL,
      notes TEXT,
      total_cents INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected')),
      created_at TEXT NOT NULL,
      request_id TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_orders_table_request ON orders (table_id, request_id);
    CREATE TABLE order_items (
      order_id TEXT NOT NULL REFERENCES orders(id),
      item_id TEXT NOT NULL, name TEXT NOT NULL, price_cents INTEGER NOT NULL, quantity INTEGER NOT NULL
    );
    INSERT INTO restaurant_tables (label, token, active) VALUES ('Legacy T', 'legacytoken', 1);
    INSERT INTO orders (id, table_id, table_label, notes, total_cents, status, created_at, request_id)
      VALUES ('00000000-0000-4000-8000-000000000001', 1, 'Legacy T', 'old note', 1234, 'accepted', '2024-01-01T00:00:00.000Z', 'legacy-req-1');
    INSERT INTO order_items VALUES ('00000000-0000-4000-8000-000000000001', 'pizza', 'Margherita', 900, 1);
    INSERT INTO order_items VALUES ('00000000-0000-4000-8000-000000000001', 'cola', 'Cola', 334, 1);
  `);
  old.close();

  const { createApp } = await import('../../server/app.mjs');
  const app = createApp({
    adminPassword: 'a-strong-password-here',
    dbPath,
    host: '127.0.0.1',
    port: 0,
    staticDir: dir,
  });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ password: 'a-strong-password-here' }),
  });
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  try {
    const { orders } = await (
      await fetch(`${base}/api/admin/orders`, { headers: { Cookie: cookie, Origin: base } })
    ).json();
    assert.equal(orders.length, 1);
    const legacy = orders[0];
    assert.equal(legacy.id, '00000000-0000-4000-8000-000000000001');
    assert.equal(legacy.status, 'accepted');
    assert.equal(legacy.total, 1234);
    assert.equal(legacy.notes, 'old note');
    assert.equal(legacy.tableLabel, 'Legacy T', 'legacy guestName falls back to table label');
    assert.equal(legacy.items.length, 2);
    assert.equal(legacy.items[0].source, 'guest');
    // legacy accepted order can be paid
    const res = await fetch(`${base}/api/admin/orders/00000000-0000-4000-8000-000000000001/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie },
      body: JSON.stringify({ paymentMethod: 'ifood_card' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).order.status, 'paid');
  } finally {
    await app.close();
  }
});
