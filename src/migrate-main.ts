import { loadConfig } from "./config.ts";
import { buildApp } from "./wiring.ts";

const config = loadConfig();
const built = buildApp({ ...config, seedSkills: false });
try {
  await built.migrationsReady;
  await built.deploymentLayerReady;
  console.log("[qm:migrate] database migrations applied");
} finally {
  await built.runtime.stop();
}
