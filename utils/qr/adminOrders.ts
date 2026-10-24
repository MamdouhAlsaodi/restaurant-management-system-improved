/**
 * Pure helpers for the multi-order cashier slice (MULTI_ORDER_PACKET.md).
 * Free of DOM/localStorage access so node:test can exercise them directly.
 *
 * Server contract (integer cents everywhere):
 * - POST /api/admin/orders            {requestId, guestName<=80, tableId?} => {order}
 * - POST /api/admin/orders/:id/items  {requestId, items:[{id,quantity}]}    => {order}
 * - POST /api/admin/orders/:id/checkout {paymentMethod}                     => {order}
 * - GET  /api/admin/orders            {orders:[...]}
 */

export interface ServerOrderItem {
  id: string;
  name: string;
  /** INTEGER CENTS from the API. */
  price: number;
  quantity: number;
  source: 'guest' | 'cashier';
}

export interface ServerOrder {
  /** Backend order ids are UUID strings. */
  id: string;
  tableId: number | null;
  tableLabel: string;
  guestName: string;
  source: 'guest' | 'cashier';
  items: ServerOrderItem[];
  /** INTEGER CENTS. */
  total: number;
  notes: string;
  status: 'pending' | 'accepted' | 'rejected' | 'paid';
  createdAt: string;
  /** Persisted kitchen preparation state (accepted/paid orders only). */
  prepStatus?: PrepStatus;
  paidAt?: string;
  paymentMethod?: 'cash' | 'pix' | 'cartao' | 'ifood_card';
}

export const PAYMENT_METHODS = ['cash', 'pix', 'cartao', 'ifood_card'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

// ---- Optional kitchen screen: persisted preparation state ----
// Strictly sequential: waiting -> preparing -> ready -> served.

export const PREP_STATUSES = ['waiting', 'preparing', 'ready', 'served'] as const;
export type PrepStatus = (typeof PREP_STATUSES)[number];

const NEXT_PREP_STATUS: Record<PrepStatus, PrepStatus | null> = {
  waiting: 'preparing',
  preparing: 'ready',
  ready: 'served',
  served: null, // terminal
};

/** The only status a kitchen order may advance to; null when terminal/unknown. */
export const nextPrepStatus = (status: PrepStatus | null | undefined): PrepStatus | null =>
  status ? NEXT_PREP_STATUS[status] ?? null : null;

/** Kitchen actions apply to accepted/paid orders that have not been served. */
export const canSetPreparation = (order: { status: string; prepStatus?: PrepStatus | null }): boolean =>
  (order.status === 'accepted' || order.status === 'paid') &&
  !!order.prepStatus &&
  order.prepStatus !== 'served';

/** Orders shown on the kitchen screen: accepted/paid, not yet served. */
export const kitchenOrders = (orders: ServerOrder[]): ServerOrder[] =>
  orders.filter((o) => canSetPreparation(o));

// ---- Stable request ids: ambiguous retries must never duplicate writes ----

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const defaultUuid = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Idempotency identifiers must be unpredictable even on non-secure origins.
  if (!globalThis.crypto?.getRandomValues) throw new Error('Secure random generator unavailable');
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const newRequestId = (uuidFn: () => string = defaultUuid): string => {
  const id = uuidFn();
  if (!UUID_RE.test(id)) throw new Error('requestId must be a UUID');
  return id;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries an idempotent-target write reusing ONE stable requestId for every
 * attempt, so an ambiguous failure (timeout after the server committed) is
 * replayed as the same request and never creates a duplicate.
 */
export async function retryWithStableId<T>(
  perform: (requestId: string) => Promise<T>,
  options: { retries?: number; delayMs?: number; uuidFn?: () => string; requestId?: string } = {},
): Promise<T> {
  const { retries = 3, delayMs = 400, uuidFn = defaultUuid, requestId: priorId } = options;
  // One id per logical operation — generated once, reused on every attempt.
  const requestId = priorId ?? newRequestId(uuidFn);
  if (!UUID_RE.test(requestId)) throw new Error('requestId must be a UUID');
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (attempt > 0 && delayMs > 0) await sleep(delayMs);
    try {
      return await perform(requestId);
    } catch (err: any) {
      lastError = err;
      // A definitive validation/auth/conflict response is not an ambiguous
      // write and must not be hammered with retries.
      if (typeof err?.status === 'number' && err.status > 0 && err.status < 500) throw err;
    }
  }
  throw lastError;
}

export async function retryPersistedWrite<T>(
  operationKey: string,
  perform: (requestId: string) => Promise<T>,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = sessionStorage,
): Promise<T> {
  const key = `qr-pending-write:${operationKey}`;
  const saved = storage.getItem(key);
  const requestId = saved && UUID_RE.test(saved) ? saved : newRequestId();
  storage.setItem(key, requestId);
  try {
    const result = await retryWithStableId(perform, { requestId });
    storage.removeItem(key);
    return result;
  } catch (err: any) {
    // Keep the id after timeouts/5xx; the server may have already committed.
    if (typeof err?.status === 'number' && err.status > 0 && err.status < 500) storage.removeItem(key);
    throw err;
  }
}

// ---- Order mapping / gating ----

/**
 * Normalizes a raw GET /api/admin/orders row. Legacy rows without a guest
 * name fall back to the table label. Throws on rows without an id.
 */
export function mapServerOrder(raw: any): ServerOrder {
  if (!raw || typeof raw.id !== 'string' && typeof raw.id !== 'number') {
    throw new Error('server order is missing an id');
  }
  const tableLabel = typeof raw.tableLabel === 'string' ? raw.tableLabel : '';
  const guestName = typeof raw.guestName === 'string' && raw.guestName.trim() ? raw.guestName.trim() : tableLabel || 'زائر';
  const items: ServerOrderItem[] = Array.isArray(raw.items)
    ? raw.items.map((it: any) => ({
        id: String(it?.id ?? ''),
        name: String(it?.name ?? ''),
        price: Math.round(Number(it?.price) || 0),
        quantity: Math.max(0, Math.round(Number(it?.quantity) || 0)),
        source: it?.source === 'cashier' ? 'cashier' : 'guest',
      }))
    : [];
  return {
    id: String(raw.id),
    tableId: typeof raw.tableId === 'number' ? raw.tableId : null,
    tableLabel,
    guestName,
    source: raw.source === 'cashier' ? 'cashier' : 'guest',
    items,
    total: Math.round(Number(raw.total) || 0),
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    status: raw.status === 'paid' || raw.status === 'accepted' || raw.status === 'rejected' ? raw.status : 'pending',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    ...((PREP_STATUSES as readonly string[]).includes(raw.prepStatus)
      ? { prepStatus: raw.prepStatus as PrepStatus }
      : raw.status === 'accepted' || raw.status === 'paid'
        ? { prepStatus: 'waiting' as PrepStatus }
        : {}),
    ...(typeof raw.paidAt === 'string' ? { paidAt: raw.paidAt } : {}),
    ...(typeof raw.paymentMethod === 'string' ? { paymentMethod: raw.paymentMethod as PaymentMethod } : {}),
  };
}

export const canApprove = (order: { status: string }): boolean => order.status === 'pending';
/** Accepted = open/unpaid: items can still be added and checkout can run. */
export const canAddItems = (order: { status: string }): boolean => order.status === 'accepted';
export const canCheckout = (order: { status: string }): boolean => order.status === 'accepted';
export const isPaid = (order: { status: string }): boolean => order.status === 'paid';

export function splitOrders(orders: ServerOrder[]): {
  pending: ServerOrder[];
  accepted: ServerOrder[];
  paid: ServerOrder[];
  rejected: ServerOrder[];
} {
  const buckets: Record<'pending' | 'accepted' | 'paid' | 'rejected', ServerOrder[]> = { pending: [], accepted: [], paid: [], rejected: [] };
  for (const order of orders) buckets[order.status]?.push(order);
  return buckets;
}

// ---- Reporting: legacy local sales preserved + read-only server paid orders ----

export interface ReportingOrder {
  id: number | string;
  serverOrderId?: string;
  items: { id: number | string; name: string; price: number; quantity: number }[];
  total: number;
  paymentMethod: string;
  orderSource: string;
  orderType: string;
  needsDelivery: boolean;
  notes: string;
  date: string;
  dateOnly: string;
  status: 'completed' | 'cancelled';
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Local dd/mm/yyyy for an ISO timestamp (matches utils/helpers formatDate). */
export const isoToDateOnly = (iso: string): string => {
  const d = new Date(iso);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
};

/** Maps a paid server order onto the local sales shape (read-only reporting). */
export function paidOrderToLegacy(order: ServerOrder): ReportingOrder {
  if (order.status !== 'paid') throw new Error('only paid orders become sales records');
  const when = order.paidAt || order.createdAt || new Date().toISOString();
  return {
    id: order.id,
    serverOrderId: order.id,
    items: order.items.map((it) => ({ id: it.id, name: it.name, price: it.price / 100, quantity: it.quantity })),
    total: order.total / 100,
    paymentMethod: order.paymentMethod ?? 'cash',
    orderSource: order.source,
    orderType: 'qr',
    needsDelivery: false,
    notes: order.notes,
    date: when,
    dateOnly: isoToDateOnly(when),
    status: 'completed',
  };
}

/**
 * Combines legacy localStorage sales with server paid orders for reporting.
 * - Never counts pending/accepted/rejected server orders (not sales).
 * - Drops legacy rows whose serverOrderId matches a server order, so the same
 *   paid order is never double counted even if it leaked into localStorage.
 * - Pure: does not mutate inputs and never writes localStorage.
 */
export function combineForReporting(
  legacyOrders: ReportingOrder[] | any[],
  serverOrders: ServerOrder[],
): ReportingOrder[] {
  const legacy = (legacyOrders as any[]) as ReportingOrder[];
  // Server paid orders already mirrored into localStorage (by a previous
  // import or bug) keep their legacy row; the server duplicate is dropped.
  const legacyServerIds = new Set(legacy.map((o: any) => o.serverOrderId ?? o.id).filter(Boolean).map(String));
  const mapped = serverOrders
    .filter(isPaid)
    .filter((o) => !legacyServerIds.has(o.id))
    .map(paidOrderToLegacy);
  return [...legacy, ...mapped];
}
