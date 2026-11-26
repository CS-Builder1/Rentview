type UploadFailure = { status?: number; statusCode?: string; message: string };
type FileInfo = { size?: number; contentType?: string };

type PhotoBucket = {
  upload: (path: string, bytes: ArrayBuffer, options: { contentType: string; upsert: false }) =>
    Promise<{ error: UploadFailure | null }>;
  info: (path: string) => Promise<{ data: FileInfo | null; error: UploadFailure | null }>;
};

/** The queue persists one UUID path per photo. A lost response may leave its object committed. */
export async function uploadPhotoOnce(bucket: PhotoBucket, path: string, bytes: ArrayBuffer, contentType: string) {
  const { error } = await bucket.upload(path, bytes, { contentType, upsert: false });
  if (!error) return;
  const duplicate = error.status === 409 || error.statusCode === "409"
    || error.statusCode === "ResourceAlreadyExists" || error.statusCode === "Duplicate"
    || error.message === "The resource already exists";
  if (!duplicate) throw error;

  const existing = await bucket.info(path);
  if (existing.error) throw existing.error;
  if (existing.data?.size !== bytes.byteLength || existing.data.contentType !== contentType) {
    throw new Error("The saved photo differs from the existing attachment. Discard this change and choose the photo again.");
  }
}
