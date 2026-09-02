export type UserMessage = {
  id: string;
  role: "user";
  text: string;
  timestamp?: number;
  turnEnd?: boolean;
  completedAt?: number;
  durationMs?: number;
  copyText?: string;
};

export type AssistantMessage = {
  id: string;
  role: "assistant";
  text: string;
  timestamp?: number;
  turnEnd?: boolean;
  completedAt?: number;
  durationMs?: number;
  copyText?: string;
};

export type ChatMessage =
  | UserMessage
  | AssistantMessage
  | { id: string; role: "tool"; toolName: string; input?: string; output?: string; status: "running" | "done" | "error" }
  | { id: string; role: "thinking"; text: string; status: "running" | "done" };

export type TurnMeta = {
  id: string;
  absoluteIndex: number;
  userPreview: string;
};

export type ConversationTurn = {
  id: string;
  absoluteIndex: number;
  user: UserMessage;
  items: Exclude<ChatMessage, UserMessage>[];
};

export type TurnWindow = {
  turns: ConversationTurn[];
  start: number;
  end: number;
  total: number;
  startCursor: number;
  hasOlder: boolean;
  metas: TurnMeta[];
};

export function createTurnWindow(total: number, count: number): TurnWindow {
  const start = Math.max(0, total - count);
  return { turns: [], start, end: start, total, startCursor: start, hasOlder: start > 0, metas: [] };
}

export function toTurns(messages: ChatMessage[], startIndex = 0): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      turns.push({ id: message.id, absoluteIndex: startIndex + turns.length, user: message, items: [] });
    } else if (turns.length) {
      const item: ConversationTurn["items"][number] = message;
      turns[turns.length - 1].items.push(item);
    } else {
      const item: ConversationTurn["items"][number] = message;
      turns.push({
        id: message.id,
        absoluteIndex: startIndex + turns.length,
        user: { id: `${message.id}:orphan`, role: "user", text: "" },
        items: [item],
      });
    }
  }
  return turns;
}

export function toTurnMeta(turns: ConversationTurn[]): TurnMeta[] {
  return turns.map((turn) => ({
    id: turn.id,
    absoluteIndex: turn.absoluteIndex,
    userPreview: turn.user.text.replace(/\s+/g, " ").trim().slice(0, 300),
  }));
}

export function emptyWindow(): TurnWindow {
  return { turns: [], start: 0, end: 0, total: 0, startCursor: 0, hasOlder: false, metas: [] };
}

export function windowFromMessages(messages: ChatMessage[], cursor: number, hasMore: boolean): TurnWindow {
  const turns = toTurns(messages, cursor);
  const total = cursor + turns.length;
  return { turns, start: cursor, end: cursor + turns.length, total, startCursor: cursor, hasOlder: hasMore, metas: toTurnMeta(turns) };
}

export function prependWindow(current: TurnWindow, older: ChatMessage[], cursor: number, hasMore: boolean): TurnWindow {
  const turns = toTurns(older, current.start - toTurns(older).length);
  return {
    ...current,
    turns: [...turns, ...current.turns],
    start: current.start - turns.length,
    startCursor: cursor,
    hasOlder: hasMore,
    metas: toTurnMeta([...turns, ...current.turns]),
  };
}

export function appendMessages(current: TurnWindow, messages: ChatMessage[]): TurnWindow {
  const appended = toTurns(messages, current.start + current.turns.length);
  const turns = [...current.turns];
  for (const turn of appended) {
    if (!turn.user.text && turns.length) {
      turns[turns.length - 1].items.push(...turn.items);
    } else {
      turns.push(turn);
    }
  }
  return { ...current, turns, end: current.start + turns.length, metas: toTurnMeta(turns) };
}

export function updateLastTurn(current: TurnWindow, update: (items: ChatMessage[]) => ChatMessage[]): TurnWindow {
  const turns = [...current.turns];
  const last = turns.at(-1);
  if (!last) return current;
  turns[turns.length - 1] = { ...last, items: update([last.user, ...last.items]).filter((item) => item.role !== "user") };
  return { ...current, turns, metas: toTurnMeta(turns) };
}
