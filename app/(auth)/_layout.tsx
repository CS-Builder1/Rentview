import { Stack } from "expo-router";

export default function AuthLayout() {
  // Keep the navigator registered while shared-browser auth changes. Removing
  // it during sign-in churns navigation state in the other tab. Login owns its
  // signed-in redirect; callback and reset-password keep their own guards.
  return <Stack screenOptions={{headerShown:false}}/>;
}
