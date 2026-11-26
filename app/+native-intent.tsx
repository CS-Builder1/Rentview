import { sanitizeInboundUrlQuery } from "../lib/inboundUrl";

/** Expo Router applies this to both initial and subsequent native deep links. */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return sanitizeInboundUrlQuery(path);
}
