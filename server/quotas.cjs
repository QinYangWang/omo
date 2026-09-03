"use strict";
/**
 * Provider subscription quota fetching, implemented in omo itself.
 *
 * Ported from @latentminds/pi-quotas (provider fetchers/parsers) and
 * omo-run's omo-usage extension (auth resolution). No external package
 * or tsx runtime required.
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FETCH_TIMEOUT_MS = 15_000;
const COPILOT_VERSION = "0.35.0";
const EDITOR_VERSION = "vscode/1.107.0";
const bearerPrefix = /^Bearer\s+/i;

const SUPPORTED_PROVIDERS = [
  "anthropic",
  "openai-codex",
  "github-copilot",
  "openrouter",
  "synthetic",
  "xai",
  "zai",
  "opencode-go",
  "kimi-coding",
  "ollama-cloud",
];

const PROVIDER_LABELS = {
  anthropic: "Anthropic",
  "openai-codex": "OpenAI Codex",
  "github-copilot": "GitHub Copilot",
  openrouter: "OpenRouter",
  synthetic: "Synthetic",
  xai: "Grok",
  zai: "Z.ai",
  "opencode-go": "OpenCode Go",
  "kimi-coding": "Kimi Code",
  "ollama-cloud": "Ollama Cloud",
};

const PROVIDER_TTLS_MS = {
  anthropic: 5 * 60_000,
  "openai-codex": 60_000,
  "github-copilot": 5 * 60_000,
  openrouter: 60_000,
  synthetic: 60_000,
  xai: 60_000,
  zai: 60_000,
  "opencode-go": 60_000,
  "kimi-coding": 60_000,
  "ollama-cloud": 60_000,
};

function safePercent(used, limit) {
  if (!(Number.isFinite(used) && Number.isFinite(limit)) || limit <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, (used / limit) * 100));
}

// ---------- parsers ----------

function parseDateish(value) {
  if (typeof value === "number") {
    const ms = value > 10 ** 11 ? value : value * 1000;
    return new Date(ms);
  }
  if (typeof value === "string") {
    return new Date(value);
  }
  return new Date(0);
}

function monthWindowSeconds(resetAt) {
  const approxStart = new Date(resetAt);
  approxStart.setMonth(approxStart.getMonth() - 1);
  return Math.max(1, Math.round((resetAt.getTime() - approxStart.getTime()) / 1000));
}

function parseAnthropicUsage(data) {
  const windows = [];
  if (data?.five_hour) {
    windows.push({
      label: "5h",
      usedPercent: Number(data.five_hour.utilization ?? 0),
      resetsAt: parseDateish(data.five_hour.resets_at),
      windowSeconds: 5 * 60 * 60,
      usedValue: Number(data.five_hour.utilization ?? 0),
      limitValue: 100,
    });
  }
  if (data?.seven_day) {
    windows.push({
      label: "7d",
      usedPercent: Number(data.seven_day.utilization ?? 0),
      resetsAt: parseDateish(data.seven_day.resets_at),
      windowSeconds: 7 * 24 * 60 * 60,
      usedValue: Number(data.seven_day.utilization ?? 0),
      limitValue: 100,
    });
  }
  const modelWindows = [
    ["seven_day_sonnet", "7d Sonnet"],
    ["seven_day_omelette", "7d Opus"],
    ["seven_day_opus", "7d Opus (legacy)"],
  ];
  for (const [key, label] of modelWindows) {
    const entry = data?.[key];
    if (entry && typeof entry === "object" && entry.utilization != null) {
      windows.push({
        label,
        usedPercent: Number(entry.utilization),
        resetsAt: parseDateish(entry.resets_at),
        windowSeconds: 7 * 24 * 60 * 60,
        usedValue: Number(entry.utilization),
        limitValue: 100,
      });
    }
  }
  const extra = data?.extra_usage;
  if (extra?.is_enabled && extra.monthly_limit > 0) {
    const limitDollars = extra.monthly_limit / 100;
    const usedDollars = (extra.used_credits ?? 0) / 100;
    const currency = extra.currency ?? "USD";
    windows.push({
      label: `Extra (${currency})`,
      usedPercent: Number(extra.utilization ?? safePercent(usedDollars, limitDollars)),
      resetsAt: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1),
      windowSeconds: 30 * 24 * 60 * 60,
      usedValue: usedDollars,
      limitValue: limitDollars,
      isCurrency: true,
    });
  }
  return windows;
}

function percentLeftToUsedPercent(limit) {
  if (limit?.percent_left != null) {
    return Math.max(0, 100 - Number(limit.percent_left));
  }
  if (limit?.remaining_percent != null) {
    return Math.max(0, 100 - Number(limit.remaining_percent));
  }
  if (limit?.used_percent != null) {
    return Number(limit.used_percent);
  }
  return 0;
}

function codexWindowSeconds(value, fallback) {
  const seconds = Number(value ?? fallback);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : fallback;
}

function codexWindowLabel(windowSeconds) {
  if (windowSeconds % (24 * 60 * 60) === 0) {
    return `${windowSeconds / (24 * 60 * 60)}d`;
  }
  if (windowSeconds % (60 * 60) === 0) {
    return `${windowSeconds / (60 * 60)}h`;
  }
  if (windowSeconds % 60 === 0) {
    return `${windowSeconds / 60}m`;
  }
  return `${windowSeconds}s`;
}

function parseCodexUsage(data) {
  const rateLimit = data?.rate_limit ?? data?.rate_limits ?? {};
  const primary =
    rateLimit.primary_window ??
    rateLimit.primary ??
    rateLimit.five_hour_limit ??
    rateLimit.five_hour;
  const secondary =
    rateLimit.secondary_window ??
    rateLimit.secondary ??
    rateLimit.weekly_limit ??
    rateLimit.weekly;
  const windows = [];
  if (primary) {
    const windowSeconds = codexWindowSeconds(primary.limit_window_seconds, 5 * 60 * 60);
    windows.push({
      label: codexWindowLabel(windowSeconds),
      usedPercent: percentLeftToUsedPercent(primary),
      resetsAt: parseDateish(primary.reset_at ?? primary.reset_time_ms),
      windowSeconds,
      usedValue: percentLeftToUsedPercent(primary),
      limitValue: 100,
    });
  }
  if (secondary) {
    const windowSeconds = codexWindowSeconds(
      secondary.limit_window_seconds,
      7 * 24 * 60 * 60
    );
    windows.push({
      label: codexWindowLabel(windowSeconds),
      usedPercent: percentLeftToUsedPercent(secondary),
      resetsAt: parseDateish(secondary.reset_at ?? secondary.reset_time_ms),
      windowSeconds,
      usedValue: percentLeftToUsedPercent(secondary),
      limitValue: 100,
    });
  }
  const credits = data?.credits;
  if (credits?.has_credits && credits.balance != null) {
    const balance = Number(credits.balance);
    windows.push({
      label: "Credits",
      usedPercent: 0,
      resetsAt: new Date(0),
      windowSeconds: 0,
      usedValue: balance,
      limitValue: balance,
      isCurrency: true,
    });
  }
  return windows;
}

function parseGitHubCopilotUsage(data) {
  const windows = [];
  const resetAt = parseDateish(
    data?.quota_reset_date ?? data?.quota_reset_date_utc ?? data?.limited_user_reset_date
  );
  const periodSeconds = monthWindowSeconds(resetAt);
  const snapshots = data?.quota_snapshots;
  if (snapshots && typeof snapshots === "object") {
    const mappings = [
      ["premium_interactions", "Premium / month"],
      ["chat", "Chat / month"],
      ["completions", "Completions / month"],
    ];
    for (const [key, label] of mappings) {
      const snap = snapshots[key];
      if (!snap || snap.unlimited) {
        continue;
      }
      const entitlement = Number(snap.entitlement ?? 0);
      const remaining = Number(snap.remaining ?? snap.quota_remaining ?? 0);
      if (entitlement <= 0) {
        continue;
      }
      windows.push({
        label,
        usedPercent: safePercent(entitlement - remaining, entitlement),
        resetsAt: resetAt,
        windowSeconds: periodSeconds,
        usedValue: entitlement - remaining,
        limitValue: entitlement,
      });
    }
    return windows;
  }
  if (data?.monthly_quotas && data?.limited_user_quotas) {
    for (const [key, label] of [
      ["chat", "Chat / month"],
      ["completions", "Completions / month"],
    ]) {
      const limitValue = Number(data.monthly_quotas[key] ?? 0);
      const remaining = Number(data.limited_user_quotas[key] ?? 0);
      if (limitValue <= 0) {
        continue;
      }
      windows.push({
        label,
        usedPercent: safePercent(limitValue - remaining, limitValue),
        resetsAt: resetAt,
        windowSeconds: periodSeconds,
        usedValue: limitValue - remaining,
        limitValue,
      });
    }
  }
  return windows;
}

function nextMidnightUTC() {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  );
}

function nextMondayUTC() {
  const now = new Date();
  const day = now.getUTCDay();
  const daysUntilMonday = day === 0 ? 1 : 8 - day;
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + daysUntilMonday
    )
  );
}

function nextMonthStartUTC() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

function parseOpenRouterUsage(data) {
  const windows = [];
  const keyData = data?.data;
  if (!keyData) {
    return windows;
  }
  const { limit } = keyData;
  const limitRemaining = keyData.limit_remaining;
  const usageDaily = keyData.usage_daily ?? 0;
  const usageWeekly = keyData.usage_weekly ?? 0;
  const usageMonthly = keyData.usage_monthly ?? 0;
  if (limit != null && limit > 0) {
    windows.push({
      label: "Monthly Budget",
      usedPercent: safePercent(usageMonthly, limit),
      resetsAt: nextMonthStartUTC(),
      windowSeconds: 30 * 24 * 60 * 60,
      usedValue: usageMonthly,
      limitValue: limit,
      isCurrency: true,
    });
  } else if (limitRemaining != null && limitRemaining >= 0) {
    windows.push({
      label: "Credits Remaining",
      usedPercent: 0,
      resetsAt: new Date(0),
      windowSeconds: 0,
      usedValue: limitRemaining,
      limitValue: limitRemaining,
      isCurrency: true,
    });
  }
  windows.push(
    {
      label: "Daily",
      usedPercent: 0,
      resetsAt: nextMidnightUTC(),
      windowSeconds: 24 * 60 * 60,
      usedValue: usageDaily,
      limitValue: 0,
      isCurrency: true,
    },
    {
      label: "Weekly",
      usedPercent: 0,
      resetsAt: nextMondayUTC(),
      windowSeconds: 7 * 24 * 60 * 60,
      usedValue: usageWeekly,
      limitValue: 0,
      isCurrency: true,
    },
    {
      label: "Monthly",
      usedPercent: 0,
      resetsAt: nextMonthStartUTC(),
      windowSeconds: 30 * 24 * 60 * 60,
      usedValue: usageMonthly,
      limitValue: 0,
      isCurrency: true,
    }
  );
  return windows;
}

function parseCurrency(value) {
  const n = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function parseSyntheticUsage(data) {
  const windows = [];
  if (data?.weeklyTokenLimit) {
    const limitValue = parseCurrency(data.weeklyTokenLimit.maxCredits);
    const remainingValue = parseCurrency(data.weeklyTokenLimit.remainingCredits);
    windows.push({
      label: "Credits / week",
      usedPercent: Math.max(
        0,
        Math.min(100, 100 - data.weeklyTokenLimit.percentRemaining)
      ),
      resetsAt: parseDateish(data.weeklyTokenLimit.nextRegenAt),
      windowSeconds: 24 * 60 * 60,
      usedValue: limitValue - remainingValue,
      limitValue,
      isCurrency: true,
    });
  }
  if (data?.rollingFiveHourLimit && data.rollingFiveHourLimit.max > 0) {
    const used = data.rollingFiveHourLimit.max - data.rollingFiveHourLimit.remaining;
    windows.push({
      label: "Requests / 5h",
      usedPercent: safePercent(used, data.rollingFiveHourLimit.max),
      resetsAt: parseDateish(data.rollingFiveHourLimit.nextTickAt),
      windowSeconds: 5 * 60 * 60,
      usedValue: Math.round(used),
      limitValue: data.rollingFiveHourLimit.max,
    });
  }
  if (data?.search?.hourly?.limit > 0) {
    windows.push({
      label: "Search / hour",
      usedPercent: safePercent(data.search.hourly.requests, data.search.hourly.limit),
      resetsAt: parseDateish(data.search.hourly.renewsAt),
      windowSeconds: 60 * 60,
      usedValue: data.search.hourly.requests,
      limitValue: data.search.hourly.limit,
    });
  }
  if (data?.freeToolCalls?.limit > 0) {
    windows.push({
      label: "Free Tool Calls / day",
      usedPercent: safePercent(data.freeToolCalls.requests, data.freeToolCalls.limit),
      resetsAt: parseDateish(data.freeToolCalls.renewsAt),
      windowSeconds: 24 * 60 * 60,
      usedValue: data.freeToolCalls.requests,
      limitValue: data.freeToolCalls.limit,
    });
  }
  return windows;
}

function parseOpenCodeGoUsage(data) {
  const windows = [];
  const entries = [
    ["rolling", "5h Rolling", 5 * 60 * 60],
    ["weekly", "Weekly", 7 * 24 * 60 * 60],
    ["monthly", "Monthly", 30 * 24 * 60 * 60],
  ];
  for (const [key, label, windowSeconds] of entries) {
    const entry = data?.[key];
    if (!entry) {
      continue;
    }
    windows.push({
      label,
      usedPercent: entry.usagePercent,
      resetsAt: new Date(entry.resetTimeIso),
      windowSeconds,
      usedValue: entry.usagePercent,
      limitValue: 100,
    });
  }
  return windows;
}

function parseKimiCodingUsage(data) {
  const windows = [];
  const weekly = data?.usage;
  if (weekly && typeof weekly === "object") {
    const limit = Number(weekly.limit ?? 0);
    const used = Number(weekly.used ?? 0);
    if (Number.isFinite(limit) && Number.isFinite(used) && limit > 0) {
      windows.push({
        label: "Weekly",
        usedPercent: safePercent(used, limit),
        resetsAt: parseDateish(weekly.resetTime),
        windowSeconds: 7 * 24 * 60 * 60,
        usedValue: used,
        limitValue: limit,
      });
    }
  }
  const limits = Array.isArray(data?.limits) ? data.limits : [];
  for (const entry of limits) {
    const detail = entry?.detail;
    const window = entry?.window;
    if (!(detail && window)) {
      continue;
    }
    const limit = Number(detail.limit ?? 0);
    const used = Number(detail.used ?? 0);
    const duration = Number(window.duration ?? 0);
    if (
      !(Number.isFinite(limit) && Number.isFinite(used) && Number.isFinite(duration)) ||
      limit <= 0 ||
      duration <= 0
    ) {
      continue;
    }
    let windowSeconds;
    let label;
    switch (window.timeUnit) {
      case "TIME_UNIT_SECOND":
        windowSeconds = duration;
        label = `${duration}s`;
        break;
      case "TIME_UNIT_MINUTE":
        windowSeconds = duration * 60;
        label = duration % 60 === 0 ? `${duration / 60}h` : `${duration}m`;
        break;
      case "TIME_UNIT_HOUR":
        windowSeconds = duration * 60 * 60;
        label = `${duration}h`;
        break;
      case "TIME_UNIT_DAY":
        windowSeconds = duration * 24 * 60 * 60;
        label = `${duration}d`;
        break;
      default:
        continue;
    }
    windows.push({
      label,
      usedPercent: safePercent(used, limit),
      resetsAt: parseDateish(detail.resetTime),
      windowSeconds,
      usedValue: used,
      limitValue: limit,
    });
  }
  windows.sort((a, b) => a.windowSeconds - b.windowSeconds);
  return windows;
}

// Z.ai GLM Coding Plan: unit 3 = HOUR, 6 = WEEK, 5 = MONTH (TIME_LIMIT only).
function parseZaiUsage(data) {
  const collected = [];
  const limits = data?.data?.limits ?? data?.limits ?? [];
  if (!Array.isArray(limits)) {
    return collected;
  }
  for (const entry of limits) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    if (entry.type === "TOKENS_LIMIT") {
      const count = Number(entry.number ?? 1) || 1;
      let label;
      let windowSeconds;
      switch (entry.unit) {
        case 3:
          label = `${count}h`;
          windowSeconds = count * 60 * 60;
          break;
        case 4:
          label = `${count}d`;
          windowSeconds = count * 24 * 60 * 60;
          break;
        case 6:
          label = `${count * 7}d`;
          windowSeconds = count * 7 * 24 * 60 * 60;
          break;
        default:
          label = "Tokens";
          windowSeconds = 0;
      }
      collected.push({
        label,
        usedPercent: Number(entry.percentage ?? 0),
        resetsAt: parseDateish(entry.nextResetTime),
        windowSeconds,
        usedValue: Number(entry.percentage ?? 0),
        limitValue: 100,
      });
      continue;
    }
    if (entry.type === "TIME_LIMIT") {
      const limit = Number(entry.usage ?? 0);
      const used = Number(entry.currentValue ?? 0);
      if (limit <= 0) {
        continue;
      }
      collected.push({
        label: "Web / month",
        usedPercent: safePercent(used, limit),
        resetsAt: parseDateish(entry.nextResetTime),
        windowSeconds: 30 * 24 * 60 * 60,
        usedValue: used,
        limitValue: limit,
      });
    }
  }
  collected.sort((a, b) => a.windowSeconds - b.windowSeconds);
  return collected;
}

function parseOllamaCloudUsage(data) {
  const windows = [];
  const session = data?.limits?.session;
  if (session && typeof session.usage === "number") {
    windows.push({
      label: "5h",
      usedPercent: Math.max(0, Math.min(100, Math.round(session.usage * 100))),
      resetsAt: new Date(0),
      windowSeconds: 5 * 60 * 60,
      usedValue: Math.max(0, Math.min(100, Math.round(session.usage * 100))),
      limitValue: 100,
    });
  }
  const weekly = data?.limits?.weekly;
  if (weekly && typeof weekly.usage === "number") {
    windows.push({
      label: "7d",
      usedPercent: Math.max(0, Math.min(100, Math.round(weekly.usage * 100))),
      resetsAt: new Date(0),
      windowSeconds: 7 * 24 * 60 * 60,
      usedValue: Math.max(0, Math.min(100, Math.round(weekly.usage * 100))),
      limitValue: 100,
    });
  }
  return windows;
}

function parseXaiUsage(data) {
  const config = data?.config;
  if (!config || typeof config !== "object") {
    return [];
  }
  const start = parseDateish(config.currentPeriod?.start ?? config.billingPeriodStart);
  const end = parseDateish(config.currentPeriod?.end ?? config.billingPeriodEnd);
  const periodMs = end.getTime() - start.getTime();
  if (!Number.isFinite(periodMs) || periodMs <= 0) {
    return [];
  }
  const windowSeconds = Math.round(periodMs / 1000);
  const isWeekly =
    config.currentPeriod?.type === "USAGE_PERIOD_TYPE_WEEKLY" ||
    config.isUnifiedBillingUser === true;
  const periodLabel = isWeekly ? "Week" : "Month";
  const windows = [];
  const creditUsagePercent = Number(config.creditUsagePercent);
  if (config.creditUsagePercent != null && Number.isFinite(creditUsagePercent)) {
    windows.push({
      label: `${periodLabel} (credits)`,
      usedPercent: creditUsagePercent,
      resetsAt: end,
      windowSeconds,
      usedValue: creditUsagePercent,
      limitValue: 100,
    });
  }
  const products = Array.isArray(config.productUsage) ? config.productUsage : [];
  for (const product of products.slice(0, 8)) {
    if (product?.usagePercent == null) {
      continue;
    }
    const usagePercent = Number(product.usagePercent);
    if (!Number.isFinite(usagePercent)) {
      continue;
    }
    const label = String(product?.product ?? "")
      .replace(/^Grok/i, "")
      .trim();
    if (!label) {
      continue;
    }
    windows.push({
      label,
      usedPercent: usagePercent,
      resetsAt: end,
      windowSeconds,
      usedValue: usagePercent,
      limitValue: 100,
    });
  }
  const onDemandLimit = Number(config.onDemandCap?.val);
  const onDemandUsed = Number(config.onDemandUsed?.val);
  if (Number.isFinite(onDemandLimit) && Number.isFinite(onDemandUsed) && onDemandLimit > 0) {
    windows.push({
      label: "On-demand",
      usedPercent: safePercent(onDemandUsed, onDemandLimit),
      resetsAt: end,
      windowSeconds,
      usedValue: onDemandUsed,
      limitValue: onDemandLimit,
      isCurrency: true,
    });
  }
  return windows;
}

// ---------- http ----------

function cleanHttpErrorMessage(body) {
  const trimmed = body.trim();
  if (!trimmed) {
    return "";
  }
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return trimmed;
  }
  try {
    const parsed = JSON.parse(trimmed);
    const message =
      parsed?.error?.message ??
      parsed?.message ??
      parsed?.error ??
      parsed?.detail ??
      parsed?.error_description;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  } catch {
    // not JSON
  }
  return trimmed;
}

async function fetchJson(url, init) {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        kind: "http",
        message:
          cleanHttpErrorMessage(body) || response.statusText || `HTTP ${response.status}`,
        ok: false,
      };
    }
    return { data: await response.json(), ok: true };
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      return { kind: "timeout", message: "Request timed out", ok: false };
    }
    return {
      kind: "network",
      message: error instanceof Error ? error.message : "Unknown error",
      ok: false,
    };
  }
}

const success = (windows) => ({ data: { windows }, success: true });
const failure = (message, kind) => ({ error: { kind, message }, success: false });

// ---------- OpenCode Go ---------

// Public API (anomalyco/opencode#16017, PR #16513):
// GET https://opencode.ai/zen/go/v1/usage with Bearer API key.
const OPEN_CODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

// Handles both the proposed rollingUsage shape and the production
// usage.rolling shape (parser ported from omo-run's omo-usage extension).
function parseOpenCodeGoApiUsage(payload) {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const source =
    payload.usage && typeof payload.usage === "object" ? payload.usage : payload;
  const windows = [];
  const groups = [
    [["rolling", "rollingUsage"], "5h Rolling", 5 * 60 * 60],
    [["weekly", "weeklyUsage"], "Weekly", 7 * 24 * 60 * 60],
    [["monthly", "monthlyUsage"], "Monthly", 30 * 24 * 60 * 60],
  ];
  for (const [keys, label, windowSeconds] of groups) {
    const raw = keys
      .map((key) => source[key])
      .find((value) => value && typeof value === "object");
    if (!raw) {
      continue;
    }
    const percent =
      typeof raw.percent === "number"
        ? raw.percent
        : typeof raw.usagePercent === "number"
          ? raw.usagePercent
          : undefined;
    if (percent === undefined || !Number.isFinite(percent)) {
      continue;
    }
    let resetsAt = new Date(0);
    const resetText =
      typeof raw.resetsAt === "string"
        ? raw.resetsAt
        : typeof raw.reset_at === "string"
          ? raw.reset_at
          : undefined;
    if (resetText) {
      const parsed = Date.parse(resetText);
      if (!Number.isNaN(parsed)) {
        resetsAt = new Date(parsed);
      }
    } else if (typeof raw.resetInSec === "number" && Number.isFinite(raw.resetInSec)) {
      resetsAt = new Date(Date.now() + raw.resetInSec * 1000);
    }
    windows.push({
      label,
      usedPercent: Math.max(0, Math.min(100, percent)),
      resetsAt,
      windowSeconds,
      usedValue: Math.max(0, Math.min(100, percent)),
      limitValue: 100,
    });
  }
  return windows;
}

const SCRAPED_NUMBER = String.raw`(-?\d+(?:\.\d+)?)`;

function scrapedWindowPattern(name, first, second) {
  return new RegExp(
    String.raw`${name}:\$R\[\d+\]=\{[^}]*${first}:${SCRAPED_NUMBER}[^}]*${second}:${SCRAPED_NUMBER}[^}]*\}`
  );
}

const GO_WINDOWS = [
  ["rollingUsage", "rolling", 5 * 60 * 60],
  ["weeklyUsage", "weekly", 7 * 24 * 60 * 60],
  ["monthlyUsage", "monthly", 30 * 24 * 60 * 60],
];

function parseWindowUsage(html, key) {
  const pctFirst = scrapedWindowPattern(key, "usagePercent", "resetInSec").exec(html);
  if (pctFirst) {
    return { resetInSec: Number(pctFirst[2]), usagePercent: Number(pctFirst[1]) };
  }
  const resetFirst = scrapedWindowPattern(key, "resetInSec", "usagePercent").exec(html);
  if (resetFirst) {
    return { resetInSec: Number(resetFirst[1]), usagePercent: Number(resetFirst[2]) };
  }
  return null;
}

function resolveOpenCodeGoConfig() {
  const workspaceId = process.env.OPENCODE_GO_WORKSPACE_ID?.trim();
  const authCookie = process.env.OPENCODE_GO_AUTH_COOKIE?.trim();
  if (workspaceId && authCookie) {
    return { authCookie, workspaceId };
  }
  const candidates = [
    path.join(os.homedir(), ".config", "opencode", "opencode-quota", "opencode-go.json"),
    path.join(os.homedir(), ".config", "opencode-go", "config.json"),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (parsed?.workspaceId && parsed?.authCookie) {
        return { authCookie: parsed.authCookie, workspaceId: parsed.workspaceId };
      }
    } catch {
      // missing or invalid; try next
    }
  }
  return undefined;
}

async function fetchOpenCodeGoDashboard() {
  const config = resolveOpenCodeGoConfig();
  if (!config) {
    return failure(
      "No OpenCode Go config (OPENCODE_GO_WORKSPACE_ID + OPENCODE_GO_AUTH_COOKIE)",
      "config"
    );
  }
  const url = `https://opencode.ai/workspace/${encodeURIComponent(config.workspaceId)}/go`;
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "text/html",
        Cookie: `auth=${config.authCookie}`,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0",
      },
      signal,
    });
    if (!response.ok) {
      return failure(`OpenCode Go dashboard error ${response.status}`, "http");
    }
    const html = await response.text();
    const now = Date.now();
    const data = {};
    for (const [key, field] of GO_WINDOWS) {
      const scraped = parseWindowUsage(html, key);
      if (scraped) {
        data[field] = {
          resetInSec: Math.max(0, scraped.resetInSec),
          resetTimeIso: new Date(now + Math.max(0, scraped.resetInSec) * 1000).toISOString(),
          usagePercent: Math.max(0, scraped.usagePercent),
        };
      }
    }
    if (!(data.rolling || data.weekly || data.monthly)) {
      return failure("Could not parse OpenCode Go dashboard usage windows", "http");
    }
    return success(parseOpenCodeGoUsage(data));
  } catch (error) {
    return failure(
      error instanceof Error ? error.message : "Unknown error",
      signal.aborted ? "timeout" : "network"
    );
  }
}

async function fetchOpenCodeGoQuotas(authStorage) {
  // Prefer the public API with the stored Go API key.
  const apiKey = await authStorage.getApiKey("opencode-go");
  let apiError;
  if (apiKey) {
    const result = await fetchJson(OPEN_CODE_GO_USAGE_URL, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": "omo",
      },
    });
    if (result.ok) {
      const windows = parseOpenCodeGoApiUsage(result.data);
      if (windows.length) {
        return success(windows);
      }
      return failure("OpenCode Go usage response had no windows", "http");
    }
    apiError = result;
  }
  // Fall back to dashboard scraping with workspace id + auth cookie.
  const dashboard = await fetchOpenCodeGoDashboard();
  if (dashboard.success) {
    return dashboard;
  }
  return apiError ? failure(apiError.message, apiError.kind) : dashboard;
}

// ---------- fetchers ----------

function isDirectAnthropicApiKey(token) {
  return token.startsWith("sk-ant-api");
}

async function fetchAnthropicQuotas(authStorage) {
  const accessToken = await authStorage.getApiKey("anthropic");
  if (!accessToken) {
    return failure("No Anthropic OAuth token found", "config");
  }
  if (isDirectAnthropicApiKey(accessToken)) {
    return failure(
      "Direct Anthropic API key — no subscription usage to report",
      "not_applicable"
    );
  }
  const result = await fetchJson("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
  });
  if (!result.ok) {
    return failure(result.message, result.kind);
  }
  return success(parseAnthropicUsage(result.data));
}

function codexAccountId(authStorage) {
  const credential = authStorage.get("openai-codex");
  if (typeof credential?.accountId === "string") {
    return credential.accountId;
  }
  try {
    const data = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".codex", "auth.json"), "utf8")
    );
    return data?.tokens?.account_id ?? data?.tokens?.accountId;
  } catch {
    return undefined;
  }
}

async function fetchCodexQuotas(authStorage) {
  const accessToken = await authStorage.getApiKey("openai-codex");
  if (!accessToken) {
    return failure("No Codex access token found", "config");
  }
  const accountId = codexAccountId(authStorage);
  if (!accountId) {
    return failure("No Codex account id found", "config");
  }
  const result = await fetchJson("https://chatgpt.com/backend-api/wham/usage", {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "ChatGPT-Account-Id": accountId,
      Origin: "https://chatgpt.com",
      Referer: "https://chatgpt.com/",
      "User-Agent": "Mozilla/5.0",
    },
  });
  if (!result.ok) {
    return failure(result.message, result.kind);
  }
  return success(parseCodexUsage(result.data));
}

function copilotHeaders(authHeader) {
  return {
    Accept: "application/json",
    Authorization: authHeader,
    "Content-Type": "application/json",
    "Copilot-Integration-Id": "vscode-chat",
    "Editor-Plugin-Version": `copilot-chat/${COPILOT_VERSION}`,
    "Editor-Version": EDITOR_VERSION,
    "User-Agent": `GitHubCopilotChat/${COPILOT_VERSION}`,
  };
}

function ghCliToken() {
  try {
    return (
      execFileSync("gh", ["auth", "token"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

async function tryGitHubUserEndpoint(authHeader) {
  return fetchJson("https://api.github.com/copilot_internal/user", {
    headers: copilotHeaders(authHeader),
  });
}

function githubOAuthToken(authStorage) {
  // Pi stores the GitHub OAuth token in `refresh`; `access` is a Copilot proxy
  // token rejected by api.github.com quota endpoints.
  const credential = authStorage.get("github-copilot");
  if (credential?.type !== "oauth") {
    return undefined;
  }
  return typeof credential.refresh === "string" && credential.refresh.length > 0
    ? credential.refresh
    : undefined;
}

async function fetchGitHubCopilotQuotas(authStorage) {
  const githubToken = githubOAuthToken(authStorage);
  if (githubToken) {
    const bearerUsage = await tryGitHubUserEndpoint(`Bearer ${githubToken}`);
    if (bearerUsage.ok) {
      return success(parseGitHubCopilotUsage(bearerUsage.data));
    }
    const tokenUsage = await tryGitHubUserEndpoint(`token ${githubToken}`);
    if (tokenUsage.ok) {
      return success(parseGitHubCopilotUsage(tokenUsage.data));
    }
  }
  const accessToken = await authStorage.getApiKey("github-copilot");
  if (!accessToken) {
    return failure("No GitHub Copilot OAuth token found", "config");
  }
  const exchange = await fetchJson("https://api.github.com/copilot_internal/v2/token", {
    headers: copilotHeaders(`Bearer ${accessToken}`),
  });
  if (exchange.ok && exchange.data?.token) {
    const usage = await tryGitHubUserEndpoint(`Bearer ${exchange.data.token}`);
    if (usage.ok) {
      return success(parseGitHubCopilotUsage(usage.data));
    }
  }
  const directUsage = await tryGitHubUserEndpoint(`token ${accessToken}`);
  if (directUsage.ok) {
    return success(parseGitHubCopilotUsage(directUsage.data));
  }
  const cliToken = ghCliToken();
  if (cliToken && cliToken !== accessToken) {
    const cliUsage = await tryGitHubUserEndpoint(`token ${cliToken}`);
    if (cliUsage.ok) {
      return success(parseGitHubCopilotUsage(cliUsage.data));
    }
    return failure(cliUsage.message, cliUsage.kind);
  }
  return failure(directUsage.message, directUsage.kind);
}

async function fetchOpenRouterQuotas(authStorage) {
  const accessToken = await authStorage.getApiKey("openrouter");
  if (!accessToken) {
    return failure("No OpenRouter API key found", "config");
  }
  const result = await fetchJson("https://openrouter.ai/api/v1/key", {
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
  });
  if (!result.ok) {
    return failure(result.message, result.kind);
  }
  return success(parseOpenRouterUsage(result.data));
}

async function fetchSyntheticQuotas(authStorage) {
  const apiKey =
    (await authStorage.getApiKey("synthetic")) ?? process.env.SYNTHETIC_API_KEY;
  if (!apiKey) {
    return failure("No Synthetic API key found", "config");
  }
  const result = await fetchJson("https://api.synthetic.new/v2/quotas", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!result.ok) {
    return failure(result.message, result.kind);
  }
  return success(parseSyntheticUsage(result.data));
}

async function fetchKimiCodingQuotas(authStorage) {
  const accessToken = await authStorage.getApiKey("kimi-coding");
  if (!accessToken) {
    return failure("No Kimi Code access token found", "config");
  }
  const result = await fetchJson("https://api.kimi.com/coding/v1/usages", {
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
  });
  if (!result.ok) {
    return failure(result.message, result.kind);
  }
  return success(parseKimiCodingUsage(result.data));
}

async function fetchZaiQuotas(authStorage) {
  const apiKey = await authStorage.getApiKey("zai");
  if (!apiKey) {
    return failure("No Z.ai API key found", "config");
  }
  const result = await fetchJson("https://api.z.ai/api/monitor/usage/quota/limit", {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
  });
  if (!result.ok) {
    return failure(result.message, result.kind);
  }
  return success(parseZaiUsage(result.data));
}

async function fetchOllamaCloudQuotas(authStorage) {
  const apiKey =
    (await authStorage.getApiKey("ollama-cloud")) ?? process.env.OLLAMA_API_KEY;
  if (!apiKey) {
    return failure("No Ollama Cloud API key found", "config");
  }
  const result = await fetchJson("https://ollama.com/api/usage", {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
  });
  if (!result.ok) {
    return failure(result.message, result.kind);
  }
  return success(parseOllamaCloudUsage(result.data));
}

async function fetchXaiQuotas(authStorage) {
  const accessToken = await authStorage.getApiKey("xai");
  if (!accessToken) {
    return failure("No xAI OAuth token found", "config");
  }
  const result = await fetchJson("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
  });
  if (!result.ok) {
    return failure(result.message, result.kind);
  }
  return success(parseXaiUsage(result.data));
}

const PROVIDER_FETCHERS = {
  anthropic: fetchAnthropicQuotas,
  "openai-codex": fetchCodexQuotas,
  "github-copilot": fetchGitHubCopilotQuotas,
  openrouter: fetchOpenRouterQuotas,
  synthetic: fetchSyntheticQuotas,
  xai: fetchXaiQuotas,
  zai: fetchZaiQuotas,
  "opencode-go": fetchOpenCodeGoQuotas,
  "kimi-coding": fetchKimiCodingQuotas,
  "ollama-cloud": fetchOllamaCloudQuotas,
};

// ---------- cache + orchestration ----------

const cache = new Map();

function toFailureResult(provider, error) {
  const message = error instanceof Error ? error.message : String(error);
  const isOAuthError =
    error?.code === "oauth" || /oauth|refresh token|token refresh/i.test(message);
  if (isOAuthError) {
    return failure(
      `${PROVIDER_LABELS[provider]} OAuth token refresh failed — re-authenticate with /login`,
      "config"
    );
  }
  return failure(message.split("\n")[0].slice(0, 200) || "Unknown error", "network");
}

async function fetchProviderQuotas(authStorage, provider, force) {
  const entry = cache.get(provider) ?? {};
  const now = Date.now();
  const ttl = PROVIDER_TTLS_MS[provider];
  if (!force && entry.result && entry.fetchedAt && now - entry.fetchedAt < ttl) {
    return entry.result;
  }
  if (!force && entry.inFlight) {
    return entry.inFlight;
  }
  const promise = PROVIDER_FETCHERS[provider](authStorage)
    .catch((error) => toFailureResult(provider, error))
    .then((result) => {
      cache.set(provider, { fetchedAt: Date.now(), result });
      return result;
    })
    .finally(() => {
      const current = cache.get(provider) ?? {};
      delete current.inFlight;
      cache.set(provider, current);
    });
  cache.set(provider, { ...entry, inFlight: promise });
  return promise;
}

// ---------- entry point ----------

/**
 * @param piService  object with async runtime() resolving to pi's ModelRuntime
 * @param agentDir   pi agent dir (contains auth.json)
 * @param force      bypass the per-provider TTL cache
 */
async function fetchQuotas(piService, agentDir, force = false) {
  let stored = {};
  try {
    stored = JSON.parse(
      fs.readFileSync(path.join(agentDir, "auth.json"), "utf8")
    );
  } catch {
    stored = {};
  }
  const authStorage = {
    get: (provider) => stored[provider],
    getApiKey: async (provider) => {
      const credential = stored[provider];
      if (credential?.type === "api_key" && credential.key) {
        return credential.key;
      }
      const runtime = await piService.runtime();
      const auth = (await runtime.getAuth(provider).catch(() => undefined))?.auth;
      const authorization = auth?.headers?.Authorization;
      return auth?.apiKey ?? authorization?.replace(bearerPrefix, "");
    },
  };
  const items = await Promise.all(
    SUPPORTED_PROVIDERS.map(async (provider) => {
      const result = await fetchProviderQuotas(authStorage, provider, force);
      return {
        error: result.success ? undefined : result.error,
        label: PROVIDER_LABELS[provider],
        provider,
        success: result.success,
        windows: result.success
          ? result.data.windows.map((window) => ({
              ...window,
              provider,
              resetsAt: new Date(window.resetsAt).toISOString(),
            }))
          : [],
      };
    })
  );
  return { installed: true, items };
}

module.exports = { fetchQuotas, PROVIDER_LABELS, SUPPORTED_PROVIDERS };
