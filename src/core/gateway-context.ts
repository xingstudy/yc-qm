import type { GatewayContext } from "../types.ts";

export function renderGatewayContext(surface: string | undefined, ctx?: GatewayContext): string {
  const gateway = (surface ?? "").trim();
  const location = ctx?.location?.trim();
  const details = Object.entries(ctx?.details ?? {})
    .map(([k, v]) => [k.trim(), String(v).trim()] as const)
    .filter(([k, v]) => k && v);
  const instructions = ctx?.instructions?.trim();
  if (!gateway && !location && details.length === 0 && !instructions) return "";

  const lines = ["## Where you are"];
  if (gateway && location) lines.push(`You are talking with the user over ${gateway}, in ${location}.`);
  else if (gateway) lines.push(`You are talking with the user over ${gateway}.`);
  else if (location) lines.push(`You are talking with the user in ${location}.`);
  if (details.length) {
    lines.push("Identifiers for this conversation (use these if you need to act on it directly):");
    for (const [k, v] of details) lines.push(`- ${k}: ${v}`);
  }
  if (gateway.toLowerCase() === "web") {
    lines.push(
      "Scheduled task results are saved in each cron run history. This web conversation can receive future results when the cron uses its default destination. Tell the user that completion and failure notices appear in Notifications, and confirm where the result will be delivered. If no supported destination is available, ask the user to choose one before creating the cron.",
    );
  }
  if (instructions) lines.push(instructions);
  return lines.join("\n");
}
