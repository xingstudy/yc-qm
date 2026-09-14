import { NonRetryableTurnError } from "../core/turn-error.ts";
import { resolveRuntimeChoiceDurable } from "../harness/harness-router.ts";
import type { ServerDeps } from "./deps.ts";
import type { ScopeId } from "../types.ts";
import { orgScope } from "./routes/shared.ts";
import {
  defaultModelForHarness,
  isHarnessId,
  modelProviderAvailabilityFor,
  modelSupportedByHarness,
  serviceableModelIds,
  ALL_PROVIDERS_AVAILABLE,
  fastModeModelIds,
  safeModelMetadata,
  modelOfferedInWebui,
  modelUnavailableReason,
  thinkingLevelsForHarness,
  harnessSupportsFastMode,
  type HarnessId,
} from "../model/pi-models.ts";
import { builtInModelCatalog, selectableCatalogForHarness, selectableModelCatalog } from "../model/model-catalog.ts";
import type { RuntimeChoice } from "../harness/harness.ts";

export type RuntimeDeps = Pick<
  ServerDeps,
  | "config"
  | "harnessId"
  | "baseModelDefault"
  | "providerKeys"
  | "modelCredentials"
  | "modelCredentialFetch"
  | "refreshModels"
  | "refreshCustomProviders"
>;

export function runtimeFallback(ctx: { deps: RuntimeDeps }): { harnessId: HarnessId; modelId: string } {
  const harnessId = isHarnessId(ctx.deps.harnessId) ? ctx.deps.harnessId : "pi";
  return { harnessId, modelId: ctx.deps.baseModelDefault ?? defaultModelForHarness(harnessId) };
}

export async function runtimeConfigBody(ctx: { deps: RuntimeDeps }, scope: ScopeId, principalId?: string) {
  await ctx.deps.refreshModels?.();
  await ctx.deps.refreshCustomProviders?.();
  const config = ctx.deps.config!;
  const fallback = runtimeFallback(ctx);
  const org = orgScope(ctx.deps);
  const approvedHarnesses = (
    (await config.getApprovedHarnessesDurable(scope, principalId)) ?? [fallback.harnessId]
  ).filter(isHarnessId);
  const firstApproved = approvedHarnesses[0] ?? fallback.harnessId;
  const safeFallback =
    approvedHarnesses.includes(fallback.harnessId) && modelSupportedByHarness(fallback.modelId, fallback.harnessId)
      ? fallback
      : { harnessId: firstApproved, modelId: defaultModelForHarness(firstApproved, fallback.modelId) };
  const configuredKeys = ctx.deps.providerKeys ?? ALL_PROVIDERS_AVAILABLE;
  const managedKeys = ctx.deps.modelCredentials ? await ctx.deps.modelCredentials.availability() : configuredKeys;
  const providersFor = (harnessId: string) => modelProviderAvailabilityFor(harnessId, configuredKeys, managedKeys);
  const catalog =
    ctx.deps.modelCredentials && managedKeys.openrouter
      ? await selectableModelCatalog(ctx.deps.modelCredentialFetch)
      : builtInModelCatalog();
  const orgStored = await config.getRuntimeSelectionDurable(org);
  const orgLegacyModel = orgStored ? null : await config.getBaseModelOwnDurable(org);
  let orgDefault: {
    harnessId: HarnessId;
    modelId: string;
    effortLevel?: string;
    fastMode?: boolean;
    revision: number;
  } = { ...safeFallback, revision: orgStored?.revision ?? 0 };
  if (
    orgStored &&
    isHarnessId(orgStored.harnessId) &&
    approvedHarnesses.includes(orgStored.harnessId) &&
    (modelSupportedByHarness(orgStored.modelId, orgStored.harnessId) || modelUnavailableReason(orgStored.modelId))
  ) {
    orgDefault = {
      harnessId: orgStored.harnessId,
      modelId: orgStored.modelId,
      ...(orgStored.effortLevel ? { effortLevel: orgStored.effortLevel } : {}),
      ...(typeof orgStored.fastMode === "boolean" ? { fastMode: orgStored.fastMode } : {}),
      revision: orgStored.revision ?? 0,
    };
  } else if (
    orgLegacyModel &&
    approvedHarnesses.includes(fallback.harnessId) &&
    modelSupportedByHarness(orgLegacyModel, fallback.harnessId)
  ) {
    orgDefault = { harnessId: fallback.harnessId, modelId: orgLegacyModel, revision: 0 };
  }
  const runtimeScope = await config.getRuntimeConfigScopeDurable(scope, principalId);
  const stored = scope === org ? orgStored : await config.getRuntimeSelectionDurable(runtimeScope);
  const legacyModel = scope === org ? null : await config.getBaseModelOwnDurable(runtimeScope);
  let scopeOverride: {
    harnessId: HarnessId;
    modelId: string;
    effortLevel?: string;
    fastMode?: boolean;
    orgRevision?: number;
  } | null = null;
  if (
    stored &&
    isHarnessId(stored.harnessId) &&
    approvedHarnesses.includes(stored.harnessId) &&
    (modelSupportedByHarness(stored.modelId, stored.harnessId) || modelUnavailableReason(stored.modelId))
  ) {
    scopeOverride = {
      harnessId: stored.harnessId,
      modelId: stored.modelId,
      ...(stored.effortLevel ? { effortLevel: stored.effortLevel } : {}),
      ...(typeof stored.fastMode === "boolean" ? { fastMode: stored.fastMode } : {}),
      orgRevision: stored.orgRevision,
    };
  } else if (
    legacyModel &&
    approvedHarnesses.includes(fallback.harnessId) &&
    modelSupportedByHarness(legacyModel, fallback.harnessId)
  ) {
    scopeOverride = { harnessId: fallback.harnessId, modelId: legacyModel, orgRevision: 0 };
  }
  const displayChoice = async (target: ScopeId): Promise<RuntimeChoice> => {
    try {
      return await resolveRuntimeChoiceDurable(config, org, target, fallback, undefined, principalId);
    } catch (error) {
      if (!(error instanceof NonRetryableTurnError)) throw error;
      const owner = await config.getRuntimeConfigScopeDurable(target, principalId);
      const selected = (await config.getRuntimeSelectionDurable(owner)) ?? orgStored;
      const allowed = await config.getWebuiModelsDurable(target, principalId);
      const scopedAllowed = await config.getScopedWebuiModelsDurable(target, principalId);
      if (
        selected &&
        isHarnessId(selected.harnessId) &&
        approvedHarnesses.includes(selected.harnessId) &&
        modelUnavailableReason(selected.modelId) &&
        (allowed === null || allowed.includes(selected.modelId) || selected.modelId === orgStored?.modelId) &&
        (scopedAllowed === null || scopedAllowed.includes(selected.modelId))
      )
        return selected as RuntimeChoice;
      throw error;
    }
  };
  const effectiveChoice = await displayChoice(scope);
  const effective = { ...(scopeOverride ?? orgDefault), ...effectiveChoice };
  const inheritedScope = await config.getRuntimeConfigScopeDurable(scope, principalId, true);
  const inheritedDefault = await displayChoice(inheritedScope);
  const selected = [orgDefault, scopeOverride, effective, inheritedDefault].filter((choice) => choice !== null);
  const allowlist = await config.getWebuiModelsDurable(scope, principalId);
  const scopedAllowlist = await config.getScopedWebuiModelsDurable(scope, principalId);
  const modelsByHarness = Object.fromEntries(
    approvedHarnesses.map((harnessId) => {
      const ids =
        allowlist !== null
          ? allowlist.filter((id) => modelSupportedByHarness(id, harnessId))
          : selectableCatalogForHarness(catalog, harnessId)
              .filter((model) => modelOfferedInWebui(model.id))
              .map((model) => model.id);
      for (const choice of selected) {
        if (
          (allowlist === null || allowlist.includes(choice.modelId) || choice.modelId === orgDefault.modelId) &&
          (scopedAllowlist === null || scopedAllowlist.includes(choice.modelId)) &&
          choice.harnessId === harnessId &&
          modelSupportedByHarness(choice.modelId, harnessId) &&
          !ids.includes(choice.modelId)
        )
          ids.push(choice.modelId);
      }
      return [harnessId, serviceableModelIds(ids, providersFor(harnessId))];
    }),
  );
  const advertisedModelIds = new Set(Object.values(modelsByHarness).flat());
  const modelCatalog = Object.fromEntries(
    [...advertisedModelIds].flatMap((id) => {
      const metadata = safeModelMetadata(id);
      return metadata ? [[id, metadata]] : [];
    }),
  );
  return {
    scopeId: scope,
    approvedHarnesses,
    modelsByHarness,
    modelCatalog,
    orgDefault,
    scopeOverride: runtimeScope === scope ? scopeOverride : null,
    inheritedFrom: inheritedScope,
    inheritedDefault,
    effective: {
      harnessId: effective.harnessId,
      modelId: effective.modelId,
      ...(effective.effortLevel ? { effortLevel: effective.effortLevel } : {}),
      ...(typeof effective.fastMode === "boolean" ? { fastMode: effective.fastMode } : {}),
    },
    upgradeAvailable: Boolean(
      runtimeScope === scope && scopeOverride && scopeOverride.orgRevision !== orgDefault.revision,
    ),
    fastModeModelIds: fastModeModelIds(),
    ...(!modelsByHarness[effective.harnessId]?.includes(effective.modelId)
      ? {
          unavailableReason:
            modelUnavailableReason(effective.modelId) ?? "Selected model is unavailable; choose another model",
        }
      : {}),
    interactiveFastMode: await config.getInteractiveFastModeDurable(scope, principalId),
  };
}

export function validateRuntimeChoice(choice: RuntimeChoice): string | null {
  if (!modelSupportedByHarness(choice.modelId, choice.harnessId)) return "model_not_supported";
  if (choice.effortLevel !== undefined && !thinkingLevelsForHarness(choice.harnessId).includes(choice.effortLevel))
    return "effort_not_supported";
  if (choice.fastMode !== undefined && typeof choice.fastMode !== "boolean") return "fast_mode_invalid";
  if (choice.fastMode && (!harnessSupportsFastMode(choice.harnessId) || !fastModeModelIds().includes(choice.modelId)))
    return "fast_mode_not_supported";
  return null;
}

export async function webuiModelEnabled(
  ctx: { deps: RuntimeDeps },
  modelId: string,
  scope: ScopeId = orgScope(ctx.deps),
  principalId?: string,
): Promise<boolean> {
  modelId = modelId.replace(/^codex\//, "");
  const config = ctx.deps.config!;
  const picker = await config.getWebuiModelsDurable(scope, principalId);
  const scoped = await config.getScopedWebuiModelsDurable(scope, principalId);
  if (scoped !== null && !scoped.includes(modelId)) return false;
  if (picker === null || picker.includes(modelId)) return true;
  if (picker.length === 0) return false;
  const org = orgScope(ctx.deps);
  const stored = await config.getRuntimeSelectionDurable(org);
  const orgModel = stored?.modelId ?? (await config.getBaseModelOwnDurable(org)) ?? runtimeFallback(ctx).modelId;
  return modelId === orgModel;
}
