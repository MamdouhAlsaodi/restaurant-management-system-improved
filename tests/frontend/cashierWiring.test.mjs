import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');
const menu = readFileSync(new URL('../../components/views/MenuView.tsx', import.meta.url), 'utf8');

test('primary cart opens the independent order queue, not the legacy product cart', () => {
  assert.ok(/onClick=\{\(\) => setView\('orders'\)\}/.test(app));
  assert.ok(/سلة محلية/.test(app), 'legacy cart is still accessible by an explicit secondary action');
});

test('server checkout modal is mounted from its own selected order state', () => {
  assert.ok(/\{checkoutServerOrder && \(/.test(app));
  assert.ok(!/\{showCheckout && checkoutServerOrder && \(/.test(app));
});

test('menu does not send items to a local cart if a server order is selected but pending or paid', () => {
  assert.ok(/serverTarget && !serverMode/.test(menu));
  assert.ok(/disabled=\{!!serverTarget && !serverMode\}/.test(menu));
});
