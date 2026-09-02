import type { ChatMessage } from "@/lib/conversation-turns";

export type RenderBlock =
  | { id: string; type: "markdown"; content: string; timestamp?: number }
  | { id: string; type: "reasoning"; content: string; status: "running" | "done" }
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
  const toolCalls = new Map<string, Extract<RenderBlock, { type: "tool-call" }>>();

  for (const message of messages) {
    if (message.role === "user" || message.role === "assistant") {
      blocks.push({
        id: message.id,
        type: "markdown",
        content: message.text,
        timestamp: message.timestamp,
      });
      continue;
    }
    if (message.role === "thinking") {
      blocks.push({
        id: message.id,
        type: "reasoning",
        content: message.text,
        status: message.status,
      });
      continue;
    }
    if (message.role === "tool") {
      const call: Extract<RenderBlock, { type: "tool-call" }> = {
        id: message.id,
        type: "tool-call",
        toolName: message.toolName,
        input: message.input,
        output: message.output,
        status: message.status,
      };
      blocks.push(call);
      toolCalls.set(message.id, call);
    }
  }

  return blocks;
}

export function adaptPiEvent(blocks: RenderBlock[], event: any): RenderBlock[] {
  if (event.type === "omo_error") {
    return [...blocks, { id: crypto.randomUUID(), type: "error", content: event.message || String(event) }];
  }

  if (event.type !== "message_update" && event.type !== "tool_execution_end") return blocks;
  const assistantEvent = event.assistantMessageEvent;
  const next = [...blocks];
  const updateBlock = (id: string, update: (block: RenderBlock) => RenderBlock) => {
    const index = next.findIndex((block) => block.id === id);
    if (index >= 0) next[index] = update(next[index]);
    return index >= 0;
  };
  const lastIndex = (type: RenderBlock["type"], running?: boolean) => {
    for (let i = next.length - 1; i >= 0; i--) {
      const block = next[i];
      if (block.type !== type) continue;
      if (running === undefined || ("status" in block && block.status === (running ? "running" : "done"))) return i;
    }
    return -1;
  };

  if (assistantEvent?.type === "thinking_start") {
    next.push({ id: crypto.randomUUID(), type: "reasoning", content: "", status: "running" });
  } else if (assistantEvent?.type === "thinking_delta") {
    const index = lastIndex("reasoning", true);
    if (index >= 0 && next[index].type === "reasoning") {
      next[index] = { ...next[index], content: (next[index] as any).content + assistantEvent.delta };
    }
  } else if (assistantEvent?.type === "thinking_end") {
    const index = lastIndex("reasoning", true);
    if (index >= 0) next[index] = { ...next[index], status: "done" } as RenderBlock;
  } else if (assistantEvent?.type === "text_start") {
    next.push({ id: crypto.randomUUID(), type: "markdown", content: "", timestamp: Date.now() });
  } else if (assistantEvent?.type === "text_delta") {
    const index = lastIndex("markdown");
    if (index >= 0 && next[index].type === "markdown") {
      next[index] = { ...next[index], content: (next[index] as any).content + assistantEvent.delta };
    }
  } else if (assistantEvent?.type === "toolcall_start") {
    next.push({
      id: assistantEvent.id,
      type: "tool-call",
      toolName: assistantEvent.toolName,
      status: "running",
    });
  } else if (assistantEvent?.type === "toolcall_end") {
    updateBlock(assistantEvent.toolCall?.id, (block) =>
      block.type === "tool-call"
        ? { ...block, input: JSON.stringify(assistantEvent.toolCall.arguments, null, 2) }
        : block
    );
  }

  if (event.type === "tool_execution_end") {
    const output = typeof event.result?.content === "string"
      ? event.result.content
      : Array.isArray(event.result?.content)
        ? event.result.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n")
        : "";
    const status = event.isError ? "error" : "done";
    updateBlock(event.toolCallId, (block) => block.type === "tool-call" ? { ...block, status, output } : block);
  }

  return next;
}
