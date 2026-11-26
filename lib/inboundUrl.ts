/**
 * Remove flat query keys that shadow Object.prototype members before handing an
 * inbound URL to navigation. Keep all remaining URL bytes intact, including
 * repeated parameters, callback codes, fragments and native scheme/host syntax.
 *
 * This does not validate navigation destinations or authorize an operation.
 */
const RESERVED_QUERY_KEYS = new Set([
  "__proto__", "constructor", "__defineGetter__", "__defineSetter__",
  "hasOwnProperty", "__lookupGetter__", "__lookupSetter__", "isPrototypeOf",
  "propertyIsEnumerable", "toString", "toLocaleString", "valueOf",
]);

export function sanitizeInboundUrlQuery(value: string): string {
  const fragmentIndex = value.indexOf("#");
  const fragment = fragmentIndex < 0 ? "" : value.slice(fragmentIndex);
  const withoutFragment = fragmentIndex < 0 ? value : value.slice(0, fragmentIndex);
  const queryIndex = withoutFragment.indexOf("?");
  if (queryIndex < 0) return value;

  const prefix = withoutFragment.slice(0, queryIndex);
  const query = withoutFragment.slice(queryIndex + 1);
  let removed = false;
  const kept = query.split("&").filter(pair => {
    const equalsIndex = pair.indexOf("=");
    const rawKey = equalsIndex < 0 ? pair : pair.slice(0, equalsIndex);
    let key: string;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, " "));
    } catch {
      // A malformed key cannot decode to one of the ASCII reserved member names.
      return true;
    }
    if (!RESERVED_QUERY_KEYS.has(key)) return true;
    removed = true;
    return false;
  });
  if (!removed) return value;
  const retained = kept.join("&");
  return prefix + (retained ? `?${retained}` : "") + fragment;
}
