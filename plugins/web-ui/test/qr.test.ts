import assert from "node:assert/strict";
import test from "node:test";
import { qrDataUrl } from "../src/qr.ts";

test("qrDataUrl emits an SVG data URL", () => {
  const url = qrDataUrl("https://open.feishu.cn/device/qr/authorization");
  assert.match(url, /^data:image\/svg\+xml,/);
  const svg = decodeURIComponent(url.slice("data:image/svg+xml,".length));
  assert.match(svg, /<svg /);
  assert.match(svg, /shape-rendering="crispEdges"/);
  assert.match(svg, /<path d=/);
});

test("qrDataUrl supports long platform authorization URLs", () => {
  assert.match(
    qrDataUrl(`https://open.feishu.cn/open-apis/authen/v1/index?${"x".repeat(1_500)}`),
    /^data:image\/svg\+xml,/,
  );
});
