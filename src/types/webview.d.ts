interface Project { id: string; name: string; cwd: string }
interface PiSession {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  firstMessage: string;
  messageCount: number;
  created: number;
  modified: number;
}

interface QuotaWindow {
  provider: string;
  label: string;
  usedPercent: number;
  resetsAt: string;
  usedValue: number;
  limitValue: number;
  isCurrency?: boolean;
}
interface QuotaItem {
  provider: string;
  label: string;
  success: boolean;
  error?: { message: string; kind: string };
  windows: QuotaWindow[];
}

interface ProviderInfo {
  id: string;
  name: string;
  connected: boolean;
  authType?: "api_key" | "oauth";
  source?: string;
  hasApiKey: boolean;
  hasOAuth: boolean;
  subscription: boolean;
  error?: string;
}

interface OmoApi {
  pi: {
    open(sessionId: string, cwd: string, sessionPath?: string): Promise<{ messages: any[]; cursor: number; hasMore: boolean }>;
    history(sessionId: string, before: number): Promise<{ messages: any[]; cursor: number; hasMore: boolean }>;
    models(): Promise<{ id: string; provider: string; name: string }[]>;
    setModel(sessionId: string, provider: string, modelId: string): Promise<void>;
    setThinking(sessionId: string, level: string): Promise<void>;
    prompt(sessionId: string, message: string, cwd?: string, sessionPath?: string): Promise<void>;
    abort(sessionId: string): Promise<void>;
    onEvent(cb: (data: { sessionId: string; event: any }) => void): () => void;
  };
  term: {
    create(cwd?: string): Promise<void>;
    input(data: string): void;
    onData(cb: (d: string) => void): () => void;
  };
  fs: {
    list(dir: string): Promise<{ name: string; dir: boolean }[]>;
    read(p: string): Promise<{ content?: string; error?: string }>;
  };
  git: {
    status(cwd: string): Promise<string>;
    diff(cwd: string, file: string): Promise<string>;
    branches(cwd: string): Promise<{ name: string; current: boolean }[]>;
  };
  providers: {
    quotas(force?: boolean): Promise<{ installed: boolean; items: QuotaItem[] }>;
    list(): Promise<ProviderInfo[]>;
    login(providerId: string, type: "api_key" | "oauth"): Promise<boolean>;
    respond(requestId: string, value: string): Promise<boolean>;
    cancel(requestId: string): Promise<boolean>;
    logout(providerId: string): Promise<boolean>;
    onAuthEvent(cb: (event: any) => void): () => void;
  };
  usage: {
    snapshot(): Promise<{
      totals: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
      providers: { provider: string; model: string; tokens: number; cost: number }[];
    }>;
  };
  projects: {
    list(): Promise<Project[]>;
    add(): Promise<Project | null>;
  };
  sessions: {
    list(cwd: string): Promise<PiSession[]>;
    all(): Promise<PiSession[]>;
    import(sourcePath: string, cwd: string): Promise<string>;
  };
  cwd(): Promise<string>;
  usage: { snapshot(): Promise<{ totals: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }; providers: { provider: string; model: string; messages: number; tokens: number; cost: number }[] }> };
}

interface Window {
  omo: OmoApi;
}

declare namespace JSX {
  interface IntrinsicElements {
    webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
      src?: string;
      allowpopups?: string;
      partition?: string;
    };
  }
}
