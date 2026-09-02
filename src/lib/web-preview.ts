const previewProjects: Project[] = [
  { id: "preview", name: "omo", cwd: "/workspace/omo" },
]

const previewSessions: PiSession[] = [
  {
    id: "preview-session",
    path: "/workspace/omo/.pi/preview.jsonl",
    cwd: "/workspace/omo",
    name: "shadcn UI migration",
    firstMessage: "Review the new Base UI interface",
    messageCount: 4,
    created: Date.now() - 3_600_000,
    modified: Date.now() - 60_000,
  },
]

/** Installs a browser-only API stub so the Electron renderer can be reviewed in Vite. */
export function installWebPreviewApi() {
  if (window.omo) return

  window.omo = {
    pi: {
      open: async () => ({ messages: [], cursor: 0, hasMore: false }),
      history: async () => ({ messages: [], cursor: 0, hasMore: false }),
      models: async () => [
        { id: "claude-sonnet-4", provider: "anthropic", name: "Claude Sonnet 4" },
        { id: "gpt-5", provider: "openai", name: "GPT-5" },
      ],
      setModel: async () => undefined,
      setThinking: async () => undefined,
      prompt: async () => undefined,
      abort: async () => undefined,
      onEvent: () => () => undefined,
    },
    term: {
      create: async () => undefined,
      input: () => undefined,
      onData: (callback) => {
        queueMicrotask(() => callback("omo web preview — terminal input is available in Electron only.\r\n"))
        return () => undefined
      },
    },
    fs: {
      list: async () => [
        { name: "src", dir: true },
        { name: "package.json", dir: false },
        { name: "AGENTS.md", dir: false },
      ],
      read: async (path) => ({ content: `Web preview placeholder for ${path}\n` }),
    },
    git: {
      status: async () => " M src/components/ChatView.tsx\n M src/index.css",
      diff: async (_cwd, file) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old UI\n+shadcn Base UI\n`,
      branches: async () => [{ name: "main", current: true }],
    },
    providers: {
      quotas: async () => ({ installed: true, items: [] }),
      list: async () => [
        { id: "anthropic", name: "Anthropic", connected: true, authType: "oauth", source: "Pi", hasApiKey: true, hasOAuth: true, subscription: true },
        { id: "openai", name: "OpenAI", connected: false, source: "Pi", hasApiKey: true, hasOAuth: true, subscription: true },
      ],
      login: async () => true,
      respond: async () => true,
      cancel: async () => true,
      logout: async () => true,
      onAuthEvent: () => () => undefined,
    },
    usage: {
      snapshot: async () => ({
        totals: { input: 125_400, output: 31_200, cacheRead: 82_000, cacheWrite: 4_100, cost: 3.42 },
        providers: [{ provider: "anthropic", model: "claude-sonnet-4", messages: 24, tokens: 156_600, cost: 3.42 }],
      }),
    },
    projects: {
      list: async () => previewProjects,
      add: async () => null,
      pickDirectory: async () => null,
    },
    sessions: {
      list: async () => previewSessions,
      all: async () => previewSessions,
      import: async () => previewSessions[0].path,
    },
    cwd: async () => previewProjects[0].cwd,
  }
}
