import assert from "node:assert/strict";
import test from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";

test("project pin persists after reload and leaves conversation pinning intact", async () => {
  const scopeId = "group:web-project-launch";
  const project = {
    scopeId,
    kind: "group",
    name: "Launch",
    sessionCount: 2,
    lastActivityAt: Date.now(),
    project: {
      id: "launch",
      name: "Launch",
      ownerId: "tester",
      memberIds: ["tester"],
      scopeId,
      members: [{ principalId: "tester", displayName: "Tester" }],
    },
  };
  const h = await harness({
    path: "/",
    contexts: [project],
    listSessions: [
      { ...SESSION, id: "pinned-chat", threadRef: "web:tester:pinned", scopeId, pinned: true, createdAt: Date.now() },
      { ...SESSION, id: "regular-chat", threadRef: "web:tester:regular", scopeId, createdAt: Date.now() - 1000 },
    ],
  });
  try {
    const boot = h.boot();
    h.releaseSessions();
    await boot;
    await h.sessionsReady();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const projectRow = document.querySelector<HTMLElement>(".recent-project");
    assert.match(projectRow?.textContent ?? "", /Launch/);
    assert.equal(document.querySelectorAll(".pinned-children .session").length, 1);
    projectRow!.querySelector<HTMLButtonElement>(".recent-project-menu .session-menu-btn")!.click();
    assert.match(
      document.querySelector(".recent-project-menu .session-menu-popover")?.textContent ?? "",
      /Pin project/,
    );
    projectRow!.querySelector<HTMLButtonElement>(".session-menu-option")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(h.uiStateWrites.at(-1)?.value, [scopeId]);
    assert.equal(document.querySelectorAll(".pinned-children .session").length, 1);
    assert.ok(document.querySelector(".pinned-head ~ .recent-project .recent-project-pin"));

    h.resetSessions();
    await h.reloadSessions();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(document.querySelector(".pinned-head ~ .recent-project .recent-project-pin"));
    assert.equal(document.querySelectorAll(".pinned-children .session").length, 1);

    document.querySelector<HTMLButtonElement>(".recent-project-menu .session-menu-btn")!.click();
    assert.match(
      document.querySelector(".recent-project-menu .session-menu-popover")?.textContent ?? "",
      /Unpin project/,
    );
    document.querySelector<HTMLButtonElement>(".recent-project-menu .session-menu-option")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(h.uiStateWrites.at(-1)?.value, []);
    assert.equal(document.querySelectorAll(".pinned-children .session").length, 1);
  } finally {
    await h.close();
  }
});
