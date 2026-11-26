import { useFocusEffect } from "expo-router";
import { useCallback, useRef } from "react";
import { AppState } from "react-native";

/** Run immediately on focus/resume, then poll while visible. Ignore results
 * from an old identity or screen, including after a manual refresh. */
export function useInboxRefresh(load: (current: () => boolean) => Promise<void>, interval = 12000) {
  const active = useRef(false);
  const revision = useRef(0);
  const running = useRef(false);
  const refresh = useCallback(async () => {
    if (!active.current) return;
    const ticket = ++revision.current;
    const current = () => active.current && ticket === revision.current;
    running.current = true;
    try { await load(current); }
    finally { if (current()) running.current = false; }
  }, [load]);
  useFocusEffect(useCallback(() => {
    active.current = true;
    void refresh();
    const timer = setInterval(() => {
      if (AppState.currentState === "active" && !running.current) void refresh();
    }, interval);
    const listener = AppState.addEventListener("change", state => {
      if (state === "active") void refresh();
    });
    return () => {
      active.current = false;
      revision.current++;
      running.current = false;
      listener.remove();
      clearInterval(timer);
    };
  }, [interval, refresh]));
  return refresh;
}
