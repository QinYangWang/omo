import { useState } from "react";
import { Asterisk } from "lucide-react";
import { cn } from "@/lib/utils";

const aliases: Record<string, string> = {
  githubcopilot: "githubcopilot",
  "openai-codex": "openai",
  "github-copilot": "githubcopilot",
  "ollama-cloud": "ollamacloud",
  "kimi-coding": "moonshot",
  zai: "zhipu",
  google: "google",
  googlecloud: "googlecloud",
  meta: "meta",
  ollama: "ollama",
  openai: "openai",
  openrouter: "openrouter",
  qwen: "qwen",
  xai: "xai",
  zhipu: "zhipu",
  zhipuai: "zhipu",
};

export function ProviderIcon({ provider, className }: { provider?: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const key = provider?.toLowerCase() || "";
  const id = aliases[key] || aliases[key.replace(/[^a-z0-9]/g, "")] || key;
  if (!id || failed) return <Asterisk className={cn("size-3.5", className)} />;

  return (
    <img
      src={`https://registry.npmmirror.com/@lobehub/icons-static-svg/latest/files/icons/${id}-color.svg`}
      alt=""
      aria-hidden="true"
      className={cn("size-3.5 shrink-0", className)}
      onError={() => setFailed(true)}
    />
  );
}
