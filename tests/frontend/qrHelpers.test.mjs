import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toPublishedItems,
  guestCartTotal,
  guestUrl,
  describeOrderStatus,
  canActOnOrder,
  mergeOrders,
} from '../../utils/qr/helpers.ts';

test('toPublishedItems maps local menu to published snapshot with only contract fields (string id, cents)', () => {
  const local = [
    {
      id: 1,
      name: 'شاورما',
      price: 25,
      image: 'data:image/png;base64,xxx',
      category: 'Shawarma',
      description: 'لذيذ',
      isFavorite: true,
      order: 3,
    },
  ];
  const out = toPublishedItems(local);
  assert.deepEqual(out, [
    { id: '1', name: 'شاورما', price: 2500, category: 'Shawarma', description: 'لذيذ' },
  ]);
});

test('toPublishedItems keeps snapshot identical to source menu values (no discounts applied)', () => {
  const local = [{ id: 2, name: 'عصير', price: 10, image: '', category: 'Bebidas' }];
  const out = toPublishedItems(local);
  assert.equal(out[0].price, 1000);
  assert.equal(out[0].image, undefined);
});

test('guestCartTotal sums price * quantity (cents)', () => {
  assert.equal(guestCartTotal([]), 0);
  assert.equal(
    guestCartTotal([
      { id: '1', price: 2500, quantity: 2 },
      { id: '2', price: 1000, quantity: 1 },
    ]),
    6000,
  );
});

test('guestUrl builds origin/q/token without leaking or altering token', () => {
  assert.equal(guestUrl('http://localhost:3000', 'tok-1'), 'http://localhost:3000/q/tok-1');
  assert.equal(guestUrl('http://restaurant.example.test:3000/', '/tok 2/'), 'http://restaurant.example.test:3000/q/tok-2');
});

test('describeOrderStatus returns Arabic labels and unknown-safe value', () => {
  assert.equal(describeOrderStatus('pending'), 'بانتظار الموافقة');
  assert.equal(describeOrderStatus('accepted'), 'مقبول');
  assert.equal(describeOrderStatus('rejected'), 'مرفوض');
  assert.equal(describeOrderStatus('weird'), 'weird');
});

test('canActOnOrder allows accept/reject only while pending', () => {
  assert.equal(canActOnOrder({ status: 'pending' }), true);
  assert.equal(canActOnOrder({ status: 'accepted' }), false);
  assert.equal(canActOnOrder({ status: 'rejected' }), false);
});

test('mergeOrders replaces matching ids and keeps local unknown pending rows first', () => {
  const existing = [
    { id: 1, status: 'pending' },
    { id: 2, status: 'accepted' },
  ];
  const incoming = [
    { id: 2, status: 'rejected' },
    { id: 3, status: 'pending' },
  ];
  const merged = mergeOrders(existing, incoming);
  assert.deepEqual(
    merged.map((o) => [o.id, o.status]),
    [
      [1, 'pending'],
      [3, 'pending'],
      [2, 'rejected'],
    ],
  );
});
