import type { DailySalesRecord, Discount, MenuItem, Order, Settings } from '../types';

export interface LegacyBackup {
  menuItems: MenuItem[];
  completedOrders: Order[];
  settings: Settings;
  discounts: Discount[];
  dailySalesRecords: Record<string, DailySalesRecord>;
  version?: string;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const list = (value: unknown, check: (entry: unknown) => boolean): boolean =>
  Array.isArray(value) && value.every(check);
const item = (v: unknown) => object(v) && finite(v.id) && typeof v.name === 'string' && finite(v.price) && v.price >= 0;
const order = (v: unknown) => object(v) && (finite(v.id) || typeof v.id === 'string') &&
  list(v.items, (entry) => object(entry) && typeof entry.name === 'string' && finite(entry.price) && finite(entry.quantity)) &&
  finite(v.total) && v.total >= 0 && ['completed', 'cancelled'].includes(String(v.status));
const discount = (v: unknown) => object(v) && finite(v.id) && finite(v.itemId) && finite(v.discountPrice);

/** Validate all datasets before any persistent data is overwritten. */
export function parseLegacyBackup(text: string): LegacyBackup {
  if (text.length > 20_000_000) throw new Error('backup too large');
  const value: unknown = JSON.parse(text);
  if (!object(value)) throw new Error('invalid backup');
  if (!list(value.menuItems, item)) throw new Error('invalid menuItems');
  if (!list(value.completedOrders, order)) throw new Error('invalid completedOrders');
  if (!object(value.settings) || !finite(value.settings.dailyMotorcycleCost) ||
    !finite(value.settings.perDeliveryCost) ||
    (value.settings.language !== undefined && !['ar', 'en', 'pt'].includes(String(value.settings.language)))) {
    throw new Error('invalid settings');
  }
  if (!list(value.discounts, discount)) throw new Error('invalid discounts');
  if (!object(value.dailySalesRecords) || Object.entries(value.dailySalesRecords).some(([key, v]) =>
    key === '__proto__' || key === 'constructor' || !object(v) || !finite(v.totalSales) || !finite(v.ordersCount))) {
    throw new Error('invalid dailySalesRecords');
  }
  return value as unknown as LegacyBackup;
}

const fields = [
  ['restaurant-menu', 'menuItems'],
  ['restaurant-orders', 'completedOrders'],
  ['restaurant-settings', 'settings'],
  ['restaurant-discounts', 'discounts'],
  ['restaurant-daily-sales', 'dailySalesRecords'],
] as const;

/** Best-effort rollback of browser datasets if a storage write throws. */
export function restoreLegacyBackup(
  backup: LegacyBackup,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
): void {
  const old = fields.map(([key]) => [key, storage.getItem(key)] as const);
  const writes = fields.map(([key, field]) => [key, JSON.stringify(backup[field])] as const);
  let written = 0;
  try {
    for (const [key, value] of writes) {
      storage.setItem(key, value);
      written += 1;
    }
  } catch (error) {
    let rollbackError: unknown;
    for (const [key, value] of old.slice(0, written).reverse()) {
      try {
        if (value === null) storage.removeItem(key);
        else storage.setItem(key, value);
      } catch (err) { rollbackError = err; }
    }
    if (rollbackError) throw new Error('Backup restore failed and rollback may be incomplete', { cause: error });
    throw error;
  }
}
