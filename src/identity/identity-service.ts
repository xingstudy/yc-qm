import type { ActorAssertion, Principal } from "../types.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import { personKey } from "../directory/person.ts";

interface IdentityProvider {
  resolve(actor: ActorAssertion): Principal;
  classify(externalId: string, isExternalGuest?: boolean): Principal;
}

type DeactivationSource = "manual" | "directory-sync";

export interface DeactivationRecord {
  principalId: string;
  source: DeactivationSource;
  at: number;
  status?: "active" | "deactivated";
  sessionVersion?: number;
}

export interface IdentityStatusRecord {
  principalId: string;
  source: DeactivationSource;
  status: "active" | "deactivated";
  sessionVersion: number;
  at: number;
}

interface DirectorySyncOutcome {
  deactivated: string[];
  reactivated: string[];
}

export interface IdentityService extends IdentityProvider {
  isInternal(p: Principal): boolean;
  audienceIsAllInternal(audience: Principal[]): boolean;
  deactivate(externalId: string, source?: DeactivationSource, sessionVersion?: number): Promise<void>;
  reactivate(externalId: string, sessionVersion?: number): Promise<void>;
  recordDirectorySync(removedIds: string[], presentIds: string[]): Promise<DirectorySyncOutcome>;
  hydrate(): Promise<void>;
  refresh(): Promise<void>;
}

export function createIdentityService(
  backing?: DurableMap<DeactivationRecord>,
  statusBacking?: DurableMap<IdentityStatusRecord>,
): IdentityService {
  const store = backing ?? createMemoryMap<DeactivationRecord>();
  const statusStore = statusBacking ?? createMemoryMap<IdentityStatusRecord>();
  const deactivated = new Map<string, DeactivationRecord>();
  const statusVersions = new Map<string, IdentityStatusRecord>();
  const REFRESH_TTL_MS = 10_000;
  let refreshedAt = 0;
  let refreshP: Promise<void> | null = null;
  let hydrateP: Promise<void> | null = null;

  function classify(externalId: string, isExternalGuest?: boolean): Principal {
    const record = deactivated.get(personKey(externalId));
    const type: Principal["type"] =
      (record !== undefined && record.status !== "active") || isExternalGuest ? "guest" : "internal";
    return { id: externalId, type };
  }

  const remember = (key: string, record: DeactivationRecord | null): void => {
    if (record) deactivated.set(key, record);
    else deactivated.delete(key);
  };

  async function persistStatus(desired: IdentityStatusRecord): Promise<IdentityStatusRecord> {
    const key = personKey(desired.principalId);
    const initial = await statusStore.putIfAbsent(key, desired);
    if (initial.sessionVersion < desired.sessionVersion) {
      if (statusStore.update) {
        await statusStore.update(key, (current) =>
          current.sessionVersion < desired.sessionVersion ? desired : current,
        );
      } else {
        const current = await statusStore.get(key);
        if (!current || current.sessionVersion < desired.sessionVersion) await statusStore.put(key, desired);
      }
    }
    return (await statusStore.get(key)) ?? initial;
  }

  async function projectStatus(record: IdentityStatusRecord): Promise<void> {
    const key = personKey(record.principalId);
    if (record.status === "active") {
      if (store.deleteIf) {
        await store.deleteIf(key, (current) => (current.sessionVersion ?? -1) <= record.sessionVersion);
      } else {
        const current = await store.get(key);
        if (current && (current.sessionVersion ?? -1) <= record.sessionVersion) await store.delete(key);
      }
      return;
    }
    const desired: DeactivationRecord = { ...record };
    const initial = await store.putIfAbsent(key, desired);
    if ((initial.sessionVersion ?? -1) < record.sessionVersion) {
      if (store.update) {
        await store.update(key, (current) =>
          (current.sessionVersion ?? -1) < record.sessionVersion ? desired : current,
        );
      } else {
        const current = await store.get(key);
        if (!current || (current.sessionVersion ?? -1) < record.sessionVersion) await store.put(key, desired);
      }
    }
  }

  async function applyVersionedStatus(
    externalId: string,
    source: DeactivationSource,
    status: "active" | "deactivated",
    sessionVersion: number,
  ): Promise<void> {
    const key = personKey(externalId);
    let current = await persistStatus({ principalId: externalId, source, status, sessionVersion, at: Date.now() });
    for (;;) {
      statusVersions.set(key, current);
      await projectStatus(current);
      const latest = (await statusStore.get(key)) ?? current;
      if (latest.sessionVersion === current.sessionVersion && latest.status === current.status) break;
      current = latest;
    }
    remember(key, await store.get(key));
  }

  async function hasVersionedStatus(key: string): Promise<boolean> {
    if (statusVersions.has(key)) return true;
    const status = await statusStore.get(key);
    if (!status) return false;
    statusVersions.set(key, status);
    return true;
  }

  async function synchronize(): Promise<void> {
    const legacy = await store.all();
    for (const record of legacy) {
      if (record.status !== "active") continue;
      const key = personKey(record.principalId);
      if (record.sessionVersion !== undefined) {
        const migrated = await persistStatus({
          principalId: record.principalId,
          source: record.source,
          status: "active",
          sessionVersion: record.sessionVersion,
          at: record.at,
        });
        statusVersions.set(key, migrated);
        await projectStatus(migrated);
      } else if (store.deleteIf) {
        await store.deleteIf(key, (current) => current.status === "active");
      } else {
        await store.delete(key);
      }
    }
    const statuses = await statusStore.all();
    statusVersions.clear();
    for (const status of statuses) {
      statusVersions.set(personKey(status.principalId), status);
      await projectStatus(status);
    }
    deactivated.clear();
    for (const record of await store.all()) {
      if (record.status !== "active") deactivated.set(personKey(record.principalId), record);
    }
  }

  async function deactivate(
    externalId: string,
    source: DeactivationSource = "manual",
    sessionVersion?: number,
  ): Promise<void> {
    if (sessionVersion !== undefined) return applyVersionedStatus(externalId, source, "deactivated", sessionVersion);
    const key = personKey(externalId);
    if (await hasVersionedStatus(key)) return;
    const existing = deactivated.get(key);
    if (existing?.sessionVersion !== undefined) return;
    if (existing && (existing.source === "manual" || existing.source === source)) return;
    const record: DeactivationRecord = { principalId: externalId, source, status: "deactivated", at: Date.now() };
    await store.put(key, record);
    deactivated.set(key, record);
  }

  async function reactivate(externalId: string, sessionVersion?: number): Promise<void> {
    if (sessionVersion !== undefined) return applyVersionedStatus(externalId, "manual", "active", sessionVersion);
    const key = personKey(externalId);
    if (await hasVersionedStatus(key)) return;
    if (deactivated.get(key)?.sessionVersion !== undefined) return;
    await store.delete(key);
    deactivated.delete(key);
  }

  return {
    classify,
    deactivate,
    reactivate,
    async recordDirectorySync(removedIds: string[], presentIds: string[]): Promise<DirectorySyncOutcome> {
      const outcome: DirectorySyncOutcome = { deactivated: [], reactivated: [] };
      for (const id of removedIds) {
        const key = personKey(id);
        if (await hasVersionedStatus(key)) continue;
        const record = deactivated.get(key);
        if (record?.sessionVersion !== undefined || (record && record.status !== "active")) continue;
        await deactivate(id, "directory-sync");
        outcome.deactivated.push(id);
      }
      for (const id of presentIds) {
        const key = personKey(id);
        if (await hasVersionedStatus(key)) continue;
        const record = deactivated.get(key);
        if (record?.sessionVersion !== undefined || record?.source !== "directory-sync" || record.status === "active")
          continue;
        await reactivate(id);
        outcome.reactivated.push(id);
      }
      return outcome;
    },
    hydrate(): Promise<void> {
      if (!hydrateP) {
        hydrateP = synchronize();
      }
      return hydrateP;
    },
    async refresh(): Promise<void> {
      const now = Date.now();
      if (refreshP) return refreshP;
      if (now - refreshedAt < REFRESH_TTL_MS) return;
      refreshP = synchronize()
        .then(() => {
          refreshedAt = Date.now();
        })
        .finally(() => {
          refreshP = null;
        });
      return refreshP;
    },
    resolve(actor: ActorAssertion): Principal {
      const p = classify(actor.externalId, actor.isExternalGuest);
      return {
        ...p,
        ...(actor.teamIds ? { teamIds: actor.teamIds } : {}),
        ...(actor.displayName ? { displayName: actor.displayName } : {}),
      };
    },
    isInternal(p: Principal): boolean {
      return p.type === "internal";
    },
    audienceIsAllInternal(audience: Principal[]): boolean {
      return audience.length > 0 && audience.every((p) => p.type === "internal");
    },
  };
}
