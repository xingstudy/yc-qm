import type { View } from "./shell-state";
import { brandName } from "./brand-name.ts";

interface TitledSession {
  id: string;
  threadRef: string;
}

interface ActiveConversation {
  openingKey: string | null;
  sessionId: string | null;
  threadRef: string | null;
}

export const PRODUCT_TITLE = "QM · Web";

const VIEW_TITLES: Record<View, string> = {
  chats: "Chats",
  inbox: "Inbox",
  calendar: "Calendar",
  contexts: "Projects",
  crons: "Crons",
  loops: "Loops",
  webhooks: "Webhooks",
  files: "Files",
  keychain: "Keychain",
  deploys: "Apps",
  memory: "Memory",
  skills: "Skills",
  settings: "Settings",
};

const VIEW_TITLES_ZH: Record<View, string> = {
  chats: "对话",
  inbox: "收件箱",
  calendar: "日历",
  contexts: "项目",
  crons: "定时任务",
  loops: "持续任务",
  webhooks: "Webhook",
  files: "文件",
  keychain: "密钥链",
  deploys: "应用",
  memory: "记忆",
  skills: "技能",
  settings: "设置",
};

export function documentTitle(view?: View, conversationTitle?: string | null, conversationOpen = false): string {
  const zh = typeof document !== "undefined" && document.documentElement.lang.startsWith("zh");
  const title =
    view === "chats" && conversationOpen
      ? conversationTitle?.trim() || (zh ? "新建对话" : "New chat")
      : view && (zh ? VIEW_TITLES_ZH[view] : VIEW_TITLES[view]);
  const productTitle = `${brandName()} · ${zh ? "网页" : "Web"}`;
  return title ? `${title} · ${productTitle}` : productTitle;
}

export function updateDocumentTitle(view?: View, conversationTitle?: string | null, conversationOpen = false): void {
  document.title = documentTitle(view, conversationTitle, conversationOpen);
}

export function activeSessionForDocumentTitle<T extends TitledSession>(
  sessions: T[],
  active: ActiveConversation,
): T | undefined {
  if (active.openingKey) return sessions.find((session) => session.id === active.openingKey);
  return sessions.find(
    (session) => session.id === active.sessionId || (!active.sessionId && session.threadRef === active.threadRef),
  );
}
