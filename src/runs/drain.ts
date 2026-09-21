import { createKeyedQueue } from "../util/async.ts";
import type { InstanceRegistry } from "./instance-registry.ts";
import type { TaskProtection } from "./task-protection.ts";
import { createSweeper, type Sweeper } from "../util/sweeper.ts";

export interface DrainController {
  start(): void;
  stop(): Promise<void>;
  canClaim(): boolean;
  noteBusy(): void;
}

const DRAIN_SWEEP_MS = 10_000;

export function createDrainController(opts: {
  registry: InstanceRegistry;
  protection: TaskProtection | null;
  busy: () => boolean;
  sweepMs?: number;
}): DrainController {
  let superseded = false;
  let protectionOn = false;
  let stopped = false;
  let sweeping = false;
  const queue = createKeyedQueue();
  const protect = (enabled: boolean, refresh = false): Promise<void> =>
    queue("protection", async () => {
      if (!opts.protection || (enabled && stopped) || (protectionOn === enabled && !refresh)) return;
      await opts.protection.set(enabled);
      protectionOn = enabled;
    });
  const sweeper: Sweeper = createSweeper(
    async () => {
      if (sweeping || stopped) return;
      sweeping = true;
      try {
        const wasSuperseded = superseded;
        superseded = await opts.registry.beat();
        if (superseded !== wasSuperseded) {
          console.error(
            `[drain] ${superseded ? "newer build is live — draining: no new run claims, finishing in-flight turns" : "newer build gone — resuming run claims"}`,
          );
        }
        if (stopped) return;
        const busy = opts.busy();
        await protect(busy, busy);
      } finally {
        sweeping = false;
      }
    },
    opts.sweepMs ?? DRAIN_SWEEP_MS,
    { label: "deploy-drain", immediate: true },
  );
  return {
    start: () => {
      stopped = false;
      sweeper.start();
    },
    stop: async () => {
      stopped = true;
      await sweeper.stop();
      await protect(false);
    },
    canClaim: () => !superseded,
    noteBusy: () => {
      void protect(true);
    },
  };
}
