import { parseSuggestedActivities } from "../../chassis/src/suggested-activities.ts";
import { api } from "./core-bridge";
import type { Me } from "./shell-state";

const requests = new WeakMap<Me, { until: number; pending: Promise<void> }>();

export function loadGeneratedActivities(me: Me, onChange?: () => void): Promise<void> {
  if (!me.suggestedActivitiesGeneration) return Promise.resolve();
  const snapshot = () => JSON.stringify(me.suggestedActivities ?? []);
  const cached = requests.get(me);
  if (cached && cached.until > Date.now()) {
    const before = snapshot();
    return cached.pending.then(() => {
      if (snapshot() !== before) onChange?.();
    });
  }
  const pending = (async () => {
    for (let attempt = 0; attempt < 19; attempt++) {
      const response = await api<{ activities: unknown; pending?: boolean }>("/api/suggested-activities", {
        method: "POST",
        body: JSON.stringify({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
      });
      const activities = parseSuggestedActivities(JSON.stringify(response.activities));
      if (JSON.stringify(activities) !== snapshot()) {
        me.suggestedActivities = activities;
        onChange?.();
      }
      if (!response.pending) return;
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  })().catch(() => undefined);
  requests.set(me, { until: Date.now() + 5 * 60_000, pending });
  return pending;
}
