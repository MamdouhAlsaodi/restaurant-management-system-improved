import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLegacyBackup, restoreLegacyBackup } from '../../utils/legacyBackup.ts';

const valid = () => ({
  version: '1.2',
  menuItems: [{ id: 1, name: 'Coffee', price: 8 }],
  completedOrders: [{ id: 2, items: [], total: 8, status: 'completed' }],
  settings: { language: 'ar', dailyMotorcycleCost: 0, perDeliveryCost: 0, showLimitedMenu: false },
  discounts: [],
  dailySalesRecords: {},
});

test('rejects malformed legacy backup without accepting a partial restore', () => {
  assert.throws(() => parseLegacyBackup(JSON.stringify({ ...valid(), completedOrders: 'oops' })), /completedOrders/);
  assert.throws(() => parseLegacyBackup(JSON.stringify({ ...valid(), menuItems: [{ id: 1 }] })), /menuItems/);
  assert.throws(() => parseLegacyBackup(JSON.stringify({ ...valid(), settings: null })), /settings/);
  assert.throws(() => parseLegacyBackup(JSON.stringify({ ...valid(), dailySalesRecords: [] })), /dailySalesRecords/);
});

test('restores each local dataset and never stores server payment rows by implication', () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  const parsed = parseLegacyBackup(JSON.stringify(valid()));
  restoreLegacyBackup(parsed, storage);
  assert.deepEqual(JSON.parse(values.get('restaurant-orders')), valid().completedOrders);
  assert.equal(values.has('restaurant-menu'), true);
  assert.equal(values.has('restaurant-settings'), true);
  assert.equal(values.has('restaurant-discounts'), true);
  assert.equal(values.has('restaurant-daily-sales'), true);
});

test('storage error rolls back already-written datasets', () => {
  const originals = new Map([
    ['restaurant-menu', '[{"id":99}]'], ['restaurant-orders', '[]'],
    ['restaurant-settings', '{}'], ['restaurant-discounts', '[]'],
  ]);
  const values = new Map(originals);
  let failed = false;
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => {
      if (key === 'restaurant-daily-sales' && !failed) { failed = true; throw new Error('quota'); }
      values.set(key, value);
    },
    removeItem: key => values.delete(key),
  };
  assert.throws(() => restoreLegacyBackup(parseLegacyBackup(JSON.stringify(valid())), storage), /quota/);
  assert.deepEqual(values, originals);
});
