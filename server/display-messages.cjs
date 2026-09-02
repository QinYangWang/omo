function clip(value, max) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > max ? `${text.slice(0, max)}\n… truncated ${text.length - max} chars` : text;
}

function displayMessages(messages) {
  const items = [];
  const tools = new Map();
  for (const message of messages || []) {
    if (message.role === "user") {
      const text = typeof message.content === "string"
        ? message.content
        : message.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      if (text) items.push({ id: crypto.randomUUID(), role: "user", text: clip(text, 80000), timestamp: message.timestamp });
      continue;
    }
    if (message.role === "assistant") {
      let text = "";
      for (const part of message.content || []) {
        if (part.type === "text") text += part.text;
        if (part.type === "thinking") {
          if (text) items.push({ id: crypto.randomUUID(), role: "assistant", text: clip(text, 100000), timestamp: message.timestamp });
          text = "";
          items.push({ id: crypto.randomUUID(), role: "thinking", text: clip(part.thinking, 40000), status: "done" });
        }
        if (part.type === "toolCall") {
          if (text) items.push({ id: crypto.randomUUID(), role: "assistant", text: clip(text, 100000), timestamp: message.timestamp });
          text = "";
          const item = { id: part.id, role: "tool", toolName: part.name, input: clip(part.arguments, 8000), status: "running" };
          tools.set(part.id, item);
          items.push(item);
        }
      }
      if (text) items.push({ id: crypto.randomUUID(), role: "assistant", text: clip(text, 100000), timestamp: message.timestamp });
      continue;
    }
    if (message.role === "toolResult") {
      const output = message.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") || "";
      const item = tools.get(message.toolCallId);
      if (item) Object.assign(item, { output: clip(output, 16000), status: message.isError ? "error" : "done" });
      else items.push({ id: message.toolCallId, role: "tool", toolName: message.toolName, output: clip(output, 16000), status: message.isError ? "error" : "done" });
    }
  }
  let turnStart;
  let assistantItems = [];
  let lastAssistant;
  const finishTurn = () => {
    if (!lastAssistant) return;
    lastAssistant.turnEnd = true;
    lastAssistant.completedAt = lastAssistant.timestamp;
    lastAssistant.durationMs = turnStart && lastAssistant.timestamp ? Math.max(0, lastAssistant.timestamp - turnStart) : undefined;
    lastAssistant.copyText = assistantItems.map((item) => item.text).join("\n\n");
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
  return items;
}

module.exports = { displayMessages };
