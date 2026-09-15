"use strict";

const HISTORY_PAGE_SIZE = 80;

function clip(value, max) {
  const text =
    typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
  return text.length > max
    ? `${text.slice(0, max)}\n… truncated ${text.length - max} chars`
    : text;
}

function appendAssistantText(items, text, timestamp, max, sessionEntryId) {
  if (!text) {
    return;
  }
  items.push({
    id: crypto.randomUUID(),
    role: "assistant",
    sessionEntryId,
    text: clip(text, max),
    timestamp,
  });
}

function userContent(message) {
  if (typeof message.content === "string") {
    return [{ text: message.content, type: "text" }];
  }
  return message.content || [];
}

function appendUserMessage(message, items) {
  const content = userContent(message);
  const text = content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const images = content.filter((part) => part.type === "image");
  if (text || images.length) {
    items.push({
      id: crypto.randomUUID(),
      images: images.length ? images : undefined,
      role: "user",
      sessionEntryId: message.sessionEntryId,
      text: clip(text, 80_000),
      timestamp: message.timestamp,
    });
  }
}

function appendThinking(part, items) {
  items.push({
    id: crypto.randomUUID(),
    role: "thinking",
    status: "done",
    text: clip(part.thinking, 40_000),
  });
}

function appendToolCall(part, items, tools) {
  const item = {
    id: part.id,
    input: clip(part.arguments, 8000),
    role: "tool",
    status: "running",
    toolName: part.name,
  };
  tools.set(part.id, item);
  items.push(item);
}

function appendAssistantMessage(message, items, tools) {
  let text = "";
  const appendText = () => {
    appendAssistantText(
      items,
      text,
      message.timestamp,
      100_000,
      message.sessionEntryId
    );
    text = "";
  };
  for (const part of message.content || []) {
    if (part.type === "text") {
      text += part.text;
    }
    if (part.type === "thinking") {
      appendText();
      appendThinking(part, items);
    }
    if (part.type === "toolCall") {
      appendText();
      appendToolCall(part, items, tools);
    }
  }
  appendText();
  if (message.stopReason === "error") {
    // Failed LLM call (rate limit, quota, transport): keep it visible instead
    // of rendering an empty turn.
    items.push({
      id: crypto.randomUUID(),
      role: "error",
      text: clip(message.errorMessage || "Unknown error", 8000),
      timestamp: message.timestamp,
    });
  }
}

function appendToolResult(message, items, tools) {
  const output = (message.content || [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const item = tools.get(message.toolCallId);
  if (item) {
    Object.assign(item, {
      output: clip(output, 16_000),
      status: message.isError ? "error" : "done",
    });
    return;
  }
  items.push({
    id: message.toolCallId,
    output: clip(output, 16_000),
    role: "tool",
    status: message.isError ? "error" : "done",
    toolName: message.toolName,
  });
}

function finishTurns(items) {
  let turnStart;
  let assistantItems = [];
  let lastAssistant;
  const finishTurn = () => {
    if (!lastAssistant) {
      return;
    }
    lastAssistant.turnEnd = true;
    lastAssistant.completedAt = lastAssistant.timestamp;
    lastAssistant.durationMs =
      turnStart && lastAssistant.timestamp
        ? Math.max(0, lastAssistant.timestamp - turnStart)
        : undefined;
    lastAssistant.copyText = assistantItems
      .map((item) => item.text)
      .join("\n\n");
    for (const item of assistantItems) {
      if (item !== lastAssistant) {
        item.timestamp = undefined;
      }
    }
    assistantItems = [];
    lastAssistant = undefined;
  };
  for (const item of items) {
    if (item.role === "user") {
      finishTurn();
      turnStart = item.timestamp;
    } else if (item.role === "assistant") {
      lastAssistant = item;
      assistantItems.push(item);
    }
  }
  finishTurn();
}

function finalizeDanglingTools(items) {
  for (const item of items) {
    if (item.role === "tool" && item.status === "running") {
      item.output ??=
        "Interrupted: the agent stopped before returning a tool result.";
      item.status = "error";
    }
  }
}

function pruneTurnErrors(items, start, end) {
  // Error items record failed LLM attempts. Attempts followed by more output
  // in the same turn were retried and recovered, so they are transient noise;
  // when the turn ends in errors, keep only the last one as the outcome.
  let lastNonError = start - 1;
  for (let index = end - 1; index >= start; index -= 1) {
    if (items[index].role !== "error") {
      lastNonError = index;
      break;
    }
  }
  const kept = items
    .slice(start, lastNonError + 1)
    .filter((item) => item.role !== "error");
  const trailing = items.slice(lastNonError + 1, end);
  if (trailing.length) {
    kept.push(trailing.at(-1));
  }
  return kept;
}

function pruneTransientErrors(items) {
  const result = [];
  let start = 0;
  for (let index = 0; index < items.length; index += 1) {
    if (items[index].role === "user" && index > start) {
      result.push(...pruneTurnErrors(items, start, index));
      start = index;
    }
  }
  result.push(...pruneTurnErrors(items, start, items.length));
  return result;
}

function displayMessages(messages) {
  const items = [];
  const tools = new Map();
  for (const message of messages || []) {
    if (message.role === "user") {
      appendUserMessage(message, items);
    } else if (message.role === "assistant") {
      appendAssistantMessage(message, items, tools);
    } else if (message.role === "toolResult") {
      appendToolResult(message, items, tools);
    }
  }
  finishTurns(items);
  return pruneTransientErrors(items);
}

function sessionHistoryMessages(manager) {
  const messages = [];
  for (const entry of manager.getBranch()) {
    if (entry.type === "message" && entry.message) {
      messages.push({ ...entry.message, sessionEntryId: entry.id });
    }
  }
  return messages;
}

function createHistorySnapshot(messages, { running = false } = {}) {
  const items = displayMessages(messages);
  if (!running) {
    finalizeDanglingTools(items);
  }
  const turnStarts = [];
  for (let index = 0; index < items.length; index += 1) {
    if (index === 0 || items[index].role === "user") {
      turnStarts.push(index);
    }
  }
  const metas = turnStarts.map((messageIndex, absoluteIndex) => {
    const message = items[messageIndex];
    return {
      absoluteIndex,
      id: message.role === "user" ? message.id : `${message.id}:orphan`,
      userPreview:
        message.role === "user"
          ? message.text.replace(/\s+/g, " ").trim().slice(0, 300)
          : "",
    };
  });
  return { items, metas, turnStarts };
}

function historyPage(snapshot, before) {
  const totalTurns = snapshot.turnStarts.length;
  const requested = Number(before);
  const endTurn = Number.isFinite(requested)
    ? Math.max(0, Math.min(requested, totalTurns))
    : totalTurns;
  const endMessage =
    endTurn < totalTurns ? snapshot.turnStarts[endTurn] : snapshot.items.length;
  let startTurn = endTurn;
  while (startTurn > 0) {
    const candidateStart = snapshot.turnStarts[startTurn - 1];
    const candidateSize = endMessage - candidateStart;
    const isFirstCandidate = startTurn === endTurn - 1;
    if (
      startTurn < endTurn &&
      !isFirstCandidate &&
      candidateSize > HISTORY_PAGE_SIZE
    ) {
      break;
    }
    startTurn -= 1;
  }
  const startMessage =
    startTurn < totalTurns
      ? snapshot.turnStarts[startTurn]
      : snapshot.items.length;
  return {
    cursor: startTurn,
    hasMore: startTurn > 0,
    messages: snapshot.items.slice(startMessage, endMessage),
  };
}

module.exports = {
  createHistorySnapshot,
  displayMessages,
  historyPage,
  sessionHistoryMessages,
};
