import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, publishMenu } from './helpers.mjs';

test('create table returns id, label, token, active', async () => {
  const s = await startTestServer();
  try {
    const res = await s.adminFetch('/api/admin/tables', {
      method: 'POST',
      body: JSON.stringify({ label: 'Tavolo 1' }),
    });
    assert.equal(res.status, 201);
    const { table } = await res.json();
    assert.equal(table.label, 'Tavolo 1');
    assert.equal(table.active, true);
    assert.ok(typeof table.id === 'number');
    assert.ok(table.token.length >= 32, 'token from >=24 random bytes');
  } finally {
    await s.stop();
  }
});

test('list tables', async () => {
  const s = await startTestServer();
  try {
    await s.adminFetch('/api/admin/tables', {
      method: 'POST',
      body: JSON.stringify({ label: 'A' }),
    });
    await s.adminFetch('/api/admin/tables', {
      method: 'POST',
      body: JSON.stringify({ label: 'B' }),
    });
    const res = await s.adminFetch('/api/admin/tables');
    const { tables } = await res.json();
    assert.equal(tables.length, 2);
    assert.deepEqual(Object.keys(tables[0]).sort(), ['active', 'id', 'label', 'token']);
  } finally {
    await s.stop();
  }
});

test('delete table revokes guest access', async () => {
  const s = await startTestServer();
  try {
    const { table } = await (
      await s.adminFetch('/api/admin/tables', {
        method: 'POST',
        body: JSON.stringify({ label: 'X' }),
      })
    ).json();
    const del = await s.adminFetch(`/api/admin/tables/${table.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);

    const guest = await fetch(`${s.base}/api/guest/${table.token}/menu`);
    assert.equal(guest.status, 404, 'revoked token cannot read menu');
  } finally {
    await s.stop();
  }
});

test('menu publication snapshot via PUT', async () => {
  const s = await startTestServer();
  try {
    const items = [
      { id: 'pizza', name: 'Margherita', price: 900, category: 'Pizza', description: 'tomato & mozzarella' },
      { id: 'cola', name: 'Cola', price: 250, image: '/img/cola.png' },
    ];
    const pub = await s.adminFetch('/api/admin/menu', {
      method: 'PUT',
      body: JSON.stringify({ items }),
    });
    assert.equal(pub.status, 200);
    const { items: got } = await pub.json();
    assert.equal(got.length, 2);

    const list = await s.adminFetch('/api/admin/menu');
    assert.equal((await list.json()).items.length, 2);
  } finally {
    await s.stop();
  }
});

test('menu PUT replaces previous snapshot entirely', async () => {
  const s = await startTestServer();
  try {
    await publishMenu(s, [{ id: 'a', name: 'A', price: 100 }]);
    await publishMenu(s, [{ id: 'b', name: 'B', price: 200 }]);
    const list = await s.adminFetch('/api/admin/menu');
    const { items } = await list.json();
    assert.deepEqual(items.map((i) => i.id), ['b']);
  } finally {
    await s.stop();
  }
});

test('menu PUT rejects invalid items', async () => {
  const s = await startTestServer();
  try {
    for (const items of [
      'not-an-array',
      [{ id: 'x', name: 'X' }], // missing price
      [{ id: 'x', name: 'X', price: -5 }],
      [{ id: 'x', name: 'X', price: 1.5 }],
      [{ name: 'X', price: 100 }],
    ]) {
      const res = await s.adminFetch('/api/admin/menu', {
        method: 'PUT',
        body: JSON.stringify({ items }),
      });
      assert.equal(res.status, 400, JSON.stringify(items));
    }
  } finally {
    await s.stop();
  }
});
