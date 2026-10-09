import type { DurableMap } from "../persistence/durable-map.ts";

type NotificationKind = "message" | "mention" | "cron_success" | "cron_failure" | "action";

export interface NotificationRecord {
  id: string;
  recipient: string;
  kind: NotificationKind;
  createdAt: number;
  readAt?: number;
  sessionId?: string;
  entrySeq?: number;
  cronId?: string;
  fireKey?: string;
  approvalId?: string;
}

export interface NotificationStore {
  add(record: NotificationRecord): Promise<void>;
  list(recipient: string): Promise<NotificationRecord[]>;
  markRead(recipient: string, id: string, at?: number): Promise<boolean>;
  markAllRead(recipient: string, at?: number): Promise<number>;
  markSessionMessagesRead(recipient: string, sessionId: string, at?: number): Promise<number>;
  linkSession(recipient: string, id: string, sessionId: string, entrySeq: number): Promise<void>;
}

export function createNotificationStore(
  backing: DurableMap<NotificationRecord>,
  onChanged?: (record: NotificationRecord) => void,
): NotificationStore {
  const list = async (recipient: string) =>
    (await backing.select({ where: { field: "recipient", anyOfFold: [recipient] } }))
      .filter((record) => record.recipient === recipient)
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  const markRead = async (recipient: string, id: string, at = Date.now()) => {
    const record = await backing.get(id);
    if (!record || record.recipient !== recipient || record.readAt !== undefined) return false;
    await backing.update?.(id, (current) =>
      current.recipient === recipient && current.readAt === undefined ? { ...current, readAt: at } : current,
    );
    onChanged?.(record);
    return true;
  };
  return {
    async add(record) {
      const added = backing.insertIfAbsent
        ? await backing.insertIfAbsent(record.id, record)
        : (await backing.putIfAbsent(record.id, record)) === record;
      if (added) onChanged?.(record);
    },
    list,
    markRead,
    async markAllRead(recipient, at = Date.now()) {
      const unread = (await list(recipient)).filter(
        (record) => record.kind !== "message" && record.readAt === undefined,
      );
      await Promise.all(unread.map((record) => markRead(recipient, record.id, at)));
      return unread.length;
    },
    async markSessionMessagesRead(recipient, sessionId, at = Date.now()) {
      const unread = (await list(recipient)).filter(
        (record) =>
          record.sessionId === sessionId &&
          record.readAt === undefined &&
          (record.kind === "message" || record.kind === "mention"),
      );
      await Promise.all(unread.map((record) => markRead(recipient, record.id, at)));
      return unread.length;
    },
    async linkSession(recipient, id, sessionId, entrySeq) {
      const record = await backing.get(id);
      if (!record || record.recipient !== recipient) return;
      await backing.update?.(id, (current) =>
        current.recipient === recipient ? { ...current, sessionId, entrySeq } : current,
      );
      onChanged?.(record);
    },
  };
}
