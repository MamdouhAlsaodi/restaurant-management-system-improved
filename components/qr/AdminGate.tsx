import React, { useEffect, useState } from 'react';
import { apiFetch, SessionActor } from '../../utils/qr/api';

/**
 * Login gate rendered on / and /login.
 * The original App (and therefore all localStorage data) is only mounted
 * after the backend confirms an authenticated admin session.
 *
 * Owner: password only (backward compatible). Staff: username + password.
 * The server decides which; the session actor is passed to the app so the
 * UI can hide owner-only screens. Server-side enforcement is authoritative.
 */
const AdminGate = ({ children }: { children: (actor: SessionActor) => React.ReactNode }) => {
  const [checking, setChecking] = useState(true);
  const [actor, setActor] = useState<SessionActor | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiFetch<{ authenticated: boolean; actor?: SessionActor }>('/api/admin/session');
        if (!cancelled && data.authenticated && data.actor) setActor(data.actor);
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? 'تعذر التحقق من الجلسة');
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      // Username left empty => owner password-only login (unchanged contract).
      const body = username.trim()
        ? { username: username.trim(), password }
        : { password };
      const data = await apiFetch<{ authenticated: boolean; actor?: SessionActor }>('/api/admin/login', {
        method: 'POST',
        body,
      });
      if (data.authenticated && data.actor) setActor(data.actor);
      setPassword('');
    } catch (err: any) {
      setError(err?.message ?? 'فشل تسجيل الدخول');
    } finally {
      setSubmitting(false);
    }
  };

  if (actor) return <>{children(actor)}</>;

  return (
    <div dir="rtl" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f3f4f6', fontFamily: 'sans-serif' }}>
      <form
        onSubmit={handleLogin}
        style={{ background: '#fff', padding: 24, borderRadius: 12, border: '1px solid #ddd', width: 320, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}
      >
        <h1 style={{ fontSize: 20, textAlign: 'center', marginTop: 0 }}>تسجيل دخول الإدارة</h1>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="اسم المستخدم (اختياري للمالك)"
          autoCapitalize="none"
          style={{ width: '100%', boxSizing: 'border-box', padding: 10, borderRadius: 8, border: '1px solid #ccc', marginBottom: 12 }}
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="كلمة المرور"
          autoFocus
          style={{ width: '100%', boxSizing: 'border-box', padding: 10, borderRadius: 8, border: '1px solid #ccc', marginBottom: 12 }}
        />
        {error && <p style={{ color: '#b91c1c', fontSize: 14, margin: '0 0 10px' }}>⚠️ {error}</p>}
        <button
          type="submit"
          disabled={submitting || password.length === 0}
          style={{ width: '100%', padding: 10, borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', fontWeight: 700, opacity: submitting || password.length === 0 ? 0.5 : 1 }}
        >
          {submitting ? 'جارٍ الدخول…' : 'دخول'}
        </button>
      </form>
    </div>
  );
};

export default AdminGate;
