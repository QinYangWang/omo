export type Provider = {
  id: string;
  name: string;
  kind: "oauth" | "apikey";
  connected: boolean;
  quota?: number; // 0-100 剩余百分比
};

export const mockProviders: Provider[] = [
  { id: "openai", name: "OpenAI", kind: "oauth", connected: true, quota: 87 },
  { id: "anthropic", name: "Anthropic", kind: "apikey", connected: false },
  { id: "google", name: "Google", kind: "oauth", connected: true, quota: 42 },
];

export type Skill = { id: string; name: string; desc: string; enabled: boolean; installs?: string };

export const mockSkills: Skill[] = [
  { id: "ponytail", name: "ponytail", desc: "Forces the laziest solution that works", enabled: true, installs: "1.2k" },
  { id: "imagegen", name: "imagegen", desc: "Generate or edit raster images", enabled: true, installs: "800" },
  { id: "find-skills", name: "find-skills", desc: "Discover and install agent skills", enabled: false, installs: "600" },
  { id: "diffs", name: "diffs", desc: "Render beautiful file diffs", enabled: true, installs: "300" },
];
