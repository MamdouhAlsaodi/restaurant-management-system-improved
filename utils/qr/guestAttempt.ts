export interface PendingGuestAttempt {
  requestId: string;
  guestName: string;
  items: { id: string; quantity: number }[];
  notes: string;
}

const keyFor = (token: string) => `qr-pending:${token}`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function loadPendingGuestAttempt(token: string): PendingGuestAttempt | null {
  try {
    const raw = sessionStorage.getItem(keyFor(token));
    if (!raw) return null;
    const attempt = JSON.parse(raw);
    if (!uuid.test(attempt.requestId) || typeof attempt.guestName !== 'string' || !attempt.guestName.trim() ||
        attempt.guestName.length > 80 || typeof attempt.notes !== 'string' ||
        !Array.isArray(attempt.items) || !attempt.items.length || attempt.items.length > 50 ||
        !attempt.items.every((i: any) => typeof i.id === 'string' && i.id.length > 0 &&
          Number.isInteger(i.quantity) && i.quantity > 0 && i.quantity <= 99)) return null;
    return attempt as PendingGuestAttempt;
  } catch { return null; }
}

export function savePendingGuestAttempt(token: string, attempt: PendingGuestAttempt): void {
  try { sessionStorage.setItem(keyFor(token), JSON.stringify(attempt)); } catch { /* still retry in memory */ }
}

export function clearPendingGuestAttempt(token: string): void {
  try { sessionStorage.removeItem(keyFor(token)); } catch { /* storage unavailable */ }
}
