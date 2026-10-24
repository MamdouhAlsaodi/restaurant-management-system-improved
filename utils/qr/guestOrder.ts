/**
 * Guest order submission with requestId-based deduplication.
 * The same requestId is reused across retries of one attempted order so the
 * backend can return the same order if a response was lost.
 *
 * Error semantics:
 * - A 4xx response is definitive rejection and releases the attempt.
 * - A 5xx response or malformed success may have arrived after insertion;
 *   keep the exact snapshot and requestId for a safe retry.
 * - Response lost after all retries (network failure): a previous attempt MAY
 *   have arrived, so the caller MUST keep the exact payload snapshot (same
 *   quantities/notes) with the same requestId. `ambiguous === true`.
 */

export class GuestOrderSubmitError extends Error {
  /** True when it is unknown whether the server received a previous attempt. */
  ambiguous: boolean;
  status: number;
  constructor(message: string, ambiguous: boolean, status = 0) {
    super(message);
    this.name = 'GuestOrderSubmitError';
    this.ambiguous = ambiguous;
    this.status = status;
  }
}

interface GuestOrder {
  /** Backend order ids are UUID strings. */
  id: string;
  status: string;
  [key: string]: unknown;
}

/**
 * Guest name is required per QR submission (not account login). Validated and
 * trimmed client-side; must match the server contract (nonempty, <= 80 chars).
 */
export function validateGuestName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new GuestOrderSubmitError('الاسم مطلوب لإرسال الطلب', false);
  }
  const name = value.trim();
  if (name.length === 0) {
    throw new GuestOrderSubmitError('الاسم مطلوب لإرسال الطلب', false);
  }
  if (name.length > 80) {
    throw new GuestOrderSubmitError('الاسم يجب أن يكون 80 حرفاً أو أقل', false);
  }
  return name;
}

interface SubmitArgs {
  token: string;
  guestName: string;
  items: { id: string; quantity: number }[];
  notes?: string;
  requestId: string;
  attempts?: number;
  fetchImpl?: typeof fetch;
}

export async function submitGuestOrder({
  token,
  guestName,
  items,
  notes,
  requestId,
  attempts = 3,
  fetchImpl = fetch,
}: SubmitArgs): Promise<GuestOrder> {
  // Fail fast (no network call) on an invalid guest name.
  const name = validateGuestName(guestName);
  // Frozen snapshot of exactly one attempted order: retries always send this
  // byte-identical body with the same requestId. guestName is part of the
  // snapshot and travels verbatim on every retry.
  const body = JSON.stringify({
    guestName: name,
    items,
    ...(notes ? { notes } : {}),
    requestId,
  });

  for (let attempt = 0; attempt < attempts; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(`/api/guest/${encodeURIComponent(token)}/orders`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    } catch (err) {
      // Network failure: response may or may not have reached the server,
      // so retry with the SAME requestId (backend deduplicates).
      continue;
    }

    let data: any = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (res.ok && typeof data?.order?.id === 'string') {
      return data.order as GuestOrder;
    }

    const message = data && typeof data.error === 'string' ? data.error : 'حدث خطأ غير متوقع';
    // A server error (including a failed response after DB commit) or an
    // unusable 2xx is NOT proof that the order was not created.
    throw new GuestOrderSubmitError(message, res.ok || res.status >= 500, res.status);
  }

  throw new GuestOrderSubmitError(
    'تعذر إرسال الطلب، تحقق من الاتصال وحاول مرة أخرى. قد يكون طلبك السابق قد وصل بالفعل',
    true,
  );
}
