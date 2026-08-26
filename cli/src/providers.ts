export const HOSTING_PROVIDER_IDS = ["docker", "fly", "aws"] as const;

export type Target = (typeof HOSTING_PROVIDER_IDS)[number];

export const isTarget = (value: unknown): value is Target =>
  typeof value === "string" && (HOSTING_PROVIDER_IDS as readonly string[]).includes(value);

export type SandboxBackendId = "sprites" | "aws";

export interface SandboxBackendPolicy {
  allowed: readonly SandboxBackendId[];
  requireExplicit: boolean;
}

export const SANDBOX_BACKEND_POLICY: Record<Target, SandboxBackendPolicy> = {
  docker: { allowed: ["sprites"], requireExplicit: false },
  fly: { allowed: ["sprites"], requireExplicit: false },
  aws: { allowed: ["sprites", "aws"], requireExplicit: true },
};

export const targetsAllowingSandboxBackend = (backend: SandboxBackendId): Target[] =>
  HOSTING_PROVIDER_IDS.filter((target) => SANDBOX_BACKEND_POLICY[target].allowed.includes(backend));

export const hostingProviderChoices = (): string =>
  `${HOSTING_PROVIDER_IDS.slice(0, -1).join(", ")}, or ${HOSTING_PROVIDER_IDS.at(-1)}`;
