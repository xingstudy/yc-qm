export interface OrgBranding {
  orgName?: string;
  accent?: string;
  mark?: string;
  markUrl?: string;
  selfLabel?: string;
}

const REFRESH_MS = 30_000;
const RETRY_MS = 5_000;
const FIRST_RENDER_WAIT_MS = 1_500;

export interface BrandingCache {
  current(): OrgBranding;
  forRender(fresh?: boolean): Promise<OrgBranding>;
  refreshNow(): Promise<void>;
}

export function createBrandingCache(fetchBranding: () => Promise<OrgBranding>): BrandingCache {
  let value: OrgBranding = {};
  let warmed = false;
  let nextAt = 0;
  let inflight: Promise<void> | null = null;

  const kick = (): void => {
    if (inflight || Date.now() < nextAt) return;
    inflight = (async () => {
      try {
        value = await fetchBranding();
        if (process.env.BRANDING_DEBUG) console.error("[branding] fetched:", JSON.stringify(value));
        warmed = true;
        nextAt = Date.now() + REFRESH_MS;
      } catch (err) {
        if (process.env.BRANDING_DEBUG) console.error("[branding] fetch failed:", String(err));
        nextAt = Date.now() + RETRY_MS;
      } finally {
        inflight = null;
      }
    })();
  };
  setTimeout(kick, 0);

  return {
    current: () => value,
    async forRender(fresh = false): Promise<OrgBranding> {
      if (fresh) {
        if (inflight) await inflight;
        nextAt = 0;
        kick();
        if (inflight) await inflight;
        return value;
      }
      kick();
      if (!warmed && inflight) {
        await Promise.race([inflight, new Promise((r) => setTimeout(r, FIRST_RENDER_WAIT_MS))]);
      }
      return value;
    },
    async refreshNow(): Promise<void> {
      if (inflight) await inflight;
      nextAt = 0;
      kick();
      if (inflight) await inflight;
    },
  };
}

const escapeAttr = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const CSS_HOSTILE = /[<>{}"'();\\]/;
const cssSafe = (v: string | undefined): v is string => !!v && !CSS_HOSTILE.test(v);
const cssUrlSafe = (v: string | undefined): v is string => cssSafe(v) && /^https:\/\/\S+$/.test(v);

export function injectBranding(html: string, branding: OrgBranding, opts?: { titleSuffix?: string }): string {
  const { accent, mark, markUrl, selfLabel } = branding;
  let out = html;
  if (selfLabel) {
    out = out.replace(
      /(<meta name="brand-self-label" content=")[^"]*(")/,
      (_m, pre: string, post: string) => `${pre}${escapeAttr(selfLabel)}${post}`,
    );
    out = out.replace(
      /(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/,
      (_m, pre: string, post: string) => `${pre}${escapeAttr(selfLabel)}${post}`,
    );
    if (opts?.titleSuffix) {
      const title = escapeAttr(`${selfLabel} ${opts.titleSuffix}`);
      out = out.replace(/<title>[^<]*<\/title>/, () => `<title>${title}</title>`);
    }
  }
  if (cssUrlSafe(markUrl)) {
    const href = escapeAttr(markUrl);
    const icon = `<link rel="icon" href="${href}" />`;
    if (/<link rel="icon" href="[^"]*"\s*\/?>/.test(out)) {
      out = out.replace(/<link rel="icon" href="[^"]*"\s*\/?>/, icon);
    } else {
      out = out.replace("</head>", `${icon}</head>`);
    }
    out = out.replace(
      /(<link rel="apple-touch-icon" href=")[^"]*("\s*\/?>)/,
      (_match, before: string, after: string) => `${before}${href}${after}`,
    );
  }
  const decls = [
    ...(cssSafe(accent) ? [`--brand-accent:${accent}`] : []),
    ...(cssSafe(mark) ? [`--brand-mark:"${mark}"`] : []),
    ...(cssUrlSafe(markUrl) ? [`--brand-mark-image:url("${markUrl}")`] : []),
  ].join(";");
  if (decls) out = out.replace("</head>", () => `<style>:root{${decls}}</style></head>`);
  return out;
}
