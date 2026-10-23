import React, { useEffect, useState } from 'react';
import { apiFetch } from '../../utils/qr/api';

/**
 * Login gate rendered on / and /login.
 * The original App (and therefore all localStorage data) is only mounted
 * after the backend confirms an authenticated admin session.
 */
const AdminGate = ({ children }: { children: React.ReactNode }) => {
  const [checking, setChecking] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiFetch<{ authenticated: boolean }>('/api/admin/session');
        if (!cancelled) setAuthenticated(!!data.authenticated);
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
      const data = await apiFetch<{ authenticated: boolean }>('/api/admin/login', {
        method: 'POST',
        body: { password },
      });
      setAuthenticated(!!data.authenticated);
      setPassword('');
    } catch (err: any) {
      setError(err?.message ?? 'فشل تسجيل الدخول');
    } finally {
      setSubmitting(false);
    }
  };

  if (authenticated) return <>{children}</>;

  return (
    <div dir="rtl" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f3f4f6', fontFamily: 'sans-serif' }}>
      <form
        onSubmit={handleLogin}
        style={{ background: '#fff', padding: 24, borderRadius: 12, border: '1px solid #ddd', width: 320, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}
      >
        <h1 style={{ fontSize: 20, textAlign: 'center', marginTop: 0 }}>تسجيل دخول الإدارة</h1>
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
