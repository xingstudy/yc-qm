import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("generation coalesces in-flight requests, reloads completed results, and stays disabled by default", async () => {
  const oldFetch = globalThis.fetch;
  let calls = 0;
  let activities: unknown[] = [
    { id: "app", title: "Build my project tracker", prompt: "Help build my tracker.", icon: "🛠️" },
  ];
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ activities });
  };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { loadGeneratedActivities } = await vite.ssrLoadModule("/src/generated-activities.ts");
    await loadGeneratedActivities({ user: "off", org: "test" });
    assert.equal(calls, 0);
    const me = { user: "alice", org: "test", suggestedActivitiesGeneration: true, suggestedActivities: [] };
    await Promise.all([loadGeneratedActivities(me), loadGeneratedActivities(me)]);
    assert.equal(calls, 1);
    assert.deepEqual(me.suggestedActivities, activities);
    activities = [];
    await loadGeneratedActivities(me);
    assert.deepEqual(me.suggestedActivities, []);
    assert.equal(calls, 2);
    await loadGeneratedActivities({ user: "bob", org: "test", suggestedActivitiesGeneration: true });
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = oldFetch;
    await vite.close();
  }
});

test("a failed activity request preserves the previous cards and retries on the next visit", async () => {
  const oldFetch = globalThis.fetch;
  const activities = [{ id: "app", title: "Build my project tracker", prompt: "Help build my tracker.", icon: "🛠️" }];
  const previous = [{ id: "old", title: "Review my work", prompt: "Review my work.", icon: "📚" }];
  let calls = 0;
  globalThis.fetch = async () =>
    ++calls === 1 ? Response.json({ error: "unavailable" }, { status: 503 }) : Response.json({ activities });
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { loadGeneratedActivities } = await vite.ssrLoadModule("/src/generated-activities.ts");
    const me = { user: "alice", org: "test", suggestedActivitiesGeneration: true, suggestedActivities: previous };
    await loadGeneratedActivities(me);
    assert.deepEqual(me.suggestedActivities, previous);
    await loadGeneratedActivities(me);
    assert.equal(calls, 2);
    assert.deepEqual(me.suggestedActivities, activities);
  } finally {
    globalThis.fetch = oldFetch;
    await vite.close();
  }
});

test("a pending refresh displays its cached result and then publishes the completed result", async (t) => {
  const oldFetch = globalThis.fetch;
  let calls = 0;
  const first = [{ id: "first", title: "Review my current work", prompt: "Review my work.", icon: "📚" }];
  const second = [{ id: "second", title: "Plan my next steps", prompt: "Plan my next steps.", icon: "🧭" }];
  globalThis.fetch = async () =>
    Response.json(++calls === 1 ? { activities: first, pending: true } : { activities: second, pending: false });
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { loadGeneratedActivities } = await vite.ssrLoadModule("/src/generated-activities.ts");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const me = { user: "alice", org: "test", suggestedActivitiesGeneration: true, suggestedActivities: [] };
    const seen: unknown[] = [];
    const pending = loadGeneratedActivities(me, () => seen.push(structuredClone(me.suggestedActivities)));
    await new Promise(setImmediate);
    assert.deepEqual(seen, [first]);
    t.mock.timers.tick(10_000);
    await pending;
    assert.deepEqual(seen, [first, second]);
    assert.deepEqual(me.suggestedActivities, second);
  } finally {
    t.mock.timers.reset();
    globalThis.fetch = oldFetch;
    await vite.close();
  }
});

test("an unchanged activity response does not redraw the chat", async () => {
  const oldFetch = globalThis.fetch;
  const activities = [{ id: "app", title: "Build my project tracker", prompt: "Help build my tracker.", icon: "🛠️" }];
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ activities });
  };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { loadGeneratedActivities } = await vite.ssrLoadModule("/src/generated-activities.ts");
    const me = { user: "alice", org: "test", suggestedActivitiesGeneration: true, suggestedActivities: activities };
    let redraws = 0;
    await Promise.all([loadGeneratedActivities(me, () => redraws++), loadGeneratedActivities(me, () => redraws++)]);
    assert.equal(calls, 1);
    assert.equal(redraws, 0);
  } finally {
    globalThis.fetch = oldFetch;
    await vite.close();
  }
});
