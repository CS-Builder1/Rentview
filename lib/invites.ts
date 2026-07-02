import AsyncStorage from "@react-native-async-storage/async-storage";

import { supabase } from "./supabase";

// The invite code survives signup/OAuth redirects in AsyncStorage and is
// claimed on the first authenticated app load (app/index.tsx).
const PENDING_KEY = "rentview.pendingInviteCode";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

export function generateInviteCode(length = 8): string {
  let code = "";
  for (let i = 0; i < length; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

export async function setPendingInviteCode(code: string): Promise<void> {
  await AsyncStorage.setItem(PENDING_KEY, code.trim().toUpperCase());
}

export async function getPendingInviteCode(): Promise<string | null> {
  return AsyncStorage.getItem(PENDING_KEY);
}

export async function clearPendingInviteCode(): Promise<void> {
  await AsyncStorage.removeItem(PENDING_KEY);
}

/** Claim an invite for the signed-in user. Throws with a friendly message. */
export async function claimInvite(code: string): Promise<void> {
  const { error } = await supabase.rpc("claim_tenant_invite", {
    invite_code: code,
  });
  if (error) throw new Error(error.message);
}
