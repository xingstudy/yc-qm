import { AsyncLocalStorage } from "node:async_hooks";
import type { UsageFact, UsageIdentity } from "./usage-store.ts";
import type { UsageService } from "./usage-service.ts";

export interface UsageContext {
  service: UsageService;
  identity: UsageIdentity;
  harness: string;
  model: string;
  pricingMode?: "standard" | "fast";
  native?: UsageFact;
  streamActive?: boolean;
}

export const usageContext = new AsyncLocalStorage<UsageContext>();

export function usageMetered(): boolean {
  return usageContext.getStore() !== undefined;
}
