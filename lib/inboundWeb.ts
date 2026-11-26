import { sanitizeInboundUrlQuery } from "./inboundUrl";

type BrowserUrlTarget = {
  location: { readonly href: string };
  history: {
    readonly state: unknown;
    replaceState(data: unknown, unused: string, url: string): void;
  };
  addEventListener(type: "popstate", listener: () => void, capture: boolean): void;
};

/** Run before loading Router, including before its back/forward listeners. */
export function installInboundWebUrlSanitizer(browser: BrowserUrlTarget): void {
  const sanitizeLocation = () => {
    const current = browser.location.href;
    const sanitized = sanitizeInboundUrlQuery(current);
    if (sanitized !== current) {
      browser.history.replaceState(browser.history.state, "", sanitized);
    }
  };
  sanitizeLocation();
  browser.addEventListener("popstate", sanitizeLocation, true);
}
