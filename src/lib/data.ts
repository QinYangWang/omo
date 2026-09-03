export interface Provider {
  connected: boolean;
  id: string;
  kind: "oauth" | "apikey";
  name: string;
  quota?: number; // 0-100 剩余百分比
}

export const mockProviders: Provider[] = [
  { connected: true, id: "openai", kind: "oauth", name: "OpenAI", quota: 87 },
  { connected: false, id: "anthropic", kind: "apikey", name: "Anthropic" },
  { connected: true, id: "google", kind: "oauth", name: "Google", quota: 42 },
];

export interface Skill {
  desc: string;
  enabled: boolean;
  id: string;
  installs?: string;
  name: string;
}

export const mockSkills: Skill[] = [
  {
    desc: "Forces the laziest solution that works",
    enabled: true,
    id: "ponytail",
    installs: "1.2k",
    name: "ponytail",
  },
  {
    desc: "Generate or edit raster images",
    enabled: true,
    id: "imagegen",
    installs: "800",
    name: "imagegen",
  },
  {
    desc: "Discover and install agent skills",
    enabled: false,
    id: "find-skills",
    installs: "600",
    name: "find-skills",
  },
  {
    desc: "Render beautiful file diffs",
    enabled: true,
    id: "diffs",
    installs: "300",
    name: "diffs",
  },
];
