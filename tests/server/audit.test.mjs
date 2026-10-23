import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.mjs';
import { openDb } from '../../server/db.mjs';

async function seedCashierAcceptedOrderWithItem(s) {
  await s.adminFetch('/api/admin/menu', {
    method: 'PUT',
    body: JSON.stringify({ items: [{ id: 'i1', name: 'قهوة', price: 700 }] }),
  });
  const created = await s.adminFetch('/api/admin/orders', {
    method: 'POST',
    body: JSON.stringify({ requestId: crypto.randomUUID(), guestName: 'ضيف تجريبي' }),
  });
  const id = (await created.json()).order.id;
  await s.adminFetch(`/api/admin/orders/${id}/items`, {
    method: 'POST',
    body: JSON.stringify({ requestId: crypto.randomUUID(), items: [{ id: 'i1', quantity: 2 }] }),
  });
  // Cashier-created orders start accepted; no accept transition here.
  return id;
}

test('audit records staff creation and deactivation with actor metadata', async () => {
  const s = await startTestServer();
  try {
    const st = await s.createStaff({ username: 'c1', password: 'longenough1', role: 'cashier' });
    await s.adminFetch(`/api/admin/staff/${st.staff.id}/deactivate`, { method: 'POST' });
    const res = await s.adminFetch('/api/admin/audit');
    assert.equal(res.status, 200);
    const { events } = await res.json();
    const actions = events.map((e) => e.action);
    assert.ok(actions.includes('staff.create'));
    assert.ok(actions.includes('staff.deactivate'));
    const create = events.find((e) => e.action === 'staff.create');
    assert.equal(create.actorRole, 'owner');
    assert.ok(create.at);
    assert.equal(create.metadata.username, 'c1');
    assert.equal(create.metadata.role, 'cashier');
  } finally {
    await s.stop();
  }
});

test('audit records table/menu writes and order lifecycle with ids', async () => {
  const s = await startTestServer();
  try {
    await s.adminFetch('/api/admin/tables', { method: 'POST', body: JSON.stringify({ label: 'طاولة 1' }) });
    await s.adminFetch('/api/admin/menu', {
      method: 'PUT',
      body: JSON.stringify({ items: [{ id: 'i1', name: 'شاي', price: 300 }] }),
    });
    const id = await seedCashierAcceptedOrderWithItem(s);
    // order.accept on a guest pending order
    const tables = await s.adminFetch('/api/admin/tables').then((r) => r.json());
    const guest = await fetch(`${s.base}/api/guest/${tables.tables[0].token}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: s.base },
      body: JSON.stringify({ requestId: crypto.randomUUID(), guestName: 'ز', items: [{ id: 'i1', quantity: 1 }] }),
    });
    const guestId = (await guest.json()).order.id;
    await s.adminFetch(`/api/admin/orders/${guestId}/accept`, { method: 'POST' });
    await s.adminFetch(`/api/admin/orders/${id}/checkout`, { method: 'POST', body: JSON.stringify({ paymentMethod: 'cash' }) });

    const { events } = await s.adminFetch('/api/admin/audit').then((r) => r.json());
    const actions = new Set(events.map((e) => e.action));
    for (const a of ['table.create', 'menu.publish', 'order.create', 'order.add_items', 'order.accept', 'order.checkout']) {
      assert.ok(actions.has(a), `missing audit action ${a}`);
    }
    const addItems = events.find((e) => e.action === 'order.add_items');
    assert.equal(addItems.orderId, id);
    const checkout = events.find((e) => e.action === 'order.checkout');
    assert.equal(checkout.orderId, id);
  } finally {
    await s.stop();
  }
});

test('kitchen transitions are audited with actor role kitchen', async () => {
  const s = await startTestServer();
  try {
    const pwd = 'longenough1';
    await s.createStaff({ username: 'k', password: pwd, role: 'kitchen' });
    const { cookie } = await s.staffLogin('k', pwd);
    const id = await seedCashierAcceptedOrderWithItem(s);
    await s.staffFetch(cookie, `/api/admin/orders/${id}/preparation`, { method: 'POST', body: JSON.stringify({ status: 'preparing' }) });

    const { events } = await s.adminFetch('/api/admin/audit').then((r) => r.json());
    const prep = events.find((e) => e.action === 'order.preparation');
    assert.ok(prep, 'preparation must be audited');
    assert.equal(prep.actorRole, 'kitchen');
    assert.equal(prep.actorUsername, 'k');
    assert.equal(prep.orderId, id);
  } finally {
    await s.stop();
  }
});

test('audit never contains passwords, cookies, tokens or guest notes/names', async () => {
  const s = await startTestServer();
  try {
    const pwd = 'longenough1-secret';
    await s.createStaff({ username: 'c1', password: pwd, role: 'cashier' });
    await s.adminFetch('/api/admin/tables', { method: 'POST', body: JSON.stringify({ label: 'ط1' }) });
    await s.adminFetch('/api/admin/menu', {
      method: 'PUT',
      body: JSON.stringify({ items: [{ id: 'i1', name: 'شاي', price: 300 }] }),
    });
    // guest order with private notes
    const tables = await s.adminFetch('/api/admin/tables').then((r) => r.json());
    const token = tables.tables[0].token;
    await fetch(`${s.base}/api/guest/${token}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: s.base },
      body: JSON.stringify({ requestId: crypto.randomUUID(), guestName: 'اسم العميل الخاص', notes: 'ملاحظة سرية للعميل', items: [{ id: 'i1', quantity: 1 }] }),
    });
    const id = await seedCashierAcceptedOrderWithItem(s);
    await s.adminFetch(`/api/admin/orders/${id}/checkout`, { method: 'POST', body: JSON.stringify({ paymentMethod: 'pix' }) });

    const res = await s.adminFetch('/api/admin/audit');
    const raw = JSON.stringify(await res.json());
    for (const secret of [pwd, 'اسم العميل الخاص', 'ملاحظة سرية للعميل', 'sid=', token]) {
      assert.ok(!raw.includes(secret), `audit leaked secret: ${secret}`);
    }
    // and nothing in the database rows either
    const db = openDb(s.dbPath);
    let rows;
    try {
      rows = db.prepare('SELECT * FROM audit_log').all();
    } finally {
      db.close();
    }
    const rawDb = JSON.stringify(rows);
    for (const secret of [pwd, 'اسم العميل الخاص', 'ملاحظة سرية للعميل']) {
      assert.ok(!rawDb.includes(secret), 'audit table leaked a secret');
    }
  } finally {
    await s.stop();
  }
});

test('requestId replays do not duplicate audit entries', async () => {
  const s = await startTestServer();
  try {
    await s.adminFetch('/api/admin/menu', {
      method: 'PUT',
      body: JSON.stringify({ items: [{ id: 'i1', name: 'شاي', price: 300 }] }),
    });
    const created = await s.adminFetch('/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({ requestId: crypto.randomUUID(), guestName: 'x' }),
    });
    const id = (await created.json()).order.id;
    const requestId = crypto.randomUUID();
    await s.adminFetch(`/api/admin/orders/${id}/items`, {
      method: 'POST',
      body: JSON.stringify({ requestId, items: [{ id: 'i1', quantity: 1 }] }),
    });
    // replay same requestId
    await s.adminFetch(`/api/admin/orders/${id}/items`, {
      method: 'POST',
      body: JSON.stringify({ requestId, items: [{ id: 'i1', quantity: 1 }] }),
    });
    // checkout replay with same method
    await s.adminFetch(`/api/admin/orders/${id}/accept`, { method: 'POST' });
    await s.adminFetch(`/api/admin/orders/${id}/checkout`, { method: 'POST', body: JSON.stringify({ paymentMethod: 'cash' }) });
    await s.adminFetch(`/api/admin/orders/${id}/checkout`, { method: 'POST', body: JSON.stringify({ paymentMethod: 'cash' }) });

    const { events } = await s.adminFetch('/api/admin/audit').then((r) => r.json());
    const count = (a) => events.filter((e) => e.action === a).length;
    assert.equal(count('order.add_items'), 1, 'add_items replay must not add a second event');
    assert.equal(count('order.checkout'), 1, 'checkout replay must not add a second event');
  } finally {
    await s.stop();
  }
});

test('large item additions keep audit metadata valid JSON within its bound', async () => {
  const s = await startTestServer();
  try {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: `item-${String(i).padStart(2, '0')}-${'x'.repeat(40)}`, name: `Item ${i}`, price: 100 }));
    const published = await s.adminFetch('/api/admin/menu', { method: 'PUT', body: JSON.stringify({ items }) });
    assert.equal(published.status, 200);
    const created = await s.adminFetch('/api/admin/orders', { method: 'POST', body: JSON.stringify({ requestId: crypto.randomUUID(), guestName: 'x' }) });
    const id = (await created.json()).order.id;
    const added = await s.adminFetch(`/api/admin/orders/${id}/items`, {
      method: 'POST', body: JSON.stringify({ requestId: crypto.randomUUID(), items: items.map((it) => ({ id: it.id, quantity: 1 })) }),
    });
    assert.equal(added.status, 200);
    const audit = await s.adminFetch('/api/admin/audit');
    assert.equal(audit.status, 200);
    const event = (await audit.json()).events.find((e) => e.action === 'order.add_items');
    assert.deepEqual(event.metadata, { truncated: true });
  } finally {
    await s.stop();
  }
});

test('audit persists across restart and stays append-only', async () => {
  const s = await startTestServer();
  let app = null;
  try {
    await s.createStaff({ username: 'c1', password: 'longenough1', role: 'cashier' });
    const before = await s.adminFetch('/api/admin/audit').then((r) => r.json());
    assert.ok(before.events.length > 0);
    await s.stop();

    const app2 = await import('../../server/app.mjs');
    app = app2.createApp({
      adminPassword: s.adminPassword,
      dbPath: s.dbPath,
      host: '127.0.0.1',
      port: 0,
      staticDir: s.dir,
    });
    await app.listen();
    const address = app.server.address();
    const base2 = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base2}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base2 },
      body: JSON.stringify({ password: s.adminPassword }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const after = await (
      await fetch(`${base2}/api/admin/audit`, { headers: { Cookie: cookie, Origin: base2 } })
    ).json();
    assert.equal(after.events.length, before.events.length, 'audit must survive restart');
    await app.close();
    app = null;

    // append-only: no UPDATE/DELETE should be possible through normal API; rows untouched
    const db = openDb(s.dbPath);
    let n;
    try {
      n = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
    } finally {
      db.close();
    }
    assert.equal(n, before.events.length);
  } finally {
    if (app) await app.close();
    // s already stopped above if we got past the first block
  }
});

test('audit read API supports pagination via limit and offset', async () => {
  const s = await startTestServer();
  try {
    for (let i = 0; i < 5; i++) {
      await s.createStaff({ username: `u${i}`, password: 'longenough1', role: 'cashier' });
    }
    const page1 = await s.adminFetch('/api/admin/audit?limit=2').then((r) => r.json());
    assert.equal(page1.events.length, 2);
    const page2 = await s.adminFetch('/api/admin/audit?limit=2&offset=2').then((r) => r.json());
    assert.equal(page2.events.length, 2);
    const ids1 = page1.events.map((e) => e.id);
    const ids2 = page2.events.map((e) => e.id);
    assert.equal(new Set([...ids1, ...ids2]).size, 4, 'pages must not overlap');
  } finally {
    await s.stop();
  }
});
