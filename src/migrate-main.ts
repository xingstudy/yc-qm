import { loadConfig } from "./config.ts";
import { buildApp } from "./wiring.ts";

const config = loadConfig();
const built = buildApp({ ...config, seedSkills: false });
await built.migrationsReady;
await built.deploymentLayerReady;
console.log("[qm:migrate] database migrations applied");
