import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerDown } from "../src/backends/docker.ts";
import { CONFIG_FILENAME, loadConfigAt } from "../src/config.ts";

test("docker purge cannot hide a real volume failure behind a missing sibling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-docker-down-"));
  const priorPath = process.env.PATH;
  const log = console.log;
  const lines: string[] = [];
  try {
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({
        contract: 1,
        orgId: "purge-test",
        publicUrl: "http://localhost:8080",
        target: "docker",
        services: ["core"],
      }),
    );
    const docker = join(dir, "docker");
    writeFileSync(
      docker,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "version" || args[0] === "ps") process.exit(0);
if (args[0] === "network") { console.error("network purge-test not found"); process.exit(1); }
if (args[0] === "volume" && args[2].endsWith("-pgdata")) { console.error("no such volume"); process.exit(1); }
if (args[0] === "volume") { console.error("permission denied"); process.exit(1); }
process.exit(0);
`,
    );
    chmodSync(docker, 0o755);
    process.env.PATH = `${dir}:${priorPath}`;
    console.log = (...parts: unknown[]): void => void lines.push(parts.join(" "));
    const { config } = loadConfigAt(join(dir, CONFIG_FILENAME));
    await assert.rejects(() => dockerDown(config, { purge: true }), /permission denied/);
    assert.equal(
      lines.some((line) => /down\./.test(line)),
      false,
    );
  } finally {
    console.log = log;
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
