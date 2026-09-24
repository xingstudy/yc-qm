import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

class FakeVisualViewport extends EventTarget {
  height = 659;
  offsetTop = 0;
}

const dom = new JSDOM(
  '<div class="layout"><div class="chat-scroll"></div><textarea class="composer-input"></textarea></div>',
  {
    url: "https://example.test/",
  },
);
const vv = new FakeVisualViewport();
let scrollCalls = 0;
Object.defineProperty(dom.window.navigator, "userAgent", {
  value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
});
Object.defineProperties(dom.window, {
  innerHeight: { value: 659, configurable: true },
  scrollY: { get: () => (vv.offsetTop ? 309 : 0), configurable: true },
  visualViewport: { value: vv, configurable: true },
  matchMedia: {
    value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    configurable: true,
  },
  scrollTo: {
    value: () => {
      scrollCalls++;
    },
    configurable: true,
  },
});
Object.assign(globalThis, { document: dom.window.document, window: dom.window });

const transcript = dom.window.document.querySelector<HTMLElement>(".chat-scroll")!;
const layout = dom.window.document.querySelector<HTMLElement>(".layout")!;
Object.defineProperty(layout, "getBoundingClientRect", { value: () => ({ height: 659 }) });
Object.defineProperties(transcript, {
  scrollHeight: { value: 900 },
  clientHeight: { value: 500 },
  scrollTop: { value: 300, writable: true },
});

const { trackVisualViewport } = await import("../src/viewport.ts");
trackVisualViewport();

test("visual viewport height updates without scrolling or translating the page", () => {
  vv.height = 350;
  vv.offsetTop = 309;
  vv.dispatchEvent(new Event("resize"));

  assert.equal(dom.window.document.documentElement.style.getPropertyValue("--vvh"), "350px");
  assert.equal(dom.window.document.documentElement.style.getPropertyValue("--vv-top"), "");
  assert.equal(dom.window.document.documentElement.classList.contains("kbd-open"), false);
  assert.equal(scrollCalls, 0);
  assert.equal(transcript.scrollTop, 300);

  vv.height = 221;
  vv.offsetTop = 221;
  vv.dispatchEvent(new Event("scroll"));
  assert.equal(dom.window.document.documentElement.style.getPropertyValue("--vvh"), "350px");
  assert.equal(scrollCalls, 0);

  vv.height = 659;
  vv.offsetTop = 0;
  vv.dispatchEvent(new Event("resize"));
  assert.equal(dom.window.document.documentElement.style.getPropertyValue("--vvh"), "659px");
});

test("iOS chat input keeps its pre-keyboard layout height until the keyboard closes", () => {
  const input = dom.window.document.querySelector<HTMLTextAreaElement>(".composer-input")!;
  input.focus();
  assert.equal(layout.style.height, "659px");

  vv.height = 350;
  vv.dispatchEvent(new Event("resize"));
  assert.equal(dom.window.document.documentElement.style.getPropertyValue("--vvh"), "350px");
  assert.equal(layout.style.height, "659px");

  const pageSwipe = new dom.window.Event("touchmove", { bubbles: true, cancelable: true });
  dom.window.document.body.dispatchEvent(pageSwipe);
  assert.equal(pageSwipe.defaultPrevented, true);
  const chatSwipe = new dom.window.Event("touchmove", { bubbles: true, cancelable: true });
  transcript.dispatchEvent(chatSwipe);
  assert.equal(chatSwipe.defaultPrevented, false);
  const touch = (target: Element, type: string, y: number) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "touches", { value: [{ clientY: y }] });
    target.dispatchEvent(event);
    return event;
  };
  touch(transcript, "touchstart", 300);
  assert.equal(touch(transcript, "touchmove", 290).defaultPrevented, false);
  transcript.scrollTop = 400;
  assert.equal(touch(transcript, "touchmove", 280).defaultPrevented, true);
  transcript.scrollTop = 0;
  assert.equal(touch(transcript, "touchmove", 300).defaultPrevented, true);
  const emptyChat = dom.window.document.createElement("div");
  emptyChat.className = "chat-scroll";
  layout.append(emptyChat);
  const emptySwipe = new dom.window.Event("touchmove", { bubbles: true, cancelable: true });
  emptyChat.dispatchEvent(emptySwipe);
  assert.equal(emptySwipe.defaultPrevented, true);

  input.blur();
  assert.equal(layout.style.height, "659px");
  input.focus();
  assert.equal(layout.style.height, "659px");
  input.blur();
  vv.height = 659;
  vv.dispatchEvent(new Event("resize"));
  assert.equal(layout.style.height, "");
  assert.equal(scrollCalls, 0);
});
