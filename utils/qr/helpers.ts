/**
 * Pure helpers for the table-QR MVP slice.
 * Kept free of DOM/localStorage access so node:test can exercise them directly.
 */

export interface PublishedMenuItem {
  /** Backend wire contract: menu item id is a STRING (DB text). */
  id: string;
  name: string;
  /** INTEGER CENTS as expected by the API. */
  price: number;
  image?: string;
  category?: string;
  description?: string;
}

export interface LocalMenuItem {
  id: number;
  name: string;
  price: number;
  image?: string;
  category?: string;
  description?: string;
}

export interface GuestCartItem {
  /** Backend ids are strings (DB text / UUID). */
  id: string;
  price: number;
  quantity: number;
}

export type OrderStatus = 'pending' | 'accepted' | 'rejected';

/**
 * Validates one local BRL price and converts it to integer cents for the API.
 * Invalid prices are never silently sent: zero, negative, non-finite or
 * non-numeric values throw.
 */
const toCents = (price: unknown, name: string): number => {
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    throw new Error(`سعر غير صالح للصنف «${name}»: لن يتم النشر حتى تصحيح السعر`);
  }
  return Math.round(price * 100);
};

/**
 * Maps the local menu (localStorage) onto the published-menu snapshot contract.
 * Wire contract: id -> String(id), BRL price -> integer cents via
 * Math.round(price * 100) after validating a finite positive value.
 * Explicit opt-in snapshot: the caller decides when to publish; this never
 * touches localStorage itself. Existing POS menu price semantics are untouched.
 */
export const toPublishedItems = (items: LocalMenuItem[]): PublishedMenuItem[] =>
  items.map((item) => ({
    id: String(item.id),
    name: item.name,
    price: toCents(item.price, item.name),
    // The guest MVP is text-only. Local POS images can be large data URLs,
    // exceeding the backend's bounded image field and failing the snapshot.
    ...(item.category ? { category: item.category } : {}),
    ...(item.description ? { description: item.description } : {}),
  }));

const brlFormatter = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/** Formats an API integer-cent amount as Brazilian Real (R$). */
export const formatBRL = (cents: number): string =>
  brlFormatter.format(cents / 100).replace(/\u00A0/g, ' ');

export const guestCartTotal = (cart: GuestCartItem[]): number =>
  cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

export const guestUrl = (origin: string, token: string): string => {
  const safeToken = encodeURIComponent(token)
    .replaceAll('%2F', '-')
    .replaceAll('%20', '-')
    .replace(/^-+|-+$/g, '');
  return `${origin.replace(/\/+$/, '')}/q/${safeToken}`;
};

const STATUS_LABELS: Record<string, string> = {
  pending: 'بانتظار الموافقة',
  accepted: 'مقبول',
  rejected: 'مرفوض',
};

export const describeOrderStatus = (status: string): string => STATUS_LABELS[status] ?? status;

export const canActOnOrder = (order: { status: string }): boolean => order.status === 'pending';

/**
 * Merges polled backend orders into locally-known orders.
 * Local-only rows (e.g. ones the poll missed) are preserved first; existing
 * rows are updated in place; new rows are appended.
 */
export function mergeOrders<T extends { id: number | string }>(existing: T[], incoming: T[]): T[] {
  const existingById = new Map(existing.map((o) => [o.id, o]));
  const leftovers = existing.filter((o) => !incoming.some((i) => i.id === o.id));
  const merged = [...leftovers, ...incoming];
  // Pending first (stable) so actionable rows surface at the top.
  return [
    ...merged.filter((o) => (o as any).status === 'pending'),
    ...merged.filter((o) => (o as any).status !== 'pending'),
  ];
}
