import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync, existsSync, symlinkSync, writeFileSync, mkdtempSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { runBackup, runRestore } from '../../scripts/restaurant-backup.mjs';

const REQUIRED_TABLES = [
  'restaurant_tables',
  'menu_items',
  'orders',
  'order_item_requests',
  'order_items',
];

function newDbPath(name = 'db.sqlite') {
  const dir = mkdtempSync(join(tmpdir(), 'backup-test-'));
  return { dir, path: join(dir, name) };
}

// Minimal app-shaped database: schema + a few rows of each domain.
function seedDb(path, { wal = true } = {}) {
  const db = new DatabaseSync(path);
  if (wal) db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE restaurant_tables (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, token TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE menu_items (id TEXT PRIMARY KEY, name TEXT NOT NULL, price_cents INTEGER NOT NULL, image TEXT, category TEXT, description TEXT);
    CREATE TABLE orders (id TEXT PRIMARY KEY, table_id INTEGER, table_label TEXT NOT NULL, guest_name TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'guest', notes TEXT, total_cents INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, request_id TEXT NOT NULL, last_request_id TEXT, paid_at TEXT, payment_method TEXT);
    CREATE TABLE order_item_requests (order_id TEXT NOT NULL REFERENCES orders(id), request_id TEXT NOT NULL, PRIMARY KEY (order_id, request_id));
    CREATE TABLE order_items (order_id TEXT NOT NULL REFERENCES orders(id), item_id TEXT NOT NULL, name TEXT NOT NULL, price_cents INTEGER NOT NULL, quantity INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'guest');
  `);
  db.prepare("INSERT INTO restaurant_tables (label, token) VALUES ('Mesa 1', 'tok-1')").run();
  db.prepare("INSERT INTO menu_items (id, name, price_cents) VALUES ('m1', 'Pizza', 5000)").run();
  db.prepare("INSERT INTO orders (id, table_id, table_label, total_cents, status, created_at, request_id) VALUES ('o1', 1, 'Mesa 1', 5000, 'pending', '2025-01-01T00:00:00Z', 'r1')").run();
  db.prepare("INSERT INTO order_items (order_id, item_id, name, price_cents, quantity) VALUES ('o1', 'm1', 'Pizza', 5000, 1)").run();
  return db;
}

function rowCount(path, table) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  } finally {
    db.close();
  }
}

test('backup writes consistent copy including rows and WAL content', async () => {
  const src = newDbPath();
  const db = seedDb(src.path);
  // Keep the live connection open (WAL mode) while backing up.
  const out = join(src.dir, 'out.sqlite');
  await runBackup({ db: src.path, out });
  assert.equal(existsSync(out), true);
  assert.equal(rowCount(out, 'restaurant_tables'), 1);
  assert.equal(rowCount(out, 'menu_items'), 1);
  assert.equal(rowCount(out, 'orders'), 1);
  assert.equal(rowCount(out, 'order_items'), 1);
  db.close();
});

test('backup output has restrictive permissions (no group/other access)', async () => {
  const src = newDbPath();
  seedDb(src.path).close();
  const out = join(src.dir, 'out.sqlite');
  await runBackup({ db: src.path, out });
  const mode = statSync(out).mode & 0o777;
  assert.equal(mode & 0o077, 0, `expected no group/other bits, got ${mode.toString(8)}`);
});

test('backup refuses to overwrite an existing destination', async () => {
  const src = newDbPath();
  seedDb(src.path).close();
  const out = join(src.dir, 'out.sqlite');
  writeFileSync(out, 'existing');
  await assert.rejects(() => runBackup({ db: src.path, out }), /exists/i);
  assert.equal(statSync(out).size, 'existing'.length, 'destination must be untouched');
});

test('backup removes its newly created destination if source copy fails', async () => {
  const src = newDbPath('corrupt.sqlite');
  writeFileSync(src.path, 'not a sqlite database');
  const out = join(src.dir, 'retry.sqlite');
  await assert.rejects(() => runBackup({ db: src.path, out }));
  assert.equal(existsSync(out), false, 'failed copy must not block retry at the same path');
});

test('backup verifies integrity of the output', async () => {
  const src = newDbPath();
  seedDb(src.path).close();
  const out = join(src.dir, 'out.sqlite');
  await runBackup({ db: src.path, out }); // must not throw
});

test('backup errors do not leak paths or secrets', async () => {
  const src = newDbPath();
  seedDb(src.path).close();
  const out = join(src.dir, 'out.sqlite');
  // Force a failure: destination is a directory.
  const { mkdirSync } = await import('node:fs');
  const asDir = join(src.dir, 'adir');
  mkdirSync(asDir);
  await assert.rejects(() => runBackup({ db: src.path, out: asDir }), (err) => {
    const msg = `${err.message}`;
    return !msg.includes(src.dir) && !msg.includes('/');
  });
});

// ---------- restore ----------

test('restore requires --confirm-restore', async () => {
  const a = newDbPath('a.sqlite');
  const b = newDbPath('b.sqlite');
  seedDb(a.path).close();
  seedDb(b.path).close();
  await assert.rejects(
    () => runRestore({ from: a.path, to: b.path, confirmRestore: false }),
    /confirm/i,
  );
  // Target unchanged.
  assert.equal(rowCount(b.path, 'restaurant_tables'), 1);
});

test('restore refuses identical source and target', async () => {
  const a = newDbPath('a.sqlite');
  seedDb(a.path).close();
  await assert.rejects(
    () => runRestore({ from: a.path, to: a.path, confirmRestore: true }),
    /different/i,
  );
});

test('restore validates source integrity and schema before touching target', async () => {
  const a = newDbPath('a.sqlite');
  const b = newDbPath('b.sqlite');
  // Corrupt source: valid sqlite header but missing required tables.
  seedDb(a.path).close();
  const bad = new DatabaseSync(a.path);
  bad.exec('DROP TABLE order_items;');
  bad.close();
  seedDb(b.path).close();
  await assert.rejects(() => runRestore({ from: a.path, to: b.path, confirmRestore: true }), /schema|integrity/i);
  assert.equal(rowCount(b.path, 'orders'), 1, 'target untouched after failed restore');
});

test('restore rejects corrupted source file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-test-'));
  const bad = join(dir, 'corrupt.sqlite');
  writeFileSync(bad, Buffer.alloc(4096, 0)); // garbage, not a database
  const b = newDbPath('b.sqlite');
  seedDb(b.path).close();
  await assert.rejects(() => runRestore({ from: bad, to: b.path, confirmRestore: true }), /integrity|not a database/i);
  assert.equal(rowCount(b.path, 'orders'), 1);
});

test('restore rejects live target with WAL sidecar files', async () => {
  const a = newDbPath('a.sqlite');
  const b = newDbPath('b.sqlite');
  seedDb(a.path).close();
  seedDb(b.path).close();
  writeFileSync(`${b.path}-wal`, 'x');
  await assert.rejects(() => runRestore({ from: a.path, to: b.path, confirmRestore: true }), /sidecar|live/i);
});

test('restore rejects locked target and leaves it unchanged', async () => {
  const a = newDbPath('a.sqlite');
  const b = newDbPath('b.sqlite');
  seedDb(a.path).close();
  const target = seedDb(b.path);
  target.exec('BEGIN EXCLUSIVE;');
  await assert.rejects(() => runRestore({ from: a.path, to: b.path, confirmRestore: true }), /sidecar|live|lock|busy/i);
  target.exec('ROLLBACK;');
  target.close();
  assert.equal(rowCount(b.path, 'orders'), 1);
});

test('restore refuses symlinked source or target', async () => {
  const a = newDbPath('a.sqlite');
  const real = newDbPath('real.sqlite');
  const link = newDbPath('link.sqlite');
  seedDb(a.path).close();
  seedDb(real.path).close();
  symlinkSync(real.path, link.path);
  await assert.rejects(() => runRestore({ from: a.path, to: link.path, confirmRestore: true }), /symlink/i);
  await assert.rejects(() => runRestore({ from: link.path, to: a.path, confirmRestore: true }), /symlink/i);
});

test('successful restore swaps target and preserves rollback copy, no auto delete', async () => {
  const a = newDbPath('a.sqlite');
  const b = newDbPath('b.sqlite');
  const db = seedDb(a.path);
  db.prepare("INSERT INTO restaurant_tables (label, token) VALUES ('Mesa 2', 'tok-2')").run();
  db.close();
  seedDb(b.path).close();
  await runRestore({ from: a.path, to: b.path, confirmRestore: true });
  assert.equal(rowCount(b.path, 'restaurant_tables'), 2, 'target now has restored rows');
  // Rollback copy preserved in same directory.
  const entries = (await import('node:fs')).readdirSync(b.dir);
  const backups = entries.filter((e) => e.includes('pre-restore'));
  assert.equal(backups.length, 1, `expected one preserved rollback copy, got ${backups}`);
  assert.equal(rowCount(join(b.dir, backups[0]), 'restaurant_tables'), 1, 'rollback copy holds original data');
});

test('failed restore (locked target) leaves original recovery copy logic intact — no partial writes', async () => {
  const a = newDbPath('a.sqlite');
  const b = newDbPath('b.sqlite');
  seedDb(a.path).close();
  const target = seedDb(b.path);
  target.exec('BEGIN EXCLUSIVE;');
  await assert.rejects(() => runRestore({ from: a.path, to: b.path, confirmRestore: true }));
  target.close();
  // No stray pre-restore copy created for a rejected restore.
  const entries = (await import('node:fs')).readdirSync(b.dir);
  assert.equal(entries.filter((e) => e.includes('pre-restore')).length, 0);
});

test('documented CLI executes backup rather than exiting silently', () => {
  const src = newDbPath();
  seedDb(src.path).close();
  const out = join(src.dir, 'cli.sqlite');
  const script = new URL('../../scripts/restaurant-backup.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname, 'backup', '--db', src.path, '--out', out], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /complete and verified/);
  assert.equal(rowCount(out, 'orders'), 1);
});

test('documented CLI restore preserves original recovery copy', () => {
  const source = newDbPath('source.sqlite');
  const target = newDbPath('target.sqlite');
  const seeded = seedDb(source.path);
  seeded.prepare("INSERT INTO restaurant_tables (label, token) VALUES ('Mesa 2', 'tok-2')").run();
  seeded.close();
  seedDb(target.path).close();
  const script = new URL('../../scripts/restaurant-backup.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname, 'restore', '--from', source.path, '--to', target.path, '--confirm-restore'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rollback copy preserved/);
  assert.equal(rowCount(target.path, 'restaurant_tables'), 2);
});

test('CLI failure exits nonzero without leaking sensitive paths', () => {
  const secret = newDbPath('secret-database.sqlite');
  const script = new URL('../../scripts/restaurant-backup.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname, 'backup', '--db', secret.path, '--out', join(secret.dir, 'out.sqlite')], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.ok(!result.stderr.includes(secret.dir));
});

test('restore refuses a missing target without creating it', async () => {
  const source = newDbPath('source.sqlite');
  const target = newDbPath('missing.sqlite');
  seedDb(source.path).close();
  await assert.rejects(() => runRestore({ from: source.path, to: target.path, confirmRestore: true }), /target|exist/i);
  assert.equal(existsSync(target.path), false);
});

test('restored target and rollback copy remain owner-only', async () => {
  const source = newDbPath('source.sqlite');
  const target = newDbPath('target.sqlite');
  seedDb(source.path).close();
  seedDb(target.path).close();
  await runRestore({ from: source.path, to: target.path, confirmRestore: true });
  assert.equal(statSync(target.path).mode & 0o077, 0);
  const { readdirSync } = await import('node:fs');
  const rollback = readdirSync(target.dir).find((name) => name.includes('.pre-restore.'));
  assert.ok(rollback);
  assert.equal(statSync(join(target.dir, rollback)).mode & 0o077, 0);
});
