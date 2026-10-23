import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startTestServer, publishMenu } from '../server/helpers.mjs';
import { mapServerOrder, combineForReporting } from '../../utils/qr/adminOrders.ts';

// Real HTTP + SQLite endpoints feeding the same frontend adapter used by POS.
test('two guests share a table without sharing a bill; cashier addition and payment appear once beside legacy sales', async () => {
  const s = await startTestServer();
  try {
    const created = await s.adminFetch('/api/admin/tables', {
      method: 'POST', body: JSON.stringify({ label: 'Mesa 7' }),
    });
    const { table } = await created.json();
    await publishMenu(s, [{ id: 'meal', name: 'Prato', price: 1900 }, { id: 'drink', name: 'Suco', price: 500 }]);
    const guest = async guestName => {
      const res = await fetch(`${s.base}/api/guest/${table.token}/orders`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: s.base },
        body: JSON.stringify({ guestName, requestId: randomUUID(), items: [{ id: 'meal', quantity: 1 }] }),
      });
      assert.equal(res.status, 201);
      return (await res.json()).order;
    };
    const a = await guest('ليلى');
    const b = await guest('عمر');
    assert.notEqual(a.id, b.id);
    assert.equal(a.tableId, b.tableId);
    assert.equal(a.total, 1900);
    assert.equal(b.total, 1900);
    assert.equal((await s.adminFetch(`/api/admin/orders/${a.id}/accept`, { method: 'POST' })).status, 200);
    const requestId = randomUUID();
    const addition = () => s.adminFetch(`/api/admin/orders/${a.id}/items`, {
      method: 'POST', body: JSON.stringify({ requestId, items: [{ id: 'drink', quantity: 1 }] }),
    });
    assert.equal((await addition()).status, 200);
    assert.equal((await addition()).status, 200);
    const paid = await s.adminFetch(`/api/admin/orders/${a.id}/checkout`, {
      method: 'POST', body: JSON.stringify({ paymentMethod: 'pix' }),
    });
    assert.equal(paid.status, 200);
    assert.equal((await s.adminFetch(`/api/admin/orders/${a.id}/checkout`, {
      method: 'POST', body: JSON.stringify({ paymentMethod: 'pix' }),
    })).status, 200);
    const wire = (await (await s.adminFetch('/api/admin/orders')).json()).orders;
    const byId = Object.fromEntries(wire.map(o => [o.id, o]));
    assert.equal(byId[a.id].total, 2400);
    assert.equal(byId[a.id].items.length, 2);
    assert.equal(byId[b.id].status, 'pending');
    assert.equal(byId[b.id].total, 1900);
    const legacy = [{ id: 73, total: 10, items: [], status: 'completed', dateOnly: '01/01/2026' }];
    const combined = combineForReporting(legacy, wire.map(mapServerOrder));
    assert.equal(combined.length, 2, 'one paid server order plus one old local sale');
    assert.equal(combined.find(o => o.serverOrderId === a.id).total, 24, 'cents become BRL');
    assert.equal(combined.find(o => o.id === 73).total, 10);
  } finally {
    await s.stop();
  }
});
