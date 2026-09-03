import { ArrowLeft, Package } from "lucide-react";
import { useEffect, useState } from "react";
import {
  formatReset,
  ProvidersSection,
  quotaColor,
  useQuotas,
} from "@/components/ProvidersSection";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Progress,
  ProgressIndicator,
  ProgressTrack,
} from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { mockSkills } from "@/lib/data";
import { type I18nKey, type Lang, useI18n } from "@/lib/i18n";
import { omo } from "@/lib/omo";
import { getRemoteConfig, saveRemoteConfig } from "@/lib/remote-api";
import { type Theme, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const sections = [
  ["section_general", "General"],
  ["section_appearance", "Appearance"],
  ["section_providers", "Providers"],
  ["section_skills", "Skills"],
  ["section_usage", "Usage"],
  ["section_packages", "Packages"],
] as const;
type Section = (typeof sections)[number][1];
const themeLabels: Record<Theme, I18nKey> = {
  dark: "theme_dark",
  light: "theme_light",
  system: "theme_system",
};
const trailingSlash = /\/$/;

export function SettingsView({
  onBack,
  sidebarOpen = true,
}: {
  onBack: () => void;
  sidebarOpen?: boolean;
}) {
  const { t } = useI18n();
  const [section, setSection] = useState<Section>("Providers");
  return (
    <div className="flex h-full bg-background">
      {sidebarOpen ? (
        <div className="flex w-60 shrink-0 flex-col bg-sidebar">
          <div className="px-2 pb-2">
            <Input placeholder={t("search_settings")} />
          </div>
          <nav className="flex flex-col gap-0.5 px-2">
            {sections.map(([key, s]) => (
              <button
                className={cn(
                  "rounded-md px-3 py-2 text-left text-muted-foreground text-sm hover:bg-accent hover:text-foreground",
                  section === s && "bg-accent text-foreground"
                )}
                key={s}
                onClick={() => setSection(s)}
                type="button"
              >
                {t(key as I18nKey)}
              </button>
            ))}
          </nav>
          <div className="mt-auto p-2">
            <Button
              className="w-full justify-start gap-2 font-normal"
              onClick={onBack}
              type="button"
              variant="ghost"
            >
              <ArrowLeft className="size-4" /> {t("back")}
            </Button>
          </div>
        </div>
      ) : null}
      {sidebarOpen ? <div className="w-px shrink-0 bg-border" /> : null}
      <ScrollArea className="min-w-0 flex-1">
        <div className="w-full max-w-5xl px-12 py-8">
          {section === "Providers" && <ProvidersSection />}
          {section === "Skills" && <SkillsSection />}
          {section === "Usage" && <UsageSection />}
          {section === "Packages" && <PackagesSection />}
          {section === "General" && <ConnectionSection />}
          {section === "Appearance" && <AppearanceSection />}
        </div>
      </ScrollArea>
    </div>
  );
}

function ConnectionSection() {
  const current = getRemoteConfig();
  const [url, setUrl] = useState(current.url);
  const [token, setToken] = useState(current.token);
  const [status, setStatus] = useState("");

  const save = async (nextUrl: string, nextToken: string) => {
    try {
      await saveRemoteConfig(nextUrl, nextToken);
      window.location.reload();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const test = async () => {
    setStatus("Connecting…");
    try {
      const response = await fetch(
        `${url.replace(trailingSlash, "")}/api/v1/projects`,
        {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        }
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      setStatus("Connected");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <div>
        <h2 className="font-medium text-xl">Server</h2>
        <p className="mt-1 text-muted-foreground text-sm">
          留空使用 Electron 本地模式；填写地址后 Web 和 Electron 将连接远程 Pi
          Server。静态 Web 由 omo Server 托管时会自动填入当前 Server URL。
        </p>
      </div>
      <label className="flex flex-col gap-2 text-sm" htmlFor="server-url">
        Server URL
        <Input
          id="server-url"
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://omo.example.com"
          value={url}
        />
      </label>
      <label className="flex flex-col gap-2 text-sm" htmlFor="server-token">
        Access token
        <Input
          id="server-token"
          onChange={(event) => setToken(event.target.value)}
          placeholder="Bearer token"
          type="password"
          value={token}
        />
      </label>
      {status ? (
        <p className="text-muted-foreground text-sm">{status}</p>
      ) : null}
      <div className="flex gap-2">
        <Button disabled={!url} onClick={test} variant="outline">
          Test connection
        </Button>
        <Button onClick={() => save(url, token)}>Save and reconnect</Button>
        {current.url ? (
          <Button onClick={() => save("", "")} variant="ghost">
            Use local
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function AppearanceSection() {
  const { t, lang, setLang } = useI18n();
  const { theme, setTheme } = useTheme();
  const row = (label: string, control: React.ReactNode) => (
    <div className="flex items-center justify-between border-border border-b py-3 last:border-0">
      <span className="text-sm">{label}</span>
      {control}
    </div>
  );
  return (
    <div className="flex flex-col gap-5">
      <h2 className="font-medium text-xl">{t("section_appearance")}</h2>
      <div>
        {row(
          t("theme"),
          <div className="flex gap-1">
            {(["dark", "light", "system"] as Theme[]).map((v) => (
              <Button
                key={v}
                onClick={() => setTheme(v)}
                size="sm"
                variant={theme === v ? "secondary" : "ghost"}
              >
                {t(themeLabels[v])}
              </Button>
            ))}
          </div>
        )}
        {row(
          t("language"),
          <div className="flex gap-1">
            {(["en", "zh"] as Lang[]).map((v) => (
              <Button
                key={v}
                onClick={() => setLang(v)}
                size="sm"
                variant={lang === v ? "secondary" : "ghost"}
              >
                {v === "en" ? "English" : "中文"}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SkillsSection() {
  const [skills, setSkills] = useState(mockSkills);
  const [active, setActive] = useState(skills[0]?.id ?? "");
  const skill = skills.find((s) => s.id === active) ?? skills[0];
  if (!skill) {
    return null;
  }
  return (
    <div className="flex gap-6">
      <div className="flex w-64 flex-col gap-2">
        <Input placeholder="Search skills…" />
        <div className="flex flex-col gap-0.5">
          {skills.map((s) => (
            <button
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                active === s.id && "bg-accent"
              )}
              key={s.id}
              onClick={() => setActive(s.id)}
              type="button"
            >
              <Package className="size-4 shrink-0" />
              <span className="min-w-0">
                <span className="block truncate font-medium">{s.name}</span>
                <span className="block truncate text-muted-foreground text-xs">
                  {s.desc}
                </span>
              </span>
            </button>
          ))}
        </div>
        <Button size="sm" variant="outline">
          + Install
        </Button>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-semibold">{skill.name}</h3>
            <p className="text-muted-foreground text-sm">{skill.desc}</p>
          </div>
          <Switch
            checked={skill.enabled}
            onCheckedChange={(v) =>
              setSkills((prev) =>
                prev.map((x) =>
                  x.id === skill.id ? { ...x, enabled: v === true } : x
                )
              )
            }
          />
        </div>
        <div className="text-sm">
          <span className="text-muted-foreground">安装量 </span>
          {skill.installs}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline">
            Open SKILL.md
          </Button>
          <Button size="sm" variant="outline">
            Update
          </Button>
          <Button className="ml-auto" size="sm" variant="destructive">
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
}

function UsageSection() {
  const { lang, t } = useI18n();
  const [usage, setUsage] = useState<Awaited<
    ReturnType<typeof omo.usage.snapshot>
  > | null>(null);
  useEffect(() => {
    omo.usage
      .snapshot()
      .then(setUsage)
      .catch((error) => console.error("Usage unavailable", error));
  }, []);
  const totals = usage?.totals ?? {
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    input: 0,
    output: 0,
  };
  const fmt = (n: number) => n.toLocaleString();
  const stats = [
    [
      t("usage_processed_tokens"),
      fmt(totals.input + totals.output + totals.cacheWrite),
    ],
    [t("usage_cached_input"), fmt(totals.cacheRead)],
    [t("usage_uncached_input"), fmt(totals.input)],
    [t("usage_output"), fmt(totals.output)],
    [t("usage_cache_savings"), `$${totals.cost.toFixed(2)}`],
  ];
  const providers = usage?.providers ?? [];
  const { quotas: quotaItems, refresh: refreshQuotas } = useQuotas();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-lg">{t("section_usage")}</h2>
        <Badge variant="secondary">{t("usage_period")}</Badge>
      </div>
      <div>
        <div className="text-muted-foreground text-xs">
          {t("usage_raw_token_cost")}
        </div>
        <div className="font-semibold text-3xl">
          ${usage ? totals.cost.toFixed(2) : "…"}*
        </div>
        <div className="text-muted-foreground text-xs">
          {t("usage_full_api_rate")}
        </div>
      </div>
      <div className="grid grid-cols-5 divide-x rounded-lg border">
        {stats.map(([label, value]) => (
          <div className="p-4" key={label}>
            <div className="text-muted-foreground text-xs">{label}</div>
            <div className="text-xl">{value}</div>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="font-medium text-sm">
            {t("usage_subscription_quota")}
          </h3>
          <Button onClick={() => refreshQuotas(true)} size="sm" variant="ghost">
            {t("refresh")}
          </Button>
        </div>
        {quotaItems.filter((q) => q.success && q.windows.length).length ===
        0 ? (
          <div className="text-muted-foreground text-sm">
            {t("usage_no_quota")}
          </div>
        ) : (
          quotaItems
            .filter((q) => q.success && q.windows.length)
            .map((q) => (
              <div
                className="flex flex-col gap-1 border-border border-b py-2 last:border-0"
                key={q.provider}
              >
                <span className="text-sm">{q.label}</span>
                {q.windows.map((w) => (
                  <div className="flex items-center gap-3" key={w.label}>
                    <span className="w-28 truncate text-muted-foreground text-xs">
                      {w.label}
                    </span>
                    <Progress className="flex-1" value={w.usedPercent}>
                      <ProgressTrack className="h-1.5 bg-accent">
                        <ProgressIndicator
                          className={quotaColor(w.usedPercent)}
                        />
                      </ProgressTrack>
                    </Progress>
                    <span className="w-32 text-right text-muted-foreground text-xs">
                      {Math.round(w.usedPercent)}% {t("usage_used")} ·{" "}
                      {formatReset(w.resetsAt, lang)}
                    </span>
                  </div>
                ))}
              </div>
            ))
        )}
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="font-medium text-sm">{t("usage_by_model")}</h3>
        {providers.length === 0 ? (
          <div className="text-muted-foreground text-sm">
            {t("usage_no_token_usage")}
          </div>
        ) : (
          providers.map((p) => (
            <div
              className="flex items-center justify-between border-b py-2 text-sm"
              key={`${p.provider}/${p.model}`}
            >
              <span>
                {p.provider} / {p.model}
              </span>
              <span>
                {fmt(p.tokens)} {t("tokens")} · ${p.cost.toFixed(4)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function PackagesSection() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-lg">Packages</h2>
        <Button size="sm">+ Install</Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>名称</TableHead>
            <TableHead>版本</TableHead>
            <TableHead>来源</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>@latentminds/pi-quotas</TableCell>
            <TableCell>latest</TableCell>
            <TableCell>npm</TableCell>
            <TableCell className="text-right">
              <Button size="sm" variant="ghost">
                更新
              </Button>
              <Button size="sm" variant="ghost">
                删除
              </Button>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}
