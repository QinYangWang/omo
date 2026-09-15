/** Customizable theme tokens shown in Settings → Appearance. */

export interface SliderMeta {
  max: number;
  min: number;
  step: number;
}

export interface TokenMeta {
  /** Fallback value used when the computed value is unavailable. */
  fallback?: string;
  name: string;
  /** "shared" tokens (typeset) apply to both modes. */
  shared?: boolean;
  /** Numeric tokens get a slider editor. */
  slider?: SliderMeta;
}

export interface TokenGroup {
  key: string;
  tokens: TokenMeta[];
}

export const themeTokenGroups: TokenGroup[] = [
  {
    key: "theme_group_surface",
    tokens: [
      { name: "--background" },
      { name: "--foreground" },
      { name: "--card" },
      { name: "--card-foreground" },
      { name: "--popover" },
      { name: "--popover-foreground" },
      { name: "--code" },
      { name: "--code-foreground" },
      { name: "--code-highlight" },
    ],
  },
  {
    key: "theme_group_brand",
    tokens: [
      { name: "--primary" },
      { name: "--primary-foreground" },
      { name: "--secondary" },
      { name: "--secondary-foreground" },
      { name: "--accent" },
      { name: "--accent-foreground" },
      { name: "--muted" },
      { name: "--muted-foreground" },
      { name: "--destructive" },
      { name: "--destructive-foreground" },
    ],
  },
  {
    key: "theme_group_controls",
    tokens: [
      { name: "--border" },
      { name: "--input" },
      { name: "--ring" },
      {
        fallback: "0.375rem",
        name: "--radius",
        slider: { max: 2, min: 0, step: 0.125 },
      },
    ],
  },
  {
    key: "theme_group_sidebar",
    tokens: [
      { name: "--sidebar" },
      { name: "--sidebar-foreground" },
      { name: "--sidebar-primary" },
      { name: "--sidebar-primary-foreground" },
      { name: "--sidebar-accent" },
      { name: "--sidebar-accent-foreground" },
      { name: "--sidebar-border" },
      { name: "--sidebar-ring" },
    ],
  },
  {
    key: "theme_group_panels",
    tokens: [
      { name: "--panel" },
      { name: "--surface" },
      { name: "--window-background" },
      { name: "--window-panel" },
      { name: "--window-control" },
    ],
  },
  {
    key: "theme_group_status",
    tokens: [
      { name: "--info" },
      { name: "--info-foreground" },
      { name: "--success" },
      { name: "--success-foreground" },
      { name: "--warning" },
      { name: "--warning-foreground" },
    ],
  },
  {
    key: "theme_group_charts",
    tokens: [
      { name: "--chart-1" },
      { name: "--chart-2" },
      { name: "--chart-3" },
      { name: "--chart-4" },
      { name: "--chart-5" },
    ],
  },
  {
    key: "theme_group_typography",
    tokens: [
      {
        fallback: "var(--font-geist)",
        name: "--typeset-font-body",
        shared: true,
      },
      {
        fallback: "var(--font-geist)",
        name: "--typeset-font-heading",
        shared: true,
      },
      {
        fallback: "var(--font-geist-mono)",
        name: "--typeset-font-mono",
        shared: true,
      },
      {
        fallback: "15px",
        name: "--typeset-size",
        shared: true,
        slider: { max: 20, min: 12, step: 0.5 },
      },
      {
        fallback: "1.75",
        name: "--typeset-leading",
        shared: true,
        slider: { max: 2.2, min: 1.2, step: 0.05 },
      },
      {
        fallback: "1.25em",
        name: "--typeset-flow",
        shared: true,
        slider: { max: 3, min: 0.5, step: 0.125 },
      },
    ],
  },
];

const colorValue = /^(#|oklch|oklab|hsla?\(|rgba?\(|color\(|var\()/i;
const rgbTriplet =
  /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,/\s]+([\d.]+))?\s*\)$/i;
const oklchPattern =
  /^oklch\(\s*([\d.]+)%?\s+([\d.]+)%?\s+([\d.]+)(?:\s*\/\s*[\d.]+%?)?\s*\)$/i;

/** Convert oklch to #rrggbb (canvas serializes oklch verbatim). */
function oklchToHex(lightness: number, chroma: number, hue: number): string {
  const l = lightness > 1 ? lightness / 100 : lightness;
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const l3 = (l + 0.396_337_777_4 * a + 0.215_803_757_3 * b) ** 3;
  const m3 = (l - 0.105_561_345_8 * a - 0.063_854_172_8 * b) ** 3;
  const s3 = (l - 0.089_484_177_5 * a - 1.291_485_548 * b) ** 3;
  const x = 1.227_013_851_1 * l3 - 0.557_799_980_7 * m3 + 0.281_256_149 * s3;
  const y = -0.040_580_178_4 * l3 + 1.112_256_869_6 * m3 - 0.071_676_678_7 * s3;
  const z = -0.076_381_284_5 * l3 - 0.421_481_978_4 * m3 + 1.586_163_220_4 * s3;
  const gamma = (v: number) => {
    const clamped = Math.min(1, Math.max(0, v));
    return clamped <= 0.003_130_8
      ? 12.92 * clamped
      : 1.055 * clamped ** (1 / 2.4) - 0.055;
  };
  const channels = [
    3.240_969_941_9 * x - 1.537_383_177_6 * y - 0.498_610_760_3 * z,
    -0.969_243_636_3 * x + 1.875_967_501_5 * y + 0.041_555_057_4 * z,
    0.055_630_079_7 * x - 0.203_976_958_9 * y + 1.056_971_514_2 * z,
  ];
  return `#${channels
    .map((v) =>
      Math.round(gamma(v) * 255)
        .toString(16)
        .padStart(2, "0")
    )
    .join("")}`;
}

export function looksLikeColor(value: string) {
  return colorValue.test(value.trim());
}

let colorContext: CanvasRenderingContext2D | null | undefined;

/**
 * Normalize any CSS color (oklch, hsl, rgb, hex, named) to #rrggbb or
 * #rrggbbaa using the browser's color parser (with a manual oklch fallback).
 * Returns null when the value cannot be resolved (e.g. var() references).
 */
export function normalizeColorToHex(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.startsWith("var(")) {
    return null;
  }
  try {
    if (colorContext === undefined) {
      colorContext = document.createElement("canvas").getContext("2d");
    }
    if (!colorContext) {
      return null;
    }
    colorContext.fillStyle = "#000000";
    colorContext.fillStyle = trimmed;
    const serialized = String(colorContext.fillStyle);
    if (serialized.startsWith("#")) {
      return serialized;
    }
    const match = rgbTriplet.exec(serialized);
    if (match) {
      const hex = [match[1], match[2], match[3]]
        .map((part) => Number(part).toString(16).padStart(2, "0"))
        .join("");
      if (match[4] !== undefined) {
        const alpha = Math.round(Number(match[4]) * 255)
          .toString(16)
          .padStart(2, "0");
        return `#${hex}${alpha}`;
      }
      return `#${hex}`;
    }
    // Canvas serializes oklch() verbatim; convert to sRGB ourselves.
    const oklch = oklchPattern.exec(serialized);
    if (oklch) {
      return oklchToHex(Number(oklch[1]), Number(oklch[2]), Number(oklch[3]));
    }
    return null;
  } catch {
    return null;
  }
}

const numericValue = /^(-?\d+(?:\.\d+)?)(px|rem|em|%)?$/;

export function parseNumericValue(
  value: string
): { num: number; unit: string } | null {
  const match = numericValue.exec(value.trim());
  if (!match) {
    return null;
  }
  return { num: Number(match[1]), unit: match[2] ?? "" };
}
