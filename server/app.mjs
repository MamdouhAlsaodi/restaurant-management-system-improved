import { createServer } from 'node:http';
import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { openDb } from './db.mjs';

const scrypt = promisify(scryptCb);

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
    for (const [sid, rec] of sessions) if (rec.exp < now) sessions.delete(sid);
  }

  function revokeStaffSessions(staffId) {
    for (const [sid, rec] of sessions) {
      if (rec.actor?.kind === 'staff' && rec.actor.id === staffId) sessions.delete(sid);
    }
  }

  // Returns the session actor ({kind:'owner'} or staff record) or false.
  // Staff sessions are re-checked against the active flag so deactivation
  // always wins, even if the in-memory revoke was missed (e.g. restart).
  function getSession(req) {
    const cookie = req.headers.cookie ?? '';
    const m = /(?:^|;\s*)sid=([A-Za-z0-9_-]+)/.exec(cookie);
    if (!m) return false;
    pruneSessions();
    const rec = sessions.get(m[1]);
    if (!rec || rec.exp < Date.now()) return false;
    if (rec.actor.kind === 'staff') {
      const row = db.prepare('SELECT active FROM staff_users WHERE id = ?').get(rec.actor.id);
      if (!row || !row.active) {
        sessions.delete(m[1]);
        return false;
      }
    }
    return rec.actor;
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
      .prepare('SELECT item_id AS id, name, price_cents AS price, quantity, source FROM order_items WHERE order_id = ?')
      .all(orderRow.id);
    return {
      id: orderRow.id,
      tableId: orderRow.table_id === null ? null : Number(orderRow.table_id),
      tableLabel: orderRow.table_label,
      guestName: orderRow.guest_name ?? orderRow.table_label, // legacy rows fall back to table label
      source: orderRow.source ?? 'guest',
      items,
      total: orderRow.total_cents,
      notes: orderRow.notes ?? '',
      status: orderRow.status,
      createdAt: orderRow.created_at,
      // Kitchen state exists only for accepted/paid orders; pending/rejected
      // rows carry none.
      ...(orderRow.prep_status ? { prepStatus: orderRow.prep_status } : {}),
      ...(orderRow.status === 'paid'
        ? { paidAt: orderRow.paid_at ?? null, paymentMethod: orderRow.payment_method ?? null }
        : {}),
    };
  }

  // Guests never see financial/admin-only payment details.
  function guestOrderPayload(order) {
    const { paidAt, paymentMethod, prepStatus, ...rest } = order;
    return rest;
  }
  function actorOrderPayload(row, actor) {
    const payload = orderPayload(row);
    if (actor.kind !== 'staff' || actor.role !== 'kitchen') return payload;
    const { paidAt, paymentMethod, ...kitchenOnly } = payload;
    return kitchenOnly;
  }

  const PAYMENT_METHODS = new Set(['cash', 'pix', 'cartao', 'ifood_card']);

  function validateItemsRequest(body) {
    if (typeof body.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.requestId)) {
      return { error: 'requestId must be a UUID' };
    }
    if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 50) {
      return { error: 'items must be a non-empty array' };
    }
    const seen = new Set();
    for (const it of body.items) {
      if (typeof it !== 'object' || it === null) return { error: 'invalid item' };
      if (!isNonEmptyString(it.id, 64)) return { error: 'invalid item id' };
      if (!Number.isInteger(it.quantity) || it.quantity < 1 || it.quantity > 99) {
        return { error: 'invalid quantity' };
      }
      if (seen.has(it.id)) return { error: 'duplicate item' };
      seen.add(it.id);
    }
    return { wanted: body.items };
  }

  function menuItems() {
    return db
      .prepare('SELECT id, name, price_cents AS price, image, category, description FROM menu_items ORDER BY rowid')
      .all();
  }

  const insertMenuItem = db.prepare(
    'INSERT INTO menu_items (id, name, price_cents, image, category, description) VALUES (?, ?, ?, ?, ?, ?)'
  );

  // ---- staff accounts (salted scrypt; raw passwords never stored/logged) ----

  const STAFF_ROLES = new Set(['cashier', 'kitchen']);
  const USERNAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
  const STAFF_PASSWORD_MIN = 8;

  async function hashStaffPassword(password, salt) {
    return (await scrypt(password, salt, 64)).toString('hex');
  }

  // Constant-ish work whether or not the username exists (no enumeration).
  async function verifyStaffCredentials(username, password) {
    const row = db.prepare('SELECT * FROM staff_users WHERE username = ?').get(username);
    const salt = row?.salt ?? 'dummy-salt-for-timing';
    const derived = await scrypt(password, salt, 64);
    if (!row || !row.active) return null;
    const stored = Buffer.from(row.password_hash, 'hex');
    if (stored.length !== derived.length || !timingSafeEqual(stored, derived)) return null;
    return { kind: 'staff', id: Number(row.id), username: row.username, role: row.role };
  }

  // ---- append-only audit trail ----

  const insertAudit = db.prepare(
    'INSERT INTO audit_log (at, action, actor_id, actor_role, actor_username, order_id, table_id, request_id, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  // Called inside the same transaction as the domain mutation wherever one
  // exists. Metadata is constructed from safe fields only (never passwords,
  // cookies, tokens, guest names or notes) and bounded in size.
  function auditTx(actor, action, { orderId = null, tableId = null, requestId = null, metadata = null } = {}) {
    const details = metadata === null ? null : JSON.stringify(metadata);
    insertAudit.run(
      new Date().toISOString(),
      action,
      actor.kind === 'owner' ? 'owner' : String(actor.id),
      actor.kind === 'owner' ? 'owner' : actor.role,
      actor.kind === 'owner' ? null : actor.username,
      orderId,
      tableId,
      requestId,
      details === null ? null : details.length <= 2000 ? details : JSON.stringify({ truncated: true })
    );
  }

  function auditRow(r) {
    return {
      id: Number(r.id),
      at: r.at,
      action: r.action,
      actorId: r.actor_id,
      actorRole: r.actor_role,
      ...(r.actor_username ? { actorUsername: r.actor_username } : {}),
      ...(r.order_id ? { orderId: r.order_id } : {}),
      ...(r.table_id !== null && r.table_id !== undefined ? { tableId: Number(r.table_id) } : {}),
      ...(r.request_id ? { requestId: r.request_id } : {}),
      ...(r.metadata ? { metadata: JSON.parse(r.metadata) } : {}),
    };
  }

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

  function publishTx(items, actor) {
    withTransaction(() => {
      db.prepare('DELETE FROM menu_items').run();
      for (const it of items) insertMenuItem.run(it.id, it.name, it.price, it.image ?? null, it.category ?? null, it.description ?? null);
      auditTx(actor, 'menu.publish', { metadata: { count: items.length } });
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

  function insertOrderTx(order, items, actor = null) {
    withTransaction(() => {
      db.prepare(
        'INSERT INTO orders (id, table_id, table_label, guest_name, source, notes, total_cents, status, created_at, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        order.id,
        order.table_id,
        order.table_label,
        order.guest_name,
        order.source ?? 'guest',
        order.notes,
        order.total_cents,
        order.status ?? 'pending',
        order.created_at,
        order.request_id
      );
      const ins = db.prepare(
        'INSERT INTO order_items (order_id, item_id, name, price_cents, quantity, source) VALUES (?, ?, ?, ?, ?, ?)'
      );
      for (const it of items)
        ins.run(order.id, it.id, it.name, it.price, it.quantity, it.source ?? 'guest');
      // Guest submissions are not audited: the audit trail covers staff/owner
      // mutations. No guest names or notes are ever written to audit_log.
      if (actor) {
        auditTx(actor, 'order.create', {
          orderId: order.id,
          tableId: order.table_id,
          requestId: order.request_id,
          metadata: { source: order.source ?? 'guest', itemCount: items.length },
        });
      }
    });
  }

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
    if (!isNonEmptyString(body.guestName, 80)) {
      return { error: 'guestName is required (1-80 chars)' };
    }
    return { wanted, notes: typeof body.notes === 'string' ? body.notes : '', guestName: body.guestName.trim() };
  }

  // ---- API routing ----

  async function handleApi(req, res, pathname) {
    const method = req.method;
    const ip = req.socket.remoteAddress ?? 'unknown';
    // No CORS: reject any /api request whose Origin does not match the host.
    if (!sameOrigin(req)) return errorJson(res, 403, 'Forbidden');

    // Public admin endpoints
    if (pathname === '/api/admin/session' && method === 'GET') {
      const actor = getSession(req);
      return json(res, 200, actor ? { authenticated: true, actor } : { authenticated: false });
    }

    if (pathname === '/api/admin/login' && method === 'POST') {
      if (!sameOrigin(req)) return errorJson(res, 403, 'Forbidden');
      const body = await readJson(req, res);
      if (body === undefined) return;
      if (loginRateLimited(ip)) {
        res.setHeader('Retry-After', String(Math.ceil(LOGIN_WINDOW_MS / 1000)));
        return errorJson(res, 429, 'Too many failed attempts');
      }
      // Backward compatible: password-only body logs in as the owner.
      // Username + password logs in as a staff account. No default staff
      // credentials ever exist; staff must be created by the owner.
      let actor = null;
      if (typeof body.password === 'string' && body.username === undefined) {
        if (safeEqual(body.password, adminPassword)) actor = { kind: 'owner', role: 'owner' };
      } else if (typeof body.username === 'string' && typeof body.password === 'string') {
        actor = await verifyStaffCredentials(body.username, body.password);
      }
      if (!actor) {
        recordLoginFailure(ip);
        await new Promise((r) => setTimeout(r, LOGIN_FAILURE_DELAY_MS)); // fixed delay
        return errorJson(res, 401, 'Invalid credentials');
      }
      loginFailures.delete(ip);
      const sid = randomBytes(32).toString('base64url');
      sessions.set(sid, { exp: Date.now() + SESSION_TTL_MS, actor });
      res.setHeader(
        'Set-Cookie',
        `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secureCookies ? '; Secure' : ''}`
      );
      return json(res, 200, { authenticated: true, actor });
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
      if (existing) return json(res, 200, { order: guestOrderPayload(orderPayload(existing)) });
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
        guest_name: v.guestName,
        source: 'guest',
        notes: v.notes,
        total_cents: total,
        created_at: new Date().toISOString(),
        request_id: body.requestId,
      };
      insertOrderTx(order, priced);
      const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
      return json(res, 201, { order: guestOrderPayload(orderPayload(row)) });
    }

    // Everything below: authenticated admin area. Sessions carry the actor
    // (owner or staff with role); permissions are enforced server-side here.
    const actor = getSession(req);
    if (!actor) return errorJson(res, 401, 'Authentication required');
    if (method !== 'GET' && !sameOrigin(req)) return errorJson(res, 403, 'Forbidden');
    const isOwner = actor.kind === 'owner';
    const role = isOwner ? 'owner' : actor.role;
    const canCashier = isOwner || role === 'cashier';

    // Owner-only: staff management and audit viewing.
    if (pathname === '/api/admin/staff' && method === 'POST') {
      if (!isOwner) return errorJson(res, 403, 'Owner only');
      const body = await readJson(req, res);
      if (body === undefined) return;
      if (typeof body.username !== 'string' || !USERNAME_RE.test(body.username.trim())) {
        return errorJson(res, 400, 'username must be 1-64 chars of letters, digits, dot, dash or underscore');
      }
      if (typeof body.password !== 'string' || body.password.length < STAFF_PASSWORD_MIN || body.password.length > 200) {
        return errorJson(res, 400, `password must be a string of at least ${STAFF_PASSWORD_MIN} characters`);
      }
      if (!STAFF_ROLES.has(body.role)) {
        return errorJson(res, 400, "role must be 'cashier' or 'kitchen'");
      }
      const username = body.username.trim();
      const exists = db.prepare('SELECT 1 FROM staff_users WHERE username = ?').get(username);
      if (exists) return errorJson(res, 409, 'username already exists');
      const salt = randomBytes(16).toString('hex');
      const passwordHash = await hashStaffPassword(body.password, salt);
      const info = withTransaction(() => {
        const created = db
          .prepare('INSERT INTO staff_users (username, password_hash, salt, role, active, created_at) VALUES (?, ?, ?, ?, 1, ?)')
          .run(username, passwordHash, salt, body.role, new Date().toISOString());
        auditTx(actor, 'staff.create', { metadata: { username, role: body.role } });
        return created;
      });
      return json(res, 201, {
        staff: { id: Number(info.lastInsertRowid), username, role: body.role, active: true },
      });
    }

    m = /^\/api\/admin\/staff\/(\d+)\/deactivate$/.exec(pathname);
    if (m && method === 'POST') {
      if (!isOwner) return errorJson(res, 403, 'Owner only');
      const id = Number(m[1]);
      const row = db.prepare('SELECT * FROM staff_users WHERE id = ?').get(id);
      if (!row) return errorJson(res, 404, 'Not found');
      withTransaction(() => {
        db.prepare('UPDATE staff_users SET active = 0 WHERE id = ?').run(id);
        auditTx(actor, 'staff.deactivate', { metadata: { username: row.username } });
      });
      revokeStaffSessions(id);
      return json(res, 200, {
        staff: { id, username: row.username, role: row.role, active: false },
      });
    }

    if (pathname === '/api/admin/staff' && method === 'GET') {
      if (!isOwner) return errorJson(res, 403, 'Owner only');
      const rows = db.prepare('SELECT id, username, role, active, created_at FROM staff_users ORDER BY id').all();
      return json(res, 200, {
        staff: rows.map((r) => ({ id: Number(r.id), username: r.username, role: r.role, active: !!r.active, createdAt: r.created_at })),
      });
    }

    if (pathname === '/api/admin/audit' && method === 'GET') {
      if (!isOwner) return errorJson(res, 403, 'Owner only');
      const url = new URL(req.url ?? '/', 'http://localhost');
      let limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
      let offset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10);
      if (!Number.isFinite(limit) || limit < 1) limit = 50;
      if (limit > 200) limit = 200;
      if (!Number.isFinite(offset) || offset < 0) offset = 0;
      const rows = db
        .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?')
        .all(limit, offset);
      const total = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
      return json(res, 200, { events: rows.map(auditRow), total, limit, offset });
    }

    if (pathname === '/api/admin/tables' && method === 'GET') {
      if (!canCashier) return errorJson(res, 403, 'Forbidden for this role');
      const rows = db.prepare('SELECT * FROM restaurant_tables ORDER BY id').all();
      return json(res, 200, { tables: rows.map(tableRow) });
    }

    if (pathname === '/api/admin/tables' && method === 'POST') {
      if (!isOwner) return errorJson(res, 403, 'Owner only');
      const body = await readJson(req, res);
      if (body === undefined) return;
      if (!isNonEmptyString(body.label, 100)) return errorJson(res, 400, 'label is required (1-100 chars)');
      const token = randomBytes(32).toString('base64url'); // >= 24 random bytes
      const info = withTransaction(() => {
        const created = db
          .prepare('INSERT INTO restaurant_tables (label, token, active) VALUES (?, ?, 1)')
          .run(body.label.trim(), token);
        auditTx(actor, 'table.create', { tableId: Number(created.lastInsertRowid) });
        return created;
      });
      const row = db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(info.lastInsertRowid);
      return json(res, 201, { table: tableRow(row) });
    }

    m = /^\/api\/admin\/tables\/(\d+)$/.exec(pathname);
    if (m && method === 'DELETE') {
      if (!isOwner) return errorJson(res, 403, 'Owner only');
      const row = db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(Number(m[1]));
      if (!row) return errorJson(res, 404, 'Not found');
      withTransaction(() => {
        db.prepare('UPDATE restaurant_tables SET active = 0 WHERE id = ?').run(row.id);
        auditTx(actor, 'table.deactivate', { tableId: Number(row.id) });
      });
      const updated = db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(row.id);
      return json(res, 200, { table: tableRow(updated) });
    }

    if (pathname === '/api/admin/menu' && method === 'GET') {
      if (!canCashier) return errorJson(res, 403, 'Forbidden for this role');
      return json(res, 200, { items: menuItems() });
    }

    if (pathname === '/api/admin/menu' && method === 'PUT') {
      if (!isOwner) return errorJson(res, 403, 'Owner only');
      const body = await readJson(req, res);
      if (body === undefined) return;
      const items = validateMenuItems(body.items);
      if (!items) return errorJson(res, 400, 'items must be valid menu items with integer cent prices');
      publishTx(items, actor);
      return json(res, 200, { items: menuItems() });
    }

    if (pathname === '/api/admin/orders' && method === 'GET') {
      const rows = actor.kind === 'staff' && actor.role === 'kitchen'
        ? db.prepare("SELECT * FROM orders WHERE status IN ('accepted', 'paid') ORDER BY created_at DESC, rowid DESC").all()
        : db.prepare('SELECT * FROM orders ORDER BY created_at DESC, rowid DESC').all();
      return json(res, 200, { orders: rows.map((row) => actorOrderPayload(row, actor)) });
    }

    if (pathname === '/api/admin/orders' && method === 'POST') {
      if (!canCashier) return errorJson(res, 403, 'Forbidden for this role');
      const body = await readJson(req, res);
      if (body === undefined) return;
      if (typeof body.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.requestId)) {
        return errorJson(res, 400, 'requestId must be a UUID');
      }
      if (!isNonEmptyString(body.guestName, 80)) {
        return errorJson(res, 400, 'guestName is required (1-80 chars)');
      }
      // Replay before table lookup: a previously-created order must remain
      // recoverable even if the table was deactivated after a lost response.
      const existing = db
        .prepare("SELECT * FROM orders WHERE source = 'cashier' AND request_id = ?")
        .get(body.requestId);
      if (existing) return json(res, 200, { order: orderPayload(existing) });
      let table = null;
      if (body.tableId !== undefined) {
        if (!Number.isInteger(body.tableId) || body.tableId < 1) {
          return errorJson(res, 400, 'tableId must be a known table id');
        }
        table = db.prepare('SELECT * FROM restaurant_tables WHERE id = ? AND active = 1').get(body.tableId);
        if (!table) return errorJson(res, 400, 'tableId must be a known active table id');
      }
      const order = {
        id: randomUUID(),
        table_id: table ? table.id : null,
        table_label: table ? table.label : 'كاشير',
        guest_name: body.guestName.trim(),
        source: 'cashier',
        notes: '',
        total_cents: 0,
        status: 'accepted',
        created_at: new Date().toISOString(),
        request_id: body.requestId,
      };
      insertOrderTx(order, [], actor);
      const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
      return json(res, 201, { order: orderPayload(row) });
    }

    m = /^\/api\/admin\/orders\/([0-9a-f-]{36})\/items$/.exec(pathname);
    if (m && method === 'POST') {
      if (!canCashier) return errorJson(res, 403, 'Forbidden for this role');
      const body = await readJson(req, res);
      if (body === undefined) return;
      const v = validateItemsRequest(body);
      if (v.error) return errorJson(res, 400, v.error);
      const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(m[1]);
      if (!row) return errorJson(res, 404, 'Not found');
      // Ledger, not merely the last request: a delayed retry can arrive after
      // other additions or payment and must still be a replay, never a second charge.
      if (db.prepare('SELECT 1 FROM order_item_requests WHERE order_id = ? AND request_id = ?').get(row.id, body.requestId)) {
        return json(res, 200, { order: orderPayload(row) });
      }
      if (row.status !== 'accepted') {
        return errorJson(res, 409, `Order is ${row.status}; only accepted unpaid orders can be modified`);
      }
      const menuById = new Map(menuItems().map((i) => [i.id, i]));
      const priced = [];
      let added = 0;
      for (const w of v.wanted) {
        const item = menuById.get(w.id);
        if (!item) return errorJson(res, 400, 'Unknown menu item');
        priced.push({ id: item.id, name: item.name, price: item.price, quantity: w.quantity, source: 'cashier' });
        added += item.price * w.quantity;
      }
      withTransaction(() => {
        db.prepare('INSERT INTO order_item_requests (order_id, request_id) VALUES (?, ?)').run(row.id, body.requestId);
        const ins = db.prepare(
          'INSERT INTO order_items (order_id, item_id, name, price_cents, quantity, source) VALUES (?, ?, ?, ?, ?, ?)'
        );
        for (const it of priced) ins.run(row.id, it.id, it.name, it.price, it.quantity, it.source);
        db.prepare('UPDATE orders SET total_cents = total_cents + ?, last_request_id = ? WHERE id = ?').run(
          added,
          body.requestId,
          row.id
        );
        auditTx(actor, 'order.add_items', {
          orderId: row.id,
          requestId: body.requestId,
          metadata: { items: v.wanted.map((w) => ({ id: w.id, quantity: w.quantity })), addedCents: added },
        });
      });
      const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(row.id);
      return json(res, 200, { order: orderPayload(updated) });
    }

    m = /^\/api\/admin\/orders\/([0-9a-f-]{36})\/checkout$/.exec(pathname);
    if (m && method === 'POST') {
      if (!canCashier) return errorJson(res, 403, 'Forbidden for this role');
      const body = await readJson(req, res);
      if (body === undefined) return;
      if (!PAYMENT_METHODS.has(body.paymentMethod)) {
        return errorJson(res, 400, 'paymentMethod must be one of cash, pix, cartao, ifood_card');
      }
      const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(m[1]);
      if (!row) return errorJson(res, 404, 'Not found');
      if (row.status === 'paid') {
        // Idempotent on repeated matching payment; conflict on a different method.
        if (row.payment_method === body.paymentMethod) {
          return json(res, 200, { order: orderPayload(row) });
        }
        return errorJson(res, 409, `Order already paid with ${row.payment_method}`);
      }
      if (row.status !== 'accepted') {
        return errorJson(res, 409, `Order is ${row.status}; only accepted orders can be paid`);
      }
      const itemCount = db.prepare('SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?').get(row.id).n;
      if (itemCount === 0) return errorJson(res, 400, 'Cannot pay an empty order');
      const info = withTransaction(() => {
        const updated = db.prepare(
          "UPDATE orders SET status = 'paid', paid_at = ?, payment_method = ? WHERE id = ? AND status = 'accepted'"
        ).run(new Date().toISOString(), body.paymentMethod, row.id);
        if (updated.changes > 0) auditTx(actor, 'order.checkout', { orderId: row.id, metadata: { paymentMethod: body.paymentMethod } });
        return updated;
      });
      if (info.changes === 0) return errorJson(res, 409, 'Order changed concurrently; refresh and retry');
      const paid = db.prepare('SELECT * FROM orders WHERE id = ?').get(row.id);
      return json(res, 200, { order: orderPayload(paid) });
    }

    m = /^\/api\/admin\/orders\/([0-9a-f-]{36})\/(accept|reject)$/.exec(pathname);
    if (m && method === 'POST') {
      if (!canCashier) return errorJson(res, 403, 'Forbidden for this role');
      const nextStatus = m[2] === 'accept' ? 'accepted' : 'rejected';
      const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(m[1]);
      if (!row) return errorJson(res, 404, 'Not found');
      if (row.status !== 'pending') {
        return errorJson(res, 409, `Order is already ${row.status}`);
      }
      const info = withTransaction(() => {
        const updated = nextStatus === 'accepted'
          ? db.prepare("UPDATE orders SET status = 'accepted', prep_status = 'waiting' WHERE id = ? AND status = 'pending'").run(row.id)
          : db.prepare("UPDATE orders SET status = 'rejected' WHERE id = ? AND status = 'pending'").run(row.id);
        if (updated.changes > 0) auditTx(actor, nextStatus === 'accepted' ? 'order.accept' : 'order.reject', { orderId: row.id });
        return updated;
      });
      if (info.changes === 0) return errorJson(res, 409, 'Order changed concurrently; refresh and retry');
      return json(res, 200, { order: orderPayload(db.prepare('SELECT * FROM orders WHERE id = ?').get(row.id)) });
    }

    // Optional kitchen screen: persisted preparation state, strictly sequential
    // waiting -> preparing -> ready -> served, independent of payment status.
    m = /^\/api\/admin\/orders\/([0-9a-f-]{36})\/preparation$/.exec(pathname);
    if (m && method === 'POST') {
      if (!(isOwner || role === 'kitchen')) return errorJson(res, 403, 'Forbidden for this role');
      const body = await readJson(req, res);
      if (body === undefined) return;
      const next = body.status;
      if (next !== 'preparing' && next !== 'ready' && next !== 'served') {
        return errorJson(res, 400, "status must be one of 'preparing', 'ready', 'served'");
      }
      const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(m[1]);
      if (!row) return errorJson(res, 404, 'Not found');
      if (row.status === 'pending' || row.status === 'rejected') {
        return errorJson(res, 409, `Order is ${row.status}; kitchen applies only to accepted or paid orders`);
      }
      // Legacy accepted/paid rows migrated with a NULL prep_status behave as 'waiting'.
      const current = row.prep_status ?? 'waiting';
      if (current === next) {
        return json(res, 200, { order: actorOrderPayload(row, actor) }); // idempotent same state
      }
      const NEXT = { waiting: 'preparing', preparing: 'ready', ready: 'served' };
      if (NEXT[current] !== next) {
        return errorJson(res, 409, `Kitchen state must advance sequentially; cannot go ${current} -> ${next}`);
      }
      // Atomic conditional update: a concurrent transition cannot be overwritten.
      const info = withTransaction(() => {
        const updated = db
          .prepare('UPDATE orders SET prep_status = ? WHERE id = ? AND prep_status IS ?')
          .run(next, row.id, row.prep_status);
        if (updated.changes > 0) auditTx(actor, 'order.preparation', { orderId: row.id, metadata: { from: current, to: next } });
        return updated;
      });
      if (info.changes === 0) {
        return errorJson(res, 409, 'Kitchen state changed concurrently; retry with fresh data');
      }
      return json(res, 200, { order: actorOrderPayload(db.prepare('SELECT * FROM orders WHERE id = ?').get(row.id), actor) });
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
