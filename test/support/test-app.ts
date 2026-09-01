import { buildApp as buildCoreApp, type BuiltApp } from "../../src/wiring.ts";
import type { Config } from "../../src/config.ts";

export type { BuiltApp } from "../../src/wiring.ts";

export function buildApp(config: Config, overrides: Parameters<typeof buildCoreApp>[1] = {}): BuiltApp {
  const built = buildCoreApp(config, overrides);
  const getDirectoryMember = built.directory.get.bind(built.directory);
  built.directory.get = async (principalId) => {
    const member = await getDirectoryMember(principalId);
    if (member || !built.identity.isInternal(built.identity.classify(principalId))) return member;
    return { principalId, displayName: principalId, type: "internal" };
  };
  return built;
}
