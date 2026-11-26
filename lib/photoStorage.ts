/** Keys are scoped to an authenticated account and its stable document UUID. */
export interface PhotoStorage {
  write(key: string, bytes: ArrayBuffer): Promise<void>;
  read(key: string): Promise<ArrayBuffer>;
  remove(key: string): Promise<void>;
  list(accountId: string): Promise<string[]>;
}
