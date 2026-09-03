"use strict";

function clip(value, max) {
  const text =
    typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
  return text.length > max
    ? `${text.slice(0, max)}\n… truncated ${text.length - max} chars`
    : text;
}

function appendAssistantText(items, text, timestamp, max) {
  if (!text) {
    return;
  }
  items.push({
    id: crypto.randomUUID(),
    role: "assistant",
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
  for (const part of message.content || []) {
    if (part.type === "text") {
      text += part.text;
    }
    if (part.type === "thinking") {
      appendAssistantText(items, text, message.timestamp, 100_000);
      text = "";
      appendThinking(part, items);
    }
    if (part.type === "toolCall") {
      appendAssistantText(items, text, message.timestamp, 100_000);
      text = "";
      appendToolCall(part, items, tools);
    }
  }
  appendAssistantText(items, text, message.timestamp, 100_000);
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
  return items;
}

module.exports = { displayMessages };
