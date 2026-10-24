import React, { useEffect, useState } from 'react';
import { apiFetch, SessionActor } from '../../utils/qr/api';

/**
 * Owner-only staff management and audit view.
 * The server enforces ownership on every endpoint used here; this panel is
 * only the owner's convenience UI. Passwords are sent once to the create
 * endpoint and never stored client-side.
 */

interface StaffMember {
  id: number;
  username: string;
  role: 'cashier' | 'kitchen';
  active: boolean;
  createdAt?: string;
}

interface AuditEvent {
  id: number;
  at: string;
  action: string;
  actorId: string;
  actorRole: string;
  actorUsername?: string;
  orderId?: string;
  tableId?: number;
  metadata?: Record<string, unknown>;
}

const StaffPanel: React.FC<{ actor: SessionActor }> = ({ actor }) => {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'cashier' | 'kitchen'>('cashier');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (actor.kind !== 'owner') {
    return <p className="p-4 text-sm text-gray-500">هذه الشاشة متاحة للمالك فقط.</p>;
  }

  const refresh = async () => {
    try {
      const [staffData, auditData] = await Promise.all([
        apiFetch<{ staff: StaffMember[] }>('/api/admin/staff'),
        apiFetch<{ events: AuditEvent[] }>('/api/admin/audit?limit=50'),
      ]);
      setStaff(staffData.staff ?? []);
      setEvents(auditData.events ?? []);
      setError('');
    } catch (err: any) {
      setError(err?.message ?? 'تعذر تحميل البيانات');
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await apiFetch('/api/admin/staff', { method: 'POST', body: { username, password, role } });
      setUsername('');
      setPassword('');
      await refresh();
    } catch (err: any) {
      setError(err?.message ?? 'فشل إنشاء الحساب');
    } finally {
      setBusy(false);
    }
  };

  const handleDeactivate = async (id: number) => {
    setError('');
    try {
      await apiFetch(`/api/admin/staff/${id}/deactivate`, { method: 'POST' });
      await refresh();
    } catch (err: any) {
      setError(err?.message ?? 'فشل إيقاف الحساب');
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-8" dir="rtl">
      <section>
        <h2 className="text-lg font-bold mb-3">إدارة الحسابات</h2>
        <form onSubmit={handleCreate} className="flex flex-wrap gap-2 items-end mb-4">
          <label className="text-sm">
            <span className="block mb-1">اسم المستخدم</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} required maxLength={64}
              className="border rounded-lg px-3 py-2" />
          </label>
          <label className="text-sm">
            <span className="block mb-1">كلمة المرور</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8}
              className="border rounded-lg px-3 py-2" />
          </label>
          <label className="text-sm">
            <span className="block mb-1">الدور</span>
            <select value={role} onChange={(e) => setRole(e.target.value as 'cashier' | 'kitchen')}
              className="border rounded-lg px-3 py-2">
              <option value="cashier">كاشير</option>
              <option value="kitchen">مطبخ</option>
            </select>
          </label>
          <button type="submit" disabled={busy || !username || !password}
            className="bg-orange-500 text-white font-bold px-4 py-2 rounded-lg disabled:opacity-50">
            إنشاء حساب
          </button>
        </form>
        {error && <p className="text-red-600 text-sm mb-2">⚠️ {error}</p>}
        <table className="w-full text-sm border">
          <thead className="bg-gray-50">
            <tr><th className="p-2 text-right">المستخدم</th><th className="p-2 text-right">الدور</th><th className="p-2 text-right">الحالة</th><th className="p-2"></th></tr>
          </thead>
          <tbody>
            {staff.map((s) => (
              <tr key={s.id} className="border-t">
                <td className="p-2">{s.username}</td>
                <td className="p-2">{s.role === 'cashier' ? 'كاشير' : 'مطبخ'}</td>
                <td className="p-2">{s.active ? 'نشط' : 'موقوف'}</td>
                <td className="p-2">
                  {s.active && (
                    <button onClick={() => handleDeactivate(s.id)}
                      className="text-red-600 hover:underline">إيقاف</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-bold">سجل التدقيق (أحدث 50)</h2>
          <button onClick={refresh} className="text-sm text-blue-600 hover:underline">تحديث</button>
        </div>
        <ul className="text-sm space-y-1">
          {events.map((ev) => (
            <li key={ev.id} className="border rounded-lg px-3 py-2 flex flex-wrap gap-x-3">
              <span className="font-mono text-xs text-gray-500">{ev.at}</span>
              <span className="font-bold">{ev.action}</span>
              <span className="text-gray-600">
                {ev.actorRole}{ev.actorUsername ? ` (${ev.actorUsername})` : ''}
              </span>
              {ev.orderId && <span className="font-mono text-xs text-gray-400">طلب {ev.orderId.slice(0, 8)}</span>}
              {ev.tableId !== undefined && <span className="text-gray-400">طاولة {ev.tableId}</span>}
            </li>
          ))}
          {events.length === 0 && <li className="text-gray-500">لا توجد أحداث بعد.</li>}
        </ul>
      </section>
    </div>
  );
};

export default StaffPanel;
