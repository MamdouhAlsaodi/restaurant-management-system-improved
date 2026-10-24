import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS restaurant_tables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS menu_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  image TEXT,
  category TEXT,
  description TEXT
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  table_id INTEGER,
  table_label TEXT NOT NULL,
  guest_name TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'guest' CHECK (source IN ('guest','cashier')),
  notes TEXT,
  total_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected','paid')),
  created_at TEXT NOT NULL,
  request_id TEXT NOT NULL,
  last_request_id TEXT,
  paid_at TEXT,
  payment_method TEXT CHECK (payment_method IN ('cash','pix','cartao','ifood_card'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_table_request
  ON orders (table_id, request_id);
CREATE TABLE IF NOT EXISTS order_item_requests (
  order_id TEXT NOT NULL REFERENCES orders(id),
  request_id TEXT NOT NULL,
  PRIMARY KEY (order_id, request_id)
);
CREATE TABLE IF NOT EXISTS order_items (
  order_id TEXT NOT NULL REFERENCES orders(id),
  item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'guest' CHECK (source IN ('guest','cashier'))
);
`;

// Non-destructive migration for databases created before multi-order support:
// legacy `orders` rows (pending/accepted/rejected, no guest_name/source/paid
// columns) are copied into the new schema; nothing is dropped or reset.
function migrateLegacyOrders(db) {
  const ordersInfo = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orders'").get();
  if (!ordersInfo) return; // fresh database: SCHEMA above already created the new shape
  const cols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  if (cols.includes('guest_name') && cols.includes('payment_method')) return; // already migrated

  // Foreign keys must be off while swapping the orders table, otherwise the
  // DROP of the legacy table fails on rows still referenced by order_items.
  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    db.exec(`
    BEGIN;
    CREATE TABLE orders_migrated (
      id TEXT PRIMARY KEY,
      table_id INTEGER,
      table_label TEXT NOT NULL,
      guest_name TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'guest' CHECK (source IN ('guest','cashier')),
      notes TEXT,
      total_cents INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected','paid')),
      created_at TEXT NOT NULL,
      request_id TEXT NOT NULL,
      last_request_id TEXT,
      paid_at TEXT,
      payment_method TEXT CHECK (payment_method IN ('cash','pix','cartao','ifood_card'))
    );
    INSERT INTO orders_migrated
      (id, table_id, table_label, guest_name, source, notes, total_cents, status, created_at, request_id)
    SELECT id, table_id, table_label, table_label, 'guest',
           notes, total_cents, status, created_at, request_id
    FROM orders;
    DROP INDEX IF EXISTS idx_orders_table_request;
    DROP TABLE orders;
    ALTER TABLE orders_migrated RENAME TO orders;
    CREATE UNIQUE INDEX idx_orders_table_request ON orders (table_id, request_id);
    COMMIT;
  `);
    const broken = db.prepare('PRAGMA foreign_key_check').all();
    if (broken.length) throw new Error('Legacy order migration violated foreign keys');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK;');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

function migrateOrderItemsSource(db) {
  const itemsInfo = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'order_items'").get();
  if (!itemsInfo) return;
  const cols = db.prepare('PRAGMA table_info(order_items)').all().map((c) => c.name);
  if (cols.includes('source')) return;
  // Legacy item rows belong to guest orders.
  db.exec("ALTER TABLE order_items ADD COLUMN source TEXT NOT NULL DEFAULT 'guest'");
}

export function openDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrateLegacyOrders(db);
  migrateOrderItemsSource(db);
  db.exec(SCHEMA);
  // Carry forward the latest addition id from installations that briefly used
  // last_request_id alone; all subsequent ids live in the durable ledger.
  db.exec('INSERT OR IGNORE INTO order_item_requests (order_id, request_id) SELECT id, last_request_id FROM orders WHERE last_request_id IS NOT NULL;');
  return db;
}
