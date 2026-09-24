import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { PORTAL_I18N_SCRIPT, PORTAL_I18N_SCRIPT_HASH } from "../src/portal-i18n.ts";
import { readFileSync } from "node:fs";

test("portal locale follows the shared choice and switches both ways", () => {
  assert.equal(PORTAL_I18N_SCRIPT_HASH, `sha256-${createHash("sha256").update(PORTAL_I18N_SCRIPT).digest("base64")}`);
  for (const saved of ["zh-CN", "en"]) {
    const values = new Map([["qm:locale", saved]]);
    const textNodes = ["Sign in", "account suspended", "identity provider returned: denied"].map((nodeValue) => ({
      nodeValue,
      parentElement: { closest: () => null },
    }));
    const button: Record<string, unknown> = {
      setAttribute(name: string, value: string) {
        this[name] = value;
      },
    };
    const document = {
      documentElement: { lang: "en" },
      title: "Sign-in failed · Portal",
      body: { appendChild: (value: unknown) => assert.equal(value, button) },
      createElement: () => button,
      createTreeWalker: () => {
        let index = -1;
        return {
          get currentNode() {
            return textNodes[index];
          },
          nextNode: () => {
            index += 1;
            return index < textNodes.length;
          },
        };
      },
    };
    let reloaded = false;
    runInNewContext(PORTAL_I18N_SCRIPT, {
      document,
      navigator: { languages: ["zh-CN"], language: "zh-CN" },
      localStorage: {
        getItem: (key: string) => values.get(key),
        setItem: (key: string, value: string) => values.set(key, value),
      },
      location: {
        reload: () => {
          reloaded = true;
        },
      },
      NodeFilter: { SHOW_TEXT: 4 },
    });
    assert.equal(document.documentElement.lang, saved);
    assert.deepEqual(
      textNodes.map((node) => node.nodeValue),
      saved === "zh-CN"
        ? ["登录", "账户已暂停", "身份提供方返回：denied"]
        : ["Sign in", "account suspended", "identity provider returned: denied"],
    );
    assert.equal(button.textContent, saved === "zh-CN" ? "EN" : "中文");
    (button.onclick as () => void)();
    assert.equal(values.get("qm:locale"), saved === "zh-CN" ? "en" : "zh-CN");
    assert.equal(reloaded, true);
  }
});

test("late admin login errors follow the selected language", () => {
  const source = readFileSync(new URL("../src/admin-login.ts", import.meta.url), "utf8");
  assert.match(source, /document\.documentElement\.lang\.startsWith\("zh"\)/);
  assert.match(source, /此链接缺失或无效。请通过 qm admin-login 重新生成。/);
});
