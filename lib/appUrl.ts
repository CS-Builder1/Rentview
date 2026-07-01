import { Platform } from "react-native";

// Base URL used to build shareable/printable deep links (e.g. asset QR codes).
// On web we use the actual origin; on native we fall back to the configured
// production URL so a printed tag opens the live web app when scanned.
const CONFIGURED = process.env.EXPO_PUBLIC_APP_URL?.replace(/\/$/, "");

export function appBaseUrl(): string {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    return window.location.origin;
  }
  return CONFIGURED ?? "https://rentview-git-main-cs-builder1s-projects.vercel.app";
}

export function assetUrl(id: string): string {
  return `${appBaseUrl()}/asset/${id}`;
}
