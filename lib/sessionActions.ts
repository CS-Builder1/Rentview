export type SignOutDependencies = {
  account: () => string | null;
  unregisterDevice: () => Promise<void>;
  signOutSession: () => Promise<{ error: unknown }>;
  acceptSignedOut: () => void;
  clearReadCache: (accountId: string) => Promise<void>;
  clearDestination: () => Promise<void>;
};
const accountChanged = () => new Error("The signed-in account changed. The current account has not been signed out.");

/** Bind delayed deletion cleanup to its initiating account, without purging a newer account's state. */
export async function completeDeviceSignOut(deps: SignOutDependencies, expectedUserId?: string): Promise<void> {
  const owner = deps.account();
  if (expectedUserId && owner !== expectedUserId) throw accountChanged();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      deps.unregisterDevice().catch(() => undefined),
      new Promise<void>(resolve => { timeout = setTimeout(resolve, 2500); }),
    ]);
  } finally { if (timeout !== undefined) clearTimeout(timeout); }
  if (deps.account() !== owner) throw accountChanged();
  const { error } = await deps.signOutSession();
  if (error) throw error;
  if (deps.account() === owner) deps.acceptSignedOut();
  if (owner) await deps.clearReadCache(owner).catch(() => undefined);
  // SDK sign-out handles invalid/deleted-user401/403/404 locally. Never delete raw
  // auth-storage keys here: they may now hold a different account's session.
  if (deps.account() !== null) throw accountChanged();
  await deps.clearDestination().catch(() => undefined);
  if (deps.account() !== null) throw accountChanged();
}
