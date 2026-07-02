/**
 * Lightweight toast notifications. Replaces success Alert.alert popups with a
 * non-blocking banner that slides in from the top and auto-dismisses.
 *
 *   const toast = useToast();
 *   toast.show("Work order created");
 *   toast.show("Something went wrong", "error");
 */
import { Ionicons } from "@expo/vector-icons";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Pressable, Text, View } from "react-native";
import Animated, { FadeInUp, FadeOutUp } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type ToastType = "success" | "error" | "info";

type ToastState = { id: number; message: string; type: ToastType };

const ToastContext = createContext<
  { show: (message: string, type?: ToastType) => void } | undefined
>(undefined);

const toastStyles: Record<
  ToastType,
  { bg: string; icon: keyof typeof Ionicons.glyphMap; iconColor: string }
> = {
  success: { bg: "bg-brand-800", icon: "checkmark-circle", iconColor: "#5eead4" },
  error: { bg: "bg-red-700", icon: "alert-circle", iconColor: "#fecaca" },
  info: { bg: "bg-slate-800", icon: "information-circle", iconColor: "#cbd5e1" },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const insets = useSafeAreaInsets();

  const show = useCallback((message: string, type: ToastType = "success") => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ id: Date.now(), message, type });
    timer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toast ? (
        <Animated.View
          key={toast.id}
          entering={FadeInUp.duration(220)}
          exiting={FadeOutUp.duration(180)}
          style={{ position: "absolute", top: insets.top + 8, left: 16, right: 16 }}
          pointerEvents="box-none"
        >
          <Pressable onPress={() => setToast(null)}>
            <View
              className={`flex-row items-center rounded-2xl px-4 py-3 shadow-lg ${toastStyles[toast.type].bg}`}
            >
              <Ionicons
                name={toastStyles[toast.type].icon}
                size={20}
                color={toastStyles[toast.type].iconColor}
              />
              <Text className="ml-2 flex-1 font-medium text-white" numberOfLines={2}>
                {toast.message}
              </Text>
            </View>
          </Pressable>
        </Animated.View>
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}
