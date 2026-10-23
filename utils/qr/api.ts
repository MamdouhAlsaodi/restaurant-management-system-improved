/**
 * Minimal JSON API client for the table-QR slice.
 * Same-origin, cookie auth, JSON errors {error:string}.
 */

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

type FetchLike = typeof fetch;

/** Session actor metadata exposed by GET /api/admin/session. */
export type SessionActor =
  | { kind: 'owner'; role: 'owner' }
  | { kind: 'staff'; id: number; username: string; role: 'cashier' | 'kitchen' };

export async function apiFetch<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {},
  fetchImpl: FetchLike = fetch,
): Promise<T> {
  const init: RequestInit = {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  };

  let res: Response;
  try {
    res = await fetchImpl(path, init);
  } catch {
    // Never leak underlying network details.
    throw new ApiError('تعذر الاتصال بالخادم', 0);
  }

  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const message = data && typeof data.error === 'string' ? data.error : 'حدث خطأ غير متوقع';
    throw new ApiError(message, res.status);
  }
  return data as T;
}
