import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createSkillStore, type SkillManifest } from "../src/skills/skill-store.ts";
import { sameManifest } from "../src/skills/seed.ts";
import { computeBundleHash } from "../src/skills/skill-bundle-store.ts";

const manifest: SkillManifest = {
  name: "demo",
  description: "demo",
  body: "instructions",
  requiredCapabilities: [],
  files: [{ path: "asset", content: "aGVsbG8=" }],
};

test("legacy text signatures stay valid and binary encoding participates in signatures and update hashes", async () => {
  const store = createSkillStore({ signingSecret: "test-secret" });
  const skill = await store.create({ scopeId: "personal:alice", manifest, createdBy: "alice" });
  const legacy = createHmac("sha256", "test-secret")
    .update(
      JSON.stringify({
        name: manifest.name,
        description: manifest.description,
        requiredCapabilities: [],
        body: manifest.body,
        files: [["asset", "aGVsbG8=", false]],
      }),
    )
    .digest("hex");
  assert.equal(skill.signature, legacy);
  const binary: SkillManifest = { ...manifest, files: [{ ...manifest.files![0]!, encoding: "base64" }] };
  assert.equal(store.verify({ ...skill, manifest: binary }), false);
  assert.equal(sameManifest(manifest, binary), false);
  assert.notEqual(computeBundleHash(manifest.files!), computeBundleHash(binary.files!));
  const updated = await store.update(skill.id, binary);
  assert.equal(store.verify(updated), true);
  assert.equal(updated.manifest.files?.[0]?.encoding, "base64");
});
