/** Async account actions must remain bound to the account that initiated them. */
export function accountActionGuard(expectedUserId: string, current: () => string | null | undefined): () => void {
  return () => {
    if (current() !== expectedUserId) {
      throw new Error("The signed-in account changed. This action was stopped; review the current account before trying again.");
    }
  };
}

/** Successful local sign-out may already have cleared the initiating session. */
export function canNavigateAfterSignOut(expectedUserId: string, currentUserId: string | null | undefined): boolean {
  return currentUserId == null || currentUserId === expectedUserId;
}
