import React, { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { apiFetch } from '../../utils/qr/api';
import { guestUrl, toPublishedItems } from '../../utils/qr/helpers';
import { MenuItem } from '../../types';
import OrderInbox, { OrderInboxProps } from './OrderInbox';

interface AdminTable {
  id: number | string;
  label: string;
  token: string;
  active: boolean;
}

interface QRPanelProps {
  menuItems: MenuItem[];
  /** Shared, App-owned order queue state (single poller, single source of truth). */
  inbox: OrderInboxProps;
  paidServerCount: number;
  onMetaChange: () => Promise<void>;
}

const QRPanel = ({ menuItems, inbox, paidServerCount, onMetaChange }: QRPanelProps) => {
  const [tables, setTables] = useState<AdminTable[]>([]);
  const [newLabel, setNewLabel] = useState('');
  const [qrImages, setQrImages] = useState<Record<string, string>>({});
  const [tablesError, setTablesError] = useState('');

  const [publishing, setPublishing] = useState(false);
  const [publishMsg, setPublishMsg] = useState('');
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  const loadTables = useCallback(async () => {
    try {
      const data = await apiFetch<{ tables: AdminTable[] }>('/api/admin/tables');
      setTables(data.tables ?? []);
      setTablesError('');
    } catch (err: any) {
      setTablesError(err?.message ?? 'تعذر تحميل الطاولات');
    }
  }, []);

  useEffect(() => {
    loadTables();
  }, [loadTables]);

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
      await onMetaChange();
    } catch (err: any) {
      setTablesError(err?.message ?? 'تعذر إنشاء الطاولة');
    }
  };

  const handleRevoke = async (table: AdminTable) => {
    if (!window.confirm(`هل تريد إلغاء رمز الطاولة «${table.label}»؟ لن يعمل رمز QR الحالي بعد الإلغاء.`)) return;
    try {
      await apiFetch(`/api/admin/tables/${table.id}`, { method: 'DELETE' });
      await loadTables();
      await onMetaChange();
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
      await onMetaChange();
      setPublishMsg('✅ تم نشر القائمة للضيوف');
    } catch (err: any) {
      setPublishMsg(`⚠️ ${err?.message ?? 'تعذر نشر القائمة'}`);
    } finally {
      setPublishing(false);
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
      {/* Primary multi-order queue (shared with the Orders tab). Auth is the
          same admin cookie session gating the whole App — never bypassed. */}
      <section>
        <h2>طلبات الطاولات (تحديث تلقائي كل 5 ثوانٍ)</h2>
        <p style={{ color: '#6b7280', fontSize: 14 }}>
          الطلبات المعلّقة ليست مبيعات. يُحصّل كل طلب على حدة، والطلبات المدفوعة ({paidServerCount}) للقراءة فقط ولا تُكتب في السجل المحلي.
        </p>
        <OrderInbox {...inbox} />
      </section>

      <section>
        <h2>نشر القائمة للضيوف</h2>
        <p style={{ color: '#6b7280', fontSize: 14 }}>
          النشر ينشئ نسخة ثابتة من القائمة الحالية. أسعار الضيوف وإضافات الكاشير للطلبات تستخدم هذه النسخة المنشورة فقط.
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
    </div>
  );
};

export default QRPanel;
