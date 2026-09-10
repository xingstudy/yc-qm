import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import * as proc from "../scripts/dev/lib/proc.ts";

test("development sandbox commands load before core dependencies are installed", () => {
  const moduleUrl = new URL("../scripts/dev/lib/sandbox.ts", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { isBuiltin, registerHooks } from 'node:module';
       registerHooks({ resolve(specifier, context, nextResolve) {
         if (!isBuiltin(specifier) && !/^(\\.{1,2}\\/|file:)/.test(specifier))
           throw new Error('unexpected package dependency: ' + specifier);
         return nextResolve(specifier, context);
       }});
       await import(${JSON.stringify(moduleUrl)});`,
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("development cleanup removes guards and networks only after sandbox containers were removed", async (t) => {
  const calls: string[][] = [];
  let failRemoval = false;
  t.mock.module("../scripts/dev/lib/proc.ts", {
    namedExports: {
      ...proc,
      run: async (_cmd: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "ps") return { code: 0, stdout: "qm-sbx-cleanup-test\n", stderr: "" };
        return { code: failRemoval && args[0] === "rm" ? 1 : 0, stdout: "", stderr: "" };
      },
    },
  });
  const { destroyLocalDevSandboxes } = await import("../scripts/dev/lib/sandbox.ts");
  await destroyLocalDevSandboxes(() => {});
  assert.ok(calls[0]!.includes("status=exited"));
  assert.ok(calls[0]!.includes("label=agent_env=dev"));
  assert.deepEqual(calls.slice(1), [
    ["rm", "-f", "qm-sbx-cleanup-test"],
    ["rm", "-f", "qm-sbx-cleanup-test-egress"],
    ["network", "rm", "qm-net-cleanup-test"],
  ]);
  assert.ok(!calls.some((args) => args.includes("volume")));
  failRemoval = true;
  calls.length = 0;
  await destroyLocalDevSandboxes(() => {});
  assert.equal(calls.length, 2);
});
