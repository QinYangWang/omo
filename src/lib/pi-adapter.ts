import type { ChatMessage, RetryNotice } from "@/lib/conversation-turns";
import { randomUUID } from "@/lib/utils";

interface PiAssistantEvent {
  delta?: string;
  id?: string;
  toolCall?: { arguments: unknown; id: string };
  toolName?: string;
  type: string;
}
interface PiToolResultPart {
  text?: string;
  type: string;
}
interface PiEventMessage {
  errorMessage?: string;
  role?: string;
  stopReason?: string;
}
interface PiEvent {
  assistantMessageEvent?: PiAssistantEvent;
  attempt?: number;
  delayMs?: number;
  errorMessage?: string;
  finalError?: string;
  isError?: boolean;
  maxAttempts?: number;
  message?: string | PiEventMessage;
  messages?: PiEventMessage[];
  result?: { content?: PiToolResultPart[] | string };
  success?: boolean;
  toolCallId?: string;
  type: string;
  willRetry?: boolean;
}

// Stable id for the transient auto-retry notice so consecutive
// auto_retry_start events update the same block instead of stacking.
const AUTO_RETRY_BLOCK_ID = "omo:auto-retry";
// The SDK emits this exact finalError when the user aborts during the
// retry backoff; a manual abort must not surface as an error.
const RETRY_CANCELLED = "Retry cancelled";

export type RenderBlock =
  | { id: string; type: "markdown"; content: string; timestamp?: number }
  | {
      id: string;
      type: "reasoning";
      content: string;
      status: "running" | "done";
    }
  | {
      id: string;
      type: "tool-call";
      toolName: string;
      input?: string;
      output?: string;
      status: "running" | "done" | "error";
    }
  | { id: string; type: "error"; content: string; retry?: RetryNotice };

export function adaptPiMessages(messages: ChatMessage[]): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  const toolCalls = new Map<
    string,
    Extract<RenderBlock, { type: "tool-call" }>
  >();

  for (const message of messages) {
    if (message.role === "user" || message.role === "assistant") {
      blocks.push({
        content: message.text,
        id: message.id,
        timestamp: message.timestamp,
        type: "markdown",
      });
      continue;
    }
    if (message.role === "thinking") {
      blocks.push({
        content: message.text,
        id: message.id,
        status: message.status,
        type: "reasoning",
      });
      continue;
    }
    if (message.role === "error") {
      blocks.push({
        content: message.text,
        id: message.id,
        retry: message.retry,
        type: "error",
      });
      continue;
    }
    if (message.role === "tool") {
      const call: Extract<RenderBlock, { type: "tool-call" }> = {
        id: message.id,
        input: message.input,
        output: message.output,
        status: message.status,
        toolName: message.toolName,
        type: "tool-call",
      };
      blocks.push(call);
      toolCalls.set(message.id, call);
    }
  }

  return blocks;
}

function resultText(content: PiToolResultPart[] | string | undefined): string {
  if (typeof content === "string") {
    return content;
  }
  if (!content) {
    return "";
  }
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

function applyAssistantEvent(
  next: RenderBlock[],
  assistantEvent: PiAssistantEvent
) {
  const lastIndex = (type: RenderBlock["type"], running?: boolean) => {
    for (let i = next.length - 1; i >= 0; i -= 1) {
      const block = next[i];
      if (block.type !== type) {
        continue;
      }
      if (
        running === undefined ||
        ("status" in block && block.status === (running ? "running" : "done"))
      ) {
        return i;
      }
    }
    return -1;
  };

  switch (assistantEvent.type) {
    case "thinking_start":
      next.push({
        content: "",
        id: randomUUID(),
        status: "running",
        type: "reasoning",
      });
      break;
    case "thinking_delta": {
      const index = lastIndex("reasoning", true);
      if (index >= 0 && next[index].type === "reasoning") {
        next[index] = {
          ...next[index],
          content: next[index].content + (assistantEvent.delta ?? ""),
        };
      }
      break;
    }
    case "thinking_end": {
      const index = lastIndex("reasoning", true);
      if (index >= 0 && next[index].type === "reasoning") {
        next[index] = { ...next[index], status: "done" };
      }
      break;
    }
    case "text_start":
      next.push({
        content: "",
        id: randomUUID(),
        timestamp: Date.now(),
        type: "markdown",
      });
      break;
    case "text_delta": {
      const index = lastIndex("markdown");
      if (index >= 0 && next[index].type === "markdown") {
        next[index] = {
          ...next[index],
          content: next[index].content + (assistantEvent.delta ?? ""),
        };
      }
      break;
    }
    case "toolcall_start":
      if (assistantEvent.id && assistantEvent.toolName) {
        next.push({
          id: assistantEvent.id,
          status: "running",
          toolName: assistantEvent.toolName,
          type: "tool-call",
        });
      }
      break;
    case "toolcall_end": {
      const { toolCall } = assistantEvent;
      if (!toolCall) {
        break;
      }
      const index = next.findIndex((block) => block.id === toolCall.id);
      if (index >= 0 && next[index].type === "tool-call") {
        next[index] = {
          ...next[index],
          input: JSON.stringify(toolCall.arguments, null, 2),
        };
      }
      break;
    }
    default:
      break;
  }
}

function applyToolResult(next: RenderBlock[], event: PiEvent) {
  if (!event.toolCallId) {
    return;
  }
  const output = resultText(event.result?.content);
  const status = event.isError ? "error" : "done";
  const index = next.findIndex((block) => block.id === event.toolCallId);
  if (index >= 0 && next[index].type === "tool-call") {
    next[index] = { ...next[index], output, status };
  }
}

function errorBlock(content: string, retry?: RetryNotice): RenderBlock {
  return { content, id: randomUUID(), retry, type: "error" };
}

/** The trailing error already carries this text (e.g. agent_end ran first). */
function hasTrailingError(blocks: RenderBlock[], content: string): boolean {
  const last = blocks.at(-1);
  return last?.type === "error" && !last.retry && last.content === content;
}

function applyAutoRetryStart(blocks: RenderBlock[], event: PiEvent) {
  const content = event.errorMessage || "Unknown error";
  // The failed attempt's message_end may already have appended this error;
  // fold it into the retry notice instead of showing both.
  const base = hasTrailingError(blocks, content) ? blocks.slice(0, -1) : blocks;
  const notice: RenderBlock = {
    content,
    id: AUTO_RETRY_BLOCK_ID,
    retry: {
      attempt: event.attempt ?? 1,
      delayMs: event.delayMs ?? 0,
      maxAttempts: event.maxAttempts ?? 0,
    },
    type: "error",
  };
  const index = base.findIndex((block) => block.id === AUTO_RETRY_BLOCK_ID);
  if (index < 0) {
    return [...base, notice];
  }
  const next = [...base];
  next[index] = notice;
  return next;
}

function applyAutoRetryEnd(blocks: RenderBlock[], event: PiEvent) {
  const next = blocks.filter((block) => block.id !== AUTO_RETRY_BLOCK_ID);
  const content = event.finalError ?? "";
  if (event.success || !content || content === RETRY_CANCELLED) {
    return next;
  }
  // agent_end already appended the terminal error (it fires first).
  if (hasTrailingError(next, content)) {
    return next;
  }
  return [...next, errorBlock(content)];
}

function applyMessageEnd(blocks: RenderBlock[], event: PiEvent) {
  const message = typeof event.message === "object" ? event.message : undefined;
  if (message?.role !== "assistant" || message.stopReason !== "error") {
    return blocks;
  }
  const content = message.errorMessage ?? "";
  if (!content || hasTrailingError(blocks, content)) {
    return blocks;
  }
  return [...blocks, errorBlock(content)];
}

function applyAgentEnd(blocks: RenderBlock[], event: PiEvent) {
  if (event.willRetry) {
    return blocks;
  }
  // Safety net for a run whose terminal assistant error never surfaced (e.g.
  // message_end was missed). Only the run's last assistant message counts:
  // earlier errors belong to turns that already reported them.
  const lastAssistant = [...(event.messages ?? [])]
    .reverse()
    .find((message) => message.role === "assistant");
  const content =
    lastAssistant?.stopReason === "error"
      ? (lastAssistant.errorMessage ?? "")
      : "";
  if (!content || hasTrailingError(blocks, content)) {
    return blocks;
  }
  return [...blocks, errorBlock(content)];
}

function applyMessageStart(blocks: RenderBlock[], event: PiEvent) {
  const role =
    typeof event.message === "object" ? event.message?.role : undefined;
  if (role !== "assistant") {
    return blocks;
  }
  // A new assistant attempt supersedes the retry notice and any error left
  // behind by a previous failed attempt (including ones reloaded from a
  // session file while the agent was mid-retry).
  const next = blocks.filter((block) => block.id !== AUTO_RETRY_BLOCK_ID);
  let end = next.length;
  while (end > 0 && next[end - 1].type === "error") {
    end -= 1;
  }
  return next.slice(0, end);
}

export function adaptPiEvent(
  blocks: RenderBlock[],
  event: PiEvent
): RenderBlock[] {
  if (event.type === "omo_error") {
    const content =
      typeof event.message === "string" && event.message
        ? event.message
        : "Unknown error";
    return [...blocks, errorBlock(content)];
  }

  if (event.type === "auto_retry_start") {
    return applyAutoRetryStart(blocks, event);
  }
  if (event.type === "auto_retry_end") {
    return applyAutoRetryEnd(blocks, event);
  }
  if (event.type === "agent_end") {
    return applyAgentEnd(blocks, event);
  }
  if (event.type === "message_start") {
    return applyMessageStart(blocks, event);
  }
  if (event.type === "message_end") {
    return applyMessageEnd(blocks, event);
  }

  if (event.type !== "message_update" && event.type !== "tool_execution_end") {
    return blocks;
  }
  const next = [...blocks];
  if (event.type === "message_update") {
    if (event.assistantMessageEvent) {
      applyAssistantEvent(next, event.assistantMessageEvent);
    }
  } else {
    applyToolResult(next, event);
  }
  return next;
}
