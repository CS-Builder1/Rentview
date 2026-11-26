import { Directory, File, Paths } from "expo-file-system";
import type { PhotoStorage } from "./photoStorage";

const directoryFor = (accountId: string) => new Directory(Paths.document, "offline-photos", accountId);

function fileFor(key: string) {
  const [owner, id] = key.split("/");
  return new File(directoryFor(owner), id);
}

export const offlinePhotos: PhotoStorage = {
  async write(key, bytes) {
    const destination = fileFor(key);
    const directory = destination.parentDirectory;
    directory.create({ intermediates: true, idempotent: true });
    // Metadata is committed only after the complete file has been renamed.
    const temp = new File(directory, destination.name + ".tmp");
    temp.write(new Uint8Array(bytes));
    if (destination.exists) destination.delete();
    temp.move(destination);
  },
  async read(key) {
    const file = fileFor(key);
    if (!file.exists) throw new Error("The saved photo is missing from this device.");
    return file.arrayBuffer();
  },
  async remove(key) {
    const file = fileFor(key);
    if (file.exists) file.delete();
  },
  async list(accountId) {
    const directory = directoryFor(accountId);
    if (!directory.exists) return [];
    return directory.list().filter(file => file instanceof File).map(file => accountId + "/" + file.name);
  },
};
