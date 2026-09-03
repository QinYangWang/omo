export interface ImageContent {
  data: string;
  mimeType: string;
  name?: string;
  type: "image";
}

export interface UserMessage {
  completedAt?: number;
  copyText?: string;
  durationMs?: number;
  id: string;
  images?: ImageContent[];
  role: "user";
  text: string;
  timestamp?: number;
  turnEnd?: boolean;
}

export interface AssistantMessage {
  completedAt?: number;
  copyText?: string;
  durationMs?: number;
  id: string;
  role: "assistant";
  text: string;
  timestamp?: number;
  turnEnd?: boolean;
}

export type ChatMessage =
  | UserMessage
  | AssistantMessage
  | {
      id: string;
      role: "tool";
      toolName: string;
      input?: string;
      output?: string;
      status: "running" | "done" | "error";
    }
  | { id: string; role: "thinking"; text: string; status: "running" | "done" };

export interface TurnMeta {
  absoluteIndex: number;
  id: string;
  userPreview: string;
}

export interface ConversationTurn {
  absoluteIndex: number;
  id: string;
  items: Exclude<ChatMessage, UserMessage>[];
  user: UserMessage;
}

export interface TurnWindow {
  end: number;
  hasOlder: boolean;
  metas: TurnMeta[];
  start: number;
  startCursor: number;
  total: number;
  turns: ConversationTurn[];
}

export function createTurnWindow(total: number, count: number): TurnWindow {
  const start = Math.max(0, total - count);
  return {
    end: start,
    hasOlder: start > 0,
    metas: [],
    start,
    startCursor: start,
    total,
    turns: [],
  };
}

export function toTurns(
  messages: ChatMessage[],
  startIndex = 0
): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      turns.push({
        absoluteIndex: startIndex + turns.length,
        id: message.id,
        items: [],
        user: message,
      });
    } else if (turns.length) {
      const item: ConversationTurn["items"][number] = message;
      turns.at(-1)?.items.push(item);
    } else {
      const item: ConversationTurn["items"][number] = message;
      turns.push({
        absoluteIndex: startIndex + turns.length,
        id: message.id,
        items: [item],
        user: { id: `${message.id}:orphan`, role: "user", text: "" },
      });
    }
  }
  return turns;
}

export function toTurnMeta(turns: ConversationTurn[]): TurnMeta[] {
  return turns.map((turn) => ({
    absoluteIndex: turn.absoluteIndex,
    id: turn.id,
    userPreview: turn.user.text.replace(/\s+/g, " ").trim().slice(0, 300),
  }));
}

export function emptyWindow(): TurnWindow {
  return {
    end: 0,
    hasOlder: false,
    metas: [],
    start: 0,
    startCursor: 0,
    total: 0,
    turns: [],
  };
}

export function windowFromMessages(
  messages: ChatMessage[],
  cursor: number,
  hasMore: boolean
): TurnWindow {
  const turns = toTurns(messages, cursor);
  const total = cursor + turns.length;
  return {
    end: cursor + turns.length,
    hasOlder: hasMore,
    metas: toTurnMeta(turns),
    start: cursor,
    startCursor: cursor,
    total,
    turns,
  };
}

export function prependWindow(
  current: TurnWindow,
  older: ChatMessage[],
  cursor: number,
  hasMore: boolean
): TurnWindow {
  const turns = toTurns(older, current.start - toTurns(older).length);
  return {
    ...current,
    hasOlder: hasMore,
    metas: toTurnMeta([...turns, ...current.turns]),
    start: current.start - turns.length,
    startCursor: cursor,
    turns: [...turns, ...current.turns],
  };
}

export function appendMessages(
  current: TurnWindow,
  messages: ChatMessage[]
): TurnWindow {
  const appended = toTurns(messages, current.start + current.turns.length);
  const turns = [...current.turns];
  for (const turn of appended) {
    if (!turn.user.text && turns.length) {
      turns.at(-1)?.items.push(...turn.items);
    } else {
      turns.push(turn);
    }
  }
  return {
    ...current,
    end: current.start + turns.length,
    metas: toTurnMeta(turns),
    turns,
  };
}

export function updateLastTurn(
  current: TurnWindow,
  update: (items: ChatMessage[]) => ChatMessage[]
): TurnWindow {
  const turns = [...current.turns];
  const last = turns.at(-1);
  if (!last) {
    return current;
  }
  turns[turns.length - 1] = {
    ...last,
    items: update([last.user, ...last.items]).filter(
      (item) => item.role !== "user"
    ),
  };
  return { ...current, metas: toTurnMeta(turns), turns };
}
