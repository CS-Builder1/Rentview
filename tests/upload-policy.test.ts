import assert from "node:assert/strict";
import test from "node:test";
import { ALLOWED_ATTACHMENT_MIME_TYPES, MAX_ATTACHMENT_BYTES, assertStoragePath, assertUploadSize, inspectDocument, inspectImage, safeUploadName } from "../lib/uploadPolicy";

const bytes = (text: string) => new TextEncoder().encode(text);
const jpeg = Uint8Array.from([0xff,0xd8,0xff,0xe0,0,0,0,0]);
const png = Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);

test("photos use actual byte type and canonical extensions, including native HEIC conversion to JPEG", () => {
  assert.deepEqual(inspectImage(jpeg), { mimeType:"image/jpeg", ext:"jpg" });
  assert.deepEqual(inspectImage(png), { mimeType:"image/png", ext:"png" });
  assert.deepEqual(inspectImage(bytes("GIF89a fixture")), { mimeType:"image/gif", ext:"gif" });
  assert.deepEqual(inspectImage(bytes("RIFF0000WEBPfixture")), { mimeType:"image/webp", ext:"webp" });
  assert.deepEqual(inspectImage(bytes("0000ftypheic0000")), { mimeType:"image/heic", ext:"heic" });
  assert.deepEqual(inspectImage(bytes("0000ftypmif10000")), { mimeType:"image/heif", ext:"heif" });
});

test("SVG, HTML and unknown image bytes are rejected even if named or labelled as photos", () => {
  for (const value of ["<svg><script>alert(1)</script></svg>", "<!doctype html><script>alert(1)</script>", "not a photo", "0000ftypavif0000"]) assert.throws(() => inspectImage(bytes(value)), /not supported/);
  assert.throws(() => inspectDocument(bytes("<script>alert(1)</script>"), "image/jpeg", "photo.jpg"), /not supported/);
  assert.throws(() => inspectDocument(png, "image/jpeg", "photo.jpg"), /does not match/);
});

test("all attachments have the same non-empty10MiB limit enforced before upload", () => {
  assert.equal(MAX_ATTACHMENT_BYTES,10485760);
  assert.doesNotThrow(() => assertUploadSize(MAX_ATTACHMENT_BYTES));
  for (const size of [0,-1,NaN,Infinity,1.5,MAX_ATTACHMENT_BYTES+1]) assert.throws(() => assertUploadSize(size));
  assert.throws(() => inspectImage(new Uint8Array(MAX_ATTACHMENT_BYTES+1)), /10 MB/);
});

test("supported documents verify MIME and basic file signature, with safe canonical extension", () => {
  assert.deepEqual(inspectDocument(bytes("%PDF-1.7\nfixture"),"application/pdf","receipt.pdf"),{mimeType:"application/pdf",ext:"pdf"});
  assert.deepEqual(inspectDocument(bytes("name,value\nrepair,42"),"text/csv;charset=utf-8","ledger.csv"),{mimeType:"text/csv",ext:"csv"});
  assert.deepEqual(inspectDocument(bytes("{\\rtf1 fixture}"),"application/rtf","receipt.rtf"),{mimeType:"application/rtf",ext:"rtf"});
  assert.equal(inspectDocument(Uint8Array.from([0x50,0x4b,3,4,0]),"application/vnd.openxmlformats-officedocument.wordprocessingml.document","receipt.docx").ext,"docx");
  assert.equal(inspectDocument(Uint8Array.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]),"application/msword","receipt.doc").ext,"doc");
});

test("unknown MIME, active extensions and renamed document content fail closed", () => {
  for (const mime of [undefined,"application/octet-stream","image/svg+xml","text/html","application/javascript","__proto__"]) assert.throws(() => inspectDocument(bytes("%PDF-1.7"),mime,"receipt.pdf"), /type|format/);
  for (const name of ["receipt.html","receipt.svg","receipt.js","receipt.exe","receipt.php"]) assert.throws(() => inspectDocument(bytes("%PDF-1.7"),"application/pdf",name), /not supported/);
  for (const mime of ["application/pdf","application/msword","application/rtf","application/vnd.openxmlformats-officedocument.wordprocessingml.document"]) assert.throws(() => inspectDocument(bytes("<html>fake receipt</html>"),mime,"receipt.document"), /does not match/);
  assert.throws(() => inspectDocument(Uint8Array.from([0,1,2]),"text/plain","notes.txt"), /does not match/);
  assert.ok(!ALLOWED_ATTACHMENT_MIME_TYPES.includes("text/html"));
  assert.ok(!ALLOWED_ATTACHMENT_MIME_TYPES.includes("image/svg+xml"));
});

test("object locations reject traversal, encoded separators, controls and absolute paths", () => {
  assert.doesNotThrow(() => assertStoragePath("requests/11111111-1111-4111-8111-111111111111/photo-123.jpg"));
  for (const path of ["../x","owner/../x","owner//x","owner/%2e%2e/x","/owner/x","owner\\x","owner/x?download","owner/x#fragment","owner/\nfile","owner/.","a".repeat(1025)]) assert.throws(() => assertStoragePath(path), /invalid/);
});

test("display names remove control characters and are bounded without determining storage type", () => {
  assert.equal(safeUploadName(" \u0000receipt\n.pdf "),"receipt.pdf");
  assert.equal(safeUploadName(" "),"Document");
  assert.equal(safeUploadName("x".repeat(1000)).length,200);
});
