import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PAYMENT_METHODS,
  newRequestId,
  retryWithStableId,
  retryPersistedWrite,
  mapServerOrder,
  canApprove,
  canAddItems,
  canCheckout,
  isPaid,
  splitOrders,
  paidOrderToLegacy,
  combineForReporting,
} from '../../utils/qr/adminOrders.ts';

// ---- Stable request ids (no duplicate writes on ambiguous retries) ----

test('newRequestId returns a UUID string', () => {
  assert.match(newRequestId(), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});

test('newRequestId generates distinct ids across calls', () => {
  assert.notEqual(newRequestId(), newRequestId());
});

test('retryWithStableId reuses the SAME requestId across failed attempts', async () => {
  const seen = [];
  let attempt = 0;
  const result = await retryWithStableId(async (requestId) => {
    seen.push(requestId);
    attempt += 1;
    if (attempt < 3) throw new Error('ambiguous network failure');
    return 'ok';
  }, { retries: 3, delayMs: 0 });
  assert.equal(result, 'ok');
  assert.equal(seen.length, 3);
  assert.equal(new Set(seen).size, 1, 'requestId must be stable across retries');
  assert.match(seen[0], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});

test('retryWithStableId throws after exhausting retries', async () => {
  let calls = 0;
  await assert.rejects(
    () => retryWithStableId(async () => { calls += 1; throw new Error('down'); }, { retries: 2, delayMs: 0 }),
    /down/,
  );
  assert.equal(calls, 2);
});

test('retryPersistedWrite retains an id across failed user attempts and clears it on success', async () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, val) => values.set(key, val),
    removeItem: key => values.delete(key),
  };
  const seen = [];
  const attempt = async id => { seen.push(id); throw new Error('ambiguous'); };
  await assert.rejects(() => retryPersistedWrite('add:1:pizza', attempt, storage), /ambiguous/);
  await retryPersistedWrite('add:1:pizza', id => { seen.push(id); return Promise.resolve('ok'); }, storage);
  assert.equal(new Set(seen).size, 1);
  assert.equal(values.size, 0);
});

// ---- Server order mapping ----

test('mapServerOrder normalizes wire fields and falls back guestName to tableLabel', () => {
  const raw = {
    id: 'abc-123',
    tableId: 3,
    tableLabel: 'طاولة 3',
    source: 'guest',
    items: [{ id: 'm1', name: 'شاورما', price: 1990, quantity: 2, source: 'guest' }],
    total: 3980,
    status: 'pending',
    createdAt: '2024-05-03T10:00:00.000Z',
  };
  const order = mapServerOrder(raw);
  assert.equal(order.id, 'abc-123');
  assert.equal(order.guestName, 'طاولة 3');
  assert.equal(order.total, 3980);
  assert.equal(order.items.length, 1);
  assert.equal(order.status, 'pending');
  assert.equal(order.tableId, 3);
});

test('mapServerOrder passes explicit guestName through and preserves paid metadata', () => {
  const order = mapServerOrder({
    id: 'x',
    tableLabel: 'كاشير',
    guestName: 'أحمد',
    source: 'cashier',
    items: [],
    total: 5000,
    status: 'paid',
    createdAt: '2024-05-03T10:00:00.000Z',
    paidAt: '2024-05-03T12:00:00.000Z',
    paymentMethod: 'pix',
  });
  assert.equal(order.guestName, 'أحمد');
  assert.equal(order.source, 'cashier');
  assert.equal(order.paidAt, '2024-05-03T12:00:00.000Z');
  assert.equal(order.paymentMethod, 'pix');
});

test('mapServerOrder rejects rows without an id', () => {
  assert.throws(() => mapServerOrder({ items: [] }), /id/);
});

// ---- Status gating ----

test('canApprove is true only for pending orders', () => {
  assert.equal(canApprove({ status: 'pending' }), true);
  for (const s of ['accepted', 'rejected', 'paid']) {
    assert.equal(canApprove({ status: s }), false);
  }
});

test('canAddItems is true only for accepted (open/unpaid) orders', () => {
  assert.equal(canAddItems({ status: 'accepted' }), true);
  for (const s of ['pending', 'rejected', 'paid']) {
    assert.equal(canAddItems({ status: s }), false);
  }
});

test('canCheckout is true only for accepted orders', () => {
  assert.equal(canCheckout({ status: 'accepted' }), true);
  for (const s of ['pending', 'rejected', 'paid']) {
    assert.equal(canCheckout({ status: s }), false);
  }
});

test('isPaid detects paid orders', () => {
  assert.equal(isPaid({ status: 'paid' }), true);
  assert.equal(isPaid({ status: 'accepted' }), false);
});

// ---- Queue split: order-card queue buckets ----

test('splitOrders buckets orders into pending/accepted/paid/rejected', () => {
  const orders = [
    { id: '1', status: 'pending' },
    { id: '2', status: 'accepted' },
    { id: '3', status: 'paid' },
    { id: '4', status: 'rejected' },
    { id: '5', status: 'accepted' },
  ].map(mapServerOrder);
  const buckets = splitOrders(orders);
  assert.deepEqual(buckets.pending.map((o) => o.id), ['1']);
  assert.deepEqual(buckets.accepted.map((o) => o.id), ['2', '5']);
  assert.deepEqual(buckets.paid.map((o) => o.id), ['3']);
  assert.deepEqual(buckets.rejected.map((o) => o.id), ['4']);
});

// ---- Paid orders -> read-only reporting without duplicates ----

test('paidOrderToLegacy maps a paid server order onto the local reporting shape', () => {
  const legacy = paidOrderToLegacy(mapServerOrder({
    id: 'srv-1',
    tableLabel: 'طاولة 2',
    guestName: 'سارة',
    source: 'guest',
    items: [{ id: 'm1', name: 'عصير', price: 1000, quantity: 3, source: 'guest' }],
    total: 3000,
    notes: 'بدون سكر',
    status: 'paid',
    createdAt: '2024-05-03T10:00:00.000Z',
    paidAt: '2024-05-03T12:34:00',
    paymentMethod: 'cash',
  }));
  assert.equal(legacy.id, 'srv-1');
  assert.equal(legacy.total, 30, 'reporting uses BRL while server uses integer cents');
  assert.equal(legacy.items[0].price, 10, 'line prices must also convert to BRL');
  assert.equal(legacy.paymentMethod, 'cash');
  assert.equal(legacy.status, 'completed');
  assert.equal(legacy.needsDelivery, false);
  assert.equal(legacy.dateOnly, '03/05/2024');
  assert.equal(legacy.items[0].name, 'عصير');
  assert.equal(legacy.items[0].quantity, 3);
  assert.equal(legacy.notes, 'بدون سكر');
  assert.equal(legacy.serverOrderId, 'srv-1');
});

test('combineForReporting includes legacy sales plus paid server orders only', () => {
  const legacy = [{ id: 1, total: 5000, dateOnly: '03/05/2024', status: 'completed', items: [], paymentMethod: 'cash', orderSource: 'local', orderType: 'takeaway', needsDelivery: false, notes: '', date: 'x' }];
  const server = [
    { id: 's1', status: 'paid', total: 2000, paidAt: '2024-05-03T12:00:00', items: [], paymentMethod: 'pix' },
    { id: 's2', status: 'pending', total: 999, items: [] },
    { id: 's3', status: 'accepted', total: 888, items: [] },
    { id: 's4', status: 'rejected', total: 777, items: [] },
  ].map(mapServerOrder);
  const combined = combineForReporting(legacy, server);
  const ids = combined.map((o) => String(o.id));
  assert.ok(ids.includes('1'));
  assert.ok(ids.includes('s1'), 'paid server order must appear in reporting');
  assert.ok(!ids.includes('s2') && !ids.includes('s3') && !ids.includes('s4'), 'unpaid server orders must not count as sales');
  assert.equal(combined.length, 2, 'no duplicate rows');
  assert.equal(combined.reduce((sum, row) => sum + row.total, 0), 5020, 'BRL reporting must not multiply server cents');
});

test('combineForReporting drops legacy rows that already carry a matching serverOrderId (no double counting)', () => {
  const legacy = [
    { id: 1, serverOrderId: 's1', total: 2000, dateOnly: '03/05/2024', status: 'completed', items: [], paymentMethod: 'pix', orderSource: 'guest', orderType: 'qr', needsDelivery: false, notes: '', date: 'x' },
  ];
  const server = [{ id: 's1', status: 'paid', total: 2000, paidAt: '2024-05-03T12:00:00', items: [], paymentMethod: 'pix' }].map(mapServerOrder);
  const combined = combineForReporting(legacy, server);
  assert.equal(combined.length, 1, 'the same paid order must be counted exactly once');
  assert.equal(String(combined[0].id), '1');
});

test('combineForReporting does not mutate its inputs', () => {
  const legacy = [{ id: 1, total: 5000, status: 'completed', items: [] }];
  const server = [{ id: 's1', status: 'paid', total: 2000, paidAt: '2024-05-03T12:00:00', items: [] }].map(mapServerOrder);
  const legacyCopy = JSON.parse(JSON.stringify(legacy));
  combineForReporting(legacy, server);
  assert.deepEqual(legacy, legacyCopy);
});

test('payment method list matches the server contract', () => {
  assert.deepEqual([...PAYMENT_METHODS], ['cash', 'pix', 'cartao', 'ifood_card']);
});
