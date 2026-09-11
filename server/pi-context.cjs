"use strict";

function serializable(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

/** Build a JSON-safe snapshot of everything that contributes to a live Pi context. */
function contextDetails(session) {
  const loader = session.resourceLoader;
  const activeTools = new Set(session.getActiveToolNames());
  const extensionResult = loader.getExtensions();
  const stats = session.getSessionStats();

  return {
    contextUsage: session.getContextUsage() ?? null,
    extensions: extensionResult.extensions.map((extension) => ({
      commands: [...extension.commands.keys()],
      events: [...extension.handlers.keys()],
      hidden: !!extension.hidden,
      path: extension.path,
      source: serializable(extension.sourceInfo),
      tools: [...extension.tools.keys()],
    })),
    injectedMessages: session.state.messages
      .filter((message) => message?.role === "custom" && !message.display)
      .map((message, index) => ({
        content: serializable(message.content),
        customType: message.customType,
        details: serializable(message.details),
        id: `${message.customType}:${message.timestamp ?? index}`,
      })),
    resources: {
      appendSystemPrompt: loader
        .getAppendSystemPrompt()
        .map((content, index) => ({
          content,
          path: loader.getAppendSystemPromptSources()[index]?.path,
        })),
      contextFiles: loader.getAgentsFiles().agentsFiles,
      skills: loader.getSkills().skills.map((skill) => ({
        description: skill.description,
        filePath: skill.filePath,
        name: skill.name,
      })),
      systemPromptSource: loader.getSystemPromptSource()?.path,
    },
    stats,
    systemPrompt: session.systemPrompt,
    tools: session.getAllTools().map((tool) => ({
      active: activeTools.has(tool.name),
      description: tool.description,
      name: tool.name,
      parameters: serializable(tool.parameters),
      promptGuidelines: tool.promptGuidelines,
      source: serializable(tool.sourceInfo),
    })),
  };
}

module.exports = { contextDetails };
