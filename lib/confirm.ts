import { Alert, Platform } from "react-native";

/** Cross-platform destructive confirm dialog. */
export function confirmAction(
  title: string,
  message: string,
  onConfirm: () => void,
  confirmLabel = "Delete",
) {
  if (Platform.OS === "web") {
    if (window.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    { text: confirmLabel, style: "destructive", onPress: onConfirm },
  ]);
}
