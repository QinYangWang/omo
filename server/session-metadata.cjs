"use strict";

function textContent(content) {
  if (typeof content === "string") {
    return content;
  }
  return (content || [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function sessionCost(manager) {
  let cost = 0;
  for (const entry of manager.getEntries()) {
    const value = entry.message?.usage?.cost?.total ?? entry.usage?.cost?.total;
    if (Number.isFinite(value)) {
      cost += value;
    }
  }
  return cost;
}

function sessionMarkdown(manager) {
  const sections = [];
  for (const entry of manager.getBranch()) {
    if (entry.type !== "message" || !entry.message) {
      continue;
    }
    const { message } = entry;
    if (message.role === "user") {
      sections.push(`## User\n\n${textContent(message.content)}`);
    } else if (message.role === "assistant") {
      const text = (message.content || [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      if (text) {
        sections.push(`## Assistant\n\n${text}`);
      }
    } else if (message.role === "toolResult") {
      const output = textContent(message.content);
      sections.push(
        `### Tool: ${message.toolName}\n\n\`\`\`text\n${output}\n\`\`\``
      );
    }
  }
  return `${sections.join("\n\n")}\n`;
}

module.exports = { sessionCost, sessionMarkdown };
