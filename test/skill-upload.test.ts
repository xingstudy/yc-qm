import test from "node:test";
import assert from "node:assert/strict";
import { readSkillUpload } from "../src/skills/skill-upload.ts";
import { previewSkillImport } from "../src/skills/skill-import.ts";
import { skillMarkdown, skillZip, skillTar } from "./support/skill-upload-fixture.ts";

test("ZIP and tar.gz imports preserve skill directories, scripts and references", async () => {
  const entries = [
    { path: "repo-main/skills/demo/SKILL.md", text: skillMarkdown("demo") },
    { path: "repo-main/skills/demo/scripts/run.sh", text: "echo demo", mode: 0o100755 },
    { path: "repo-main/skills/demo/references/guide.md", text: "The guide" },
    { path: "repo-main/skills/second/SKILL.md", text: skillMarkdown("second") },
  ];
  for (const [name, data] of [
    ["project.zip", skillZip(entries)],
    [
      "project.tar.gz",
      await skillTar(entries.map((entry) => ({ header: { name: entry.path, mode: entry.mode }, text: entry.text }))),
    ],
  ] as const) {
    const repo = await readSkillUpload({ name, base64: data.toString("base64") });
    const { preview, manifests } = previewSkillImport(repo, new Set(), true);
    assert.equal(preview.candidates.length, 2);
    const demo = [...manifests.values()].find((manifest) => manifest.name === "demo")!;
    assert.deepEqual(
      demo.files?.map((file) => file.path),
      ["references/guide.md", "scripts/run.sh"],
    );
    assert.equal(demo.files?.[1]?.content, "echo demo");
    assert.equal(demo.files?.[1]?.executable, true);
  }
});

test("Markdown upload parses metadata instead of treating frontmatter as instructions", async () => {
  const repo = await readSkillUpload({
    name: "demo.md",
    base64: Buffer.from(skillMarkdown("demo")).toString("base64"),
  });
  const { preview } = previewSkillImport(repo, new Set(), true);
  assert.equal(preview.candidates[0]?.name, "demo");
  assert.doesNotMatch(preview.candidates[0]!.body, /description:/);
});

test("archives reject traversal, absolute paths, duplicate files and symlinks", async () => {
  for (const path of ["../SKILL.md", "/SKILL.md", "a/../../SKILL.md", "C:/SKILL.md", "a\\SKILL.md"]) {
    await assert.rejects(
      readSkillUpload({ name: "bad.zip", base64: skillZip([{ path, text: "bad" }]).toString("base64") }),
    );
    const tar = await skillTar([{ header: { name: path }, text: "bad" }]);
    await assert.rejects(readSkillUpload({ name: "bad.tgz", base64: tar.toString("base64") }));
  }
  await assert.rejects(
    readSkillUpload({
      name: "bad.zip",
      base64: skillZip([
        { path: "SKILL.md", text: "one" },
        { path: "SKILL.md", text: "two" },
      ]).toString("base64"),
    }),
    /duplicate/,
  );
  await assert.rejects(
    readSkillUpload({
      name: "bad.zip",
      base64: skillZip([{ path: "SKILL.md", text: "target", mode: 0o120777 }]).toString("base64"),
    }),
    /links/,
  );
  const tar = await skillTar([{ header: { name: "SKILL.md", type: "symlink", linkname: "/etc/passwd" } }]);
  await assert.rejects(readSkillUpload({ name: "bad.tgz", base64: tar.toString("base64") }), /Links/);
});

test("uploads reject corruption, missing skills, invalid base64 and decompression bombs", async () => {
  for (const upload of [
    { name: "bad.zip", base64: Buffer.from("not a zip").toString("base64") },
    { name: "bad.md", base64: "%%%" },
    { name: "bad.zip", base64: skillZip([{ path: "README.md", text: "readme" }]).toString("base64") },
    {
      name: "bad.zip",
      base64: skillZip([{ path: "SKILL.md", text: Buffer.alloc(33 * 1024 * 1024, 65) }]).toString("base64"),
    },
    {
      name: "bad.zip",
      base64: skillZip(Array.from({ length: 5001 }, (_, i) => ({ path: `file-${i}`, text: "" }))).toString("base64"),
    },
  ])
    await assert.rejects(readSkillUpload(upload));
});

test("preview explains conflicts, duplicate names, private scopes and unsupported assets", async () => {
  const repo = {
    commit: "demo",
    files: [
      { path: "a/SKILL.md", text: skillMarkdown("duplicate"), binary: false },
      { path: "b/SKILL.md", text: skillMarkdown("duplicate"), binary: false },
      { path: "c/SKILL.md", text: skillMarkdown("existing"), binary: false },
      { path: "d/SKILL.md", text: skillMarkdown("personal", "scope: personal\n"), binary: false },
      { path: "e/SKILL.md", text: skillMarkdown("image"), binary: false },
      { path: "e/image.png", text: "", binary: true },
      { path: "f/SKILL.md", text: skillMarkdown("../invalid"), binary: false },
    ],
  };
  const { preview, manifests } = previewSkillImport(repo, new Set(["existing"]), false);
  assert.deepEqual(
    preview.candidates.map((candidate) => candidate.reason),
    ["duplicate-name", "duplicate-name", "collision", "scope", "binary-asset", "malformed"],
  );
  assert.equal(manifests.size, 0);
  assert.equal(previewSkillImport(repo, new Set(), true).manifests.has("d/SKILL.md"), true);
});

test("a multi-megabyte Markdown upload stays within the advertised limit", async () => {
  const text = skillMarkdown("large") + "text\n".repeat(500_000);
  const repo = await readSkillUpload({ name: "large.md", base64: Buffer.from(text).toString("base64") });
  assert.equal(repo.files[0]?.text, text);
});

test("ZIP imports preserve a skill's PNG alongside scripts and references", async () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
  const archive = skillZip([
    { path: "transcribe/SKILL.md", text: skillMarkdown("transcribe") },
    { path: "transcribe/assets/transcribe.png", text: png },
    { path: "transcribe/scripts/transcribe_diarize.py", text: "print('transcribe')" },
    { path: "transcribe/references/api.md", text: "Reference" },
  ]);
  const repo = await readSkillUpload({ name: "transcribe.zip", base64: archive.toString("base64") });
  const { preview, manifests } = previewSkillImport(repo, new Set(), true);
  assert.equal(preview.candidates[0]?.eligible, true);
  assert.deepEqual(preview.candidates[0]?.files, [
    "assets/transcribe.png",
    "references/api.md",
    "scripts/transcribe_diarize.py",
  ]);
  const image = manifests.get("SKILL.md")!.files!.find((file) => file.path === "assets/transcribe.png")!;
  assert.equal(image.encoding, "base64");
  assert.deepEqual(Buffer.from(image.content, image.encoding), png);
});
