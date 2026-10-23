import React, { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../utils/qr/api';
import { formatBRL, guestCartTotal } from '../../utils/qr/helpers';
import { GuestOrderSubmitError, submitGuestOrder } from '../../utils/qr/guestOrder';
import { clearPendingGuestAttempt, loadPendingGuestAttempt, savePendingGuestAttempt, PendingGuestAttempt } from '../../utils/qr/guestAttempt';

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
  const [restored] = useState(() => loadPendingGuestAttempt(token));
  const [pendingAttempt, setPendingAttempt] = useState<PendingGuestAttempt | null>(restored);
  const [cart, setCart] = useState<Record<string, number>>(() =>
    Object.fromEntries(restored?.items.map((i) => [i.id, i.quantity]) ?? []));
  // Guest name is required per submission (not account login). Kept after a
  // successful order so the same guest can place another distinct order.
  const [guestName, setGuestName] = useState(restored?.guestName ?? '');
  const [nameTouched, setNameTouched] = useState(false);
  const [notes, setNotes] = useState(restored?.notes ?? '');
  const [requestId, setRequestId] = useState<string | null>(restored?.requestId ?? null);
  // True while an ambiguous submission is outstanding: cart and notes are
  // frozen because the same requestId MUST NOT be reused with an edited payload.
  const [frozen, setFrozen] = useState(!!restored);
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

  const trimmedName = guestName.trim();
  const nameInvalid = trimmedName.length === 0 || trimmedName.length > 80;
  const showNameError = nameTouched && nameInvalid;

  const startNewOrder = () => {
    // Allow another distinct order (new requestId) after success; the guest
    // name is prefilled but still editable and re-required on submit.
    setSubmittedOrder(null);
    setCart({});
    setNotes('');
    setRequestId(null);
    setPendingAttempt(null);
    clearPendingGuestAttempt(token);
    setFrozen(false);
    setSubmitError('');
  };

  const handleSubmit = async () => {
    if (submitting || (!frozen && cartLines.length === 0) || submittedOrder) return;
    setNameTouched(true);
    if (nameInvalid) return;
    setSubmitError('');
    setSubmitting(true);
    // Persist the exact payload BEFORE sending, so even a reload after a lost
    // response can only replay the same request (never silently create another).
    const attempt: PendingGuestAttempt = pendingAttempt ?? {
      requestId: requestId ?? crypto.randomUUID(),
      guestName: trimmedName,
      items: cartLines.map((l) => ({ id: String(l.id), quantity: l.quantity })),
      notes: notes.trim(),
    };
    savePendingGuestAttempt(token, attempt);
    setPendingAttempt(attempt);
    try {
      const order = await submitGuestOrder({ token, ...attempt });
      clearPendingGuestAttempt(token);
      setPendingAttempt(null);
      setSubmittedOrder(order);
      setCart({});
      setNotes('');
      setRequestId(null); // next order gets a fresh id
      setFrozen(false);
    } catch (err: any) {
      if (err instanceof GuestOrderSubmitError && err.ambiguous) {
        setRequestId(attempt.requestId);
        setFrozen(true);
        setSubmitError(
          'تعذر تأكيد استلام الطلب: قد يكون طلبك السابق قد وصل بالفعل. تم تثبيت الأصناف والملاحظات ولا يمكن تعديلها الآن؛ أعد المحاولة لإرسال نفس الطلب بنفس المرجع.',
        );
      } else {
        clearPendingGuestAttempt(token);
        setPendingAttempt(null);
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
          <button style={styles.newOrderBtn} onClick={startNewOrder}>
            إرسال طلب آخر
          </button>
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
        <label style={styles.nameLabel} htmlFor="guest-name">الاسم</label>
        <input
          id="guest-name"
          style={{ ...styles.nameInput, ...(showNameError ? styles.nameInputError : {}) }}
          placeholder="الاسم (مطلوب)"
          value={guestName}
          disabled={frozen || submitting}
          maxLength={80}
          onChange={(e) => {
            setGuestName(e.target.value);
            setNameTouched(true);
          }}
        />
        {showNameError && (
          <p style={{ ...styles.muted, color: '#b91c1c' }}>
            {trimmedName.length === 0 ? 'الاسم مطلوب لإرسال الطلب' : 'الاسم يجب أن يكون 80 حرفاً أو أقل'}
          </p>
        )}
        {frozen && (
          <p style={{ ...styles.muted, color: '#92400e' }}>🔒 الاسم مثبّت مع الطلب حتى يتم التأكد من وصوله.</p>
        )}
        {frozen && pendingAttempt && cartLines.length !== pendingAttempt.items.length && (
          <p style={{ ...styles.muted, color: '#92400e' }}>
            بعض الأصناف تغيّرت في القائمة؛ ستُعاد المحاولة بالطلب الأصلي: {pendingAttempt.items.map(i => `${i.id} ×${i.quantity}`).join('، ')}.
          </p>
        )}
        <div style={styles.totalRow}>
          <span>الإجمالي ({itemCount} صنف)</span>
          <strong>{frozen && pendingAttempt && cartLines.length !== pendingAttempt.items.length ? 'راجع الطلب عند التأكيد' : formatBRL(total)}</strong>
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
            ...(submitting || (!frozen && cartLines.length === 0) ? styles.disabled : {}),
          }}
          disabled={submitting || (!frozen && cartLines.length === 0) || nameInvalid}
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
  nameLabel: { display: 'block', fontSize: 14, fontWeight: 600, marginBottom: 4 },
  nameInput: { width: '100%', boxSizing: 'border-box', padding: 10, marginBottom: 6, borderRadius: 8, border: '1px solid #ccc', fontSize: 16 },
  nameInputError: { borderColor: '#b91c1c' },
  newOrderBtn: { marginTop: 12, padding: '10px 18px', borderRadius: 8, border: 'none', background: '#059669', color: '#fff', fontWeight: 700 },
  submitBtn: { width: '100%', padding: 12, fontSize: 17, borderRadius: 10, border: 'none', background: '#059669', color: '#fff', fontWeight: 700 },
  disabled: { opacity: 0.5 },
  errorBox: { borderColor: '#b91c1c', color: '#b91c1c', textAlign: 'center' },
  successBox: { borderColor: '#059669', textAlign: 'center' },
  retryBtn: { marginTop: 10, padding: '8px 16px', borderRadius: 8, border: '1px solid #b91c1c', background: 'transparent', color: '#b91c1c' },
  center: { textAlign: 'center' },
  muted: { color: '#6b7280', fontSize: 13 },
};

export default GuestPage;
