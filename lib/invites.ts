/** Pure parsing helpers: authentication destinations never accept external URLs. */
export function normalizeInviteCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9]{6,64}$/.test(normalized) ? normalized : null;
}

export function safeReturnPath(value: unknown, fallback = "/"): string {
  const defaultPath = fallback === "/" ? "/" : safeReturnPath(fallback);
  if (typeof value !== "string" || value.length > 2048 || /[\\\u0000-\u0020\u007f]/.test(value)) return defaultPath;
  if (!value.startsWith("/") || value.startsWith("//")) return defaultPath;
  try {
    const url = new URL(value, "https://rentview.invalid");
    if (url.origin !== "https://rentview.invalid") return defaultPath;
    const decoded = decodeURIComponent(url.pathname);
    if (decoded !== url.pathname || decoded.includes("\\") || decoded.startsWith("//")) return defaultPath;
    if (url.pathname === "/claim") {
      const code = url.searchParams.get("code");
      if (!code) return "/claim";
      const valid = normalizeInviteCode(code);
      return valid ? `/claim?code=${encodeURIComponent(valid)}` : "/claim";
    }
    if (/^\/(?:tenant(?:\/(?:requests|rent|more|notices|new-request|request\/[a-f0-9-]+))?|account|asset\/[a-f0-9-]+|property\/[a-f0-9-]+|unit\/[a-f0-9-]+|work-order\/[a-f0-9-]+|request\/[a-f0-9-]+)?$/.test(url.pathname)) {
      return url.pathname;
    }
  } catch { /* Invalid URL or encoding. */ }
  return defaultPath;
}

export function claimPath(code?: unknown): string {
  const valid = normalizeInviteCode(code);
  return valid ? `/claim?code=${encodeURIComponent(valid)}` : "/claim";
}

/** A default callback path must not discard an invitation saved before sign-up. */
export function authDestination(explicit: unknown, saved: unknown): string {
  const preferred = safeReturnPath(explicit);
  return preferred === "/" ? safeReturnPath(saved) : preferred;
}

export function callbackParams(value: string): { code: string | null; error: string | null; next: string; recovery: boolean } {
  const url = new URL(value, "https://rentview.invalid");
  return {
    code: url.searchParams.get("code"),
    error: url.searchParams.get("error_description") ?? url.searchParams.get("error"),
    next: safeReturnPath(url.searchParams.get("next")),
    recovery: url.searchParams.get("intent") === "recovery",
  };
}
