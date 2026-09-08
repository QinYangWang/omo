import Antgroup from "@thesvg/react/antgroup";
import Anthropic from "@thesvg/react/anthropic";
import AwsAmazonBedrock from "@thesvg/react/aws-amazon-bedrock";
import Azure from "@thesvg/react/azure";
import Baseten from "@thesvg/react/baseten";
import Cerebras from "@thesvg/react/cerebras";
import Cloudflare from "@thesvg/react/cloudflare";
import Deepseek from "@thesvg/react/deepseek";
import Doubao from "@thesvg/react/doubao";
import Fireworks from "@thesvg/react/fireworks";
import Gemini from "@thesvg/react/gemini";
import Github from "@thesvg/react/github";
import GithubCopilot from "@thesvg/react/github-copilot";
import Google from "@thesvg/react/google";
import Groq from "@thesvg/react/groq";
import HuggingFace from "@thesvg/react/hugging-face";
import Kimi from "@thesvg/react/kimi";
import Meta from "@thesvg/react/meta";
import Minimax from "@thesvg/react/minimax";
import MistralAi from "@thesvg/react/mistral-ai";
import MoonshotAi from "@thesvg/react/moonshot-ai";
import Nvidia from "@thesvg/react/nvidia";
import Ollama from "@thesvg/react/ollama";
import Openai from "@thesvg/react/openai";
import Opencode from "@thesvg/react/opencode";
import Openrouter from "@thesvg/react/openrouter";
import Qwen from "@thesvg/react/qwen";
import SiliconcloudSiliconflow from "@thesvg/react/siliconcloud-siliconflow";
import Togetherdotai from "@thesvg/react/togetherdotai";
import Vercel from "@thesvg/react/vercel";
import VertexaiGoogle from "@thesvg/react/vertexai-google";
import Volcengine from "@thesvg/react/volcengine";
import Xai from "@thesvg/react/xai";
import Xiaomi from "@thesvg/react/xiaomi";
import Zhipu from "@thesvg/react/zhipu";
import type { ComponentType, CSSProperties, ElementType } from "react";
import { cn } from "@/lib/utils";

const compactProvider = /[^a-z0-9]/g;
const iconMap: Record<string, ElementType> = {
  amazonbedrock: AwsAmazonBedrock,
  antgroup: Antgroup,
  anthropic: Anthropic,
  antling: Antgroup,
  azure: Azure,
  azureai: Azure,
  azureopenai: Azure,
  azureopenairesponses: Azure,
  baseten: Baseten,
  bedrock: AwsAmazonBedrock,
  cerebras: Cerebras,
  cloudflare: Cloudflare,
  cloudflareaigateway: Cloudflare,
  cloudflareworkersai: Cloudflare,
  deepseek: Deepseek,
  doubao: Doubao,
  fireworks: Fireworks,
  fireworksai: Fireworks,
  gemini: Gemini,
  github: Github,
  githubcopilot: GithubCopilot,
  google: Google,
  googlevertex: VertexaiGoogle,
  groq: Groq,
  huggingface: HuggingFace,
  kimi: Kimi,
  kimicoding: Kimi,
  meta: Meta,
  minimax: Minimax,
  minimaxcn: Minimax,
  mistral: MistralAi,
  moonshot: MoonshotAi,
  moonshotai: MoonshotAi,
  moonshotaicn: MoonshotAi,
  nvidia: Nvidia,
  ollama: Ollama,
  ollamacloud: Ollama,
  openai: Openai,
  openaicodex: Openai,
  opencode: Opencode,
  opencodego: Opencode,
  openrouter: Openrouter,
  qwen: Qwen,
  qwentokenplan: Qwen,
  qwentokenplancn: Qwen,
  qwentokenplanindividual: Qwen,
  siliconcloud: SiliconcloudSiliconflow,
  siliconflow: SiliconcloudSiliconflow,
  together: Togetherdotai,
  togetherai: Togetherdotai,
  vercel: Vercel,
  vercelaigateway: Vercel,
  vertexai: VertexaiGoogle,
  volcengine: Volcengine,
  xai: Xai,
  xiaomi: Xiaomi,
  xiaomitokenplanams: Xiaomi,
  xiaomitokenplancn: Xiaomi,
  xiaomitokenplansgp: Xiaomi,
  zai: Zhipu,
  zaicodingcn: Zhipu,
  zhipu: Zhipu,
  zhipuai: Zhipu,
};

function resolveIconKey(provider?: string): string | undefined {
  if (!provider) {
    return undefined;
  }
  return provider.toLowerCase().replace(compactProvider, "");
}

// Icons whose default variant is fully monochrome via currentColor accept the
// "mono" variant. These providers have no mono variant, so use another variant
// that the package renders entirely with currentColor.
const variantOverrides: Record<string, string> = {
  groq: "wordmarkLight",
  kimi: "wordmarkLight",
  kimicoding: "wordmarkLight",
  openai: "light",
  openaicodex: "light",
  qwen: "light",
  qwentokenplan: "light",
  qwentokenplancn: "light",
  qwentokenplanindividual: "light",
};

// These default variants hardcode brand fills on child nodes; CSS overrides
// every fill with currentColor so the glyph stays black/white in both themes.
const forceMonoIcons = new Set([
  "amazonbedrock",
  "anthropic",
  "azure",
  "azureai",
  "azureopenai",
  "azureopenairesponses",
  "bedrock",
  "deepseek",
  "gemini",
]);

function providerInitial(provider?: string): string {
  return provider?.trim().charAt(0).toUpperCase() || "?";
}

function ProviderGlyph({
  provider,
  className,
  size,
}: {
  provider?: string;
  className?: string;
  size: number;
}) {
  const key = resolveIconKey(provider);
  const icon = key ? iconMap[key] : undefined;
  const radius = Math.max(3, Math.round(size * 0.28));
  const sharedStyle = { borderRadius: radius, height: size, width: size };
  if (!icon) {
    return (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center bg-foreground font-semibold text-background",
          className
        )}
        style={sharedStyle}
      >
        {providerInitial(provider)}
      </span>
    );
  }
  const Glyph = icon as ComponentType<{
    fill?: string;
    height?: number;
    style?: CSSProperties;
    variant?: string;
    width?: number;
  }>;
  const glyphSize = Math.round(size * 0.78);
  const forceMono = key ? forceMonoIcons.has(key) : false;
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center text-foreground",
        forceMono && "[&_svg]:fill-current [&_svg_*]:fill-current",
        className
      )}
      style={sharedStyle}
    >
      <Glyph
        fill="currentColor"
        height={glyphSize}
        style={{ color: "currentColor" }}
        variant={(key && variantOverrides[key]) ?? "mono"}
        width={glyphSize}
      />
    </span>
  );
}

export function ProviderIcon({
  provider,
  className,
  size = 14,
}: {
  provider?: string;
  className?: string;
  size?: number;
}) {
  return (
    <ProviderGlyph className={className} provider={provider} size={size} />
  );
}

export function ProviderAvatar({
  provider,
  className,
  size = 28,
}: {
  provider?: string;
  className?: string;
  size?: number;
}) {
  return (
    <ProviderGlyph className={className} provider={provider} size={size} />
  );
}
