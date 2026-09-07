import { SparklesIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import AntGroupMono from "@lobehub/icons/es/AntGroup/components/Mono";
import AnthropicMono from "@lobehub/icons/es/Anthropic/components/Mono";
import AzureColor from "@lobehub/icons/es/Azure/components/Color";
import AzureMono from "@lobehub/icons/es/Azure/components/Mono";
import BasetenMono from "@lobehub/icons/es/Baseten/components/Mono";
import BedrockMono from "@lobehub/icons/es/Bedrock/components/Mono";
import CerebrasMono from "@lobehub/icons/es/Cerebras/components/Mono";
import CloudflareMono from "@lobehub/icons/es/Cloudflare/components/Mono";
import DeepSeekMono from "@lobehub/icons/es/DeepSeek/components/Mono";
import DoubaoColor from "@lobehub/icons/es/Doubao/components/Color";
import DoubaoMono from "@lobehub/icons/es/Doubao/components/Mono";
import FireworksMono from "@lobehub/icons/es/Fireworks/components/Mono";
import GeminiColor from "@lobehub/icons/es/Gemini/components/Color";
import GeminiMono from "@lobehub/icons/es/Gemini/components/Mono";
import GithubMono from "@lobehub/icons/es/Github/components/Mono";
import GithubCopilotMono from "@lobehub/icons/es/GithubCopilot/components/Mono";
import GoogleColor from "@lobehub/icons/es/Google/components/Color";
import GoogleMono from "@lobehub/icons/es/Google/components/Mono";
import GroqMono from "@lobehub/icons/es/Groq/components/Mono";
import HuggingFaceColor from "@lobehub/icons/es/HuggingFace/components/Color";
import HuggingFaceMono from "@lobehub/icons/es/HuggingFace/components/Mono";
import KimiColor from "@lobehub/icons/es/Kimi/components/Color";
import KimiMono from "@lobehub/icons/es/Kimi/components/Mono";
import MetaMono from "@lobehub/icons/es/Meta/components/Mono";
import MinimaxMono from "@lobehub/icons/es/Minimax/components/Mono";
import MistralMono from "@lobehub/icons/es/Mistral/components/Mono";
import MoonshotMono from "@lobehub/icons/es/Moonshot/components/Mono";
import NvidiaMono from "@lobehub/icons/es/Nvidia/components/Mono";
import OllamaMono from "@lobehub/icons/es/Ollama/components/Mono";
import OpenAIMono from "@lobehub/icons/es/OpenAI/components/Mono";
import OpenCodeMono from "@lobehub/icons/es/OpenCode/components/Mono";
import OpenRouterMono from "@lobehub/icons/es/OpenRouter/components/Mono";
import QwenMono from "@lobehub/icons/es/Qwen/components/Mono";
import SiliconCloudMono from "@lobehub/icons/es/SiliconCloud/components/Mono";
import TogetherColor from "@lobehub/icons/es/Together/components/Color";
import TogetherMono from "@lobehub/icons/es/Together/components/Mono";
import type { IconType } from "@lobehub/icons/es/types";
import VercelMono from "@lobehub/icons/es/Vercel/components/Mono";
import VertexAIMono from "@lobehub/icons/es/VertexAI/components/Mono";
import VolcengineColor from "@lobehub/icons/es/Volcengine/components/Color";
import VolcengineMono from "@lobehub/icons/es/Volcengine/components/Mono";
import XAIMono from "@lobehub/icons/es/XAI/components/Mono";
import ZAIMono from "@lobehub/icons/es/ZAI/components/Mono";
import ZhipuMono from "@lobehub/icons/es/Zhipu/components/Mono";
import { cn } from "@/lib/utils";

interface IconEntry {
  /**
   * Avatar tile background (solid color or CSS gradient), ported from the
   * icon's style.js (AVATAR_BACKGROUND) so tiles stay readable in both
   * light and dark themes.
   */
  avatarBg: string;
  /** Glyph color on the avatar tile (AVATAR_COLOR). */
  avatarColor: string;
  /** Icon scale inside the avatar tile (AVATAR_ICON_MULTIPLE). */
  avatarMultiple: number;
  /**
   * Brand-color glyph for the avatar tile. Only present for icons whose
   * official lobe avatar uses the Color variant (Azure, Doubao, Gemini,
   * Google, HuggingFace, Kimi, Together, Volcengine); every other icon
   * renders its mono variant in avatarColor, which is guaranteed to
   * contrast with the tile background.
   */
  colorGlyph?: IconType;
  mono: IconType;
}

const compactProvider = /[^a-z0-9]/g;

// Map pi/omo provider ids to @lobehub/icons components. Keys are the
// lowercase id with all non-alphanumerics removed.
const iconMap: Record<string, IconEntry> = {
  amazonbedrock: {
    avatarBg: "linear-gradient(45deg, #9AD8F8, #3D8FFF, #6350FB)",
    avatarColor: "#fff",
    avatarMultiple: 0.75,
    mono: BedrockMono,
  },
  antgroup: {
    avatarBg: "#1677ff",
    avatarColor: "#fff",
    avatarMultiple: 0.8,
    mono: AntGroupMono,
  },
  anthropic: {
    avatarBg: "#F1F0E8",
    avatarColor: "#141413",
    avatarMultiple: 0.75,
    mono: AnthropicMono,
  },
  antling: {
    avatarBg: "#1677ff",
    avatarColor: "#fff",
    avatarMultiple: 0.8,
    mono: AntGroupMono,
  },
  azure: {
    avatarBg: "#fff",
    avatarColor: "#fff",
    avatarMultiple: 0.7,
    colorGlyph: AzureColor,
    mono: AzureMono,
  },
  azureai: {
    avatarBg: "#fff",
    avatarColor: "#fff",
    avatarMultiple: 0.7,
    colorGlyph: AzureColor,
    mono: AzureMono,
  },
  azureopenai: {
    avatarBg: "#fff",
    avatarColor: "#fff",
    avatarMultiple: 0.7,
    colorGlyph: AzureColor,
    mono: AzureMono,
  },
  azureopenairesponses: {
    avatarBg: "#fff",
    avatarColor: "#fff",
    avatarMultiple: 0.7,
    colorGlyph: AzureColor,
    mono: AzureMono,
  },
  baseten: {
    avatarBg: "#19E76E",
    avatarColor: "#000",
    avatarMultiple: 0.65,
    mono: BasetenMono,
  },
  bedrock: {
    avatarBg: "linear-gradient(45deg, #9AD8F8, #3D8FFF, #6350FB)",
    avatarColor: "#fff",
    avatarMultiple: 0.75,
    mono: BedrockMono,
  },
  cerebras: {
    avatarBg: "#F15A29",
    avatarColor: "#fff",
    avatarMultiple: 0.8,
    mono: CerebrasMono,
  },
  cloudflare: {
    avatarBg: "#F38020",
    avatarColor: "#fff",
    avatarMultiple: 0.75,
    mono: CloudflareMono,
  },
  cloudflareaigateway: {
    avatarBg: "#F38020",
    avatarColor: "#fff",
    avatarMultiple: 0.75,
    mono: CloudflareMono,
  },
  cloudflareworkersai: {
    avatarBg: "#F38020",
    avatarColor: "#fff",
    avatarMultiple: 0.75,
    mono: CloudflareMono,
  },
  deepseek: {
    avatarBg: "#4D6BFE",
    avatarColor: "#fff",
    avatarMultiple: 0.75,
    mono: DeepSeekMono,
  },
  doubao: {
    avatarBg: "#FFF",
    avatarColor: "#fff",
    avatarMultiple: 0.75,
    colorGlyph: DoubaoColor,
    mono: DoubaoMono,
  },
  fireworks: {
    avatarBg: "#5019C5",
    avatarColor: "#000",
    avatarMultiple: 0.75,
    mono: FireworksMono,
  },
  fireworksai: {
    avatarBg: "#5019C5",
    avatarColor: "#000",
    avatarMultiple: 0.75,
    mono: FireworksMono,
  },
  gemini: {
    avatarBg: "#fff",
    avatarColor: "#fff",
    avatarMultiple: 0.8,
    colorGlyph: GeminiColor,
    mono: GeminiMono,
  },
  github: {
    avatarBg: "#000",
    avatarColor: "#fff",
    avatarMultiple: 0.75,
    mono: GithubMono,
  },
  githubcopilot: {
    avatarBg: "#000",
    avatarColor: "#fff",
    avatarMultiple: 0.75,
    mono: GithubCopilotMono,
  },
  google: {
    avatarBg: "#fff",
    avatarColor: "#fff",
    avatarMultiple: 0.75,
    colorGlyph: GoogleColor,
    mono: GoogleMono,
  },
  googlevertex: {
    avatarBg: "#4285F4",
    avatarColor: "#fff",
    avatarMultiple: 0.6,
    mono: VertexAIMono,
  },
  groq: {
    avatarBg: "#F55036",
    avatarColor: "#fff",
    avatarMultiple: 0.75,
    mono: GroqMono,
  },
  huggingface: {
    avatarBg: "#fff",
    avatarColor: "#fff",
    avatarMultiple: 0.75,
    colorGlyph: HuggingFaceColor,
    mono: HuggingFaceMono,
  },
  kimi: {
    avatarBg: "#000",
    avatarColor: "#fff",
    avatarMultiple: 0.6,
    colorGlyph: KimiColor,
    mono: KimiMono,
  },
  kimicoding: {
    avatarBg: "#000",
    avatarColor: "#fff",
    avatarMultiple: 0.6,
    colorGlyph: KimiColor,
    mono: KimiMono,
  },
  kimicodingplan: {
    avatarBg: "#000",
    avatarColor: "#fff",
    avatarMultiple: 0.6,
    colorGlyph: KimiColor,
    mono: KimiMono,
  },
  meta: {
    avatarBg: "linear-gradient(45deg, #007FF8, #0668E1, #007FF8)",
    avatarColor: "#fff",
    avatarMultiple: 0.75,
    mono: MetaMono,
  },
  minimax: {
    avatarBg: "linear-gradient(to right, #E2167E, #FE603C)",
    avatarColor: "#fff",
    avatarMultiple: 0.75,
    mono: MinimaxMono,
  },
  minimaxcn: {
    avatarBg: "linear-gradient(to right, #E2167E, #FE603C)",
    avatarColor: "#fff",
    avatarMultiple: 0.75,
    mono: MinimaxMono,
  },
  mistral: {
    avatarBg: "#FA520F",
    avatarColor: "#fff",
    avatarMultiple: 0.75,
    mono: MistralMono,
  },
  moonshot: {
    avatarBg: "#16191E",
    avatarColor: "#fff",
    avatarMultiple: 0.75,
    mono: MoonshotMono,
  },
  moonshotai: {
    avatarBg: "#16191E",
    avatarColor: "#fff",
    avatarMultiple: 0.75,
    mono: MoonshotMono,
  },
  moonshotaicn: {
    avatarBg: "#16191E",
    avatarColor: "#fff",
    avatarMultiple: 0.75,
    mono: MoonshotMono,
  },
  nvidia: {
    avatarBg: "#74B71B",
    avatarColor: "#fff",
    avatarMultiple: 0.75,
    mono: NvidiaMono,
  },
  ollama: {
    avatarBg: "#fff",
    avatarColor: "#000",
    avatarMultiple: 0.75,
    mono: OllamaMono,
  },
  ollamacloud: {
    avatarBg: "#fff",
    avatarColor: "#000",
    avatarMultiple: 0.75,
    mono: OllamaMono,
  },
  openai: {
    avatarBg: "#000",
    avatarColor: "#fff",
    avatarMultiple: 0.75,
    mono: OpenAIMono,
  },
  openaicodex: {
    avatarBg: "#000",
    avatarColor: "#fff",
    avatarMultiple: 0.75,
    mono: OpenAIMono,
  },
  opencode: {
    avatarBg: "#000",
    avatarColor: "#fff",
    avatarMultiple: 0.75,
    mono: OpenCodeMono,
  },
  opencodego: {
    avatarBg: "#000",
    avatarColor: "#fff",
    avatarMultiple: 0.75,
    mono: OpenCodeMono,
  },
  openrouter: {
    avatarBg: "#000",
    avatarColor: "#C8FF00",
    avatarMultiple: 0.75,
    mono: OpenRouterMono,
  },
  qwen: {
    avatarBg: "#615ced",
    avatarColor: "#fff",
    avatarMultiple: 0.75,
    mono: QwenMono,
  },
  qwentokenplan: {
    avatarBg: "#615ced",
    avatarColor: "#fff",
    avatarMultiple: 0.75,
    mono: QwenMono,
  },
  qwentokenplancn: {
    avatarBg: "#615ced",
    avatarColor: "#fff",
    avatarMultiple: 0.75,
    mono: QwenMono,
  },
  qwentokenplanindividual: {
    avatarBg: "#615ced",
    avatarColor: "#fff",
    avatarMultiple: 0.75,
    mono: QwenMono,
  },
  siliconcloud: {
    avatarBg: "#6E29F6",
    avatarColor: "#fff",
    avatarMultiple: 0.7,
    mono: SiliconCloudMono,
  },
  together: {
    avatarBg: "#fff",
    avatarColor: "#000",
    avatarMultiple: 0.75,
    colorGlyph: TogetherColor,
    mono: TogetherMono,
  },
  togetherai: {
    avatarBg: "#fff",
    avatarColor: "#000",
    avatarMultiple: 0.75,
    colorGlyph: TogetherColor,
    mono: TogetherMono,
  },
  vercel: {
    avatarBg: "#000",
    avatarColor: "#fff",
    avatarMultiple: 0.6,
    mono: VercelMono,
  },
  vercelaigateway: {
    avatarBg: "#000",
    avatarColor: "#fff",
    avatarMultiple: 0.6,
    mono: VercelMono,
  },
  vertexai: {
    avatarBg: "#4285F4",
    avatarColor: "#fff",
    avatarMultiple: 0.6,
    mono: VertexAIMono,
  },
  volcengine: {
    avatarBg: "#fff",
    avatarColor: "#fff",
    avatarMultiple: 0.75,
    colorGlyph: VolcengineColor,
    mono: VolcengineMono,
  },
  xai: {
    avatarBg: "#fff",
    avatarColor: "#000",
    avatarMultiple: 0.65,
    mono: XAIMono,
  },
  zai: {
    avatarBg: "#000",
    avatarColor: "#fff",
    avatarMultiple: 0.6,
    mono: ZAIMono,
  },
  zaicodingcn: {
    avatarBg: "#000",
    avatarColor: "#fff",
    avatarMultiple: 0.6,
    mono: ZAIMono,
  },
  zhipu: {
    avatarBg: "#3859FF",
    avatarColor: "#fff",
    avatarMultiple: 0.75,
    mono: ZhipuMono,
  },
  zhipuai: {
    avatarBg: "#3859FF",
    avatarColor: "#fff",
    avatarMultiple: 0.75,
    mono: ZhipuMono,
  },
};

function resolveIcon(provider?: string): IconEntry | undefined {
  if (!provider) {
    return undefined;
  }
  const key = provider.toLowerCase();
  return iconMap[key] ?? iconMap[key.replace(compactProvider, "")];
}

/**
 * Provider glyph on a fixed brand tile. The tile keeps the same background
 * in light and dark themes (like the official lobe avatars), so the glyph
 * never blends into the page background.
 */
function ProviderTile({
  provider,
  className,
  size,
}: {
  provider?: string;
  className?: string;
  size: number;
}) {
  const entry = resolveIcon(provider);
  const radius = Math.max(3, Math.round(size * 0.28));
  if (!entry) {
    return (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center bg-muted text-muted-foreground",
          className
        )}
        style={{ borderRadius: radius, height: size, width: size }}
      >
        <HugeiconsIcon
          icon={SparklesIcon}
          style={{ height: size * 0.6, width: size * 0.6 }}
        />
      </span>
    );
  }
  const Glyph = entry.colorGlyph ?? entry.mono;
  return (
    <span
      className={cn("flex shrink-0 items-center justify-center", className)}
      style={{
        background: entry.avatarBg,
        borderRadius: radius,
        height: size,
        width: size,
      }}
    >
      <Glyph
        size={Math.round(size * entry.avatarMultiple)}
        style={entry.colorGlyph ? undefined : { color: entry.avatarColor }}
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
  return <ProviderTile className={className} provider={provider} size={size} />;
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
  return <ProviderTile className={className} provider={provider} size={size} />;
}
