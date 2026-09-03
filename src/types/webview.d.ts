interface Project {
  cwd: string;
  id: string;
  name: string;
}
interface PiImageContent {
  data: string;
  mimeType: string;
  type: "image";
}
interface OmoPiAssistantEvent {
  delta?: string;
  id?: string;
  toolCall?: { arguments: unknown; id: string };
  toolName?: string;
  type: string;
}
interface OmoPiResultPart {
  text?: string;
  type: string;
}
interface OmoPiEvent {
  assistantMessageEvent?: OmoPiAssistantEvent;
  isError?: boolean;
  message?: { role?: string };
  result?: { content?: OmoPiResultPart[] | string };
  toolCallId?: string;
  type: string;
}
interface OmoPiEventEnvelope {
  event: OmoPiEvent;
  sessionId: string;
}
interface PiSession {
  created: number;
  cwd: string;
  firstMessage: string;
  id: string;
  messageCount: number;
  modified: number;
  name?: string;
  path: string;
}

interface QuotaWindow {
  isCurrency?: boolean;
  label: string;
  limitValue: number;
  provider: string;
  resetsAt: string;
  usedPercent: number;
  usedValue: number;
}
interface QuotaItem {
  error?: { message: string; kind: string };
  label: string;
  provider: string;
  success: boolean;
  windows: QuotaWindow[];
}

interface AuthPrompt {
  message: string;
  options?: readonly {
    description?: string;
    id: string;
    label: string;
  }[];
  placeholder?: string;
  type: "text" | "secret" | "select" | "manual_code";
}
type ProviderAuthNotification =
  | {
      links?: readonly { label?: string; url: string }[];
      message: string;
      type: "info";
    }
  | { message: string; type: "progress" }
  | {
      expiresInSeconds?: number;
      intervalSeconds?: number;
      type: "device_code";
      userCode: string;
      verificationUri: string;
    }
  | { instructions?: string; type: "auth_url"; url: string };
type ProviderAuthEvent =
  | {
      kind: "prompt";
      prompt: AuthPrompt;
      providerId: string;
      requestId: string;
    }
  | {
      event: ProviderAuthNotification;
      kind: "notify";
      providerId: string;
    };

interface ProviderInfo {
  authType?: "api_key" | "oauth";
  connected: boolean;
  error?: string;
  hasApiKey: boolean;
  hasOAuth: boolean;
  id: string;
  name: string;
  source?: string;
  subscription: boolean;
}

interface omoApi {
  cwd: () => Promise<string>;
  fs: {
    list: (dir: string) => Promise<{ name: string; dir: boolean }[]>;
    read: (
      p: string,
      binary?: boolean
    ) => Promise<{
      content?: string;
      data?: string;
      mimeType?: string;
      error?: string;
    }>;
  };
  git: {
    status: (cwd: string) => Promise<string>;
    diff: (cwd: string, file: string) => Promise<string>;
    branches: (cwd: string) => Promise<{ name: string; current: boolean }[]>;
  };
  pi: {
    open: (
      sessionId: string,
      cwd: string,
      sessionPath?: string
    ) => Promise<{
      messages: unknown[];
      cursor: number;
      hasMore: boolean;
      model?: { id: string; provider: string; name: string } | null;
      thinkingLevel?: string;
    }>;
    history: (
      sessionId: string,
      before: number
    ) => Promise<{ messages: unknown[]; cursor: number; hasMore: boolean }>;
    models: () => Promise<{ id: string; provider: string; name: string }[]>;
    commands: (
      sessionId: string,
      cwd: string,
      sessionPath?: string
    ) => Promise<{ name: string; description?: string; source?: string }[]>;
    setModel: (
      sessionId: string,
      provider: string,
      modelId: string
    ) => Promise<void>;
    setThinking: (sessionId: string, level: string) => Promise<void>;
    prompt: (
      sessionId: string,
      message: string,
      cwd?: string,
      sessionPath?: string,
      images?: PiImageContent[]
    ) => Promise<void>;
    abort: (sessionId: string) => Promise<void>;
    onEvent: (cb: (data: OmoPiEventEnvelope) => void) => () => void;
  };
  projects: {
    list: () => Promise<Project[]>;
    add: (path?: string) => Promise<Project | null>;
    pickDirectory: () => Promise<string | null>;
  };
  providers: {
    quotas: (
      force?: boolean
    ) => Promise<{ installed: boolean; items: QuotaItem[] }>;
    list: () => Promise<ProviderInfo[]>;
    login: (providerId: string, type: "api_key" | "oauth") => Promise<boolean>;
    respond: (requestId: string, value: string) => Promise<boolean>;
    cancel: (requestId: string) => Promise<boolean>;
    logout: (providerId: string) => Promise<boolean>;
    onAuthEvent: (cb: (event: ProviderAuthEvent) => void) => () => void;
  };
  sessions: {
    list: (cwd: string) => Promise<PiSession[]>;
    all: () => Promise<PiSession[]>;
    import: (sourcePath: string, cwd: string) => Promise<string>;
  };
  term: {
    create: (cwd?: string) => Promise<void>;
    input: (data: string) => void;
    onData: (cb: (d: string) => void) => () => void;
  };
  usage: {
    snapshot: () => Promise<{
      totals: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        cost: number;
      };
      providers: {
        provider: string;
        model: string;
        messages: number;
        tokens: number;
        cost: number;
      }[];
    }>;
  };
  windowControls: {
    setTitleBarOverlay: (options: {
      color: string;
      symbolColor: string;
    }) => void;
  };
}

interface Window {
  omo: omoApi;
  omoSecure?: {
    loadRemoteConfig: () => Promise<{ url: string; token: string }>;
    saveRemoteConfig: (url: string, token: string) => Promise<boolean>;
    clearRemoteConfig: () => Promise<boolean>;
  };
}

interface WebviewElement extends HTMLElement {
  loadURL: (url: string) => Promise<void>;
}

// biome-ignore lint/style/noNamespace: React's JSX augmentation requires a namespace.
declare namespace JSX {
  interface IntrinsicElements {
    webview: React.DetailedHTMLProps<
      React.HTMLAttributes<WebviewElement>,
      WebviewElement
    > & {
      src?: string;
      allowpopups?: string;
      partition?: string;
    };
  }
}
