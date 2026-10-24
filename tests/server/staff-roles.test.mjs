import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, randomPassword } from './helpers.mjs';
import { openDb } from '../../server/db.mjs';

// Password helper for staff accounts (never logged).
const staffPassword = () => randomPassword();

test('owner password-only login remains backward compatible and session reports owner actor', async () => {
  const s = await startTestServer();
  try {
    const res = await fetch(`${s.base}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: s.base },
      body: JSON.stringify({ password: s.adminPassword }),
    });
    assert.equal(res.status, 200);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const session = await (await fetch(`${s.base}/api/admin/session`, { headers: { Cookie: cookie } })).json();
    assert.equal(session.authenticated, true);
    assert.deepEqual(session.actor, { kind: 'owner', role: 'owner' });
  } finally {
    await s.stop();
  }
});

test('staff login via same /api/admin/login binds role and actor; no secret material in response', async () => {
  const s = await startTestServer();
  try {
    const pwd = staffPassword();
    await s.createStaff({ username: 'cash1', password: pwd, role: 'cashier' });
    const { status, cookie, body } = await s.staffLogin('cash1', pwd);
    assert.equal(status, 200);
    assert.equal(body.authenticated, true);
    assert.ok(!JSON.stringify(body).includes(pwd));
    const session = await (await fetch(`${s.base}/api/admin/session`, { headers: { Cookie: cookie } })).json();
    assert.equal(session.authenticated, true);
    assert.equal(session.actor.kind, 'staff');
    assert.equal(session.actor.username, 'cash1');
    assert.equal(session.actor.role, 'cashier');
    assert.ok(!('password_hash' in session.actor));
  } finally {
    await s.stop();
  }
});

test('staff login with wrong password fails generically without cookie', async () => {
  const s = await startTestServer();
  try {
    await s.createStaff({ username: 'k1', password: staffPassword(), role: 'kitchen' });
    const { status, cookie, body } = await s.staffLogin('k1', 'wrong');
    assert.equal(status, 401);
    assert.equal(cookie, '');
    assert.deepEqual(body, { error: 'Invalid credentials' });
  } finally {
    await s.stop();
  }
});

test('unknown username login fails like wrong password (no user enumeration)', async () => {
  const s = await startTestServer();
  try {
    const { status } = await s.staffLogin('ghost', 'whatever');
    assert.equal(status, 401);
  } finally {
    await s.stop();
  }
});

test('staff accounts are stored salted-scrypt hashed, never plaintext', async () => {
  const s = await startTestServer();
  try {
    const pwd = staffPassword();
    await s.createStaff({ username: 'cash2', password: pwd, role: 'cashier' });
    const db = openDb(s.dbPath);
    let row;
    try {
      row = db.prepare('SELECT * FROM staff_users WHERE username = ?').get('cash2');
    } finally {
      db.close();
    }
    assert.ok(row);
    assert.ok(!JSON.stringify(row).includes(pwd), 'raw password must not be stored');
    assert.notEqual(row.password_hash, pwd);
    assert.ok(row.salt && row.salt.length >= 16);
  } finally {
    await s.stop();
  }
});

test('cashier reads orders/menu/tables and creates/accepts/add-items/checkout', async () => {
  const s = await startTestServer();
  try {
    const pwd = staffPassword();
    await s.createStaff({ username: 'c', password: pwd, role: 'cashier' });
    const { cookie } = await s.staffLogin('c', pwd);
    const f = (p, o) => s.staffFetch(cookie, p, o);
    assert.equal((await f('/api/admin/orders')).status, 200);
    assert.equal((await f('/api/admin/menu')).status, 200);
    assert.equal((await f('/api/admin/tables')).status, 200);
    const created = await f('/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({ requestId: crypto.randomUUID(), guestName: 'زبون' }),
    });
    assert.equal(created.status, 201);
    const order = (await created.json()).order;
    // give the order an item via menu publish (owner) then add
    await publishSimpleMenu(s);
    const added = await f(`/api/admin/orders/${order.id}/items`, {
      method: 'POST',
      body: JSON.stringify({ requestId: crypto.randomUUID(), items: [{ id: 'i1', quantity: 1 }] }),
    });
    assert.equal(added.status, 200);
    const accepted = await f(`/api/admin/orders/${order.id}/accept`, { method: 'POST' });
    assert.equal(accepted.status, 409); // cashier-created orders start accepted
    const paid = await f(`/api/admin/orders/${order.id}/checkout`, {
      method: 'POST',
      body: JSON.stringify({ paymentMethod: 'cash' }),
    });
    assert.equal(paid.status, 200);
  } finally {
    await s.stop();
  }
});

test('cashier cannot publish menu, manage tables/staff, or view audit', async () => {
  const s = await startTestServer();
  try {
    const pwd = staffPassword();
    await s.createStaff({ username: 'c', password: pwd, role: 'cashier' });
    const { cookie } = await s.staffLogin('c', pwd);
    const f = (p, o) => s.staffFetch(cookie, p, o);
    assert.equal((await f('/api/admin/menu', { method: 'PUT', body: JSON.stringify({ items: [] }) })).status, 403);
    assert.equal((await f('/api/admin/tables', { method: 'POST', body: JSON.stringify({ label: 't' }) })).status, 403);
    assert.equal((await f('/api/admin/tables/1', { method: 'DELETE' })).status, 403);
    assert.equal((await f('/api/admin/staff', { method: 'POST', body: JSON.stringify({ username: 'x', password: 'longenough1', role: 'kitchen' }) })).status, 403);
    assert.equal((await f('/api/admin/audit')).status, 403);
    assert.equal((await f(`/api/admin/orders/${crypto.randomUUID()}/preparation`, { method: 'POST', body: JSON.stringify({ status: 'preparing' }) })).status, 403);
  } finally {
    await s.stop();
  }
});

test('kitchen reads orders and advances preparation only', async () => {
  const s = await startTestServer();
  try {
    const pwd = staffPassword();
    await s.createStaff({ username: 'k', password: pwd, role: 'kitchen' });
    const { cookie } = await s.staffLogin('k', pwd);
    const f = (p, o) => s.staffFetch(cookie, p, o);
    assert.equal((await f('/api/admin/orders')).status, 200);
    assert.equal((await f('/api/admin/menu')).status, 403);
    assert.equal((await f('/api/admin/tables')).status, 403);
    assert.equal((await f('/api/admin/orders', { method: 'POST', body: JSON.stringify({ requestId: crypto.randomUUID(), guestName: 'x' }) })).status, 403);
    assert.equal((await f('/api/admin/menu', { method: 'PUT', body: JSON.stringify({ items: [] }) })).status, 403);
    assert.equal((await f('/api/admin/tables', { method: 'POST', body: JSON.stringify({ label: 't' }) })).status, 403);
    assert.equal((await f('/api/admin/staff', { method: 'POST', body: JSON.stringify({ username: 'x', password: 'longenough1', role: 'cashier' }) })).status, 403);
    assert.equal((await f('/api/admin/audit')).status, 403);

    // Owner seeds a pending order, kitchen advances preparation after cashier accepts.
    await publishSimpleMenu(s);
    const created = await s.adminFetch('/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({ requestId: crypto.randomUUID(), guestName: 't' }),
    });
    const id = (await created.json()).order.id;
    const table = (await (await s.adminFetch('/api/admin/tables', {
      method: 'POST', body: JSON.stringify({ label: 'T1' }),
    })).json()).table;
    const guest = await fetch(`${s.base}/api/guest/${table.token}/orders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: s.base },
      body: JSON.stringify({ requestId: crypto.randomUUID(), guestName: 'waiting', items: [{ id: 'i1', quantity: 1 }] }),
    });
    assert.equal(guest.status, 201);
    assert.equal((await (await f('/api/admin/orders')).json()).orders.length, 1, 'kitchen should not see pending guest orders');
    await s.adminFetch(`/api/admin/orders/${id}/items`, {
      method: 'POST',
      body: JSON.stringify({ requestId: crypto.randomUUID(), items: [{ id: 'i1', quantity: 1 }] }),
    });
    await s.adminFetch(`/api/admin/orders/${id}/accept`, { method: 'POST' });
    assert.equal((await f(`/api/admin/orders/${id}/accept`, { method: 'POST' })).status, 403);
    assert.equal((await f(`/api/admin/orders/${id}/reject`, { method: 'POST' })).status, 403);
    const prep = await f(`/api/admin/orders/${id}/preparation`, { method: 'POST', body: JSON.stringify({ status: 'preparing' }) });
    assert.equal(prep.status, 200);
    assert.equal((await prep.json()).order.paymentMethod, undefined);
    const paid = await s.adminFetch(`/api/admin/orders/${id}/checkout`, {
      method: 'POST', body: JSON.stringify({ paymentMethod: 'cash' }),
    });
    assert.equal(paid.status, 200);
    const kitchenList = (await (await f('/api/admin/orders')).json()).orders;
    assert.equal(kitchenList.length, 1);
    assert.equal(kitchenList[0].status, 'paid');
    assert.equal(kitchenList[0].paymentMethod, undefined);
    assert.equal(kitchenList[0].paidAt, undefined);
    const prepAgain = await f(`/api/admin/orders/${id}/preparation`, { method: 'POST', body: JSON.stringify({ status: 'ready' }) });
    assert.equal((await prepAgain.json()).order.paymentMethod, undefined);
    const checkout = await f(`/api/admin/orders/${id}/checkout`, { method: 'POST', body: JSON.stringify({ paymentMethod: 'cash' }) });
    assert.equal(checkout.status, 403);
  } finally {
    await s.stop();
  }
});

test('logout revokes the current staff session', async () => {
  const s = await startTestServer();
  try {
    const pwd = staffPassword();
    await s.createStaff({ username: 'c', password: pwd, role: 'cashier' });
    const { cookie } = await s.staffLogin('c', pwd);
    await s.staffFetch(cookie, '/api/admin/logout', { method: 'POST' });
    const res = await s.staffFetch(cookie, '/api/admin/orders');
    assert.equal(res.status, 401);
  } finally {
    await s.stop();
  }
});

test('deactivating staff revokes their existing sessions and blocks new logins', async () => {
  const s = await startTestServer();
  try {
    const pwd = staffPassword();
    const created = await s.createStaff({ username: 'c', password: pwd, role: 'cashier' });
    const { cookie } = await s.staffLogin('c', pwd);
    assert.equal((await s.staffFetch(cookie, '/api/admin/orders')).status, 200);
    const res = await s.adminFetch(`/api/admin/staff/${created.staff.id}/deactivate`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal((await s.staffFetch(cookie, '/api/admin/orders')).status, 401, 'existing session must be revoked');
    assert.equal((await s.staffLogin('c', pwd)).status, 401, 'new login must fail');
  } finally {
    await s.stop();
  }
});

test('staff accounts persist across restart (login works after reopen)', async () => {
  const s = await startTestServer();
  try {
    const pwd = staffPassword();
    await s.createStaff({ username: 'c', password: pwd, role: 'cashier' });
    await s.stop();

    const app2 = await import('../../server/app.mjs');
    const app = app2.createApp({
      adminPassword: s.adminPassword,
      dbPath: s.dbPath,
      host: '127.0.0.1',
      port: 0,
      staticDir: s.dir,
    });
    await app.listen();
    const address = app.server.address();
    const base2 = `http://127.0.0.1:${address.port}`;
    const res = await fetch(`${base2}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base2 },
      body: JSON.stringify({ username: 'c', password: pwd }),
    });
    assert.equal(res.status, 200);
    await app.close();
  } finally {
    // s already stopped above
  }
});

test('staff creation validates username, role and password strength', async () => {
  const s = await startTestServer();
  try {
    assert.equal((await s.adminFetch('/api/admin/staff', { method: 'POST', body: JSON.stringify({ username: 'bad name!', password: 'longenough1', role: 'cashier' }) })).status, 400);
    assert.equal((await s.adminFetch('/api/admin/staff', { method: 'POST', body: JSON.stringify({ username: 'ok1', password: 'short', role: 'cashier' }) })).status, 400);
    assert.equal((await s.adminFetch('/api/admin/staff', { method: 'POST', body: JSON.stringify({ username: 'ok1', password: 'longenough1', role: 'manager' }) })).status, 400);
    assert.equal((await s.createStaff({ username: 'ok1', password: 'longenough1', role: 'cashier' })).staff.username, 'ok1');
    // duplicate username rejected
    assert.equal((await s.adminFetch('/api/admin/staff', { method: 'POST', body: JSON.stringify({ username: 'ok1', password: 'longenough2', role: 'kitchen' }) })).status, 409);
  } finally {
    await s.stop();
  }
});

async function publishSimpleMenu(s) {
  const res = await s.adminFetch('/api/admin/menu', {
    method: 'PUT',
    body: JSON.stringify({ items: [{ id: 'i1', name: 'شاي', price: 500 }] }),
  });
  if (res.status !== 200) throw new Error(`menu publish failed: ${res.status}`);
}
