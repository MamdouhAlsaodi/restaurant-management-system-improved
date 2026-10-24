import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  PREP_STATUSES,
  nextPrepStatus,
  canSetPreparation,
  kitchenOrders,
  mapServerOrder,
} from '../../utils/qr/adminOrders.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (p) => readFileSync(path.join(root, p), 'utf8');

// ---- Pure kitchen helpers ----

test('PREP_STATUSES and nextPrepStatus encode the strict sequence', () => {
  assert.deepEqual(PREP_STATUSES, ['waiting', 'preparing', 'ready', 'served']);
  assert.equal(nextPrepStatus('waiting'), 'preparing');
  assert.equal(nextPrepStatus('preparing'), 'ready');
  assert.equal(nextPrepStatus('ready'), 'served');
  assert.equal(nextPrepStatus('served'), null, 'served is terminal');
  assert.equal(nextPrepStatus(null), null);
  assert.equal(nextPrepStatus(undefined), null);
});

test('canSetPreparation only allows accepted/paid orders that are not served', () => {
  assert.equal(canSetPreparation({ status: 'accepted', prepStatus: 'waiting' }), true);
  assert.equal(canSetPreparation({ status: 'accepted', prepStatus: 'ready' }), true);
  assert.equal(canSetPreparation({ status: 'paid', prepStatus: 'preparing' }), true, 'payment must not break kitchen flow');
  assert.equal(canSetPreparation({ status: 'pending', prepStatus: null }), false);
  assert.equal(canSetPreparation({ status: 'rejected', prepStatus: null }), false);
  assert.equal(canSetPreparation({ status: 'accepted', prepStatus: 'served' }), false, 'served is terminal');
  assert.equal(canSetPreparation({ status: 'accepted' }), false, 'no kitchen state yet');
});

test('kitchenOrders lists only accepted/paid orders not yet served, order preserved', () => {
  const orders = [
    { id: 'a', status: 'pending', prepStatus: null },
    { id: 'b', status: 'accepted', prepStatus: 'waiting' },
    { id: 'c', status: 'paid', prepStatus: 'ready' },
    { id: 'd', status: 'accepted', prepStatus: 'served' },
    { id: 'e', status: 'rejected', prepStatus: null },
    { id: 'f', status: 'accepted' },
  ];
  assert.deepEqual(kitchenOrders(orders).map((o) => o.id), ['b', 'c']);
});

test('mapServerOrder falls back to waiting for legacy accepted rows lacking prep state', () => {
  const base = { id: 'x', tableLabel: 'T1', guestName: 'G', items: [], total: 0, notes: '', status: 'accepted', createdAt: '' };
  assert.equal(mapServerOrder({ ...base, prepStatus: 'preparing' }).prepStatus, 'preparing');
  assert.equal(mapServerOrder(base).prepStatus, 'waiting');
  assert.equal(mapServerOrder({ ...base, prepStatus: null }).prepStatus, 'waiting');
  assert.equal(mapServerOrder({ ...base, prepStatus: 'hacker' }).prepStatus, 'waiting');
  assert.equal(mapServerOrder({ ...base, status: 'pending' }).prepStatus, undefined);
});

// ---- UI wiring: optional kitchen subview inside the Orders tab ----

test('App renders KitchenPanel in the Orders tab after the primary cashier queue', () => {
  const app = read('./App.tsx');
  assert.ok(/import\s+KitchenPanel\s+from\s+'\.\/components\/qr\/KitchenPanel'/.test(app), 'App must import KitchenPanel');
  const inbox = app.indexOf('<OrderInbox');
  const kitchen = app.indexOf('<KitchenPanel');
  assert.ok(inbox !== -1, 'OrderInbox (cashier queue) stays primary');
  assert.ok(kitchen > inbox, 'KitchenPanel comes after OrderInbox');
});

test('KitchenPanel is collapsed by default (off by default)', () => {
  const src = read('./components/qr/KitchenPanel.tsx');
  assert.ok(/useState(<boolean>)?\(false\)/.test(src), 'expanded state must default to false');
  assert.ok(/kitchenOrders|canSetPreparation|nextPrepStatus/.test(src), 'uses the shared pure helpers');
});
