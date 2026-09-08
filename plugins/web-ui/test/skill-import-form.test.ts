import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { SkillImportPreview } from "../../chassis/src/skill-import.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.window.document });
const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
let respond: () => Promise<SkillImportPreview>;
mock.module("../src/core-bridge.ts", {
  namedExports: {
    api: async (path: string, init: RequestInit) => {
      calls.push({ path, body: JSON.parse(String(init.body)) });
      return respond();
    },
  },
});
const { SkillImportForm } = await import("../src/skill-import-form.ts");
const { render } = await import("lit");

const preview: SkillImportPreview = {
  fingerprint: "fingerprint",
  candidates: [
    {
      path: "demo/SKILL.md",
      name: "demo",
      description: "Demo skill",
      body: "<script>untrusted</script>",
      files: ["scripts/run.sh"],
      eligible: true,
    },
    {
      path: "blocked/SKILL.md",
      name: "blocked",
      description: "Blocked skill",
      body: "text",
      files: [],
      eligible: false,
      reason: "collision",
    },
  ],
};

test("URL preview requires a separate confirmation and renders escaped instructions and disabled conflicts", async () => {
  const form = new SkillImportForm();
  const host = document.createElement("div");
  const redraw = () => render(form.render(redraw), host);
  let completed = 0;
  form.url = "https://github.com/example/skills";
  form.ref = "main";
  respond = async () => preview;
  await form.submit("personal:alice", redraw, async () => {
    completed++;
  });
  assert.equal(completed, 0);
  assert.deepEqual([...form.selected], ["demo/SKILL.md"]);
  assert.equal(calls.at(-1)?.body.selected, undefined);
  assert.equal(host.querySelectorAll('input[type="checkbox"]')[1]?.hasAttribute("disabled"), true);
  assert.equal(host.querySelector("script"), null);
  assert.match(host.textContent ?? "", /scripts\/run.sh/);
  respond = async () => ({ ...preview, imported: ["demo"] });
  await form.submit("personal:alice", redraw, async () => {
    completed++;
  });
  assert.equal(completed, 1);
  assert.deepEqual(calls.at(-1)?.body, {
    source: { kind: "git", url: form.url, ref: "main" },
    scopeId: "personal:alice",
    selected: ["demo/SKILL.md"],
    fingerprint: "fingerprint",
  });
});

test("changing source or leaving the flow prevents stale previews from returning", async () => {
  const form = new SkillImportForm();
  let resolve!: (value: SkillImportPreview) => void;
  respond = () =>
    new Promise((done) => {
      resolve = done;
    });
  const pending = form.submit(
    "personal:alice",
    () => {},
    async () => {},
  );
  form.invalidate();
  resolve(preview);
  await pending;
  assert.equal(form.preview, null);
  assert.equal(form.busy, false);
});

test("file selection keeps the complete upload and rejected imports clear stale review", async () => {
  const form = new SkillImportForm();
  form.mode = "upload";
  await form.chooseFile(new File(["---\nname: demo\n---\nhello"], "demo.md"), () => {});
  assert.equal(form.upload?.name, "demo.md");
  assert.match(atob(form.upload!.base64), /name: demo/);
  respond = async () => preview;
  await form.submit(
    "personal:alice",
    () => {},
    async () => {},
  );
  assert.equal(calls.at(-1)?.body.source && (calls.at(-1)?.body.source as { kind: string }).kind, "upload");
  respond = async () => {
    throw new Error("Source changed");
  };
  await form.submit(
    "personal:alice",
    () => {},
    async () => {},
  );
  assert.equal(form.preview, null);
  assert.equal(form.error, "Source changed");
  assert.equal(form.busy, false);
});

test.after(() => dom.window.close());

test("an entirely unavailable preview explains the block and retries preview without an empty import", async () => {
  const form = new SkillImportForm();
  const host = document.createElement("div");
  const redraw = () => render(form.render(redraw), host);
  respond = async () => ({ ...preview, candidates: [preview.candidates[1]!] });
  await form.submit("personal:alice", redraw, async () => assert.fail("must not finish an unavailable preview"));
  assert.equal(form.hasEligibleSkills, false);
  assert.match(host.textContent ?? "", /No skills available to import/);
  assert.match(host.textContent ?? "", /choose another file or source/);
  assert.match(host.textContent ?? "", /already exists/);
  respond = async () => preview;
  await form.submit("personal:alice", redraw, async () => assert.fail("retry is still only a preview"));
  assert.equal(calls.at(-1)?.body.selected, undefined);
  assert.equal(calls.at(-1)?.body.fingerprint, undefined);
  assert.equal(form.hasEligibleSkills, true);
});

test("deselecting all skills gives feedback and sends no import request", async () => {
  const form = new SkillImportForm();
  respond = async () => preview;
  await form.submit(
    "personal:alice",
    () => {},
    async () => {},
  );
  form.selected.clear();
  const before = calls.length;
  await form.submit(
    "personal:alice",
    () => {},
    async () => assert.fail("must not finish"),
  );
  assert.equal(calls.length, before);
  assert.equal(form.busy, false);
  assert.match(form.error, /Select at least one/);
});
