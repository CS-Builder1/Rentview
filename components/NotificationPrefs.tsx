import { useCallback, useEffect, useState } from "react";
import { Switch, Text, View } from "react-native";

import { useAuth } from "../lib/auth";
import { PUSH_SUPPORTED } from "../lib/push";
import { supabase } from "../lib/supabase";
import { Card } from "./ui";

type Prefs = {
  push_enabled: boolean;
  requests: boolean;
  messages: boolean;
  announcements: boolean;
};

// No row means everything is on, so a user who never opens this screen still
// hears about their requests.
const DEFAULTS: Prefs = {
  push_enabled: true,
  requests: true,
  messages: true,
  announcements: true,
};

const LABELS: Record<
  "owner" | "tenant",
  { key: keyof Prefs; label: string; hint: string }[]
> = {
  owner: [
    {
      key: "requests",
      label: "Tenant requests",
      hint: "New reports and when a tenant closes one",
    },
    {
      key: "messages",
      label: "Messages",
      hint: "Replies on a request thread",
    },
  ],
  tenant: [
    {
      key: "requests",
      label: "Repair updates",
      hint: "When your landlord picks up or finishes a job",
    },
    {
      key: "messages",
      label: "Messages",
      hint: "Replies from your landlord",
    },
    {
      key: "announcements",
      label: "Building notices",
      hint: "Shut-offs, inspections and other broadcasts",
    },
  ],
};

function Row({
  label,
  hint,
  value,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <View className="flex-row items-center border-b border-slate-100 py-3">
      <View className="flex-1 pr-3">
        <Text
          className={`text-base ${disabled ? "text-slate-400" : "text-slate-800"}`}
        >
          {label}
        </Text>
        {hint ? <Text className="mt-0.5 text-xs text-slate-400">{hint}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ true: "#0f766e", false: "#cbd5e1" }}
      />
    </View>
  );
}

/**
 * Per-user mute switches. Writes go straight through — the switch reflects
 * what was asked for immediately and reverts if the write fails, because a
 * toggle that lags feels broken.
 */
export function NotificationPrefs({ variant }: { variant: "owner" | "tenant" }) {
  const { session } = useAuth();
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS);

  const load = useCallback(async () => {
    if (!session) return;
    const { data } = await supabase
      .from("notification_prefs")
      .select("push_enabled, requests, messages, announcements")
      .eq("user_id", session.user.id)
      .maybeSingle();
    if (data) setPrefs(data);
  }, [session]);

  useEffect(() => {
    load();
  }, [load]);

  async function update(patch: Partial<Prefs>) {
    if (!session) return;
    const previous = prefs;
    const next = { ...prefs, ...patch };
    setPrefs(next);
    const { error } = await supabase
      .from("notification_prefs")
      .upsert({ user_id: session.user.id, ...next }, { onConflict: "user_id" });
    if (error) setPrefs(previous);
  }

  const muted = !prefs.push_enabled;

  return (
    <View>
      <Text className="mb-2 mt-4 text-sm font-semibold uppercase text-slate-400">
        Notifications
      </Text>
      <Card>
        <Row
          label="Push notifications"
          hint={muted ? "Everything is muted on this account" : undefined}
          value={prefs.push_enabled}
          onChange={(value) => update({ push_enabled: value })}
        />
        {LABELS[variant].map((row) => (
          <Row
            key={row.key}
            label={row.label}
            hint={row.hint}
            value={prefs[row.key]}
            disabled={muted}
            onChange={(value) => update({ [row.key]: value } as Partial<Prefs>)}
          />
        ))}
        {!PUSH_SUPPORTED ? (
          <Text className="mt-3 text-xs text-slate-400">
            These apply to the mobile app — the web app does not send push
            notifications.
          </Text>
        ) : null}
      </Card>
    </View>
  );
}
