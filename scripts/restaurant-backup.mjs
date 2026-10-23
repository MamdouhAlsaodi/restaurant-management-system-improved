#!/usr/bin/env node
// Safe SQLite backup + guarded offline restore for the restaurant database
// (tables, menu, orders). Requires Node >= 24 (built-in node:sqlite).
//
// Usage:
//   node scripts/restaurant-backup.mjs backup --db <live.sqlite> --out <backup.sqlite>
//   node scripts/restaurant-backup.mjs restore --from <backup.sqlite> --to <target.sqlite> --confirm-restore
//
// Notes:
// - Backup uses the SQLite online backup API, so the copy is consistent even
//   while the live database is running in WAL mode. It is not a naive copy.
// - Restore is OFFLINE only: it refuses a live target (WAL/SHM sidecar files,
//   locks), refuses symlinked paths, verifies source integrity and schema
//   before touching the target, and preserves a rollback copy of the original
//   target next to it. Nothing is deleted automatically.
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { lstatSync, fstatSync, unlinkSync, copyFileSync, renameSync, openSync, closeSync, existsSync, chmodSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REQUIRED_TABLES = [
  'restaurant_tables',
  'menu_items',
  'orders',
  'order_item_requests',
  'order_items',
];

// Minimal per-table column contract the app relies on.
const REQUIRED_COLUMNS = {
  restaurant_tables: ['id', 'label', 'token', 'active'],
  menu_items: ['id', 'name', 'price_cents'],
  orders: ['id', 'table_label', 'total_cents', 'status', 'created_at', 'request_id'],
  order_item_requests: ['order_id', 'request_id'],
  order_items: ['order_id', 'item_id', 'name', 'price_cents', 'quantity', 'source'],
};

// Errors must never include filesystem paths or secrets.
function safeError(message) {
  // Public CLI/API errors deliberately omit underlying filesystem exceptions:
  // their messages and stacks can contain customer backup paths.
  return new Error(message);
}

function stripPath(text) {
  // Replace any path-like sequence with a placeholder before surfacing a message.
  return String(text ?? '').replace(/(?:\/|\\|[A-Za-z]:\\)[^\s'"]*/g, '<path>');
}

// Resolve to an absolute path and refuse symlinks in the final component
// (symlink traps: a swapped link could redirect a write). The path itself may
// not exist yet (backup destination).
function realPathNoSymlink(p) {
  const abs = resolve(p);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return { abs, st: null }; // does not exist yet: fine for a new destination
  }
  if (st.isSymbolicLink()) {
    throw safeError('refusing to operate on a symlink');
  }
  return { abs, st };
}

function integrityOk(db) {
  const rows = db.prepare('PRAGMA integrity_check;').all();
  return rows.length === 1 && rows[0].integrity_check === 'ok';
}

function foreignKeysOk(db) {
  return db.prepare('PRAGMA foreign_key_check;').all().length === 0;
}

function schemaOk(db) {
  for (const table of REQUIRED_TABLES) {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (!row) return false;
    const cols = db.prepare(`PRAGMA table_info(${table});`).all().map((c) => c.name);
    for (const col of REQUIRED_COLUMNS[table]) {
      if (!cols.includes(col)) return false;
    }
  }
  return true;
}

// ---------------- backup ----------------

export async function runBackup({ db: dbPath, out: outPath }) {
  if (!dbPath || !outPath) throw safeError('backup requires --db and --out');

  const src = realPathNoSymlink(dbPath);
  if (!src.st || !src.st.isFile()) throw safeError('source database not found');
  const dest = realPathNoSymlink(outPath);

  // Refuse to overwrite an existing destination.
  if (existsSync(dest.abs)) {
    throw safeError('destination already exists; refusing to overwrite');
  }

  // Pre-create the destination exclusively with restrictive permissions so no
  // other process (or user) can race a permissive file into place.
  let fd;
  let created;
  try {
    fd = openSync(dest.abs, 'wx', 0o600);
    created = fstatSync(fd);
  } catch (err) {
    throw safeError('cannot create destination file');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  try {
    let srcDb;
    try {
      srcDb = new DatabaseSync(src.abs, { readOnly: true });
      await sqliteBackup(srcDb, dest.abs);
    } catch (err) {
      throw safeError(`backup failed: ${stripPath(err?.message)}`);
    } finally {
      try { srcDb?.close(); } catch { /* ignore */ }
    }

    // Verify the produced backup before declaring success.
    let outDb;
    try {
      outDb = new DatabaseSync(dest.abs, { readOnly: true });
      if (!integrityOk(outDb)) throw safeError('backup failed integrity check');
    } catch (err) {
      throw safeError(`backup verification failed: ${stripPath(err?.message)}`);
    } finally {
      try { outDb?.close(); } catch { /* ignore */ }
    }
  } catch (err) {
    // Do not leave a failed partial copy that permanently blocks a retry.
    // Only remove the inode this invocation created, never a replacement.
    try {
      const current = lstatSync(dest.abs);
      if (current.dev === created.dev && current.ino === created.ino) unlinkSync(dest.abs);
    } catch { /* preserve original failure */ }
    throw err;
  }
}

// ---------------- restore (offline, guarded) ----------------

function assertRestorableSource(fromPath) {
  const src = realPathNoSymlink(fromPath);
  let db;
  try {
    db = new DatabaseSync(src.abs, { readOnly: true });
    if (!integrityOk(db)) throw safeError('source failed integrity check');
    if (!schemaOk(db)) throw safeError('source schema does not match required application schema');
    if (!foreignKeysOk(db)) throw safeError('source has foreign key violations');
  } catch (err) {
    throw safeError(`source validation failed: ${stripPath(err?.message)}`);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
  return src;
}

function assertOfflineTarget(toPath) {
  const target = realPathNoSymlink(toPath);
  if (!target.st?.isFile()) throw safeError('target database must already exist');
  // Sidecar files mean the database is live (or was not shut down cleanly).
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${target.abs}${suffix}`)) {
      throw safeError(`target appears live: ${suffix.slice(1)} sidecar file present`);
    }
  }
  // A locked target means some process is using it.
  let db;
  try {
    db = new DatabaseSync(target.abs);
    db.exec('BEGIN EXCLUSIVE;');
    db.exec('COMMIT;');
  } catch (err) {
    throw safeError(`target is locked or unreadable: ${stripPath(err?.message)}`);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
  return target;
}

export async function runRestore({ from: fromPath, to: toPath, confirmRestore = false }) {
  if (!confirmRestore) {
    throw safeError('restore requires explicit --confirm-restore');
  }

  const src = realPathNoSymlink(fromPath);
  const target = realPathNoSymlink(toPath);
  if (src.abs === target.abs) {
    throw safeError('source and target must be different paths');
  }

  // Phase 1: fully validate the source BEFORE touching the target.
  assertRestorableSource(src.abs);

  // Phase 2: assert the target is offline and writable.
  assertOfflineTarget(target.abs);

  // Phase 3: preserve a rollback copy of the original target in the same
  // directory. It is never deleted automatically.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rollbackName = `${basename(target.abs)}.pre-restore.${stamp}.${randomBytes(3).toString('hex')}.bak`;
  const rollbackPath = join(dirname(target.abs), rollbackName);
  closeSync(openSync(rollbackPath, 'wx', 0o600));
  copyFileSync(target.abs, rollbackPath);
  chmodSync(rollbackPath, 0o600);

  // Phase 4: stage the restored database in the same directory, then atomically
  // swap it into place.
  const stagingPath = join(dirname(target.abs), `.${basename(target.abs)}.restore-${randomBytes(4).toString('hex')}.tmp`);
  closeSync(openSync(stagingPath, 'wx', 0o600));
  let sourceDb;
  try {
    sourceDb = new DatabaseSync(src.abs, { readOnly: true });
    await sqliteBackup(sourceDb, stagingPath);
    chmodSync(stagingPath, 0o600);
  } catch (err) {
    throw safeError(`restore staging failed: ${stripPath(err?.message)}`);
  } finally {
    try { sourceDb?.close(); } catch { /* ignore */ }
  }

  // Verify the staged copy before swapping.
  let verifyDb;
  try {
    verifyDb = new DatabaseSync(stagingPath, { readOnly: true });
    if (!integrityOk(verifyDb)) throw safeError('staged restore failed integrity check');
    if (!schemaOk(verifyDb)) throw safeError('staged restore schema mismatch');
    if (!foreignKeysOk(verifyDb)) throw safeError('staged restore foreign key mismatch');
  } finally {
    try { verifyDb?.close(); } catch { /* ignore */ }
  }

  renameSync(stagingPath, target.abs);
}

// ---------------- CLI ----------------

async function main(argv) {
  const [command, ...rest] = argv;
  const args = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--confirm-restore') args.confirmRestore = true;
    else if (a.startsWith('--')) args[a.slice(2)] = rest[++i];
  }
  if (command === 'backup') {
    await runBackup({ db: args.db, out: args.out });
    process.stdout.write('backup complete and verified\n');
  } else if (command === 'restore') {
    await runRestore({ from: args.from, to: args.to, confirmRestore: args.confirmRestore === true });
    process.stdout.write('restore complete; rollback copy preserved next to the target\n');
  } else {
    process.stderr.write('usage: see header comment in scripts/restaurant-backup.mjs\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${stripPath(err?.message ?? 'backup or restore failed')}\n`);
    process.exitCode = 1;
  }
}
