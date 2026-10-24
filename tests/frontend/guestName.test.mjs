import { test } from 'node:test';
import assert from 'node:assert/strict';

import { submitGuestOrder, validateGuestName } from '../../utils/qr/guestOrder.ts';

const base = {
  token: 'tok-1',
  guestName: 'أحمد',
  items: [{ id: '5', quantity: 2 }],
  requestId: '11111111-2222-3333-4444-555555555555',
  attempts: 3,
};

// ---- validateGuestName: required, nonempty, <=80 (client-side guard) ----

test('validateGuestName accepts a normal name and trims it', () => {
  assert.equal(validateGuestName('  أحمد  '), 'أحمد');
});

test('validateGuestName rejects empty/whitespace/missing names', () => {
  for (const bad of ['', '   ', undefined, null, 42]) {
    assert.throws(() => validateGuestName(bad), /الاسم/, `should reject ${String(bad)}`);
  }
});

test('validateGuestName rejects names over 80 characters', () => {
  assert.throws(() => validateGuestName('ا'.repeat(81)), /80/);
  assert.equal(validateGuestName('ا'.repeat(80)), 'ا'.repeat(80));
});

// ---- guestName travels verbatim in the frozen retry snapshot ----

test('includes guestName verbatim in the POST body', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return { ok: true, status: 201, json: async () => ({ order: { id: '9', status: 'pending' } }) };
  };
  await submitGuestOrder({ ...base, fetchImpl });
  assert.equal(calls[0].guestName, 'أحمد');
});

test('retries reuse the SAME requestId and identical guestName/items snapshot', async () => {
  const bodies = [];
  let n = 0;
  const fetchImpl = async (url, opts) => {
    n += 1;
    bodies.push(opts.body);
    if (n < 3) throw new TypeError('network down');
    return { ok: true, status: 201, json: async () => ({ order: { id: '1', status: 'pending' } }) };
  };
  await submitGuestOrder({ ...base, fetchImpl });
  assert.equal(n, 3);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(bodies[1], bodies[2]);
  assert.equal(JSON.parse(bodies[0]).guestName, 'أحمد');
});

test('missing guestName fails fast without any network call', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 201, json: async () => ({ order: { id: '1' } }) };
  };
  await assert.rejects(submitGuestOrder({ ...base, guestName: '  ', fetchImpl }), /الاسم/);
  assert.equal(calls, 0);
});

test('guestName is NOT leaked as undefined key when absent notes', async () => {
  const bodies = [];
  const fetchImpl = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true, status: 201, json: async () => ({ order: { id: '2' } }) };
  };
  await submitGuestOrder({ ...base, fetchImpl });
  assert.equal('notes' in bodies[0], false);
  assert.equal(typeof bodies[0].guestName, 'string');
});
