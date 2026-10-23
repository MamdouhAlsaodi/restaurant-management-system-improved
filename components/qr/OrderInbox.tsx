import React, { useState } from 'react';
import {
  ServerOrder,
  canApprove,
  canAddItems,
  canCheckout,
  splitOrders,
} from '../../utils/qr/adminOrders';
import { formatBRL, describeOrderStatus, PublishedMenuItem } from '../../utils/qr/helpers';

export interface InboxTable {
  id: number | string;
  label: string;
  active: boolean;
}

export interface OrderInboxProps {
  orders: ServerOrder[];
  tables: InboxTable[];
  publishedMenu: PublishedMenuItem[];
  /** Error fetching the order list (auth/server). */
  loadError: string;
  /** Error from the last write action — always shown, never silent. */
  actionError: string;
  busyOrderId: string | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onApprove: (order: ServerOrder) => void;
  onReject: (order: ServerOrder) => void;
  onCreateManual: (guestName: string, tableId: number | null) => Promise<boolean>;
  /** Adds a PUBLISHED menu item to the selected accepted order (server prices). */
  onAddItems: (orderId: string, publishedItemId: string, quantity: number) => Promise<boolean> | boolean;
  onCheckout: (order: ServerOrder) => void;
}

const statusChipStyle = (status: string): React.CSSProperties => ({
  padding: '2px 10px',
  borderRadius: 999,
  fontSize: 13,
  background:
    status === 'accepted' ? '#d1fae5' :
    status === 'rejected' ? '#fee2e2' :
    status === 'paid' ? '#e0e7ff' : '#fef3c7',
  color:
    status === 'accepted' ? '#065f46' :
    status === 'rejected' ? '#991b1b' :
    status === 'paid' ? '#3730a3' : '#92400e',
});

const SOURCE_LABELS: Record<string, string> = { guest: 'ضيف QR', cashier: 'كاشير' };

/**
 * Order-card queue: the primary multi-order cart UX.
 * Every open order (pending with approve/reject, accepted open/unpaid) is its
 * own card; clicking a card reveals its items. Each order is checked out
 * separately — no automatic combining. Paid orders appear read-only.
 */
const OrderInbox = ({
  orders,
  tables,
  publishedMenu,
  loadError,
  actionError,
  busyOrderId,
  selectedId,
  onSelect,
  onApprove,
  onReject,
  onCreateManual,
  onAddItems,
  onCheckout,
}: OrderInboxProps) => {
  const [manualName, setManualName] = useState('');
  const [manualTable, setManualTable] = useState<string>('');
  const [addItemId, setAddItemId] = useState<string>('');
  const [addItemQty, setAddItemQty] = useState<number>(1);

  const { pending, accepted, paid, rejected } = splitOrders(orders);
  const selected = orders.find((o) => o.id === selectedId) ?? null;

  const submitManual = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = manualName.trim() || 'كاشير';
    const tableId = manualTable ? Number(manualTable) : null;
    const succeeded = await onCreateManual(name, tableId != null && !Number.isNaN(tableId) ? tableId : null);
    if (succeeded) {
      setManualName('');
      setManualTable('');
    }
  };

  const renderCard = (order: ServerOrder) => {
    const isSelected = order.id === selectedId;
    const busy = busyOrderId === order.id;
    return (
      <div
        key={order.id}
        style={{
          border: isSelected ? '2px solid #2563eb' : '1px solid #ddd',
          borderRadius: 12,
          padding: 12,
          background: isSelected ? '#f8fafc' : '#fff',
          cursor: 'pointer',
        }}
        onClick={() => onSelect(isSelected ? null : order.id)}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
          <strong>
            {order.guestName}
            {order.tableLabel ? ` — ${order.tableLabel}` : ''}
          </strong>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, color: '#6b7280' }}>{SOURCE_LABELS[order.source] ?? order.source}</span>
            <span style={statusChipStyle(order.status)}>{describeOrderStatus(order.status)}</span>
          </span>
        </div>
        <div style={{ color: '#6b7280', fontSize: 13, marginTop: 4 }}>
          {order.createdAt ? new Date(order.createdAt).toLocaleString('ar') : ''} · الإجمالي: {formatBRL(order.total)}
          {order.status === 'paid' && order.paymentMethod ? ` · ${order.paymentMethod}` : ''}
        </div>

        {/* Selected card reveals its own items */}
        {isSelected && (
          <div style={{ marginTop: 10 }} onClick={(e) => e.stopPropagation()}>
            <ul style={{ margin: '0 0 8px', paddingRight: 18, listStyle: 'disc' }}>
              {order.items.map((item, idx) => (
                <li key={`${item.id}-${idx}`}>
                  {item.name} × {item.quantity} — {formatBRL(item.price * item.quantity)}
                </li>
              ))}
              {order.items.length === 0 && <li style={{ listStyle: 'none', color: '#6b7280' }}>لا توجد أصناف بعد.</li>}
            </ul>
            {order.notes && <div style={{ color: '#6b7280', fontSize: 14 }}>ملاحظات: {order.notes}</div>}

            {canApprove(order) && (
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button
                  onClick={() => onApprove(order)}
                  disabled={busy || busyOrderId !== null}
                  style={{ padding: '6px 14px', borderRadius: 8, border: 'none', background: '#059669', color: '#fff', fontWeight: 700, opacity: busy ? 0.5 : 1 }}
                >
                  {busy ? 'جارٍ التنفيذ…' : 'قبول'}
                </button>
                <button
                  onClick={() => onReject(order)}
                  disabled={busy || busyOrderId !== null}
                  style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid #b91c1c', background: 'transparent', color: '#b91c1c' }}
                >
                  رفض
                </button>
              </div>
            )}

            {canAddItems(order) && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10, alignItems: 'center' }}>
                <span style={{ fontSize: 13, color: '#374151' }}>إضافة صنف (من القائمة المنشورة):</span>
                <select
                  value={addItemId}
                  onChange={(e) => setAddItemId(e.target.value)}
                  style={{ padding: 6, borderRadius: 8, border: '1px solid #ccc', maxWidth: 220 }}
                >
                  <option value="">اختر صنفاً…</option>
                  {publishedMenu.map((mi) => (
                    <option key={mi.id} value={mi.id}>
                      {mi.name} — {formatBRL(mi.price)}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min={1}
                  value={addItemQty}
                  onChange={(e) => setAddItemQty(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                  style={{ width: 64, padding: 6, borderRadius: 8, border: '1px solid #ccc' }}
                />
                <button
                  onClick={async () => {
                    if (addItemId) {
                      const succeeded = await onAddItems(order.id, addItemId, addItemQty);
                      if (succeeded) {
                        setAddItemId('');
                        setAddItemQty(1);
                      }
                    }
                  }}
                  disabled={busy || busyOrderId !== null || !addItemId}
                  style={{ padding: '6px 14px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', fontWeight: 700, opacity: busy || !addItemId ? 0.5 : 1 }}
                >
                  إضافة إلى الطلب المحدد
                </button>
                {publishedMenu.length === 0 && (
                  <span style={{ fontSize: 12, color: '#b45309' }}>انشر القائمة أولاً من تبويب QR.</span>
                )}
              </div>
            )}

            {canCheckout(order) && (
              <button
                onClick={() => onCheckout(order)}
                disabled={busy || busyOrderId !== null}
                style={{ marginTop: 10, padding: '8px 16px', borderRadius: 8, border: 'none', background: '#16a34a', color: '#fff', fontWeight: 700, opacity: busy ? 0.5 : 1 }}
              >
                💵 تحصيل (Checkout) — {formatBRL(order.total)}
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div dir="rtl" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Manual order creation */}
      <section style={{ border: '1px solid #ddd', borderRadius: 12, padding: 12 }}>
        <h3 style={{ marginTop: 0 }}>إنشاء طلب كاشير جديد</h3>
        <form onSubmit={submitManual} style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <input
            value={manualName}
            onChange={(e) => setManualName(e.target.value)}
            placeholder="اسم العميل (افتراضي: كاشير)"
            maxLength={80}
            style={{ padding: 8, borderRadius: 8, border: '1px solid #ccc', width: 200 }}
          />
          <select
            value={manualTable}
            onChange={(e) => setManualTable(e.target.value)}
            style={{ padding: 8, borderRadius: 8, border: '1px solid #ccc' }}
          >
            <option value="">بدون طاولة (كاشير)</option>
            {tables.filter((t) => t.active !== false).map((t) => (
              <option key={t.id} value={String(t.id)}>{t.label}</option>
            ))}
          </select>
          <button
            type="submit"
            disabled={busyOrderId !== null}
            style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#111827', color: '#fff', fontWeight: 700, opacity: busyOrderId !== null ? 0.5 : 1 }}
          >
            إنشاء طلب فارغ
          </button>
        </form>
      </section>

      {loadError && <p style={{ color: '#b91c1c' }}>⚠️ خطأ في جلب الطلبات: {loadError}</p>}
      {actionError && <p style={{ color: '#b91c1c' }}>⚠️ {actionError}</p>}

      {/* Open queue: pending + accepted cards */}
      <section>
        <h3>الطلبات المفتوحة ({pending.length + accepted.length})</h3>
        {pending.length === 0 && accepted.length === 0 && <p style={{ color: '#6b7280' }}>لا توجد طلبات مفتوحة.</p>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[...pending, ...accepted].map(renderCard)}
        </div>
      </section>

      {/* Paid: read-only history from the server */}
      {paid.length > 0 && (
        <section>
          <h3>الطلبات المدفوعة ({paid.length}) — للقراءة فقط</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {paid.map(renderCard)}
          </div>
        </section>
      )}

      {rejected.length > 0 && (
        <section>
          <h3>الطلبات المرفوضة ({rejected.length})</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, opacity: 0.7 }}>
            {rejected.map(renderCard)}
          </div>
        </section>
      )}

      {selected && !canApprove(selected) && !canAddItems(selected) && !canCheckout(selected) && (
        <p style={{ color: '#6b7280', fontSize: 13 }}>
          الطلبات المدفوعة والمرفوضة ثابتة: لا يمكن تعديلها أو إعادة تحصيلها.
        </p>
      )}
    </div>
  );
};

export default OrderInbox;
