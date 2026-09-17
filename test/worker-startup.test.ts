import assert from "node:assert/strict";
import test from "node:test";

for (const failed of ["migrationsReady", "deploymentLayerReady"] as const) {
  test(`worker does not initialize sandboxes or claim runs after ${failed} rejects`, async (t) => {
    let starts = 0;
    let sandboxInitializations = 0;
    const failure = Promise.reject(new Error(`failed ${failed}`));
    void failure.catch(() => undefined);
    t.mock.module("../src/config.ts", { namedExports: { loadConfig: () => ({}) } });
    t.mock.module("../src/wiring.ts", {
      namedExports: {
        buildApp: () => ({
          migrationsReady: failed === "migrationsReady" ? failure : Promise.resolve(),
          deploymentLayerReady: failed === "deploymentLayerReady" ? failure : Promise.resolve(),
          sandboxResources: {
            initialize: async () => {
              sandboxInitializations++;
            },
          },
          runtime: {
            start: () => {
              starts++;
            },
          },
        }),
        stopWithBackstop: () => undefined,
      },
    });
    await assert.rejects(import(`../src/runs/worker-main.ts?failure=${failed}`), new RegExp(`failed ${failed}`));
    assert.equal(starts, 0);
    assert.equal(sandboxInitializations, 0);
  });
}
