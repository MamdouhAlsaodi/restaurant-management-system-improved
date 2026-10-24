import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadPendingGuestAttempt, savePendingGuestAttempt, clearPendingGuestAttempt } from '../../utils/qr/guestAttempt.ts';

test('guest pending snapshot survives a simulated page reload, scoped to its table token', () => {
  const values = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
  };
  const attempt = { requestId: randomUUID(), guestName: 'ليلى', items: [{ id: 'meal', quantity: 2 }], notes: 'بدون ملح' };
  savePendingGuestAttempt('table-a', attempt);
  assert.deepEqual(loadPendingGuestAttempt('table-a'), attempt);
  assert.equal(loadPendingGuestAttempt('table-b'), null);
  clearPendingGuestAttempt('table-a');
  assert.equal(loadPendingGuestAttempt('table-a'), null);
});

test('damaged pending snapshot is never replayed', () => {
  globalThis.sessionStorage = { getItem: () => '{bad', setItem: () => {}, removeItem: () => {} };
  assert.equal(loadPendingGuestAttempt('a'), null);
});
