import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startTestServer, publishMenu } from './helpers.mjs';

async function setupWithTableAndMenu(s) {
  const { table } = await (
    await s.adminFetch('/api/admin/tables', {
      method: 'POST',
      body: JSON.stringify({ label: 'T1' }),
    })
  ).json();
  await publishMenu(s, [
    { id: 'pizza', name: 'Margherita', price: 900 },
    { id: 'cola', name: 'Cola', price: 250 },
  ]);
  return table;
}

test('guest menu returns table label and published items', async () => {
  const s = await startTestServer();
  try {
    const table = await setupWithTableAndMenu(s);
    const res = await fetch(`${s.base}/api/guest/${table.token}/menu`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.table.label, 'T1');
    assert.equal(body.items.length, 2);
    assert.deepEqual(
      body.items.map((i) => Object.keys(i).sort()).map((k) => k.join(',')),
      body.items.map(() => 'category,description,id,image,name,price')
    );
  } finally {
    await s.stop();
  }
});

test('guest menu rejects unknown/revoked token', async () => {
  const s = await startTestServer();
  try {
    const res = await fetch(`${s.base}/api/guest/not-a-real-token/menu`);
    assert.equal(res.status, 404);
  } finally {
    await s.stop();
  }
});

test('guest order is priced server-side and appears in admin queue', async () => {
  const s = await startTestServer();
  try {
    const table = await setupWithTableAndMenu(s);
    const requestId = randomUUID();
    const res = await fetch(`${s.base}/api/guest/${table.token}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: s.base },
      body: JSON.stringify({
        items: [
          { id: 'pizza', quantity: 2 },
          { id: 'cola', quantity: 1 },
        ],
        notes: 'no onions',
        guestName: 'Guest',
        requestId,
      }),
    });
    assert.equal(res.status, 201);
    const { order } = await res.json();
    assert.equal(order.status, 'pending');
    assert.equal(order.tableLabel, 'T1');
    assert.equal(order.total, 2050); // 2*900 + 250 cents
    assert.deepEqual(order.items, [
      { id: 'pizza', name: 'Margherita', price: 900, quantity: 2, source: 'guest' },
      { id: 'cola', name: 'Cola', price: 250, quantity: 1, source: 'guest' },
    ]);

    const queue = await s.adminFetch('/api/admin/orders');
    const { orders } = await queue.json();
    assert.equal(orders.length, 1);
    assert.equal(orders[0].id, order.id);
    assert.equal(orders[0].total, 2050);
    assert.equal(orders[0].notes, 'no onions');
  } finally {
    await s.stop();
  }
});

test('duplicate requestId returns same order with 200', async () => {
  const s = await startTestServer();
  try {
    const table = await setupWithTableAndMenu(s);
    const requestId = randomUUID();
    const payload = {
      items: [{ id: 'pizza', quantity: 1 }],
        guestName: 'Guest',
      requestId,
    };
    const first = await fetch(`${s.base}/api/guest/${table.token}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: s.base },
      body: JSON.stringify(payload),
    });
    assert.equal(first.status, 201);
    const second = await fetch(`${s.base}/api/guest/${table.token}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: s.base },
      body: JSON.stringify(payload),
    });
    assert.equal(second.status, 200);
    const a = (await first.json()).order;
    const b = (await second.json()).order;
    assert.equal(a.id, b.id);
  } finally {
    await s.stop();
  }
});

test('guest order validation rejects unsafe input', async () => {
  const s = await startTestServer();
  try {
    const table = await setupWithTableAndMenu(s);
    const post = (body, opts = {}) =>
      fetch(`${s.base}/api/guest/${table.token}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: s.base },
        body: JSON.stringify(body),
        ...opts,
      });

    assert.equal((await post({ items: [], guestName: 'Guest', requestId: randomUUID() })).status, 400, 'empty order');
    assert.equal(
      (await post({ items: [{ id: 'ghost', quantity: 1 }], guestName: 'Guest', requestId: randomUUID() })).status,
      400,
      'unknown item'
    );
    assert.equal(
      (await post({
        items: [
          { id: 'pizza', quantity: 1 },
          { id: 'pizza', quantity: 2 },
        ],
        guestName: 'Guest', requestId: randomUUID(),
      })).status,
      400,
      'duplicate item'
    );
    assert.equal(
      (await post({ items: [{ id: 'pizza', quantity: 0 }], guestName: 'Guest', requestId: randomUUID() })).status,
      400,
      'invalid quantity'
    );
    assert.equal(
      (await post({ items: [{ id: 'pizza', quantity: 1.5 }], guestName: 'Guest', requestId: randomUUID() })).status,
      400,
      'fractional quantity'
    );
    assert.equal(
      (await post({ items: [{ id: 'pizza', quantity: 1 }], requestId: 'not-a-uuid' })).status,
      400,
      'requestId must be UUID'
    );
    assert.equal(
      (await post({ items: [{ id: 'pizza', quantity: 1 }], guestName: 'Guest', requestId: randomUUID(), notes: 'x'.repeat(600) }))
        .status,
      400,
      'oversize notes'
    );
    const big = await fetch(`${s.base}/api/guest/${table.token}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: s.base },
      body: JSON.stringify({ items: [{ id: 'pizza', quantity: 1 }], guestName: 'Guest', requestId: randomUUID() }) + 'x'.repeat(100_000),
    });
    assert.equal(big.status, 413, 'oversize payload');
  } finally {
    await s.stop();
  }
});

test('revoked token cannot submit orders', async () => {
  const s = await startTestServer();
  try {
    const table = await setupWithTableAndMenu(s);
    await s.adminFetch(`/api/admin/tables/${table.id}`, { method: 'DELETE' });
    const res = await fetch(`${s.base}/api/guest/${table.token}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: s.base },
      body: JSON.stringify({ items: [{ id: 'pizza', quantity: 1 }], guestName: 'Guest', requestId: randomUUID() }),
    });
    assert.equal(res.status, 404);
  } finally {
    await s.stop();
  }
});

test('guest submissions are rate limited', async () => {
  const s = await startTestServer();
  try {
    const table = await setupWithTableAndMenu(s);
    let last;
    for (let i = 0; i < 20; i++) {
      last = await fetch(`${s.base}/api/guest/${table.token}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: s.base },
        body: JSON.stringify({ items: [{ id: 'cola', quantity: 1 }], guestName: 'Guest', requestId: randomUUID() }),
      });
      if (last.status === 429) break;
    }
    assert.equal(last.status, 429);
  } finally {
    await s.stop();
  }
});

test('retry of an accepted request id still works after rate limit', async () => {
  const s = await startTestServer();
  try {
    const table = await setupWithTableAndMenu(s);
    const post = (requestId) => fetch(`${s.base}/api/guest/${table.token}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: s.base },
      body: JSON.stringify({ items: [{ id: 'pizza', quantity: 1 }], guestName: 'Guest', requestId }),
    });
    const firstId = randomUUID();
    const first = await post(firstId);
    assert.equal(first.status, 201);
    const created = (await first.json()).order;
    for (let i = 0; i < 9; i++) assert.equal((await post(randomUUID())).status, 201);
    assert.equal((await post(randomUUID())).status, 429);
    const retry = await post(firstId);
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).order.id, created.id);
  } finally {
    await s.stop();
  }
});

test('no guest access to admin data', async () => {
  const s = await startTestServer();
  try {
    for (const path of ['/api/admin/orders', '/api/admin/tables']) {
      const res = await fetch(`${s.base}${path}`);
      assert.equal(res.status, 401, path);
    }
  } finally {
    await s.stop();
  }
});
