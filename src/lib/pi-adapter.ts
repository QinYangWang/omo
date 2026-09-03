import type { ChatMessage } from "@/lib/conversation-turns";
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
interface PiEvent {
  assistantMessageEvent?: PiAssistantEvent;
  isError?: boolean;
  message?: string | { role?: string };
  result?: { content?: PiToolResultPart[] | string };
  toolCallId?: string;
  type: string;
}

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
  | { id: string; type: "error"; content: string };

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

export function adaptPiEvent(
  blocks: RenderBlock[],
  event: PiEvent
): RenderBlock[] {
  if (event.type === "omo_error") {
    return [
      ...blocks,
      {
        content:
          typeof event.message === "string" ? event.message : String(event),
        id: randomUUID(),
        type: "error",
      },
    ];
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
