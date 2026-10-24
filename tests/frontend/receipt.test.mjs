import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReceiptData,
  escapeHtml,
  renderReceiptHtml,
  RECEIPT_POPUP_BLOCKED_MESSAGE,
  openReceiptPrintPopup,
} from '../../utils/qr/receipt.ts';

const paidOrder = {
  id: 'abc-123',
  tableId: 4,
  tableLabel: 'Mesa 4',
  guestName: 'فاطمة <b>X</b>',
  source: 'guest',
  items: [
    { id: 'i1', name: 'شاورما & "especial"', price: 2500, quantity: 2, source: 'guest' },
    { id: 'i2', name: 'Refri <img src=x>', price: 500, quantity: 1, source: 'cashier' },
  ],
  total: 5500,
  notes: 'Sem cebola <script>alert(1)</script>',
  status: 'paid',
  createdAt: '2024-05-01T12:00:00.000Z',
  paidAt: '2024-05-01T12:30:00.000Z',
  paymentMethod: 'pix',
};

test('buildReceiptData rejects non-paid orders (pending/accepted/rejected)', () => {
  for (const status of ['pending', 'accepted', 'rejected']) {
    assert.throws(() => buildReceiptData({ ...paidOrder, status }), /paid|مدفوع/i);
  }
});

test('buildReceiptData carries id, name, table, items, notes, total, paidAt, payment method', () => {
  const data = buildReceiptData(paidOrder);
  assert.equal(data.id, 'abc-123');
  assert.equal(data.guestName, 'فاطمة <b>X</b>');
  assert.equal(data.tableLabel, 'Mesa 4');
  assert.equal(data.totalCents, 5500);
  assert.equal(data.paidAt, '2024-05-01T12:30:00.000Z');
  assert.equal(data.paymentMethod, 'pix');
  assert.equal(data.notes, 'Sem cebola <script>alert(1)</script>');
  assert.equal(data.items.length, 2);
  assert.deepEqual(
    data.items.map((i) => [i.name, i.quantity, i.unitCents, i.subtotalCents]),
    [
      ['شاورما & "especial"', 2, 2500, 5000],
      ['Refri <img src=x>', 1, 500, 500],
    ],
  );
});

test('buildReceiptData recomputes line subtotals and total from items (integer cents, no invented charges)', () => {
  const data = buildReceiptData(paidOrder);
  assert.equal(data.items.reduce((s, i) => s + i.subtotalCents, 0), data.totalCents);
  assert.equal(data.taxCents, undefined);
  assert.equal(data.serviceCents, undefined);
});

test('renderReceiptHtml escapes ALL untrusted names, notes and order ids', () => {
  const html = renderReceiptHtml(buildReceiptData(paidOrder));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('<img src=x>'));
  assert.ok(!html.includes('<b>X</b>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('شاورما &amp; &quot;especial&quot;'));
  assert.ok(html.includes('abc-123'));
});

test('renderReceiptHtml is labeled non-fiscal and shows payment method + date, no tax lines', () => {
  const html = renderReceiptHtml(buildReceiptData(paidOrder));
  assert.match(html, /não (é|é) documento fiscal|Não (é|é) documento fiscal|não fiscal/i);
  assert.match(html, /pix/i);
  assert.match(html, /2024/);
  assert.ok(!/imposto|taxa de servi/i.test(html));
});

test('renderReceiptHtml formats totals as BRL from integer cents', () => {
  const html = renderReceiptHtml(buildReceiptData(paidOrder));
  assert.match(html, /55,00|5\.500|R\$ 55,00/);
});

test('popup print control works under CSP without inline event handlers', () => {
  const html = renderReceiptHtml(buildReceiptData(paidOrder));
  assert.ok(!/\bonclick\s*=/.test(html));
  let clicked;
  let prints = 0;
  const popup = {
    document: {
      write(markup) { assert.ok(markup.includes('print-receipt')); },
      close() {},
      getElementById(id) {
        assert.equal(id, 'print-receipt');
        return { addEventListener(type, callback) { assert.equal(type, 'click'); clicked = callback; } };
      },
    },
    focus() {},
    print() { prints++; },
  };
  assert.equal(openReceiptPrintPopup(buildReceiptData(paidOrder), { open: () => popup }), popup);
  clicked();
  assert.equal(prints, 1);
});

test('popup blocked message constant is a visible Arabic error', () => {
  assert.equal(typeof RECEIPT_POPUP_BLOCKED_MESSAGE, 'string');
  assert.match(RECEIPT_POPUP_BLOCKED_MESSAGE, /المتصفح|منع|حظر/);
});
