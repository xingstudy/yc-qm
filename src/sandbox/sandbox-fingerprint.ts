import { createHash } from "node:crypto";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";

const FIXED_SOURCES = ["fly/Dockerfile", "local/Dockerfile", "aws/microvm-agent/agent.mjs"];

export async function computeSandboxImageFingerprint(repoRoot: string): Promise<string | null> {
  try {
    const tools = (await readdir(join(repoRoot, "fly/tools"))).sort().map((file) => `fly/tools/${file}`);
    const paths = [...FIXED_SOURCES, ...tools].sort();
    const fingerprint = createHash("sha256");
    for (const path of paths) {
      fingerprint.update(path);
      fingerprint.update("\0");
      fingerprint.update(
        createHash("sha256")
          .update(await readFile(join(repoRoot, path)))
          .digest(),
      );
      fingerprint.update("\n");
    }
    return fingerprint.digest("hex");
  } catch {
    return null;
  }
}
