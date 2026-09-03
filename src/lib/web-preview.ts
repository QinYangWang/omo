const previewProjects: Project[] = [
  { cwd: "/workspace/omo", id: "preview", name: "omo", serverId: "local" },
];

const previewSessions: PiSession[] = [
  {
    created: Date.now() - 3_600_000,
    cwd: "/workspace/omo",
    firstMessage: "Review the new Base UI interface",
    id: "preview-session",
    messageCount: 4,
    modified: Date.now() - 60_000,
    name: "shadcn UI migration",
    path: "/workspace/omo/.pi/preview.jsonl",
  },
];

/** Installs a browser-only API stub so the Electron renderer can be reviewed in Vite. */
export function installWebPreviewApi() {
  if (window.omo) {
    return;
  }

  window.omo = {
    cwd: async () => previewProjects[0].cwd,
    fs: {
      list: async () => [
        { dir: true, name: "src" },
        { dir: false, name: "package.json" },
        { dir: false, name: "AGENTS.md" },
      ],
      read: async (path) => ({
        content: `Web preview placeholder for ${path}\n`,
      }),
    },
    git: {
      branches: async () => [{ current: true, name: "main" }],
      diff: async (_cwd, file) =>
        `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old UI\n+shadcn Base UI\n`,
      status: async () => " M src/components/ChatView.tsx\n M src/index.css",
    },
    pi: {
      abort: async () => undefined,
      commands: async () => [
        {
          description: "Review the current changes",
          name: "review",
          source: "prompt",
        },
        {
          description: "Run the project code standards",
          name: "skill:ultracite",
          source: "skill",
        },
      ],
      history: async () => ({ cursor: 0, hasMore: false, messages: [] }),
      models: async () => [
        {
          id: "claude-sonnet-4",
          name: "Claude Sonnet 4",
          provider: "anthropic",
        },
        { id: "gpt-5", name: "GPT-5", provider: "openai" },
      ],
      onEvent: () => () => undefined,
      open: async () => ({ cursor: 0, hasMore: false, messages: [] }),
      prompt: async () => undefined,
      setModel: async () => undefined,
      setThinking: async () => undefined,
    },
    projects: {
      add: async () => null,
      list: async () => previewProjects,
      pickDirectory: async () => null,
    },
    providers: {
      cancel: async () => true,
      list: async () => [
        {
          authType: "oauth",
          connected: true,
          hasApiKey: true,
          hasOAuth: true,
          id: "anthropic",
          name: "Anthropic",
          source: "Pi",
          subscription: true,
        },
        {
          connected: false,
          hasApiKey: true,
          hasOAuth: true,
          id: "openai",
          name: "OpenAI",
          source: "Pi",
          subscription: true,
        },
      ],
      login: async () => true,
      logout: async () => true,
      onAuthEvent: () => () => undefined,
      quotas: async () => ({ installed: true, items: [] }),
      respond: async () => true,
    },
    sessions: {
      all: async () => previewSessions,
      import: async () => previewSessions[0].path,
      list: async () => previewSessions,
    },
    term: {
      create: async () => undefined,
      input: () => undefined,
      onData: (callback) => {
        queueMicrotask(() =>
          callback(
            "omo web preview — terminal input is available in Electron only.\r\n"
          )
        );
        return () => undefined;
      },
    },
    usage: {
      snapshot: async () => ({
        providers: [
          {
            cost: 3.42,
            messages: 24,
            model: "claude-sonnet-4",
            provider: "anthropic",
            tokens: 156_600,
          },
        ],
        totals: {
          cacheRead: 82_000,
          cacheWrite: 4100,
          cost: 3.42,
          input: 125_400,
          output: 31_200,
        },
      }),
    },
    windowControls: { setTitleBarOverlay: () => undefined },
    skills: {
      list: async () => [
        {
          description: "Review the current changes against the code standards",
          filePath: "/workspace/omo/.agents/skills/review/SKILL.md",
          name: "review",
        },
      ],
    },
    models: {
      list: async () => [
        {
          enabled: true,
          id: "claude-sonnet-4",
          name: "Claude Sonnet 4",
          provider: "anthropic",
        },
        {
          enabled: false,
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "openai-codex",
        },
      ],
      setEnabled: async () => [],
    },
    packages: {
      install: async () => [],
      list: async () => [
        {
          kind: "npm",
          name: "@example/pi-tools",
          source: "npm:@example/pi-tools",
          version: "1.2.0",
        },
      ],
      remove: async () => [],
    },
  };
}
