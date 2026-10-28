import { Platform } from "react-native";
import { normalizeInviteCode } from "./invites";

// Base URL used to build shareable/printable deep links (e.g. asset QR codes).
// On web we use the actual origin; on native we fall back to the configured
// production URL so a printed tag opens the live web app when scanned.
const CONFIGURED = process.env.EXPO_PUBLIC_APP_URL?.replace(/\/$/, "");

export function appBaseUrl(): string {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    return window.location.origin;
  }
  if (!CONFIGURED) throw new Error("Sharing is unavailable until the app's web address is configured.");
  const url = new URL(CONFIGURED);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Sharing requires a valid HTTPS app address.");
  return url.origin;
}

export function assetUrl(id: string): string {
  return `${appBaseUrl()}/asset/${id}`;
}

/** Share only an app-origin invitation URL, never an arbitrary redirect target. */
export function inviteUrl(code: string): string {
  const valid = normalizeInviteCode(code);
  if (!valid) throw new Error("Invalid invitation code.");
  return `${appBaseUrl()}/claim?code=${encodeURIComponent(valid)}`;
}
