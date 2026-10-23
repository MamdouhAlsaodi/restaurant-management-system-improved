import { test } from 'node:test';
import assert from 'node:assert/strict';

import { submitGuestOrder } from '../../utils/qr/guestOrder.ts';

const base = {
  token: 'tok-1',
  guestName: 'أحمد',
  items: [{ id: '5', quantity: 2 }],
  notes: 'بدون بصل',
  requestId: '11111111-2222-3333-4444-555555555555',
  attempts: 3,
};

test('posts to guest order endpoint with requestId and returns order on 201', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push([url, JSON.parse(opts.body)]);
    return { ok: true, status: 201, json: async () => ({ order: { id: '9', status: 'pending' } }) };
  };
  const order = await submitGuestOrder({ ...base, fetchImpl });
  assert.equal(order.id, '9');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/guest/tok-1/orders');
  assert.equal(calls[0][1].requestId, base.requestId);
  assert.deepEqual(calls[0][1].items, base.items);
});

test('retries with the SAME requestId when network fails, then succeeds', async () => {
  let n = 0;
  const requestIds = [];
  const fetchImpl = async (url, opts) => {
    n += 1;
    requestIds.push(JSON.parse(opts.body).requestId);
    if (n < 3) {
      const e = new TypeError('network down');
      throw e;
    }
    return { ok: true, status: 201, json: async () => ({ order: { id: '1', status: 'pending' } }) };
  };
  const order = await submitGuestOrder({ ...base, fetchImpl });
  assert.equal(order.id, '1');
  assert.equal(n, 3);
  assert.deepEqual(requestIds, [base.requestId, base.requestId, base.requestId]);
});

test('does NOT retry on 4xx and surfaces API error message', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    return { ok: false, status: 400, json: async () => ({ error: 'صيغة الطلب غير صحيحة' }) };
  };
  await assert.rejects(
    submitGuestOrder({ ...base, fetchImpl }),
    /صيغة الطلب غير صحيحة/,
  );
  assert.equal(n, 1);
});

test('throws generic Arabic error when response lost after all retries', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(submitGuestOrder({ ...base, fetchImpl }), /تعذر إرسال الطلب/);
});

test('server 5xx is ambiguous so the request snapshot must remain frozen', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({ error: 'Internal error' }) });
  await assert.rejects(submitGuestOrder({ ...base, fetchImpl }), (error) => {
    assert.equal(error.ambiguous, true);
    assert.equal(error.status, 500);
    return true;
  });
});

test('success without a usable order is ambiguous rather than a fresh request', async () => {
  const fetchImpl = async () => ({ ok: true, status: 201, json: async () => ({}) });
  await assert.rejects(submitGuestOrder({ ...base, fetchImpl }), (error) => {
    assert.equal(error.ambiguous, true);
    return true;
  });
});

test('accepts duplicate (200) response and returns the same order', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    return { ok: true, status: 200, json: async () => ({ order: { id: '7', status: 'pending' } }) };
  };
  const order = await submitGuestOrder({ ...base, fetchImpl });
  assert.equal(order.id, '7');
  assert.equal(n, 1);
});
