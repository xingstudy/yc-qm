import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "../src/random.ts";

test("randomUUID uses the browser implementation when available", () => {
  const source = {
    randomUUID: () => "browser-uuid",
    getRandomValues: () => {
      throw new Error("fallback should not run");
    },
  } as unknown as Crypto;
  assert.equal(randomUUID(source), "browser-uuid");
});

test("randomUUID generates an RFC 4122 v4 value when randomUUID is unavailable", () => {
  const source = {
    getRandomValues: (bytes: Uint8Array) => {
      bytes.fill(0xab);
      return bytes;
    },
  } as unknown as Crypto;
  const value = randomUUID(source);
  assert.equal(value, "abababab-abab-4bab-abab-abababababab");
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
