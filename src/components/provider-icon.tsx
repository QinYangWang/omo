import { Asterisk } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

const compactProvider = /[^a-z0-9]/g;
const aliases: Record<string, string> = {
  "github-copilot": "githubcopilot",
  githubcopilot: "githubcopilot",
  google: "google",
  googlecloud: "googlecloud",
  "kimi-coding": "moonshot",
  meta: "meta",
  ollama: "ollama",
  "ollama-cloud": "ollamacloud",
  openai: "openai",
  "openai-codex": "openai",
  openrouter: "openrouter",
  qwen: "qwen",
  xai: "xai",
  zai: "zhipu",
  zhipu: "zhipu",
  zhipuai: "zhipu",
};

export function ProviderIcon({
  provider,
  className,
}: {
  provider?: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const key = provider?.toLowerCase() || "";
  const id = aliases[key] || aliases[key.replace(compactProvider, "")] || key;
  if (!id || failed) {
    return <Asterisk className={cn("size-3.5", className)} />;
  }

  return (
    <img
      alt=""
      aria-hidden="true"
      className={cn("size-3.5 shrink-0", className)}
      height={14}
      onError={() => setFailed(true)}
      src={`https://registry.npmmirror.com/@lobehub/icons-static-svg/latest/files/icons/${id}-color.svg`}
      width={14}
    />
  );
}
