import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { openDb } from './db.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const NOTES_MAX = 500;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_FAILURE_DELAY_MS = 300;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const GUEST_ORDER_MAX_PER_WINDOW = 10;
const GUEST_WINDOW_MS = 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function errorJson(res, status, message) {
  json(res, status, { error: message });
}

function isNonEmptyString(v, max) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function createApp({
  adminPassword,
  dbPath,
  host = '127.0.0.1',
  port = 8787,
  staticDir = 'dist',
  secureCookies = false,
}) {
  if (typeof adminPassword !== 'string' || adminPassword.length === 0) {
    throw new Error(
      'Refusing to start: ADMIN_PASSWORD must be set to a strong secret (fail closed).'
    );
  }
  const root = resolve(staticDir);
  const db = openDb(dbPath);

  // session id -> expiry (in-memory by design; admin re-login after restart)
  const sessions = new Map();
  const loginFailures = new Map(); // ip -> {count, firstAt}
  const guestSubmissions = new Map(); // "ip|token" -> [timestamps]
  const requestCounts = new Map(); // coarse per-request counter cap

  function pruneSessions() {
    const now = Date.now();
    for (const [sid, exp] of sessions) if (exp < now) sessions.delete(sid);
  }

  function getSession(req) {
    const cookie = req.headers.cookie ?? '';
    const m = /(?:^|;\s*)sid=([A-Za-z0-9_-]+)/.exec(cookie);
    if (!m) return false;
    pruneSessions();
    const exp = sessions.get(m[1]);
    if (!exp || exp < Date.now()) return false;
    return true;
  }

  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser client without Origin
    try {
      const o = new URL(origin);
      const host = req.headers.host ?? '';
      return o.host === host && (o.protocol === 'http:' || o.protocol === 'https:');
    } catch {
      return false;
    }
  }

  function loginRateLimited(ip) {
    const rec = loginFailures.get(ip);
    if (!rec) return false;
    if (Date.now() - rec.firstAt > LOGIN_WINDOW_MS) {
      loginFailures.delete(ip);
      return false;
    }
    return rec.count >= LOGIN_MAX_FAILURES;
  }

  function recordLoginFailure(ip) {
    const rec = loginFailures.get(ip);
    if (!rec || Date.now() - rec.firstAt > LOGIN_WINDOW_MS) {
      loginFailures.set(ip, { count: 1, firstAt: Date.now() });
    } else {
      rec.count += 1;
    }
  }

  function guestRateLimited(ip, token) {
    const key = `${ip}|${token}`;
    const now = Date.now();
    const arr = (guestSubmissions.get(key) ?? []).filter((t) => now - t < GUEST_WINDOW_MS);
    if (arr.length >= GUEST_ORDER_MAX_PER_WINDOW) {
      guestSubmissions.set(key, arr);
      return true;
    }
    arr.push(now);
    guestSubmissions.set(key, arr);
    return false;
  }

  function readBody(req, res) {
    return new Promise((resolveBody, reject) => {
      const chunks = [];
      let size = 0;
      let oversized = false;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          oversized = true;
          chunks.length = 0;
          return; // discard rest, keep socket draining
        }
        if (!oversized) chunks.push(c);
      });
      req.on('end', () => {
        if (oversized) reject({ status: 413, message: 'Payload too large' });
        else resolveBody(Buffer.concat(chunks).toString('utf8'));
      });
      req.on('error', () => reject({ status: 400, message: 'Bad request' }));
    });
  }

  async function readJson(req, res) {
    const ct = String(req.headers['content-type'] ?? '');
    if (!/^\s*application\/json/i.test(ct)) {
      errorJson(res, 415, 'Content-Type must be application/json');
      return undefined;
    }
    let raw;
    try {
      raw = await readBody(req, res);
    } catch (e) {
      errorJson(res, e.status ?? 400, e.message ?? 'Bad request');
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw || '{}');
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        errorJson(res, 400, 'Invalid JSON body');
        return undefined;
      }
      return parsed;
    } catch {
      errorJson(res, 400, 'Invalid JSON body');
      return undefined;
    }
  }

  // ---- domain helpers ----

  function tableRow(r) {
    return { id: Number(r.id), label: r.label, token: r.token, active: !!r.active };
  }

  function getTableByToken(token) {
    return db
      .prepare('SELECT * FROM restaurant_tables WHERE token = ? AND active = 1')
      .get(token);
  }

  function orderPayload(orderRow) {
    const items = db
      .prepare('SELECT item_id AS id, name, price_cents AS price, quantity FROM order_items WHERE order_id = ?')
      .all(orderRow.id);
    return {
      id: orderRow.id,
      tableLabel: orderRow.table_label,
      items,
      total: orderRow.total_cents,
      notes: orderRow.notes ?? '',
      status: orderRow.status,
      createdAt: orderRow.created_at,
    };
  }

  function menuItems() {
    return db
      .prepare('SELECT id, name, price_cents AS price, image, category, description FROM menu_items ORDER BY rowid')
      .all();
  }

  const insertMenuItem = db.prepare(
    'INSERT INTO menu_items (id, name, price_cents, image, category, description) VALUES (?, ?, ?, ?, ?, ?)'
  );
  function withTransaction(fn) {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  function publishTx(items) {
    withTransaction(() => {
      db.prepare('DELETE FROM menu_items').run();
      for (const it of items) insertMenuItem.run(it.id, it.name, it.price, it.image ?? null, it.category ?? null, it.description ?? null);
    });
  }

  function validateMenuItems(items) {
    if (!Array.isArray(items) || items.length > 500) return null;
    const out = [];
    const seen = new Set();
    for (const it of items) {
      if (typeof it !== 'object' || it === null) return null;
      if (!isNonEmptyString(it.id, 64)) return null;
      if (!isNonEmptyString(it.name, 200)) return null;
      if (!Number.isInteger(it.price) || it.price < 0 || it.price > 100_000_000) return null;
      for (const k of ['image', 'category', 'description']) {
        if (it[k] !== undefined && (typeof it[k] !== 'string' || it[k].length > 1000)) return null;
      }
      if (seen.has(it.id)) return null;
      seen.add(it.id);
      out.push({ id: it.id, name: it.name.trim(), price: it.price, image: it.image, category: it.category, description: it.description });
    }
    return out;
  }

  const insertOrderTx = function (order, items) {
      withTransaction(() => {
        db.prepare(
          'INSERT INTO orders (id, table_id, table_label, notes, total_cents, status, created_at, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(order.id, order.table_id, order.table_label, order.notes, order.total_cents, 'pending', order.created_at, order.request_id);
        const ins = db.prepare('INSERT INTO order_items (order_id, item_id, name, price_cents, quantity) VALUES (?, ?, ?, ?, ?)');
        for (const it of items) ins.run(order.id, it.id, it.name, it.price, it.quantity);
      });
  };

  function validateOrderPayload(body) {
    if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 50) {
      return { error: 'items must be a non-empty array' };
    }
    const seen = new Set();
    const wanted = [];
    for (const it of body.items) {
      if (typeof it !== 'object' || it === null) return { error: 'invalid item' };
      if (!isNonEmptyString(it.id, 64)) return { error: 'invalid item id' };
      if (!Number.isInteger(it.quantity) || it.quantity < 1 || it.quantity > 99) {
        return { error: 'invalid quantity' };
      }
      if (seen.has(it.id)) return { error: 'duplicate item' };
      seen.add(it.id);
      wanted.push({ id: it.id, quantity: it.quantity });
    }
    if (body.notes !== undefined && (typeof body.notes !== 'string' || body.notes.length > NOTES_MAX)) {
      return { error: `notes must be a string of at most ${NOTES_MAX} characters` };
    }
    if (typeof body.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.requestId)) {
      return { error: 'requestId must be a UUID' };
    }
    return { wanted, notes: typeof body.notes === 'string' ? body.notes : '' };
  }

  // ---- API routing ----

  async function handleApi(req, res, pathname) {
    const method = req.method;
    const ip = req.socket.remoteAddress ?? 'unknown';
    // No CORS: reject any /api request whose Origin does not match the host.
    if (!sameOrigin(req)) return errorJson(res, 403, 'Forbidden');

    // Public admin endpoints
    if (pathname === '/api/admin/session' && method === 'GET') {
      return json(res, 200, { authenticated: getSession(req) });
    }

    if (pathname === '/api/admin/login' && method === 'POST') {
      if (!sameOrigin(req)) return errorJson(res, 403, 'Forbidden');
      const body = await readJson(req, res);
      if (body === undefined) return;
      if (loginRateLimited(ip)) {
        res.setHeader('Retry-After', String(Math.ceil(LOGIN_WINDOW_MS / 1000)));
        return errorJson(res, 429, 'Too many failed attempts');
      }
      const ok =
        typeof body.password === 'string' &&
        safeEqual(body.password, adminPassword);
      if (!ok) {
        recordLoginFailure(ip);
        await new Promise((r) => setTimeout(r, LOGIN_FAILURE_DELAY_MS)); // fixed delay
        return errorJson(res, 401, 'Invalid credentials');
      }
      loginFailures.delete(ip);
      const sid = randomBytes(32).toString('base64url');
      sessions.set(sid, Date.now() + SESSION_TTL_MS);
      res.setHeader(
        'Set-Cookie',
        `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secureCookies ? '; Secure' : ''}`
      );
      return json(res, 200, { authenticated: true });
    }

    if (pathname === '/api/admin/logout' && method === 'POST') {
      if (!sameOrigin(req)) return errorJson(res, 403, 'Forbidden');
      const m = /(?:^|;\s*)sid=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '');
      if (m) sessions.delete(m[1]);
      res.setHeader('Set-Cookie', `sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookies ? '; Secure' : ''}`);
      return json(res, 200, { authenticated: false });
    }

    // Guest endpoints (token-scoped, no session)
    let m = /^\/api\/guest\/([A-Za-z0-9_-]+)\/menu$/.exec(pathname);
    if (m && method === 'GET') {
      const table = getTableByToken(m[1]);
      if (!table) return errorJson(res, 404, 'Not found');
      return json(res, 200, { table: { label: table.label }, items: menuItems() });
    }

    m = /^\/api\/guest\/([A-Za-z0-9_-]+)\/orders$/.exec(pathname);
    if (m && method === 'POST') {
      if (!sameOrigin(req)) return errorJson(res, 403, 'Forbidden');
      const table = getTableByToken(m[1]);
      if (!table) return errorJson(res, 404, 'Not found');
      const body = await readJson(req, res);
      if (body === undefined) return;
      const v = validateOrderPayload(body);
      if (v.error) return errorJson(res, 400, v.error);

      // A lost response must remain recoverable even when new submissions
      // are temporarily rate-limited.
      const existing = db
        .prepare('SELECT * FROM orders WHERE table_id = ? AND request_id = ?')
        .get(table.id, body.requestId);
      if (existing) return json(res, 200, { order: orderPayload(existing) });
      if (guestRateLimited(ip, table.token)) {
        res.setHeader('Retry-After', String(GUEST_WINDOW_MS / 1000));
        return errorJson(res, 429, 'Too many submissions');
      }

      // price server-side from published snapshot (integer cents)
      const menuById = new Map(menuItems().map((i) => [i.id, i]));
      const priced = [];
      let total = 0;
      for (const w of v.wanted) {
        const item = menuById.get(w.id);
        if (!item) return errorJson(res, 400, 'Unknown menu item');
        priced.push({ id: item.id, name: item.name, price: item.price, quantity: w.quantity });
        total += item.price * w.quantity;
      }
      const order = {
        id: randomUUID(),
        table_id: table.id,
        table_label: table.label,
        notes: v.notes,
        total_cents: total,
        created_at: new Date().toISOString(),
        request_id: body.requestId,
      };
      insertOrderTx(order, priced);
      return json(res, 201, { order: orderPayload({ ...order, status: 'pending' }) });
    }

    // Everything below: authenticated admin area
    if (!getSession(req)) return errorJson(res, 401, 'Authentication required');
    if (method !== 'GET' && !sameOrigin(req)) return errorJson(res, 403, 'Forbidden');

    if (pathname === '/api/admin/tables' && method === 'GET') {
      const rows = db.prepare('SELECT * FROM restaurant_tables ORDER BY id').all();
      return json(res, 200, { tables: rows.map(tableRow) });
    }

    if (pathname === '/api/admin/tables' && method === 'POST') {
      const body = await readJson(req, res);
      if (body === undefined) return;
      if (!isNonEmptyString(body.label, 100)) return errorJson(res, 400, 'label is required (1-100 chars)');
      const token = randomBytes(32).toString('base64url'); // >= 24 random bytes
      const info = db
        .prepare('INSERT INTO restaurant_tables (label, token, active) VALUES (?, ?, 1)')
        .run(body.label.trim(), token);
      const row = db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(info.lastInsertRowid);
      return json(res, 201, { table: tableRow(row) });
    }

    m = /^\/api\/admin\/tables\/(\d+)$/.exec(pathname);
    if (m && method === 'DELETE') {
      const row = db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(Number(m[1]));
      if (!row) return errorJson(res, 404, 'Not found');
      db.prepare('UPDATE restaurant_tables SET active = 0 WHERE id = ?').run(row.id);
      const updated = db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(row.id);
      return json(res, 200, { table: tableRow(updated) });
    }

    if (pathname === '/api/admin/menu' && method === 'GET') {
      return json(res, 200, { items: menuItems() });
    }

    if (pathname === '/api/admin/menu' && method === 'PUT') {
      const body = await readJson(req, res);
      if (body === undefined) return;
      const items = validateMenuItems(body.items);
      if (!items) return errorJson(res, 400, 'items must be valid menu items with integer cent prices');
      publishTx(items);
      return json(res, 200, { items: menuItems() });
    }

    if (pathname === '/api/admin/orders' && method === 'GET') {
      const rows = db.prepare('SELECT * FROM orders ORDER BY created_at DESC, rowid DESC').all();
      return json(res, 200, { orders: rows.map(orderPayload) });
    }

    m = /^\/api\/admin\/orders\/([0-9a-f-]{36})\/(accept|reject)$/.exec(pathname);
    if (m && method === 'POST') {
      const nextStatus = m[2] === 'accept' ? 'accepted' : 'rejected';
      const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(m[1]);
      if (!row) return errorJson(res, 404, 'Not found');
      if (row.status !== 'pending') {
        return errorJson(res, 409, `Order is already ${row.status}`);
      }
      db.prepare('UPDATE orders SET status = ? WHERE id = ? AND status = ?').run(nextStatus, row.id, 'pending');
      return json(res, 200, { order: orderPayload(db.prepare('SELECT * FROM orders WHERE id = ?').get(row.id)) });
    }

    return errorJson(res, 404, 'Not found');
  }

  // ---- static files ----

  async function serveStatic(req, res, pathname) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return errorJson(res, 400, 'Bad request');
    }
    if (decoded.includes('\0')) return errorJson(res, 400, 'Bad request');

    const resolved = normalize(join(root, decoded));
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      return errorJson(res, 403, 'Forbidden');
    }

    let filePath = resolved;
    try {
      const st = await stat(filePath);
      if (st.isDirectory()) filePath = join(filePath, 'index.html');
      const data = await readFile(filePath);
      const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': type,
        'Cache-Control': filePath.includes(`${sep}assets${sep}`)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      });
      return res.end(data);
    } catch {
      // SPA fallback only for real client routes: /, /login, /q/:token
      const isClientRoute =
        decoded === '/' || decoded === '/login' || decoded.startsWith('/q/');
      if (!extname(decoded) && isClientRoute) {
        try {
          const data = await readFile(join(root, 'index.html'));
          res.writeHead(200, {
            ...SECURITY_HEADERS,
            'Content-Type': MIME['.html'],
            'Cache-Control': 'no-cache',
          });
          return res.end(data);
        } catch {
          /* fall through */
        }
      }
      return errorJson(res, 404, 'Not found');
    }
  }

  const server = createServer((req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      return errorJson(res, 400, 'Bad request');
    }

    if (pathname.startsWith('/api/')) {
      handleApi(req, res, pathname).catch(() => {
        if (!res.headersSent) errorJson(res, 500, 'Internal error');
        else res.end();
      });
      return;
    }

    serveStatic(req, res, pathname).catch(() => {
      if (!res.headersSent) errorJson(res, 500, 'Internal error');
    });
  });

  return {
    server,
    listen: () =>
      new Promise((resolveListen) => {
        server.listen(port, host, () => resolveListen(server.address()));
      }),
    close: () =>
      new Promise((resolveClose) => {
        db.close();
        server.closeAllConnections?.();
        server.close(() => resolveClose());
      }),
  };
}
