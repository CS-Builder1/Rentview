/** Client limits mirror the private bucket. Never trust a filename as a MIME declaration. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_BYTES = MAX_ATTACHMENT_BYTES;
const IMAGES = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif" } as const;
const DOCUMENTS: Record<string, string> = { ...IMAGES, "application/pdf": "pdf", "text/plain": "txt", "text/csv": "csv", "application/rtf": "rtf", "application/msword": "doc", "application/vnd.ms-excel": "xls", "application/vnd.ms-powerpoint": "ppt", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx", "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx", "application/vnd.oasis.opendocument.text": "odt", "application/vnd.oasis.opendocument.spreadsheet": "ods" };
export const ALLOWED_ATTACHMENT_MIME_TYPES = Object.keys(DOCUMENTS);
export type ImageMime = keyof typeof IMAGES;
const textAt = (bytes: Uint8Array, from: number, size: number) => String.fromCharCode(...bytes.slice(from, from + size));
const startsWith = (bytes: Uint8Array, signature: number[]) => signature.every((byte, index) => bytes[index] === byte);

export function assertUploadSize(size: number): void {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Choose a non-empty file.");
  if (size > MAX_ATTACHMENT_BYTES) throw new Error("Choose a file no larger than 10 MB.");
}
export function inspectImage(bytes: Uint8Array): { mimeType: ImageMime; ext: string } {
  assertUploadSize(bytes.byteLength);
  let mimeType: ImageMime | undefined;
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) mimeType = "image/jpeg";
  else if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) mimeType = "image/png";
  else if (["GIF87a", "GIF89a"].includes(textAt(bytes, 0, 6))) mimeType = "image/gif";
  else if (textAt(bytes, 0, 4) === "RIFF" && textAt(bytes, 8, 4) === "WEBP") mimeType = "image/webp";
  else if (textAt(bytes, 4, 4) === "ftyp") {
    const brand = textAt(bytes, 8, 4);
    if (["heic", "heix", "hevc", "hevx"].includes(brand)) mimeType = "image/heic";
    else if (["mif1", "msf1", "heif"].includes(brand)) mimeType = "image/heif";
  }
  if (!mimeType) throw new Error("Choose a JPEG, PNG, GIF, WebP or HEIC photo. SVG and other active file formats are not supported.");
  return { mimeType, ext: IMAGES[mimeType] };
}
export function inspectDocument(bytes: Uint8Array, suppliedMime: string | undefined, filename: string): { mimeType: string; ext: string } {
  assertUploadSize(bytes.byteLength);
  if (/\.(?:svgz?|html?|xhtml|xml|[cm]?js|exe|com|bat|cmd|ps1|sh|php|jsp|aspx?)$/i.test(filename.trim())) throw new Error("This file format is not supported. Choose a photo, PDF, text or office document.");
  const mimeType = suppliedMime?.trim().toLowerCase().split(";")[0];
  if (!mimeType || !Object.hasOwn(DOCUMENTS, mimeType)) throw new Error("The file type could not be verified. Choose a supported photo, PDF, text or office document.");
  if (mimeType.startsWith("image/")) {
    const detected = inspectImage(bytes);
    if (detected.mimeType !== mimeType) throw new Error("The selected file does not match its photo type.");
    return detected;
  }
  const ext = DOCUMENTS[mimeType];
  const prefix = textAt(bytes, 0, 5);
  const zip = startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]);
  const ole = startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  if ((ext === "pdf" && prefix !== "%PDF-") || (ext === "rtf" && prefix !== "{\\rtf") || (["doc", "xls", "ppt"].includes(ext) && !ole) || (["docx", "xlsx", "pptx", "odt", "ods"].includes(ext) && !zip) || (["txt", "csv"].includes(ext) && bytes.some(byte => byte < 0x20 && ![0x09, 0x0a, 0x0d].includes(byte)))) throw new Error("The selected file does not match its document type.");
  return { mimeType, ext };
}
export function assertStoragePath(path: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/.test(path) || path.split("/").some(segment => !segment || segment === "." || segment === "..")) throw new Error("The attachment location is invalid.");
}
export function safeUploadName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200) || "Document";
}
