import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apiFetch, ApiError } from '../../utils/qr/api.ts';

test('apiFetch returns parsed JSON on ok responses', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ authenticated: true }) });
  assert.deepEqual(await apiFetch('/api/admin/session', {}, fetchImpl), { authenticated: true });
});

test('apiFetch throws ApiError with server error message', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: 'غير مصرح' }) });
  await assert.rejects(apiFetch('/api/admin/tables', {}, fetchImpl), (e) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.message, 'غير مصرح');
    assert.equal(e.status, 401);
    return true;
  });
});

test('apiFetch converts network failure to friendly Arabic error without leaking details', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed http://secret-host internal stack');
  };
  await assert.rejects(apiFetch('/x', {}, fetchImpl), /تعذر الاتصال بالخادم/);
});

test('apiFetch sends JSON headers and credentials for JSON bodies', async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  await apiFetch('/api/admin/login', { method: 'POST', body: { password: 'x' } }, fetchImpl);
  assert.equal(seen.url, '/api/admin/login');
  assert.equal(seen.opts.credentials, 'same-origin');
  assert.equal(seen.opts.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(seen.opts.body), { password: 'x' });
});
