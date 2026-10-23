/**
 * Pure per-order paid-receipt helpers (no DOM access here, so node:test can
 * exercise them directly). The popup wrapper lives at the bottom and is only
 * invoked from the browser.
 *
 * Rules:
 * - Only PAID orders get a receipt (pending/accepted/rejected are refused).
 * - One receipt per order: no merging of same-table people.
 * - Amounts are integer cents formatted as BRL; no tax, service or fiscal
 *   charges are invented. Receipt is explicitly labeled "não fiscal".
 */
import { formatBRL } from './helpers.ts';

export interface ReceiptLine {
  name: string;
  quantity: number;
  unitCents: number;
  subtotalCents: number;
}

export interface ReceiptData {
  id: string;
  guestName: string;
  tableLabel: string;
  items: ReceiptLine[];
  totalCents: number;
  notes: string;
  paidAt?: string;
  paymentMethod?: string;
}

/** Escapes every untrusted string (names, notes, ids, table labels) for HTML. */
export const escapeHtml = (value: string): string =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const RECEIPT_POPUP_BLOCKED_MESSAGE =
  '⚠️ تم منع فتح نافذة الإيصال من قبل المتصفح — اسمح بالنوافذ المنبثقة لهذا الموقع ثم حاول مجدداً.';

const PAYMENT_LABELS: Record<string, string> = {
  cash: 'نقداً (Dinheiro)',
  pix: 'PIX',
  cartao: 'بطاقة (Cartão)',
  ifood_card: 'iFood Card',
};

const buildReceiptData = (order: {
  id: string;
  guestName: string;
  tableLabel?: string;
  items: { name: string; price: number; quantity: number }[];
  total: number;
  notes?: string;
  paidAt?: string;
  paymentMethod?: string;
  status: string;
}): ReceiptData => {
  if (order.status !== 'paid') {
    throw new Error('الإيصال متاح فقط للطلبات المدفوعة (status must be "paid")');
  }
  const items: ReceiptLine[] = order.items.map((item) => ({
    name: item.name,
    quantity: item.quantity,
    unitCents: item.price,
    subtotalCents: item.price * item.quantity,
  }));
  const itemsTotal = items.reduce((sum, i) => sum + i.subtotalCents, 0);
  // Trust the recomputed per-line total in integer cents (never invent charges).
  return {
    id: order.id,
    guestName: order.guestName,
    tableLabel: order.tableLabel ?? '',
    items,
    totalCents: itemsTotal || order.total,
    notes: order.notes ?? '',
    paidAt: order.paidAt,
    paymentMethod: order.paymentMethod,
  };
};

const renderReceiptHtml = (data: ReceiptData): string => {
  const id = escapeHtml(data.id);
  const name = escapeHtml(data.guestName);
  const table = data.tableLabel ? ` — ${escapeHtml(data.tableLabel)}` : '';
  const notes = data.notes ? `<div class="notes">ملاحظات: ${escapeHtml(data.notes)}</div>` : '';
  const payment = data.paymentMethod
    ? `<div class="meta">طريقة الدفع: <strong>${escapeHtml(PAYMENT_LABELS[data.paymentMethod] ?? data.paymentMethod)}</strong></div>`
    : '';
  const paidDate = data.paidAt
    ? `<div class="meta">تاريخ الدفع: ${escapeHtml(new Date(data.paidAt).toLocaleString('pt-BR'))}</div>`
    : '';
  const lines = data.items
    .map(
      (item) => `<tr>
  <td>${escapeHtml(item.name)}</td>
  <td class="num">${item.quantity}</td>
  <td class="num">${formatBRL(item.unitCents)}</td>
  <td class="num">${formatBRL(item.subtotalCents)}</td>
</tr>`,
    )
    .join('\n');
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<title>إيصال طلب ${id}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; color: #111; }
  h1 { font-size: 18px; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; }
  th, td { border-bottom: 1px solid #ddd; padding: 6px 4px; text-align: right; }
  .num { text-align: left; direction: ltr; }
  .total { font-size: 16px; font-weight: 700; }
  .meta { font-size: 13px; color: #374151; }
  .notes { font-size: 13px; color: #374151; margin: 8px 0; }
  .nonfiscal { font-size: 12px; color: #6b7280; margin-top: 16px; }
  @media print { .no-print { display: none; } }
</style>
</head>
<body>
<h1>إيصال طلب — ${id}</h1>
<div class="meta">العميل: ${name}${table}</div>
${paidDate}
${payment}
<table>
  <thead>
    <tr><th>الصنف</th><th class="num">الكمية</th><th class="num">سعر الوحدة</th><th class="num">المجموع</th></tr>
  </thead>
  <tbody>
${lines}
  </tbody>
</table>
<div class="total">الإجمالي: ${formatBRL(data.totalCents)}</div>
${notes}
<p class="nonfiscal">هذا الإيصال ليس مستنداً ضريبياً (não é documento fiscal).</p>
<button type="button" class="no-print" id="print-receipt">طباعة / حفظ PDF</button>
</body>
</html>`;
};

/**
 * Opens the printable receipt in a popup (browser print dialog => Save as PDF).
 * Returns false (and the caller shows RECEIPT_POPUP_BLOCKED_MESSAGE) when the
 * browser blocks the popup, so it never fails silently.
 */
const openReceiptPrintPopup = (data: ReceiptData, win: Window = window): Window | null => {
  const popup = win.open('', '_blank', 'width=420,height=640');
  if (!popup) return null;
  popup.document.write(renderReceiptHtml(data));
  popup.document.close();
  // Event handlers in HTML attributes are blocked by the server's CSP.
  popup.document.getElementById('print-receipt')?.addEventListener('click', () => popup.print());
  popup.focus();
  return popup;
};

export { buildReceiptData, renderReceiptHtml, openReceiptPrintPopup };
