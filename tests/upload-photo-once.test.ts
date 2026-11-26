import assert from "node:assert/strict";
import test from "node:test";
import { uploadPhotoOnce } from "../lib/uploadPhotoOnce.ts";

test("replaying a committed photo reads its metadata and preserves its ownership and bytes", async () => {
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  let file: { bytes: ArrayBuffer; owner: string } | null = null;
  let reads = 0;
  const bucket = {
    async upload(path: string, input: ArrayBuffer, options: { upsert: false }) {
      assert.equal(path, "actor/photos/photo.jpg");
      assert.equal(options.upsert, false);
      if (file) return { error: { statusCode: "409", message: "Duplicate" } };
      file = { bytes: input.slice(0), owner: "portfolio" };
      return { error: null };
    },
    async info() { reads++; return { data: { size: file?.bytes.byteLength, contentType: "image/jpeg" }, error: null }; },
  };
  await uploadPhotoOnce(bucket, "actor/photos/photo.jpg", bytes, "image/jpeg");
  const committed = file;
  await uploadPhotoOnce(bucket, "actor/photos/photo.jpg", bytes, "image/jpeg");
  assert.equal(reads, 1);
  assert.equal(committed, file);
  await assert.rejects(uploadPhotoOnce(bucket, "actor/photos/photo.jpg", new ArrayBuffer(4), "image/jpeg"), /differs/);
  await assert.rejects(uploadPhotoOnce(bucket, "actor/photos/photo.jpg", bytes, "image/png"), /differs/);
});

test("a storage authorization or transport failure remains visible to the queue", async () => {
  const error = { status: 403, message: "File unavailable" };
  const bucket = {
    async upload() { return { error }; },
    async info() { assert.fail("A non-duplicate failure must not start a metadata read"); },
  };
  await assert.rejects(uploadPhotoOnce(bucket, "actor/photo.jpg", new ArrayBuffer(3), "image/jpeg"), (cause) => cause === error);
});
