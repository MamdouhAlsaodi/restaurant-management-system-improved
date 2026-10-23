import React, { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { apiFetch } from '../../utils/qr/api';
import { canActOnOrder, describeOrderStatus, formatBRL, guestUrl, mergeOrders, toPublishedItems } from '../../utils/qr/helpers';
import { MenuItem } from '../../types';

interface AdminTable {
  id: number | string;
  label: string;
  token: string;
  active: boolean;
}

interface AdminOrder {
  /** Backend order ids are UUID strings. */
  id: string;
  tableLabel: string;
  items: { id: string; name: string; price: number; quantity: number }[];
  /** INTEGER CENTS from the API. */
  total: number;
  notes?: string;
  status: string;
  createdAt: string;
}

const POLL_INTERVAL_MS = 5000;

/**
 * QR orders panel inside the authenticated admin App.
 * NOTE: pending QR orders are NOT sales. They are never counted as paid and
 * never inserted into local sales records. Checkout/payment integration for
 * guest QR orders is future work.
 */
const QRPanel = ({ menuItems }: { menuItems: MenuItem[] }) => {
  const [tables, setTables] = useState<AdminTable[]>([]);
  const [newLabel, setNewLabel] = useState('');
  const [qrImages, setQrImages] = useState<Record<string, string>>({});
  const [tablesError, setTablesError] = useState('');

  const [publishing, setPublishing] = useState(false);
  const [publishMsg, setPublishMsg] = useState('');

  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [ordersError, setOrdersError] = useState('');
  const [actingId, setActingId] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadTables = useCallback(async () => {
    try {
      const data = await apiFetch<{ tables: AdminTable[] }>('/api/admin/tables');
      setTables(data.tables ?? []);
      setTablesError('');
    } catch (err: any) {
      setTablesError(err?.message ?? 'تعذر تحميل الطاولات');
    }
  }, []);

  const loadOrders = useCallback(async () => {
    try {
      const data = await apiFetch<{ orders: AdminOrder[] }>('/api/admin/orders');
      setOrders((prev) => mergeOrders(prev, data.orders ?? []));
      setOrdersError('');
    } catch (err: any) {
      setOrdersError(err?.message ?? 'تعذر تحميل الطلبات');
    }
  }, []);

  useEffect(() => {
    loadTables();
    loadOrders();
    pollTimer.current = setInterval(loadOrders, POLL_INTERVAL_MS);
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [loadTables, loadOrders]);

  // Render QR images locally with the qrcode package (no remote QR service).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = {};
      for (const table of tables) {
        try {
          next[table.token] = await QRCode.toDataURL(guestUrl(window.location.origin, table.token), {
            margin: 1,
            width: 200,
          });
        } catch {
          // ignore individual render failures
        }
      }
      if (!cancelled) setQrImages(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [tables]);

  const handleCreateTable = async (e: React.FormEvent) => {
    e.preventDefault();
    const label = newLabel.trim();
    if (!label) return;
    try {
      await apiFetch('/api/admin/tables', { method: 'POST', body: { label } });
      setNewLabel('');
      await loadTables();
    } catch (err: any) {
      setTablesError(err?.message ?? 'تعذر إنشاء الطاولة');
    }
  };

  const handleRevoke = async (table: AdminTable) => {
    if (!window.confirm(`هل تريد إلغاء رمز الطاولة «${table.label}»؟ لن يعمل رمز QR الحالي بعد الإلغاء.`)) return;
    try {
      await apiFetch(`/api/admin/tables/${table.id}`, { method: 'DELETE' });
      await loadTables();
    } catch (err: any) {
      setTablesError(err?.message ?? 'تعذر إلغاء الطاولة');
    }
  };

  const handlePublish = async () => {
    // Validate BEFORE confirming: invalid local prices are never silently sent.
    let payload;
    try {
      payload = toPublishedItems(menuItems);
    } catch (err: any) {
      setPublishMsg(`⚠️ ${err?.message ?? 'يوجد أسعار غير صالحة في القائمة'}`);
      return;
    }
    if (
      !window.confirm(
        'سيتم نشر نسخة ثابتة (Snapshot) من القائمة الحالية للضيوف. الأسعار المعروضة للضيوف قد تختلف عن الأسعار المحلية حتى تقوم بالنشر مجدداً. هل تريد المتابعة؟',
      )
    )
      return;
    setPublishing(true);
    setPublishMsg('');
    try {
      // Explicit opt-in snapshot: only published on this confirmed action.
      // Wire contract: string ids, integer cents.
      await apiFetch('/api/admin/menu', {
        method: 'PUT',
        body: { items: payload },
      });
      setPublishMsg('✅ تم نشر القائمة للضيوف');
    } catch (err: any) {
      setPublishMsg(`⚠️ ${err?.message ?? 'تعذر نشر القائمة'}`);
    } finally {
      setPublishing(false);
    }
  };

  const handleAct = async (order: AdminOrder, action: 'accept' | 'reject') => {
    if (!canActOnOrder(order) || actingId !== null) return;
    setActingId(order.id);
    try {
      const data = await apiFetch<{ order: AdminOrder }>(`/api/admin/orders/${order.id}/${action}`, {
        method: 'POST',
      });
      setOrders((prev) => mergeOrders(prev, [data.order]));
      setOrdersError('');
    } catch (err: any) {
      setOrdersError(err?.message ?? 'تعذر تحديث الطلب');
    } finally {
      setActingId(null);
    }
  };

  const handleCopy = async (table: AdminTable) => {
    const url = guestUrl(window.location.origin, table.token);
    try {
      await navigator.clipboard.writeText(url);
      setCopiedToken(table.token);
      setTimeout(() => setCopiedToken(null), 2000);
    } catch {
      setCopiedToken(null);
    }
  };

  return (
    <div dir="rtl" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <section>
        <h2>نشر القائمة للضيوف</h2>
        <p style={{ color: '#6b7280', fontSize: 14 }}>
          النشر ينشئ نسخة ثابتة من القائمة الحالية. أسعار الضيوف لن تتغير حتى تنشر مرة أخرى.
        </p>
        <button
          onClick={handlePublish}
          disabled={publishing}
          style={{ padding: '10px 18px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', fontWeight: 700, opacity: publishing ? 0.5 : 1 }}
        >
          {publishing ? 'جارٍ النشر…' : 'نشر القائمة الحالية للضيوف'}
        </button>
        {publishMsg && <p style={{ marginTop: 8 }}>{publishMsg}</p>}
      </section>

      <section>
        <h2>رموز الطاولات (QR)</h2>
        <form onSubmit={handleCreateTable} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="اسم الطاولة (مثال: طاولة 5)"
            style={{ flex: 1, maxWidth: 280, padding: 8, borderRadius: 8, border: '1px solid #ccc' }}
          />
          <button type="submit" style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #ccc', background: '#f9fafb' }}>
            إضافة طاولة
          </button>
        </form>
        {tablesError && <p style={{ color: '#b91c1c' }}>⚠️ {tablesError}</p>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
          {tables.map((table) => (
            <div key={table.id} style={{ border: '1px solid #ddd', borderRadius: 10, padding: 12, width: 220, textAlign: 'center' }}>
              <strong>{table.label}</strong>
              <div style={{ margin: '8px 0' }}>
                {qrImages[table.token] ? (
                  <img src={qrImages[table.token]} alt={`رمز QR لـ ${table.label}`} width={200} height={200} />
                ) : (
                  <div style={{ width: 200, height: 200, background: '#f3f4f6', margin: '0 auto' }} />
                )}
              </div>
              <div style={{ fontSize: 11, color: '#6b7280', wordBreak: 'break-all' }}>
                {guestUrl(window.location.origin, table.token)}
              </div>
              <p style={{ fontSize: 12, color: '#b45309', margin: '6px 0' }}>
                ⚠️ تأكد من أن العنوان قابل للوصول من جهاز الضيف (localhost لا يعمل خارج هذا الجهاز).
              </p>
              <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
                <button onClick={() => handleCopy(table)} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid #ccc', background: '#f9fafb' }}>
                  {copiedToken === table.token ? 'تم النسخ ✓' : 'نسخ الرابط'}
                </button>
                <button onClick={() => handleRevoke(table)} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid #b91c1c', background: 'transparent', color: '#b91c1c' }}>
                  إلغاء الرمز
                </button>
              </div>
            </div>
          ))}
          {tables.length === 0 && !tablesError && <p style={{ color: '#6b7280' }}>لا توجد طاولات بعد.</p>}
        </div>
      </section>

      <section>
        <h2>طلبات الضيوف (تحديث تلقائي كل 5 ثوانٍ)</h2>
        <p style={{ color: '#6b7280', fontSize: 14 }}>
          الطلبات المعلّقة ليست مبيعات: لا تُحسب كمدفوعات ولا تُضاف إلى السجل المحلي. ربط الدفع عند Checkout عمل مستقبلي.
        </p>
        {ordersError && <p style={{ color: '#b91c1c' }}>⚠️ خطأ في جلب الطلبات: {ordersError}</p>}
        {orders.length === 0 && !ordersError && <p style={{ color: '#6b7280' }}>لا توجد طلبات حالياً.</p>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {orders.map((order) => (
            <div key={order.id} style={{ border: '1px solid #ddd', borderRadius: 10, padding: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
                <strong>طلب #{order.id} — {order.tableLabel}</strong>
                <span
                  style={{
                    padding: '2px 10px',
                    borderRadius: 999,
                    fontSize: 13,
                    background: order.status === 'accepted' ? '#d1fae5' : order.status === 'rejected' ? '#fee2e2' : '#fef3c7',
                    color: order.status === 'accepted' ? '#065f46' : order.status === 'rejected' ? '#991b1b' : '#92400e',
                  }}
                >
                  {describeOrderStatus(order.status)}
                </span>
              </div>
              <ul style={{ margin: '8px 0', paddingLeft: 0, paddingRight: 18, listStyle: 'disc' }}>
                {order.items.map((item, idx) => (
                  <li key={idx}>
                    {item.name} × {item.quantity} — {formatBRL(item.price * item.quantity)}
                  </li>
                ))}
              </ul>
              <div>الإجمالي: {formatBRL(order.total)}</div>
              {order.notes && <div style={{ color: '#6b7280', fontSize: 14 }}>ملاحظات: {order.notes}</div>}
              <div style={{ color: '#6b7280', fontSize: 13 }}>
                {order.createdAt ? new Date(order.createdAt).toLocaleString('ar') : ''}
              </div>
              {canActOnOrder(order) && (
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button
                    onClick={() => handleAct(order, 'accept')}
                    disabled={actingId === order.id}
                    style={{ padding: '6px 14px', borderRadius: 8, border: 'none', background: '#059669', color: '#fff', fontWeight: 700 }}
                  >
                    قبول
                  </button>
                  <button
                    onClick={() => handleAct(order, 'reject')}
                    disabled={actingId === order.id}
                    style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid #b91c1c', background: 'transparent', color: '#b91c1c' }}
                  >
                    رفض
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};

export default QRPanel;
