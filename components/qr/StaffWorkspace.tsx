import React, { useEffect, useRef, useState } from 'react';
import { apiFetch, SessionActor } from '../../utils/qr/api';
import {
  ServerOrder, PrepStatus, mapServerOrder, canAddItems, canApprove,
  canCheckout, canSetPreparation, retryPersistedWrite,
} from '../../utils/qr/adminOrders';
import { PublishedMenuItem } from '../../utils/qr/helpers';
import { ArrivalAlertCenter } from '../../utils/qr/arrivalAlerts';
import OrderInbox, { InboxTable } from './OrderInbox';
import KitchenPanel from './KitchenPanel';
import CheckoutModal from '../modals/CheckoutModal';

/** Staff never mounts the legacy POS App or reads its browser-local sales. */
const StaffWorkspace = ({ actor }: { actor: Extract<SessionActor, { kind: 'staff' }> }) => {
  const [orders, setOrders] = useState<ServerOrder[]>([]);
  const [tables, setTables] = useState<InboxTable[]>([]);
  const [menu, setMenu] = useState<PublishedMenuItem[]>([]);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checkoutOrder, setCheckoutOrder] = useState<ServerOrder | null>(null);
  const alerts = useRef(new ArrivalAlertCenter());
  const hydrated = useRef(false);
  const [alertsEnabled, setAlertsEnabled] = useState(false);
  const [newAlertIds, setNewAlertIds] = useState<string[]>([]);

  const refreshOrders = async () => {
    try {
      const result = await apiFetch<{ orders: any[] }>('/api/admin/orders');
      const mapped = (result.orders ?? []).map(mapServerOrder);
      setOrders(mapped);
      setLoadError('');
      if (actor.role === 'cashier') {
        if (!hydrated.current) {
          alerts.current.syncBaseline(mapped);
          hydrated.current = true;
        }
        const arrivals = alerts.current.processOrders(mapped);
        if (arrivals.length) setNewAlertIds((prior) => [...new Set([...prior, ...arrivals.map((o) => o.id)])]);
      }
    } catch (err: any) {
      setLoadError(err?.message ?? 'تعذر تحميل الطلبات');
    }
  };

  useEffect(() => {
    void refreshOrders();
    if (actor.role === 'cashier') {
      void apiFetch<{ tables: InboxTable[] }>('/api/admin/tables').then((r) => setTables(r.tables)).catch(() => {});
      void apiFetch<{ items: PublishedMenuItem[] }>('/api/admin/menu').then((r) => setMenu(r.items)).catch(() => {});
    }
    const timer = setInterval(() => void refreshOrders(), 5000);
    return () => clearInterval(timer);
  }, [actor.role]);

  const mergeOrder = (order: ServerOrder) => setOrders((prior) => [order, ...prior.filter((o) => o.id !== order.id)]);
  const withAction = async (order: ServerOrder | null, fn: () => Promise<void>): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusyId(order?.id ?? '__global__');
    setActionError('');
    try {
      await fn();
      return true;
    } catch (err: any) {
      setActionError(err?.message ?? 'تعذر تنفيذ العملية');
      return false;
    } finally {
      busyRef.current = false;
      setBusyId(null);
    }
  };

  const decide = (order: ServerOrder, action: 'accept' | 'reject') => withAction(order, async () => {
    if (!canApprove(order)) throw new Error('الطلب لم يعد معلقاً');
    const data = await apiFetch<{ order: any }>(`/api/admin/orders/${order.id}/${action}`, { method: 'POST' });
    mergeOrder(mapServerOrder(data.order));
  });

  const prepare = (order: ServerOrder, next: PrepStatus) => withAction(order, async () => {
    if (!canSetPreparation(order)) throw new Error('لا يمكن تحديث تجهيز هذا الطلب');
    const data = await apiFetch<{ order: any }>(`/api/admin/orders/${order.id}/preparation`, {
      method: 'POST', body: { status: next },
    });
    mergeOrder(mapServerOrder(data.order));
  });

  const create = (guestName: string, tableId: number | null) => withAction(null, async () => {
    const data = await retryPersistedWrite(`create:${JSON.stringify([guestName, tableId])}`, async (requestId) => {
      const reply = await apiFetch<{ order: any }>('/api/admin/orders', {
        method: 'POST', body: { requestId, guestName, tableId: tableId ?? undefined },
      });
      if (!reply?.order?.id) throw new Error('رد غير مكتمل من الخادم؛ أعد المحاولة');
      return reply;
    });
    mergeOrder(mapServerOrder(data.order));
    setSelectedId(data.order.id);
  });

  const addItems = (orderId: string, itemId: string, quantity: number) => {
    const order = orders.find((o) => o.id === orderId);
    if (!order || !canAddItems(order)) {
      setActionError('يمكن إضافة الأصناف إلى الطلب المقبول غير المدفوع فقط');
      return false;
    }
    return withAction(order, async () => {
      const data = await retryPersistedWrite(`add:${JSON.stringify([orderId, itemId, quantity])}`, async (requestId) => {
        const reply = await apiFetch<{ order: any }>(`/api/admin/orders/${orderId}/items`, {
          method: 'POST', body: { requestId, items: [{ id: itemId, quantity }] },
        });
        if (!reply?.order?.id) throw new Error('رد غير مكتمل من الخادم؛ أعد المحاولة');
        return reply;
      });
      mergeOrder(mapServerOrder(data.order));
    });
  };

  const checkout = async (order: ServerOrder, paymentMethod: string) => {
    if (busyRef.current || !canCheckout(order)) throw new Error('الطلب غير قابل للتحصيل الآن');
    const ok = await withAction(order, async () => {
      const data = await apiFetch<{ order: any }>(`/api/admin/orders/${order.id}/checkout`, {
        method: 'POST', body: { paymentMethod },
      });
      mergeOrder(mapServerOrder(data.order));
      setCheckoutOrder(null);
    });
    if (!ok) throw new Error('تعذر التحصيل؛ افحص الطلب ثم أعد المحاولة');
  };

  const toggleAlerts = () => {
    if (alertsEnabled) {
      alerts.current.disable();
      setAlertsEnabled(false);
      setNewAlertIds([]);
    } else {
      alerts.current.syncBaseline(orders);
      void alerts.current.requestEnable().then(() => setAlertsEnabled(true));
    }
  };

  return (
    <div dir="rtl" className="min-h-screen bg-gray-50 p-4">
      <header className="max-w-5xl mx-auto flex justify-between items-center mb-5">
        <h1 className="font-bold text-xl">{actor.role === 'kitchen' ? 'شاشة المطبخ' : 'طلبات الكاشير'}</h1>
        <button type="button" className="border rounded px-3 py-2" onClick={async () => {
          try { await apiFetch('/api/admin/logout', { method: 'POST' }); } finally { window.location.assign('/login'); }
        }}>خروج</button>
      </header>
      <main className="max-w-5xl mx-auto">
        {actor.role === 'kitchen' ? (
          <>
            {loadError && <p role="alert" className="text-red-700">{loadError}</p>}
            <KitchenPanel orders={orders} actionError={actionError} busyOrderId={busyId} onSetPreparation={prepare} defaultExpanded />
          </>
        ) : (
          <OrderInbox orders={orders} tables={tables} publishedMenu={menu} loadError={loadError}
            actionError={actionError} busyOrderId={busyId} selectedId={selectedId} onSelect={setSelectedId}
            onApprove={(o) => { void decide(o, 'accept'); }} onReject={(o) => { void decide(o, 'reject'); }}
            onCreateManual={create} onAddItems={addItems} onCheckout={setCheckoutOrder}
            alertsEnabled={alertsEnabled} newAlertCount={newAlertIds.length}
            onToggleAlerts={toggleAlerts} onDismissAlerts={() => setNewAlertIds([])} />
        )}
      </main>
      {actor.role === 'cashier' && checkoutOrder && (
        <CheckoutModal language="ar"
          serverOrder={{ id: checkoutOrder.id, label: `${checkoutOrder.guestName} — ${checkoutOrder.tableLabel}`, total: checkoutOrder.total }}
          onCancel={() => setCheckoutOrder(null)}
          onCompleteServer={(method) => checkout(checkoutOrder, method)} />
      )}
    </div>
  );
};

export default StaffWorkspace;
