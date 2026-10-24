/**
 * Optional QR arrival alerts (ARRIVAL_ALERTS slice).
 *
 * Opt-in, non-blocking notification for newly arriving PENDING GUEST orders in
 * the cashier queue. Design rules:
 * - Never alerts on initial hydration: the caller must `syncBaseline(...)` with
 *   the orders already on screen BEFORE enabling, so existing orders are seen.
 * - Alerts only `source === 'guest'` and `status === 'pending'` orders.
 * - Dedupes forever per order id: status flips (pending -> accepted -> pending)
 *   or refetches never re-alert the same order.
 * - Manual cashier orders, accepted/rejected/paid updates: never alerted.
 * - OS notifications use the browser Notification API, permission requested
 *   ONLY from an explicit user gesture (`requestEnable`), never automatically.
 *   Unsupported or denied browsers degrade to in-app-only alerts.
 * - OS notifications contain no customer personal data (no guest name, no
 *   order contents) — just a generic arrival notice.
 * - No audio autoplay. Failures inside processOrders never throw: polling and
 *   checkout must keep working.
 *
 * Opt-in is session-local (in-memory); reloading the page starts disabled.
 * No Web Push / background delivery: the page must stay open and authenticated.
 *
 * DOM-free by construction: the Notification constructor is injected, so
 * node:test can exercise the logic without a browser.
 */

export interface AlertableOrder {
  id: string;
  status: string;
  source: string;
}

export type NotificationPermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

/** Minimal structural type so tests can inject fakes. */
export interface NotifierPort {
  permission: string;
  requestPermission(): Promise<string>;
  new (title: string, options?: { body?: string; tag?: string }): unknown;
}

export const isAlertableGuestOrder = (order: AlertableOrder): boolean =>
  order.source === 'guest' && order.status === 'pending';

/** Pure: new guest pending orders whose ids are not in the baseline set. */
export function detectNewGuestPendingOrders<T extends AlertableOrder>(
  orders: T[],
  seenIds: ReadonlySet<string>,
): T[] {
  const seen = new Set(seenIds);
  const out: T[] = [];
  for (const o of orders) {
    if (!isAlertableGuestOrder(o) || seen.has(o.id)) continue;
    // Dedupe within the same batch too (e.g. duplicated rows in one poll).
    seen.add(o.id);
    out.push(o);
  }
  return out;
}

export class ArrivalAlertCenter {
  enabled = false;
  permission: NotificationPermissionState = 'default';
  private seenIds = new Set<string>();
  private readonly Notifier: NotifierPort | null;

  constructor(Notifier: NotifierPort | null = safeGlobalNotifier()) {
    this.Notifier = Notifier;
    if (!Notifier) this.permission = 'unsupported';
  }

  /** Records current order ids as already-seen WITHOUT alerting (hydration). */
  syncBaseline(orders: AlertableOrder[]): void {
    for (const o of orders) {
      if (isAlertableGuestOrder(o)) this.seenIds.add(o.id);
    }
  }

  /**
   * The ONLY path to enabling — call it from a click handler (user gesture).
   * Never throws. Returns the resulting state.
   */
  async requestEnable(): Promise<{ enabled: boolean; permission: NotificationPermissionState }> {
    if (!this.Notifier || typeof this.Notifier.requestPermission !== 'function') {
      this.permission = 'unsupported';
    } else {
      try {
        const result = await this.Notifier.requestPermission();
        this.permission = result === 'granted' || result === 'denied' ? result : 'default';
      } catch {
        this.permission = 'denied';
      }
    }
    this.enabled = true;
    return { enabled: this.enabled, permission: this.permission };
  }

  disable(): void {
    this.enabled = false;
  }

  /**
   * Feeds one poll result. Returns newly arrived guest pending orders (first
   * sighting each) and fires OS notifications for them. Never throws: any
   * Notification failure is swallowed so polling is never blocked.
   */
  processOrders<T extends AlertableOrder>(orders: T[]): T[] {
    if (!this.enabled) return [];
    const arrivals = detectNewGuestPendingOrders(orders, this.seenIds);
    for (const o of arrivals) this.seenIds.add(o.id);
    if (arrivals.length > 0 && this.permission === 'granted') {
      this.notify(arrivals.length);
    }
    return arrivals;
  }

  private notify(count: number): void {
    try {
      const body = count === 1
        ? 'وصل طلب جديد من طاولة QR — راجع قائمة الطلبات'
        : `وصل ${count} طلبات جديدة من طاولات QR — راجع قائمة الطلبات`;
      // A stable tag coalesces rapid successive batches; no personal data.
      void new this.Notifier!('طلب QR جديد', { body, tag: 'qr-arrivals' });
    } catch {
      // OS notification is best-effort only; the in-app badge is the source of truth.
    }
  }
}

function safeGlobalNotifier(): NotifierPort | null {
  try {
    const g = typeof globalThis !== 'undefined' ? (globalThis as any) : undefined;
    const N = g?.Notification;
    if (N && typeof N.requestPermission === 'function' && typeof N === 'function') return N as NotifierPort;
  } catch { /* ignore */ }
  return null;
}
