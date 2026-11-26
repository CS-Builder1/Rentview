export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200, cors = false): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...(cors ? corsHeaders : {}) },
  });
}

/** Bound input before parsing, including chunked requests without Content-Length. */
export async function boundedBody(req: Request, limit = 1_048_576): Promise<string> {
  const declared = req.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new HttpError(413, "Request body is too large");
  if (!req.body) throw new HttpError(400, "Expected a JSON body");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); throw new HttpError(413, "Request body is too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(length);
  let position = 0;
  for (const chunk of chunks) { body.set(chunk, position); position += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(body); }
  catch { throw new HttpError(400, "Invalid UTF-8 body"); }
}

export function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Expected an object");
  return value as Record<string, unknown>;
}

export function parseObject(raw: string): Record<string, unknown> {
  try { return asObject(JSON.parse(raw)); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, "Malformed JSON body"); }
}

export function safeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left), b = new TextEncoder().encode(right);
  let mismatch = a.length ^ b.length;
  // Runtime is bounded by the trusted secret's length; never echo either operand.
  for (let i = 0; i < b.length; i++) mismatch |= (a[i] ?? 0) ^ b[i];
  return mismatch === 0;
}

export async function fetchWithTimeout(input: string, init: RequestInit = {}, milliseconds = 15_000): Promise<Response> {
  return await fetch(input, { ...init, signal: AbortSignal.timeout(milliseconds) });
}

export function errorResponse(error: unknown, cors = false): Response {
  if (error instanceof HttpError) return json({ error: error.message }, error.status, cors);
  console.error("Service operation failed", error instanceof Error ? error.name : "unknown");
  return json({ error: "The service could not complete this action. Please try again." }, 500, cors);
}
