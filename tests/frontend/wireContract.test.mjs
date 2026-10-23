import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { toPublishedItems, formatBRL, guestCartTotal, mergeOrders } from '../../utils/qr/helpers.ts';
import { submitGuestOrder, GuestOrderSubmitError } from '../../utils/qr/guestOrder.ts';

// ---- Publish mapping: numeric local id -> STRING id, BRL price -> INTEGER CENTS ----

test('toPublishedItems converts numeric local id to string id', () => {
  const out = toPublishedItems([{ id: 42, name: 'شاورما', price: 19.9 }]);
  assert.equal(typeof out[0].id, 'string');
  assert.equal(out[0].id, '42');
});

test('toPublishedItems converts BRL price 19.90 to 1990 integer cents', () => {
  const out = toPublishedItems([{ id: 1, name: 'كوكا', price: 19.9 }]);
  assert.equal(out[0].price, 1990);
  assert.equal(Number.isInteger(out[0].price), true);
});

test('toPublishedItems handles classic cent rounding (2.675 -> 268)', () => {
  const out = toPublishedItems([{ id: 'a', name: 'بوكس', price: 2.675 }]);
  assert.equal(out[0].price, 268);
});

test('toPublishedItems throws on invalid local prices (zero, negative, NaN, Infinity)', () => {
  for (const bad of [0, -19.9, NaN, Infinity, '19.90']) {
    assert.throws(
      () => toPublishedItems([{ id: 1, name: 'صنف', price: bad }]),
      /سعر/,
      `should throw for ${String(bad)}`,
    );
  }
});

test('toPublishedItems keeps whole-BRL prices exact (25 -> 2500)', () => {
  const out = toPublishedItems([{ id: 7, name: 'طبق', price: 25 }]);
  assert.equal(out[0].price, 2500);
});

// ---- BRL formatting: API cents -> R$ via Intl pt-BR ----

test('formatBRL renders integer cents as R$ with pt-BR formatting', () => {
  assert.equal(formatBRL(1990), 'R$ 19,90');
  assert.equal(formatBRL(0), 'R$ 0,00');
  assert.equal(formatBRL(5), 'R$ 0,05');
  assert.equal(formatBRL(4480), 'R$ 44,80');
  assert.equal(formatBRL(123456), 'R$ 1.234,56');
});

test('guestCartTotal sums cents exactly for a real order (2×19.90 + 1×5.00)', () => {
  const total = guestCartTotal([
    { id: '1', price: 1990, quantity: 2 },
    { id: '2', price: 500, quantity: 1 },
  ]);
  assert.equal(total, 4480);
  assert.equal(formatBRL(total), 'R$ 44,80');
});

// ---- String ids everywhere on the guest/admin wire ----

test('mergeOrders merges and dedupes by STRING UUID order ids', () => {
  const uuidA = '9f1c3e22-6b0a-4b7e-9d0e-1a2b3c4d5e6f';
  const uuidB = 'aa1c3e22-6b0a-4b7e-9d0e-1a2b3c4d5e6f';
  const merged = mergeOrders(
    [
      { id: uuidA, status: 'pending' },
      { id: uuidB, status: 'accepted' },
    ],
    [{ id: uuidA, status: 'rejected' }],
  );
  assert.equal(merged.length, 2);
  assert.deepEqual(
    merged.filter((o) => o.id === uuidA).map((o) => o.status),
    ['rejected'],
  );
});

test('guest cart ids are strings on submission payload', async () => {
  let body = null;
  const fetchImpl = async (_url, opts) => {
    body = JSON.parse(opts.body);
    return { ok: true, status: 201, json: async () => ({ order: { id: 'uuid-order', status: 'pending' } }) };
  };
  const order = await submitGuestOrder({
    token: 'tok',
    guestName: 'أحمد',
    items: [{ id: '12', quantity: 3 }],
    requestId: '11111111-2222-3333-4444-555555555555',
    fetchImpl,
  });
  assert.equal(typeof body.items[0].id, 'string');
  assert.equal(typeof order.id, 'string');
});

// ---- requestId integrity across ambiguous vs definitive failures ----

test('after ambiguous network failure, retry reuses the EXACT same payload snapshot', async () => {
  const bodies = [];
  let n = 0;
  const fetchImpl = async (_url, opts) => {
    n += 1;
    bodies.push(opts.body);
    if (n === 1) throw new TypeError('fetch failed'); // ambiguous: response lost
    return { ok: true, status: 201, json: async () => ({ order: { id: 'o-1', status: 'pending' } }) };
  };
  const snapshot = {
    token: 'tok',
    guestName: 'أحمد',
    items: [
      { id: '1', quantity: 2 },
      { id: '3', quantity: 1 },
    ],
    notes: 'بدون بصل',
    requestId: 'abcdef00-1111-2222-3333-444455556666',
    fetchImpl,
  };
  await submitGuestOrder(snapshot);
  assert.equal(n, 2);
  // identical serialized payload across attempts: same requestId, quantities, notes
  assert.equal(bodies[0], bodies[1]);
});

test('definitive server 4xx raises a NON-ambiguous error (attempt may be released)', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: 'طلب غير صالح' }),
  });
  await assert.rejects(
    submitGuestOrder({
      token: 'tok',
      guestName: 'أحمد',
      items: [{ id: '1', quantity: 1 }],
      requestId: 'r-1',
      fetchImpl,
    }),
    (err) => err instanceof GuestOrderSubmitError && err.ambiguous === false && /طلب غير صالح/.test(err.message),
  );
});

test('lost response after all retries raises an AMBIGUOUS error', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(
    submitGuestOrder({
      token: 'tok',
      guestName: 'أحمد',
      items: [{ id: '1', quantity: 1 }],
      requestId: 'r-1',
      fetchImpl,
    }),
    (err) => err instanceof GuestOrderSubmitError && err.ambiguous === true,
  );
});

// ---- Currency: all three translations use R$, never Riyal ----
// translations.ts is outside this slice's allowed files, so it is checked by
// content scanning (each of ar/en/pt declares currency: 'R$').

test('all three translations define currency as R$ and never use Riyal', () => {
  const src = readFileSync(new URL('../../utils/translations.ts', import.meta.url), 'utf8');
  const count = (src.match(/currency:\s*'R\$'/g) || []).length;
  assert.equal(count, 3, `expected R$ in ar/en/pt, found ${count}`);
  assert.ok(!/[﷼]|ريال|SAR|Riyal/i.test(src), 'translations must never use Riyal');
});

// ---- Translations source never contains Riyal glyphs anywhere ----

test('translations source contains no Riyal/SAR glyphs', () => {
  const src = readFileSync(new URL('../../utils/translations.ts', import.meta.url), 'utf8');
  assert.ok(!/[﷼]|ريال|SAR|Riyal/i.test(src));
});
