import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMap, type DurableMap } from "../src/persistence/durable-map.ts";
import { createSkillStore, type Skill, type SkillManifest, type SkillStore } from "../src/skills/skill-store.ts";
import { scopeId, type ScopeId } from "../src/types.ts";

const ORG = scopeId("org", "default-org");
const JOSH = scopeId("personal", "josh");
const ERIC = scopeId("personal", "eric");

const manifest = (name: string): SkillManifest => ({
  name,
  description: "d",
  requiredCapabilities: [],
  body: `# ${name}`,
});

async function publishedSkill(store: SkillStore, scope: ScopeId, name: string) {
  const s = await store.create({ scopeId: scope, manifest: manifest(name), createdBy: "josh" });
  await store.review(s.id, "reviewer", []);
  return store.publish(s.id);
}

test("visibleFor includes granted skills, shadowed by scope-owned skills of the same name", async () => {
  const store = createSkillStore({ signingSecret: "grant-test" });
  const granted = await publishedSkill(store, JOSH, "quickbooks");
  const own = await publishedSkill(store, ERIC, "quickbooks");
  const unique = await publishedSkill(store, JOSH, "reconcile");

  const before = await store.visibleFor([ERIC, ORG]);
  assert.deepEqual(
    before.map((r) => r.skill!.id),
    [own.id],
  );

  const ref = (s: { id: string; scopeId: ReturnType<typeof scopeId> }) => ({ id: s.id, ownerScopeId: s.scopeId });

  const withGrant = await store.visibleFor([ERIC, ORG], [ref(unique)]);
  assert.deepEqual(new Set(withGrant.map((r) => r.skill!.id)), new Set([own.id, unique.id]));

  const collided = await store.visibleFor([ERIC, ORG], [ref(granted), ref(unique)]);
  const quickbooks = collided.filter((r) => r.skill!.manifest.name === "quickbooks");
  assert.equal(quickbooks.length, 1);
  assert.equal(quickbooks[0]!.skill!.id, own.id);
  assert.deepEqual(
    quickbooks[0]!.shadowed.map((s) => s.id),
    [granted.id],
  );

  const draft = await store.create({ scopeId: JOSH, manifest: manifest("draft-skill"), createdBy: "josh" });
  const ignored = await store.visibleFor([ERIC, ORG], [ref(draft), { id: "no-such-id", ownerScopeId: JOSH }]);
  assert.deepEqual(
    ignored.map((r) => r.skill!.id),
    [own.id],
  );
});

test("a grant redundant with scope visibility does not self-shadow", async () => {
  const store = createSkillStore({ signingSecret: "self-shadow-test" });
  const own = await publishedSkill(store, ERIC, "quickbooks");

  const rows = await store.visibleFor([ERIC, ORG], [{ id: own.id, ownerScopeId: ERIC }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.skill!.id, own.id);
  assert.deepEqual(rows[0]!.shadowed, []);
});

test("visibleFor takes one snapshot instead of one per published name", async () => {
  const backing = createMemoryMap<Skill>();
  let allCalls = 0;
  let getCalls = 0;
  const counted: DurableMap<Skill> = {
    ...backing,
    all: () => {
      allCalls += 1;
      return backing.all();
    },
    get: (id) => {
      getCalls += 1;
      return backing.get(id);
    },
  };
  const store = createSkillStore({ signingSecret: "snapshot-test", backing: counted });
  const orgAlpha = await publishedSkill(store, ORG, "alpha-skill");
  for (const name of ["beta-skill", "gamma-skill"]) await publishedSkill(store, ORG, name);
  const own = await publishedSkill(store, ERIC, "alpha-skill");
  const granted = await publishedSkill(store, JOSH, "delta-skill");

  allCalls = 0;
  getCalls = 0;
  const rows = await store.visibleFor([ERIC, ORG], [{ id: granted.id, ownerScopeId: JOSH }]);
  assert.equal(allCalls, 1);
  assert.equal(getCalls, 0);

  const byName = new Map(rows.map((r) => [r.skill!.manifest.name, r]));
  assert.deepEqual([...byName.keys()].sort(), ["alpha-skill", "beta-skill", "delta-skill", "gamma-skill"]);
  assert.equal(byName.get("alpha-skill")!.skill!.id, own.id);
  assert.deepEqual(
    byName.get("alpha-skill")!.shadowed.map((s) => s.id),
    [orgAlpha.id],
  );
  assert.equal(byName.get("delta-skill")!.skill!.id, granted.id);
});

test("a grant whose claimed owner scope does not match the skill's home is ignored", async () => {
  const store = createSkillStore({ signingSecret: "forge-test" });
  const victim = await publishedSkill(store, JOSH, "victim-skill");

  const forged = await store.visibleFor([ERIC, ORG], [{ id: victim.id, ownerScopeId: ERIC }]);
  assert.deepEqual(forged, []);

  const legit = await store.visibleFor([ERIC, ORG], [{ id: victim.id, ownerScopeId: JOSH }]);
  assert.deepEqual(
    legit.map((r) => r.skill!.id),
    [victim.id],
  );
});
