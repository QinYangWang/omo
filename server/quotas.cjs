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
  "github-copilot": "GitHub Copilot",
  "kimi-coding": "Kimi Code",
  "ollama-cloud": "Ollama Cloud",
  "openai-codex": "OpenAI Codex",
  "opencode-go": "OpenCode Go",
  openrouter: "OpenRouter",
  synthetic: "Synthetic",
  xai: "Grok",
  zai: "Z.ai",
};

const PROVIDER_TTLS_MS = {
  anthropic: 5 * 60_000,
  "github-copilot": 5 * 60_000,
  "kimi-coding": 60_000,
  "ollama-cloud": 60_000,
  "openai-codex": 60_000,
  "opencode-go": 60_000,
  openrouter: 60_000,
  synthetic: 60_000,
  xai: 60_000,
  zai: 60_000,
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
  return Math.max(
    1,
    Math.round((resetAt.getTime() - approxStart.getTime()) / 1000)
  );
}

function parseAnthropicUsage(data) {
  const windows = [];
  if (data?.five_hour) {
    windows.push({
      label: "5h",
      limitValue: 100,
      resetsAt: parseDateish(data.five_hour.resets_at),
      usedPercent: Number(data.five_hour.utilization ?? 0),
      usedValue: Number(data.five_hour.utilization ?? 0),
      windowSeconds: 5 * 60 * 60,
    });
  }
  if (data?.seven_day) {
    windows.push({
      label: "7d",
      limitValue: 100,
      resetsAt: parseDateish(data.seven_day.resets_at),
      usedPercent: Number(data.seven_day.utilization ?? 0),
      usedValue: Number(data.seven_day.utilization ?? 0),
      windowSeconds: 7 * 24 * 60 * 60,
    });
  }
  const modelWindows = [
    ["seven_day_sonnet", "7d Sonnet"],
    ["seven_day_omelette", "7d Opus"],
    ["seven_day_opus", "7d Opus (legacy)"],
  ];
  for (const [key, label] of modelWindows) {
    const entry = data?.[key];
    if (
      entry &&
      typeof entry === "object" &&
      entry.utilization !== null &&
      entry.utilization !== undefined
    ) {
      windows.push({
        label,
        limitValue: 100,
        resetsAt: parseDateish(entry.resets_at),
        usedPercent: Number(entry.utilization),
        usedValue: Number(entry.utilization),
        windowSeconds: 7 * 24 * 60 * 60,
      });
    }
  }
  const extra = data?.extra_usage;
  if (extra?.is_enabled && extra.monthly_limit > 0) {
    const limitDollars = extra.monthly_limit / 100;
    const usedDollars = (extra.used_credits ?? 0) / 100;
    const currency = extra.currency ?? "USD";
    windows.push({
      isCurrency: true,
      label: `Extra (${currency})`,
      limitValue: limitDollars,
      resetsAt: new Date(
        new Date().getFullYear(),
        new Date().getMonth() + 1,
        1
      ),
      usedPercent: Number(
        extra.utilization ?? safePercent(usedDollars, limitDollars)
      ),
      usedValue: usedDollars,
      windowSeconds: 30 * 24 * 60 * 60,
    });
  }
  return windows;
}

function percentLeftToUsedPercent(limit) {
  if (limit?.percent_left !== null && limit?.percent_left !== undefined) {
    return Math.max(0, 100 - Number(limit.percent_left));
  }
  if (
    limit?.remaining_percent !== null &&
    limit?.remaining_percent !== undefined
  ) {
    return Math.max(0, 100 - Number(limit.remaining_percent));
  }
  if (limit?.used_percent !== null && limit?.used_percent !== undefined) {
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
    const windowSeconds = codexWindowSeconds(
      primary.limit_window_seconds,
      5 * 60 * 60
    );
    windows.push({
      label: codexWindowLabel(windowSeconds),
      limitValue: 100,
      resetsAt: parseDateish(primary.reset_at ?? primary.reset_time_ms),
      usedPercent: percentLeftToUsedPercent(primary),
      usedValue: percentLeftToUsedPercent(primary),
      windowSeconds,
    });
  }
  if (secondary) {
    const windowSeconds = codexWindowSeconds(
      secondary.limit_window_seconds,
      7 * 24 * 60 * 60
    );
    windows.push({
      label: codexWindowLabel(windowSeconds),
      limitValue: 100,
      resetsAt: parseDateish(secondary.reset_at ?? secondary.reset_time_ms),
      usedPercent: percentLeftToUsedPercent(secondary),
      usedValue: percentLeftToUsedPercent(secondary),
      windowSeconds,
    });
  }
  const credits = data?.credits;
  if (
    credits?.has_credits &&
    credits.balance !== null &&
    credits.balance !== undefined
  ) {
    const balance = Number(credits.balance);
    windows.push({
      isCurrency: true,
      label: "Credits",
      limitValue: balance,
      resetsAt: new Date(0),
      usedPercent: 0,
      usedValue: balance,
      windowSeconds: 0,
    });
  }
  return windows;
}

function copilotSnapshotWindows(snapshots, mappings, resetAt, periodSeconds) {
  const windows = [];
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
      limitValue: entitlement,
      resetsAt: resetAt,
      usedPercent: safePercent(entitlement - remaining, entitlement),
      usedValue: entitlement - remaining,
      windowSeconds: periodSeconds,
    });
  }
  return windows;
}

function copilotMonthlyWindows(data, resetAt, periodSeconds) {
  const windows = [];
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
      limitValue,
      resetsAt: resetAt,
      usedPercent: safePercent(limitValue - remaining, limitValue),
      usedValue: limitValue - remaining,
      windowSeconds: periodSeconds,
    });
  }
  return windows;
}

function parseGitHubCopilotUsage(data) {
  const resetAt = parseDateish(
    data?.quota_reset_date ??
      data?.quota_reset_date_utc ??
      data?.limited_user_reset_date
  );
  const periodSeconds = monthWindowSeconds(resetAt);
  const snapshots = data?.quota_snapshots;
  if (snapshots && typeof snapshots === "object") {
    return copilotSnapshotWindows(
      snapshots,
      [
        ["premium_interactions", "Premium / month"],
        ["chat", "Chat / month"],
        ["completions", "Completions / month"],
      ],
      resetAt,
      periodSeconds
    );
  }
  if (data?.monthly_quotas && data?.limited_user_quotas) {
    return copilotMonthlyWindows(data, resetAt, periodSeconds);
  }
  return [];
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
  if (limit !== null && limit !== undefined && limit > 0) {
    windows.push({
      isCurrency: true,
      label: "Monthly Budget",
      limitValue: limit,
      resetsAt: nextMonthStartUTC(),
      usedPercent: safePercent(usageMonthly, limit),
      usedValue: usageMonthly,
      windowSeconds: 30 * 24 * 60 * 60,
    });
  } else if (
    limitRemaining !== null &&
    limitRemaining !== undefined &&
    limitRemaining >= 0
  ) {
    windows.push({
      isCurrency: true,
      label: "Credits Remaining",
      limitValue: limitRemaining,
      resetsAt: new Date(0),
      usedPercent: 0,
      usedValue: limitRemaining,
      windowSeconds: 0,
    });
  }
  windows.push(
    {
      isCurrency: true,
      label: "Daily",
      limitValue: 0,
      resetsAt: nextMidnightUTC(),
      usedPercent: 0,
      usedValue: usageDaily,
      windowSeconds: 24 * 60 * 60,
    },
    {
      isCurrency: true,
      label: "Weekly",
      limitValue: 0,
      resetsAt: nextMondayUTC(),
      usedPercent: 0,
      usedValue: usageWeekly,
      windowSeconds: 7 * 24 * 60 * 60,
    },
    {
      isCurrency: true,
      label: "Monthly",
      limitValue: 0,
      resetsAt: nextMonthStartUTC(),
      usedPercent: 0,
      usedValue: usageMonthly,
      windowSeconds: 30 * 24 * 60 * 60,
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
    const remainingValue = parseCurrency(
      data.weeklyTokenLimit.remainingCredits
    );
    windows.push({
      isCurrency: true,
      label: "Credits / week",
      limitValue,
      resetsAt: parseDateish(data.weeklyTokenLimit.nextRegenAt),
      usedPercent: Math.max(
        0,
        Math.min(100, 100 - data.weeklyTokenLimit.percentRemaining)
      ),
      usedValue: limitValue - remainingValue,
      windowSeconds: 24 * 60 * 60,
    });
  }
  if (data?.rollingFiveHourLimit && data.rollingFiveHourLimit.max > 0) {
    const used =
      data.rollingFiveHourLimit.max - data.rollingFiveHourLimit.remaining;
    windows.push({
      label: "Requests / 5h",
      limitValue: data.rollingFiveHourLimit.max,
      resetsAt: parseDateish(data.rollingFiveHourLimit.nextTickAt),
      usedPercent: safePercent(used, data.rollingFiveHourLimit.max),
      usedValue: Math.round(used),
      windowSeconds: 5 * 60 * 60,
    });
  }
  if (data?.search?.hourly?.limit > 0) {
    windows.push({
      label: "Search / hour",
      limitValue: data.search.hourly.limit,
      resetsAt: parseDateish(data.search.hourly.renewsAt),
      usedPercent: safePercent(
        data.search.hourly.requests,
        data.search.hourly.limit
      ),
      usedValue: data.search.hourly.requests,
      windowSeconds: 60 * 60,
    });
  }
  if (data?.freeToolCalls?.limit > 0) {
    windows.push({
      label: "Free Tool Calls / day",
      limitValue: data.freeToolCalls.limit,
      resetsAt: parseDateish(data.freeToolCalls.renewsAt),
      usedPercent: safePercent(
        data.freeToolCalls.requests,
        data.freeToolCalls.limit
      ),
      usedValue: data.freeToolCalls.requests,
      windowSeconds: 24 * 60 * 60,
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
      limitValue: 100,
      resetsAt: new Date(entry.resetTimeIso),
      usedPercent: entry.usagePercent,
      usedValue: entry.usagePercent,
      windowSeconds,
    });
  }
  return windows;
}

function kimiUnitWindow(timeUnit, duration) {
  switch (timeUnit) {
    case "TIME_UNIT_SECOND":
      return { label: `${duration}s`, windowSeconds: duration };
    case "TIME_UNIT_MINUTE": {
      const windowSeconds = duration * 60;
      const label = duration % 60 === 0 ? `${duration / 60}h` : `${duration}m`;
      return { label, windowSeconds };
    }
    case "TIME_UNIT_HOUR":
      return { label: `${duration}h`, windowSeconds: duration * 60 * 60 };
    case "TIME_UNIT_DAY":
      return { label: `${duration}d`, windowSeconds: duration * 24 * 60 * 60 };
    default:
      return null;
  }
}

function kimiLimitWindows(limits) {
  const windows = [];
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
      !(
        Number.isFinite(limit) &&
        Number.isFinite(used) &&
        Number.isFinite(duration)
      ) ||
      limit <= 0 ||
      duration <= 0
    ) {
      continue;
    }
    const unit = kimiUnitWindow(window.timeUnit, duration);
    if (!unit) {
      continue;
    }
    windows.push({
      label: unit.label,
      limitValue: limit,
      resetsAt: parseDateish(detail.resetTime),
      usedPercent: safePercent(used, limit),
      usedValue: used,
      windowSeconds: unit.windowSeconds,
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
        limitValue: limit,
        resetsAt: parseDateish(weekly.resetTime),
        usedPercent: safePercent(used, limit),
        usedValue: used,
        windowSeconds: 7 * 24 * 60 * 60,
      });
    }
  }
  const limits = Array.isArray(data?.limits) ? data.limits : [];
  windows.push(...kimiLimitWindows(limits));
  windows.sort((a, b) => a.windowSeconds - b.windowSeconds);
  return windows;
}

function zaiUnit(count, unit) {
  switch (unit) {
    case 3:
      return { label: `${count}h`, windowSeconds: count * 60 * 60 };
    case 4:
      return { label: `${count}d`, windowSeconds: count * 24 * 60 * 60 };
    case 6:
      return {
        label: `${count * 7}d`,
        windowSeconds: count * 7 * 24 * 60 * 60,
      };
    default:
      return { label: "Tokens", windowSeconds: 0 };
  }
}

function zaiTokensWindow(entry) {
  const count = Number(entry.number ?? 1) || 1;
  const unit = zaiUnit(count, entry.unit);
  return {
    label: unit.label,
    limitValue: 100,
    resetsAt: parseDateish(entry.nextResetTime),
    usedPercent: Number(entry.percentage ?? 0),
    usedValue: Number(entry.percentage ?? 0),
    windowSeconds: unit.windowSeconds,
  };
}

function zaiTimeWindow(entry) {
  const limit = Number(entry.usage ?? 0);
  const used = Number(entry.currentValue ?? 0);
  if (limit <= 0) {
    return null;
  }
  return {
    label: "Web / month",
    limitValue: limit,
    resetsAt: parseDateish(entry.nextResetTime),
    usedPercent: safePercent(used, limit),
    usedValue: used,
    windowSeconds: 30 * 24 * 60 * 60,
  };
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
      collected.push(zaiTokensWindow(entry));
      continue;
    }
    if (entry.type === "TIME_LIMIT") {
      const window = zaiTimeWindow(entry);
      if (window) {
        collected.push(window);
      }
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
      limitValue: 100,
      resetsAt: new Date(0),
      usedPercent: Math.max(0, Math.min(100, Math.round(session.usage * 100))),
      usedValue: Math.max(0, Math.min(100, Math.round(session.usage * 100))),
      windowSeconds: 5 * 60 * 60,
    });
  }
  const weekly = data?.limits?.weekly;
  if (weekly && typeof weekly.usage === "number") {
    windows.push({
      label: "7d",
      limitValue: 100,
      resetsAt: new Date(0),
      usedPercent: Math.max(0, Math.min(100, Math.round(weekly.usage * 100))),
      usedValue: Math.max(0, Math.min(100, Math.round(weekly.usage * 100))),
      windowSeconds: 7 * 24 * 60 * 60,
    });
  }
  return windows;
}

function xaiProductWindows(products, end, windowSeconds) {
  const windows = [];
  for (const product of products.slice(0, 8)) {
    if (product?.usagePercent === null || product?.usagePercent === undefined) {
      continue;
    }
    const usagePercent = Number(product.usagePercent);
    if (!Number.isFinite(usagePercent)) {
      continue;
    }
    const label = String(product?.product ?? "")
      .replace(GROK_PREFIX, "")
      .trim();
    if (!label) {
      continue;
    }
    windows.push({
      label,
      limitValue: 100,
      resetsAt: end,
      usedPercent: usagePercent,
      usedValue: usagePercent,
      windowSeconds,
    });
  }
  return windows;
}

function parseXaiUsage(data) {
  const config = data?.config;
  if (!config || typeof config !== "object") {
    return [];
  }
  const start = parseDateish(
    config.currentPeriod?.start ?? config.billingPeriodStart
  );
  const end = parseDateish(
    config.currentPeriod?.end ?? config.billingPeriodEnd
  );
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
  if (
    config.creditUsagePercent !== null &&
    config.creditUsagePercent !== undefined &&
    Number.isFinite(creditUsagePercent)
  ) {
    windows.push({
      label: `${periodLabel} (credits)`,
      limitValue: 100,
      resetsAt: end,
      usedPercent: creditUsagePercent,
      usedValue: creditUsagePercent,
      windowSeconds,
    });
  }
  const products = Array.isArray(config.productUsage)
    ? config.productUsage
    : [];
  windows.push(...xaiProductWindows(products, end, windowSeconds));
  const onDemandLimit = Number(config.onDemandCap?.val);
  const onDemandUsed = Number(config.onDemandUsed?.val);
  if (
    Number.isFinite(onDemandLimit) &&
    Number.isFinite(onDemandUsed) &&
    onDemandLimit > 0
  ) {
    windows.push({
      isCurrency: true,
      label: "On-demand",
      limitValue: onDemandLimit,
      resetsAt: end,
      usedPercent: safePercent(onDemandUsed, onDemandLimit),
      usedValue: onDemandUsed,
      windowSeconds,
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
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
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
          cleanHttpErrorMessage(body) ||
          response.statusText ||
          `HTTP ${response.status}`,
        ok: false,
      };
    }
    return { data: await response.json(), ok: true };
  } catch (error) {
    if (
      signal.aborted ||
      (error instanceof Error && error.name === "AbortError")
    ) {
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
const failure = (message, kind) => ({
  error: { kind, message },
  success: false,
});

// ---------- OpenCode Go ---------

// Public API (anomalyco/opencode#16017, PR #16513):
// GET https://opencode.ai/zen/go/v1/usage with Bearer API key.
const OPEN_CODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

// Handles both the proposed rollingUsage shape and the production
// usage.rolling shape (parser ported from omo-run's omo-usage extension).
function firstUsagePercent(raw) {
  if (typeof raw.percent === "number") {
    return raw.percent;
  }
  if (typeof raw.usagePercent === "number") {
    return raw.usagePercent;
  }
}

function usageResetAt(raw) {
  let resetText;
  if (typeof raw.resetsAt === "string") {
    resetText = raw.resetsAt;
  } else if (typeof raw.reset_at === "string") {
    resetText = raw.reset_at;
  }
  if (resetText) {
    const parsed = Date.parse(resetText);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed);
    }
  } else if (
    typeof raw.resetInSec === "number" &&
    Number.isFinite(raw.resetInSec)
  ) {
    return new Date(Date.now() + raw.resetInSec * 1000);
  }
  return new Date(0);
}

function parseOpenCodeGoApiUsage(payload) {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const source =
    payload.usage && typeof payload.usage === "object"
      ? payload.usage
      : payload;
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
    const percent = firstUsagePercent(raw);
    if (percent === undefined || !Number.isFinite(percent)) {
      continue;
    }
    windows.push({
      label,
      limitValue: 100,
      resetsAt: usageResetAt(raw),
      usedPercent: Math.max(0, Math.min(100, percent)),
      usedValue: Math.max(0, Math.min(100, percent)),
      windowSeconds,
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
const GROK_PREFIX = /^Grok/i;
const OAUTH_REFRESH_ERROR = /oauth|refresh token|token refresh/i;

function parseWindowUsage(html, key) {
  const variants = [
    scrapedWindowPattern(key, "usagePercent", "resetInSec"),
    scrapedWindowPattern(key, "resetInSec", "usagePercent"),
  ];
  for (const pattern of variants) {
    const match = pattern.exec(html);
    if (match) {
      const isPercentFirst = pattern.source.includes("usagePercent");
      return isPercentFirst
        ? {
            resetInSec: Number(match[2]),
            usagePercent: Number(match[1]),
          }
        : {
            resetInSec: Number(match[1]),
            usagePercent: Number(match[2]),
          };
    }
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
    path.join(
      os.homedir(),
      ".config",
      "opencode",
      "opencode-quota",
      "opencode-go.json"
    ),
    path.join(os.homedir(), ".config", "opencode-go", "config.json"),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (parsed?.workspaceId && parsed?.authCookie) {
        return {
          authCookie: parsed.authCookie,
          workspaceId: parsed.workspaceId,
        };
      }
    } catch {
      // missing or invalid; try next
    }
  }
  return null;
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
          resetTimeIso: new Date(
            now + Math.max(0, scraped.resetInSec) * 1000
          ).toISOString(),
          usagePercent: Math.max(0, scraped.usagePercent),
        };
      }
    }
    if (!(data.rolling || data.weekly || data.monthly)) {
      return failure(
        "Could not parse OpenCode Go dashboard usage windows",
        "http"
      );
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
    // no codex auth file on this machine
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
    // gh CLI not installed or not authenticated
  }
}

function tryGitHubUserEndpoint(authHeader) {
  return fetchJson("https://api.github.com/copilot_internal/user", {
    headers: copilotHeaders(authHeader),
  });
}

function githubOAuthToken(authStorage) {
  // Pi stores the GitHub OAuth token in `refresh`; `access` is a Copilot proxy
  // token rejected by api.github.com quota endpoints.
  const credential = authStorage.get("github-copilot");
  if (credential?.type !== "oauth") {
    return;
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
  const exchange = await fetchJson(
    "https://api.github.com/copilot_internal/v2/token",
    {
      headers: copilotHeaders(`Bearer ${accessToken}`),
    }
  );
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
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
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
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
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
  const result = await fetchJson(
    "https://api.z.ai/api/monitor/usage/quota/limit",
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    }
  );
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
  const result = await fetchJson(
    "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );
  if (!result.ok) {
    return failure(result.message, result.kind);
  }
  return success(parseXaiUsage(result.data));
}

const PROVIDER_FETCHERS = {
  anthropic: fetchAnthropicQuotas,
  "github-copilot": fetchGitHubCopilotQuotas,
  "kimi-coding": fetchKimiCodingQuotas,
  "ollama-cloud": fetchOllamaCloudQuotas,
  "openai-codex": fetchCodexQuotas,
  "opencode-go": fetchOpenCodeGoQuotas,
  openrouter: fetchOpenRouterQuotas,
  synthetic: fetchSyntheticQuotas,
  xai: fetchXaiQuotas,
  zai: fetchZaiQuotas,
};

// ---------- cache + orchestration ----------

const cache = new Map();

function toFailureResult(provider, error) {
  const message = error instanceof Error ? error.message : String(error);
  const isOAuthError =
    error?.code === "oauth" || OAUTH_REFRESH_ERROR.test(message);
  if (isOAuthError) {
    return failure(
      `${PROVIDER_LABELS[provider]} OAuth token refresh failed — re-authenticate with /login`,
      "config"
    );
  }
  return failure(
    message.split("\n")[0].slice(0, 200) || "Unknown error",
    "network"
  );
}

function fetchProviderQuotas(authStorage, provider, force) {
  const entry = cache.get(provider) ?? {};
  const now = Date.now();
  const ttl = PROVIDER_TTLS_MS[provider];
  if (
    !force &&
    entry.result &&
    entry.fetchedAt &&
    now - entry.fetchedAt < ttl
  ) {
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
      const { inFlight: _inFlight, ...rest } = cache.get(provider) ?? {};
      cache.set(provider, rest);
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
      const auth = (await runtime.getAuth(provider).catch(() => undefined))
        ?.auth;
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
