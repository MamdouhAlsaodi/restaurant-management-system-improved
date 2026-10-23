import React, { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../utils/qr/api';
import { formatBRL, guestCartTotal } from '../../utils/qr/helpers';
import { GuestOrderSubmitError, submitGuestOrder } from '../../utils/qr/guestOrder';

interface GuestMenuItem {
  /** Backend menu ids are strings. */
  id: string;
  name: string;
  /** INTEGER CENTS from the API. */
  price: number;
  image?: string;
  category?: string;
  description?: string;
}

interface GuestOrder {
  id: string;
  status: string;
  tableLabel?: string;
  total?: number;
}

/**
 * Guest-only, mobile-first page for /q/:token.
 * Never mounts the admin App and never touches localStorage.
 */
const GuestPage = ({ token }: { token: string }) => {
  const [tableLabel, setTableLabel] = useState('');
  const [items, setItems] = useState<GuestMenuItem[]>([]);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  // True while an ambiguous submission is outstanding: cart and notes are
  // frozen because the same requestId MUST NOT be reused with an edited payload.
  const [frozen, setFrozen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submittedOrder, setSubmittedOrder] = useState<GuestOrder | null>(null);
  const [error, setError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiFetch<{ table: { label: string }; items: GuestMenuItem[] }>(
          `/api/guest/${encodeURIComponent(token)}/menu`,
        );
        if (cancelled) return;
        setTableLabel(data.table?.label ?? '');
        setItems(data.items ?? []);
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? 'تعذر تحميل القائمة');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const categories = useMemo(() => {
    const map = new Map<string, GuestMenuItem[]>();
    for (const item of items) {
      const key = item.category ?? 'أصناف';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    return map;
  }, [items]);

  const cartLines = items
    .filter((i) => (cart[i.id] ?? 0) > 0)
    .map((i) => ({ ...i, quantity: cart[i.id] }));
  // API money is integer cents; the total preview is therefore already in cents.
  const total = guestCartTotal(cartLines);
  const itemCount = cartLines.reduce((s, l) => s + l.quantity, 0);

  const setQty = (id: string, qty: number) => {
    setCart((prev) => {
      const next = { ...prev };
      if (qty <= 0) delete next[id];
      else next[id] = qty;
      return next;
    });
  };

  const handleSubmit = async () => {
    if (submitting || frozen || cartLines.length === 0 || submittedOrder) return;
    setSubmitError('');
    setSubmitting(true);
    // One requestId per attempted order; reused verbatim on retries so the
    // backend can deduplicate if a response was lost.
    const rid = requestId ?? crypto.randomUUID();
    try {
      const order = await submitGuestOrder({
        token,
        items: cartLines.map((l) => ({ id: String(l.id), quantity: l.quantity })),
        notes: notes.trim() || undefined,
        requestId: rid,
      });
      setSubmittedOrder(order);
      setCart({});
      setNotes('');
      setRequestId(null); // clear on success; next order gets a fresh id
      setFrozen(false);
    } catch (err: any) {
      if (err instanceof GuestOrderSubmitError && err.ambiguous) {
        // Response lost: a previous submission MAY have arrived. Freeze the
        // exact cart/notes snapshot and keep the same requestId for retry.
        setRequestId(rid);
        setFrozen(true);
        setSubmitError(
          'تعذر تأكيد استلام الطلب: قد يكون طلبك السابق قد وصل بالفعل. تم تثبيت الأصناف والملاحظات ولا يمكن تعديلها الآن؛ أعد المحاولة لإرسال نفس الطلب بنفس المرجع.',
        );
      } else {
        // Definitive server rejection: the order was NOT created, so release
        // the attempt and let the customer edit before retrying.
        setRequestId(null);
        setFrozen(false);
        setSubmitError(`${err?.message ?? 'تعذر إرسال الطلب'} — يمكنك تعديل طلبك والمحاولة مجدداً.`);
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div dir="rtl" style={styles.page}>
        <p style={styles.center}>جارٍ تحميل القائمة…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div dir="rtl" style={styles.page}>
        <div style={{ ...styles.card, ...styles.errorBox }}>
          <p style={{ margin: 0 }}>⚠️ {error}</p>
          <button style={styles.retryBtn} onClick={() => window.location.reload()}>
            إعادة المحاولة
          </button>
        </div>
      </div>
    );
  }

  if (submittedOrder) {
    return (
      <div dir="rtl" style={styles.page}>
        <h1 style={styles.title}>{tableLabel}</h1>
        <div style={{ ...styles.card, ...styles.successBox }}>
          <h2 style={{ marginTop: 0 }}>✅ تم إرسال طلبك</h2>
          <p>رقم الطلب: {submittedOrder.id}</p>
          <p>الحالة: بانتظار الموافقة</p>
          <p style={styles.muted}>سيتم تأكيد الطلب من إدارة المطعم.</p>
        </div>
      </div>
    );
  }

  return (
    <div dir="rtl" style={styles.page}>
      <h1 style={styles.title}>{tableLabel || 'قائمة الطاولة'}</h1>

      {items.length === 0 && <p style={styles.center}>لا توجد أصناف منشورة حالياً.</p>}

      {[...categories.entries()].map(([category, catItems]) => (
        <section key={category}>
          <h2 style={styles.category}>{category}</h2>
          {catItems.map((item) => {
            const qty = cart[item.id] ?? 0;
            return (
              <div key={item.id} style={styles.itemRow}>
                <div style={{ flex: 1 }}>
                  <div style={styles.itemName}>{item.name}</div>
                  <div style={styles.itemPrice}>{formatBRL(item.price)}</div>
                  {item.description && <div style={styles.muted}>{item.description}</div>}
                </div>
                <div style={styles.qtyControls}>
                  <button
                  style={{ ...styles.qtyBtn, ...(frozen ? styles.disabled : {}) }}
                  disabled={frozen}
                  onClick={() => setQty(item.id, qty - 1)} aria-label="إنقاص">
                    −
                  </button>
                  <span style={styles.qtyValue}>{qty}</span>
                  <button
                  style={{ ...styles.qtyBtn, ...(frozen ? styles.disabled : {}) }}
                  disabled={frozen}
                  onClick={() => setQty(item.id, qty + 1)} aria-label="زيادة">
                    +
                  </button>
                </div>
              </div>
            );
          })}
        </section>
      ))}

      <div style={styles.card}>
        <div style={styles.totalRow}>
          <span>الإجمالي ({itemCount} صنف)</span>
          <strong>{formatBRL(total)}</strong>
        </div>
        {frozen && (
          <p style={{ ...styles.muted, color: '#92400e' }}>
            🔒 الطلب مثبّت الآن: هناك محاولة إرسال سابقة لم يتم التأكد من وصولها. لا يمكن تعديل الأصناف أو الملاحظات
            حتى يتم التأكد.
          </p>
        )}
        <textarea
          style={styles.notes}
          placeholder="ملاحظات (اختياري)"
          value={notes}
          disabled={frozen}
          onChange={(e) => setNotes(e.target.value)}
        />
        {submitError && <p style={{ ...styles.muted, color: '#b91c1c' }}>⚠️ {submitError}</p>}
        <button
          style={{
            ...styles.submitBtn,
            ...(submitting || frozen || cartLines.length === 0 ? styles.disabled : {}),
          }}
          disabled={submitting || frozen || cartLines.length === 0}
          onClick={handleSubmit}
        >
          {submitting ? 'جارٍ الإرسال…' : frozen ? 'أعد المحاولة بنفس المرجع' : 'إرسال الطلب'}
        </button>
        {!navigator.onLine && <p style={styles.muted}>أنت غير متصل بالإنترنت حالياً.</p>}
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  page: { maxWidth: 480, margin: '0 auto', padding: 16, fontFamily: 'sans-serif', paddingBottom: 48 },
  title: { textAlign: 'center', fontSize: 22 },
  category: { fontSize: 17, borderBottom: '1px solid #ddd', paddingBottom: 4 },
  card: { border: '1px solid #ddd', borderRadius: 10, padding: 14, marginTop: 16, background: '#fff' },
  itemRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px dashed #eee' },
  itemName: { fontWeight: 600 },
  itemPrice: { color: '#059669' },
  qtyControls: { display: 'flex', alignItems: 'center', gap: 6 },
  qtyBtn: { width: 34, height: 34, fontSize: 18, borderRadius: 8, border: '1px solid #ccc', background: '#f9fafb' },
  qtyValue: { minWidth: 22, textAlign: 'center' },
  totalRow: { display: 'flex', justifyContent: 'space-between', fontSize: 17, marginBottom: 10 },
  notes: { width: '100%', boxSizing: 'border-box', minHeight: 60, marginBottom: 10, padding: 8, borderRadius: 8, border: '1px solid #ccc' },
  submitBtn: { width: '100%', padding: 12, fontSize: 17, borderRadius: 10, border: 'none', background: '#059669', color: '#fff', fontWeight: 700 },
  disabled: { opacity: 0.5 },
  errorBox: { borderColor: '#b91c1c', color: '#b91c1c', textAlign: 'center' },
  successBox: { borderColor: '#059669', textAlign: 'center' },
  retryBtn: { marginTop: 10, padding: '8px 16px', borderRadius: 8, border: '1px solid #b91c1c', background: 'transparent', color: '#b91c1c' },
  center: { textAlign: 'center' },
  muted: { color: '#6b7280', fontSize: 13 },
};

export default GuestPage;
