import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createPostgresOrganizationStore } from "../src/organization/postgres-organization-store.ts";
import { createPostgresAuditLog } from "../src/admin/postgres-audit-log.ts";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { migrateRegisteredPgSchemas } from "../src/persistence/pg-pool.ts";
import { createSkillStore, type Skill } from "../src/skills/skill-store.ts";
import { createSkillAccessRepository } from "../src/authorization/skill-access-repository.ts";
import { createDirectoryVisibilityResolver } from "../src/authorization/directory-visibility.ts";

const workerScript = `
const { createPostgresOrganizationStore } = await import('./src/organization/postgres-organization-store.ts');
const { createPostgresAuditLog } = await import('./src/admin/postgres-audit-log.ts');
const { createPostgresMapFactory } = await import('./src/persistence/durable-map.ts');
const { createSkillStore } = await import('./src/skills/skill-store.ts');
const { createSkillAccessRepository } = await import('./src/authorization/skill-access-repository.ts');
const { createDirectoryVisibilityResolver } = await import('./src/authorization/directory-visibility.ts');
const url = process.env.DATABASE_URL;
const audit = createPostgresAuditLog(url);
const store = createPostgresOrganizationStore(url, { auditLog: audit, exclusiveOrgId: 'acme' });
const maps = createPostgresMapFactory(url);
const base = createSkillStore({ orgId: 'acme', signingSecret: 'qa-key', backing: maps.map('skills') });
const repository = createSkillAccessRepository({ orgId: 'acme', signingSecret: 'qa-key', store, base, directory: createDirectoryVisibilityResolver({ orgId: 'acme', store }) });
await repository.ready();
if (process.env.QM_TEST_CRASH === '1') {
 const transact = store.transact.bind(store);
 store.transact = (org, operation) => transact(org, async (tx) => {
  const put = tx.putSkill.bind(tx);
  tx.putSkill = async (skill) => {
   await put(skill);
   if (skill.status === 'published') {
    process.send({ staged: skill.id });
    await new Promise(() => {});
   }
  };
  return operation(tx);
 });
}
try {
 const result = await repository.importOwnedBatch({ scopeId: 'personal:alice', createdBy: 'alice', manifests: ['first', 'second'].map(name => ({ name, body: name, description: name, requiredCapabilities: [] })) });
 process.send({ imported: result.length });
} catch (error) { process.send({ error: error.message }); }
await maps.pool.close();
await audit.close();
process.disconnect();
`;

test(
  "Postgres import hides a killed transaction and serializes confirmations from independent processes",
  { skip: !process.env.DATABASE_URL, timeout: 60_000 },
  async () => {
    const pg = (await import("pg")).default;
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const schema = `import_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const connectionString = url.toString();
    const auditLog = createPostgresAuditLog(connectionString);
    const store = createPostgresOrganizationStore(connectionString, { auditLog, exclusiveOrgId: "acme" });
    const maps = createPostgresMapFactory(connectionString);
    const base = createSkillStore({ orgId: "acme", signingSecret: "qa-key", backing: maps.map<Skill>("skills") });
    const repository = createSkillAccessRepository({
      orgId: "acme",
      signingSecret: "qa-key",
      store,
      base,
      directory: createDirectoryVisibilityResolver({ orgId: "acme", store }),
    });
    const children: ReturnType<typeof spawn>[] = [];
    const start = (crash: boolean) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", workerScript], {
        cwd: new URL("..", import.meta.url),
        env: { ...process.env, DATABASE_URL: connectionString, QM_TEST_CRASH: crash ? "1" : "0" },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      children.push(child);
      return child;
    };
    try {
      await migrateRegisteredPgSchemas(connectionString);
      await store.ensureOrgRoot({ orgId: "acme", name: "Acme", actor: "setup", now: 1 });
      await store.putUser({
        orgId: "acme",
        principalId: "alice",
        email: "alice@example.test",
        displayName: "Alice",
        jobTitle: null,
        mobile: null,
        employeeNumber: null,
        status: "active",
        sessionVersion: 1,
        profileRevision: 1,
        createdAt: 1,
        updatedAt: 1,
        lastLoginAt: 1,
        createdBy: "setup",
        updatedBy: "setup",
      });
      await repository.ready();
      const baselineAudits = (await auditLog.events()).length;
      const doomed = start(true);
      const [staged] = await once(doomed, "message", { signal: AbortSignal.timeout(20_000) });
      assert.equal(typeof staged.staged, "string");
      assert.deepEqual(await repository.list(), []);
      assert.equal(await repository.get(staged.staged), null);
      assert.equal((await repository.resolve("first", ["personal:alice"])).skill, null);
      assert.deepEqual(await store.listSkillAccessPolicies("acme"), []);
      assert.equal((await auditLog.events()).length, baselineAudits);
      doomed.kill("SIGKILL");
      await once(doomed, "exit");
      const left = start(false);
      const right = start(false);
      const messages = await Promise.all(
        [left, right].map(async (child) => (await once(child, "message", { signal: AbortSignal.timeout(20_000) }))[0]),
      );
      assert.equal(messages.filter((message) => message.imported === 2).length, 1);
      assert.equal(messages.filter((message) => /already exists/.test(message.error ?? "")).length, 1);
      assert.equal((await repository.list()).length, 2);
      assert.equal((await store.listSkillAccessPolicies("acme")).length, 2);
      assert.equal((await auditLog.events()).filter((event) => event.action === "skill.publish").length, 2);
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await maps.pool.close();
      await auditLog.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
