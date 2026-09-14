import type { ActorAssertion, Principal } from "../types.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import { personKey } from "../directory/person.ts";
import { externalMemberActive, type ExternalMember } from "./external-members.ts";

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
  listExternalMembers(): Promise<ExternalMember[]>;
  readExternalMember(email: string): Promise<ExternalMember | null>;
  externalMember(principalId: string): ExternalMember | undefined;
  putExternalMember(m: ExternalMember): Promise<void>;
  removeExternalMember(principalId: string): Promise<void>;
  hydrate(): Promise<void>;
  refresh(force?: boolean): Promise<void>;
}

export function actorAssertionActive(
  identity: Pick<IdentityService, "classify" | "isInternal">,
  actor: ActorAssertion | undefined,
): boolean {
  return !!actor?.externalId && identity.isInternal(identity.classify(actor.externalId, actor.isExternalGuest));
}

interface IdentityOptions {
  isOverridden?: (externalId: string) => boolean;
  directorySyncProtected?: readonly string[];
  externalMembers?: DurableMap<ExternalMember>;
  statusBacking?: DurableMap<IdentityStatusRecord>;
  ready?: () => Promise<void>;
}

export function createIdentityService(
  backing?: DurableMap<DeactivationRecord>,
  optionsOrStatus?: IdentityOptions | DurableMap<IdentityStatusRecord>,
  ready?: () => Promise<void>,
): IdentityService {
  const opts: IdentityOptions =
    optionsOrStatus && "all" in optionsOrStatus
      ? { statusBacking: optionsOrStatus, ready }
      : { ...optionsOrStatus, ready: ready ?? optionsOrStatus?.ready };
  const store = backing ?? createMemoryMap<DeactivationRecord>();
  const statusStore = opts.statusBacking ?? createMemoryMap<IdentityStatusRecord>();
  const deactivated = new Map<string, DeactivationRecord>();
  const statusVersions = new Map<string, IdentityStatusRecord>();
  const externalStore = opts.externalMembers ?? createMemoryMap<ExternalMember>();
  const externals = new Map<string, ExternalMember>();
  const directorySyncProtected = new Set((opts.directorySyncProtected ?? []).map(personKey).filter(Boolean));
  const REFRESH_TTL_MS = 10_000;
  let refreshedAt = 0;
  let refreshP: Promise<void> | null = null;
  let hydrateP: Promise<void> | null = null;

  const keptByDirectorySync = (key: string): boolean => directorySyncProtected.has(key) || externals.has(key);

  async function load(): Promise<void> {
    await synchronize();
    const members = await externalStore.all();
    externals.clear();
    for (const member of members) externals.set(personKey(member.email), member);
  }

  function classify(externalId: string, isExternalGuest?: boolean): Principal {
    const key = personKey(externalId);
    const record = deactivated.get(key);
    if (
      statusVersions.get(key)?.status === "deactivated" ||
      (record?.sessionVersion !== undefined && record.status !== "active")
    ) {
      return { id: externalId, type: "guest" };
    }
    if (opts.isOverridden?.(externalId)) return { id: externalId, type: "internal" };
    const external = externals.get(key);
    const inactive =
      record?.source === "manual" ||
      (record?.source === "directory-sync" && !keptByDirectorySync(key)) ||
      (external !== undefined && !externalMemberActive(external));
    const type: Principal["type"] = inactive || isExternalGuest ? "guest" : "internal";
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

  async function refresh(force = false): Promise<void> {
    await opts.ready?.();
    const now = Date.now();
    if (refreshP) return refreshP;
    if (!force && now - refreshedAt < REFRESH_TTL_MS) return;
    refreshP = load()
      .then(() => {
        refreshedAt = Date.now();
      })
      .finally(() => {
        refreshP = null;
      });
    return refreshP;
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
        if (keptByDirectorySync(key)) continue;
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
    async listExternalMembers(): Promise<ExternalMember[]> {
      await refresh();
      return [...externals.values()];
    },
    async readExternalMember(email) {
      await opts.ready?.();
      const key = personKey(email);
      const member = await externalStore.get(key);
      if (member) externals.set(key, member);
      else externals.delete(key);
      return member;
    },
    externalMember(principalId: string): ExternalMember | undefined {
      return externals.get(personKey(principalId));
    },
    async putExternalMember(m: ExternalMember): Promise<void> {
      const key = personKey(m.email);
      await externalStore.put(key, m);
      externals.set(key, m);
    },
    async removeExternalMember(principalId: string): Promise<void> {
      const key = personKey(principalId);
      await externalStore.delete(key);
      externals.delete(key);
    },
    hydrate(): Promise<void> {
      if (!hydrateP) hydrateP = load();
      return hydrateP;
    },
    refresh,
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
