type SecureIdHost = {
  expo?: { uuidv4?: () => string };
  crypto?: {
    randomUUID?: () => string;
    getRandomValues?: (bytes: Uint8Array) => Uint8Array;
  };
};

/** Use the UUID implementation already supplied by Expo, or Web Crypto on web. */
export function secureRecordId(host: SecureIdHost): string {
  let value: string;
  if (typeof host.expo?.uuidv4 === "function") value = host.expo.uuidv4();
  else if (typeof host.crypto?.randomUUID === "function") value = host.crypto.randomUUID();
  else if (typeof host.crypto?.getRandomValues === "function") {
    const bytes = host.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    value = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } else {
    throw new Error("Secure saving is unavailable. Open RentView using HTTPS in a current browser, or restart the mobile app.");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("The device could not create a valid record ID. Restart the app before saving.");
  }
  return value;
}

/** Generate once before a write; retries must reuse the same record ID. */
export function newRecordId(): string {
  return secureRecordId(globalThis as SecureIdHost);
}
