import { Alert, Platform } from "react-native";

/** Consistent feedback on native and web (React Native Alert has no web implementation). */
export function notify(title: string, message: string): void {
  if (Platform.OS === "web") window.alert(`${title}\n\n${message}`);
  else Alert.alert(title, message);
}
