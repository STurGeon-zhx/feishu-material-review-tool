type ApiSuccess<T> = { ok: true; data: T };
type ApiFailure = { ok: false; error: { code: string; message: string; retryable: boolean } };

export async function reviewApi<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = (await response.json()) as ApiSuccess<T> | ApiFailure;
  if (!payload.ok) throw new Error(payload.error.message);
  return payload.data;
}

export function jsonRequest(method: string, body: unknown, idempotent = false): RequestInit {
  return {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(idempotent ? { "Idempotency-Key": crypto.randomUUID() } : {}),
    },
    body: JSON.stringify(body),
  };
}
