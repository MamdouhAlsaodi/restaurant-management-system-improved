import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  isAlertableGuestOrder,
  detectNewGuestPendingOrders,
  ArrivalAlertCenter,
} from '../../utils/qr/arrivalAlerts.ts';

const mk = (id, status = 'pending', source = 'guest') => ({
  id,
  status,
  source,
  guestName: 'ضيف تجربة',
  tableLabel: `طاولة ${id}`,
});

// ---- Pure detection ----

test('baseline detection returns nothing when there are no orders', () => {
  assert.deepEqual(detectNewGuestPendingOrders([], new Set()), []);
});

test('detects only new guest pending orders, not manual cashier orders or other statuses', () => {
  const current = [
    mk('g1'),            // new guest pending -> alert
    mk('c1', 'pending', 'cashier'), // manual cashier -> never
    mk('g2', 'accepted'), // accepted -> never
    mk('g3', 'rejected'),
    mk('g4', 'paid'),
  ];
  const out = detectNewGuestPendingOrders(current, new Set());
  assert.deepEqual(out.map((o) => o.id), ['g1']);
});

test('dedupes: already-seen ids never alert again without mutating the baseline', () => {
  const current = [mk('g1'), mk('g2')];
  const seen = new Set(['g1']);
  assert.deepEqual(detectNewGuestPendingOrders(current, seen).map((o) => o.id), ['g2']);
  assert.deepEqual([...seen], ['g1']);
});

test('no reset false positives: an order that flips status and back, or reappears, is not re-alerted', () => {
  const seen = new Set(['g1']);
  assert.deepEqual(detectNewGuestPendingOrders([mk('g1', 'accepted')], seen), []);
  assert.deepEqual(detectNewGuestPendingOrders([mk('g1')], seen), []);
});

// ---- Center: opt-in, permission, notifications ----

class FakeNotifier {
  static permission = 'default';
  static requestPermissionCalls = 0;
  static async requestPermission() {
    FakeNotifier.requestPermissionCalls += 1;
    return FakeNotifier.permission;
  }
  constructor(title, options) {
    this.title = title;
    this.options = options;
    FakeNotifier.instances.push(this);
  }
}
FakeNotifier.instances = [];

test('center starts disabled and never asks for permission without a user gesture', () => {
  const center = new ArrivalAlertCenter(FakeNotifier);
  assert.equal(center.enabled, false);
  assert.equal(FakeNotifier.requestPermissionCalls, 0);
});

test('unsupported browsers: enable() fails gracefully, no throw, alerts stay in-app only', async () => {
  const center = new ArrivalAlertCenter(null);
  const result = await center.requestEnable();
  assert.equal(result.enabled, true);
  assert.equal(result.permission, 'unsupported');
  // in-app tracking still works
  const arrivals = center.processOrders([mk('g9')]);
  assert.deepEqual(arrivals.map((o) => o.id), ['g9']);
});

test('enable on first sight primes baseline: hydration orders never alert', () => {
  const center = new ArrivalAlertCenter(FakeNotifier);
  // Orders seen before enabling are the baseline.
  center.syncBaseline([mk('g1'), mk('g2')]);
  center.requestEnable();
  const arrivals = center.processOrders([mk('g1'), mk('g2')]);
  assert.deepEqual(arrivals, []);
});

test('granted permission enables OS notifications; denied keeps in-app only', async () => {
  FakeNotifier.permission = 'granted';
  const granted = new ArrivalAlertCenter(FakeNotifier);
  granted.syncBaseline([]);
  const ok = await granted.requestEnable();
  assert.equal(ok.enabled, true);
  assert.equal(ok.permission, 'granted');

  FakeNotifier.permission = 'denied';
  const denied = new ArrivalAlertCenter(FakeNotifier);
  denied.syncBaseline([]);
  const okDenied = await denied.requestEnable();
  assert.equal(okDenied.enabled, true);
  assert.equal(okDenied.permission, 'denied');
});

test('processOrders alerts each new guest pending order once and fires OS notification without personal data', async () => {
  FakeNotifier.permission = 'granted';
  const center = new ArrivalAlertCenter(FakeNotifier);
  await center.requestEnable();
  FakeNotifier.instances.length = 0;

  const arrivals = center.processOrders([mk('g1'), mk('g1'), mk('c1', 'pending', 'cashier')]);
  assert.deepEqual(arrivals.map((o) => o.id), ['g1']);
  assert.equal(FakeNotifier.instances.length, 1);
  const n = FakeNotifier.instances[0];
  assert.ok(!JSON.stringify(n.options ?? {}).includes('ضيف'), 'no guest personal data in OS notification');
  assert.ok(!n.title.includes('ضيف'), 'no guest personal data in title');
});

test('notification failures never throw out of processOrders (polling must keep running)', async () => {
  class BoomNotifier {
    static permission = 'granted';
    static async requestPermission() { return 'granted'; }
    constructor() { throw new Error('render failed'); }
  }
  const center = new ArrivalAlertCenter(BoomNotifier);
  await center.requestEnable();
  const arrivals = center.processOrders([mk('g1')]);
  assert.deepEqual(arrivals.map((o) => o.id), ['g1']);
});

test('disable stops alerting', () => {
  const center = new ArrivalAlertCenter(null);
  center.requestEnable();
  center.disable();
  assert.deepEqual(center.processOrders([mk('g1')]), []);
});

// ---- Wiring (source-level, same style as cashierWiring.test.mjs) ----

const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');
const inbox = readFileSync(new URL('../../components/qr/OrderInbox.tsx', import.meta.url), 'utf8');

test('App wires arrival alerts opt-in into the 5s polling path without blocking it', () => {
  assert.ok(/arrivalAlerts|ArrivalAlertCenter/.test(app), 'App uses the arrival alert helper');
  assert.ok(/processOrders\(/.test(app), 'App feeds polled orders into the alert center');
  assert.ok(/initialOrdersLoadedRef\.current[\s\S]*?syncBaseline\(mapped\)[\s\S]*?processOrders\(mapped\)/.test(app),
    'first successful fetch baselines old orders even when enabled before hydration');
  assert.ok(!/Notification\.requestPermission\(/.test(app), 'permission requested only via the helper from a click');
});

test('OrderInbox exposes an accessible opt-in toggle and new-arrival badge', () => {
  assert.ok(/aria-label/.test(inbox), 'toggle has an accessible label');
  assert.ok(/onToggleAlerts|alertsEnabled/.test(inbox), 'inbox renders the opt-in control');
});
