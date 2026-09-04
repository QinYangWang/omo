import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

export type Theme = "dark" | "light" | "system";
export type OverrideMode = "dark" | "light" | "shared";

/** Custom theme overrides per mode, keyed by CSS custom property name. */
export interface ThemeOverrides {
  dark: Record<string, string>;
  light: Record<string, string>;
  /** Mode-independent tokens (e.g. typeset typography). */
  shared: Record<string, string>;
}

const THEME_KEY = "omo:theme";
const OVERRIDES_KEY = "omo:theme-overrides";
const STYLE_ID = "omo-theme-overrides";
const emptyOverrides: ThemeOverrides = { dark: {}, light: {}, shared: {} };

const stored = localStorage.getItem(THEME_KEY);
const initial: Theme =
  stored === "light" || stored === "system" ? stored : "dark";

function loadOverrides(): ThemeOverrides {
  try {
    const raw = localStorage.getItem(OVERRIDES_KEY);
    if (!raw) {
      return emptyOverrides;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return emptyOverrides;
    }
    const record = parsed as Record<string, unknown>;
    const bucket = (value: unknown): Record<string, string> => {
      if (typeof value !== "object" || value === null) {
        return {};
      }
      const result: Record<string, string> = {};
      for (const [key, item] of Object.entries(
        value as Record<string, unknown>
      )) {
        if (key.startsWith("--") && typeof item === "string") {
          result[key] = item;
        }
      }
      return result;
    };
    return {
      dark: bucket(record.dark),
      light: bucket(record.light),
      shared: bucket(record.shared),
    };
  } catch {
    return emptyOverrides;
  }
}

function isTypesetToken(name: string) {
  return name.startsWith("--typeset-");
}

function declarations(values: Record<string, string>) {
  return Object.entries(values)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");
}

/** Render overrides as a stylesheet following the same cascade as index.css. */
export function exportThemeCss(overrides: ThemeOverrides): string {
  const sharedRoot: Record<string, string> = {};
  const typeset: Record<string, string> = {};
  for (const [name, value] of Object.entries(overrides.shared)) {
    (isTypesetToken(name) ? typeset : sharedRoot)[name] = value;
  }
  const blocks = [
    `:root {\n${declarations({ ...sharedRoot, ...overrides.light })}\n}`,
    `.dark {\n${declarations(overrides.dark)}\n}`,
  ];
  if (Object.keys(typeset).length) {
    blocks.push(`.typeset-docs {\n${declarations(typeset)}\n}`);
  }
  return blocks.join("\n\n");
}

const blockPattern = /([^{}]+)\{([^{}]*)\}/g;
const declarationPattern = /(--[\w-]+)\s*:\s*([^;]+);?/g;
const rootSelectorPattern = /(^|,)\s*:root\s*$/;
const darkSelectorPattern = /(^|,)\s*\.dark\s*$/;

/** Which override bucket a parsed declaration belongs to. */
function bucketFor(
  name: string,
  result: ThemeOverrides,
  isDark: boolean,
  isTypeset: boolean
): Record<string, string> {
  if (isTypesetToken(name)) {
    return result.shared;
  }
  if (isDark) {
    return result.dark;
  }
  if (isTypeset) {
    return result.shared;
  }
  return result.light;
}

/**
 * Parse a pasted shadcn / tweakcn / typeset theme into overrides.
 * `:root` fills light mode, `.dark` fills dark mode, typeset tokens are
 * shared. CSS without known selectors applies to the current mode.
 */
export function parseThemeCss(
  css: string,
  currentMode: "dark" | "light"
): ThemeOverrides {
  const result: ThemeOverrides = { dark: {}, light: {}, shared: {} };
  let matchedKnownBlock = false;
  for (const [_fullMatch, selectorBody, body] of css.matchAll(blockPattern)) {
    const selector = selectorBody.trim();
    const isRoot = rootSelectorPattern.test(selector) || selector === ":root";
    const isDark = darkSelectorPattern.test(selector);
    const isTypeset = selector.includes(".typeset-docs");
    if (!(isRoot || isDark || isTypeset)) {
      continue;
    }
    matchedKnownBlock = true;
    for (const decl of body.matchAll(declarationPattern)) {
      const [, name, value] = decl;
      const target = bucketFor(name, result, isDark, isTypeset);
      target[name] = value.trim();
    }
  }
  if (!matchedKnownBlock) {
    for (const decl of css.matchAll(declarationPattern)) {
      const [, name, value] = decl;
      if (isTypesetToken(name)) {
        result.shared[name] = value.trim();
      } else {
        result[currentMode][name] = value.trim();
      }
    }
  }
  return result;
}

export function countOverrides(overrides: ThemeOverrides) {
  return (
    Object.keys(overrides.dark).length +
    Object.keys(overrides.light).length +
    Object.keys(overrides.shared).length
  );
}

function applyOverridesStyle(overrides: ThemeOverrides) {
  let element = document.getElementById(STYLE_ID);
  if (!element) {
    element = document.createElement("style");
    element.id = STYLE_ID;
    document.head.append(element);
  }
  element.textContent =
    countOverrides(overrides) > 0 ? exportThemeCss(overrides) : "";
}

interface ThemeContextValue {
  importCss: (css: string) => number;
  overrides: ThemeOverrides;
  resetOverrides: (mode?: OverrideMode) => void;
  resolvedTheme: "dark" | "light";
  setOverride: (name: string, value: string | null, mode: OverrideMode) => void;
  setTheme: (t: Theme) => void;
  theme: Theme;
}

const ThemeContext = createContext<ThemeContextValue>({
  importCss: () => 0,
  overrides: emptyOverrides,
  resetOverrides: () => undefined,
  resolvedTheme: "dark",
  setOverride: () => undefined,
  setTheme: () => undefined,
  theme: "dark",
});

function apply(theme: Theme) {
  const dark =
    theme === "dark" ||
    (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initial);
  const [overrides, setOverrides] = useState<ThemeOverrides>(loadOverrides);
  const resolvedTheme: "dark" | "light" =
    theme === "dark" ||
    (theme === "system" &&
      typeof matchMedia !== "undefined" &&
      matchMedia("(prefers-color-scheme: dark)").matches)
      ? "dark"
      : "light";

  useEffect(() => {
    apply(theme);
    localStorage.setItem(THEME_KEY, theme);
    if (theme !== "system") {
      return;
    }
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  useEffect(() => {
    applyOverridesStyle(overrides);
    if (countOverrides(overrides) > 0) {
      localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides));
    } else {
      localStorage.removeItem(OVERRIDES_KEY);
    }
  }, [overrides]);

  const setOverride = (
    name: string,
    value: string | null,
    mode: OverrideMode
  ) => {
    setOverrides((current) => {
      const bucket = { ...current[mode] };
      if (value === null || value === "") {
        delete bucket[name];
      } else {
        bucket[name] = value;
      }
      return { ...current, [mode]: bucket };
    });
  };

  const importCss = (css: string) => {
    const parsed = parseThemeCss(css, resolvedTheme);
    const count = countOverrides(parsed);
    if (count > 0) {
      setOverrides((current) => ({
        dark: { ...current.dark, ...parsed.dark },
        light: { ...current.light, ...parsed.light },
        shared: { ...current.shared, ...parsed.shared },
      }));
    }
    return count;
  };

  const resetOverrides = (mode?: OverrideMode) => {
    setOverrides((current) =>
      mode ? { ...current, [mode]: {} } : emptyOverrides
    );
  };

  return (
    <ThemeContext.Provider
      value={{
        importCss,
        overrides,
        resetOverrides,
        resolvedTheme,
        setOverride,
        setTheme,
        theme,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
