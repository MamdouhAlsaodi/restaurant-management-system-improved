import React, { useState } from 'react';
import {
  ServerOrder,
  PrepStatus,
  kitchenOrders,
  canSetPreparation,
  nextPrepStatus,
} from '../../utils/qr/adminOrders';
import { formatBRL } from '../../utils/qr/helpers';

export interface KitchenPanelProps {
  orders: ServerOrder[];
  /** Error from the last preparation write — always shown, never silent. */
  actionError: string;
  busyOrderId: string | null;
  onSetPreparation: (order: ServerOrder, next: PrepStatus) => void;
}

const PREP_LABELS: Record<PrepStatus, string> = {
  waiting: 'في الانتظار',
  preparing: 'قيد التحضير',
  ready: 'جاهز',
  served: 'تم التقديم',
};

const PREP_COLORS: Record<PrepStatus, { bg: string; color: string }> = {
  waiting: { bg: '#fef3c7', color: '#92400e' },
  preparing: { bg: '#dbeafe', color: '#1e40af' },
  ready: { bg: '#d1fae5', color: '#065f46' },
  served: { bg: '#e5e7eb', color: '#374151' },
};

/**
 * OPTIONAL kitchen subview inside the Orders tab (collapsed/off by default).
 * The cashier OrderInbox queue remains the primary UX; this panel only mirrors
 * accepted/paid orders that are not yet served and lets the staff advance the
 * persisted preparation state. It polls nothing by itself — it renders the
 * same 5s admin poll data the rest of the app uses, and reports errors.
 */
const KitchenPanel = ({ orders, actionError, busyOrderId, onSetPreparation }: KitchenPanelProps) => {
  const [expanded, setExpanded] = useState<boolean>(false);
  const kitchen = kitchenOrders(orders);

  return (
    <section style={{ marginTop: 24, border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', font: 'inherit', fontWeight: 'bold', color: '#374151', width: '100%', textAlign: 'start' }}
        aria-expanded={expanded}
      >
        {expanded ? '▾' : '▸'} شاشة المطبخ (اختيارية){kitchen.length > 0 ? ` — ${kitchen.length}` : ''}
      </button>

      {expanded && (
        <div style={{ marginTop: 12 }}>
          {actionError && (
            <p role="alert" style={{ color: '#b91c1c', margin: '0 0 8px' }}>{actionError}</p>
          )}
          {kitchen.length === 0 && (
            <p style={{ color: '#6b7280', margin: 0 }}>لا توجد طلبات قيد التحضير حالياً.</p>
          )}
          {kitchen.map((order) => {
            const next = nextPrepStatus(order.prepStatus);
            const prep = order.prepStatus as PrepStatus;
            const colors = PREP_COLORS[prep];
            return (
              <article key={order.id} style={{ border: '1px solid #f3f4f6', borderRadius: 8, padding: 10, marginBottom: 8 }}>
                <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <strong>
                    {order.guestName}
                    {order.tableLabel ? ` — ${order.tableLabel}` : ''}
                  </strong>
                  <span style={{ background: colors.bg, color: colors.color, borderRadius: 999, padding: '2px 10px', fontSize: 13 }}>
                    {PREP_LABELS[prep]}
                  </span>
                </header>
                <ul style={{ margin: '8px 0', paddingInlineStart: 18, color: '#374151' }}>
                  {order.items.map((it, i) => (
                    <li key={`${it.id}-${i}`}>{it.quantity} × {it.name}</li>
                  ))}
                </ul>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ color: '#6b7280', fontSize: 13 }}>
                    {formatBRL(order.total)} · {order.status === 'paid' ? 'مدفوع' : 'مقبول'}
                  </span>
                  {next && canSetPreparation(order) && (
                    <button
                      type="button"
                      disabled={busyOrderId === order.id}
                      onClick={() => onSetPreparation(order, next)}
                      style={{ background: '#f97316', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 14px', fontWeight: 'bold', cursor: busyOrderId === order.id ? 'wait' : 'pointer' }}
                    >
                      {busyOrderId === order.id ? '...' : `تسجيل: ${PREP_LABELS[next]}`}
                    </button>
                  )}
                </div>
                {order.notes && <p style={{ margin: '8px 0 0', color: '#92400e' }}>ملاحظات: {order.notes}</p>}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
};

export default KitchenPanel;
