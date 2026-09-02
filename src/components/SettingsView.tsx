import { useEffect, useState } from "react";
import { ArrowLeft, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { useI18n, type Lang } from "@/lib/i18n";
import { useTheme, type Theme } from "@/lib/theme";
import { mockSkills } from "@/lib/data";
import { ProvidersSection, useQuotas, formatReset } from "@/components/ProvidersSection";
import { Progress, ProgressTrack, ProgressIndicator } from "@/components/ui/progress";
import { omo } from "@/lib/omo";
import { getRemoteConfig, saveRemoteConfig } from "@/lib/remote-api";

const sections = [
  ["section_general", "General"],
  ["section_appearance", "Appearance"],
  ["section_providers", "Providers"],
  ["section_skills", "Skills"],
  ["section_usage", "Usage"],
  ["section_packages", "Packages"],
] as const;
type Section = (typeof sections)[number][1];

export function SettingsView({ onBack, sidebarOpen = true }: { onBack: () => void; sidebarOpen?: boolean }) {
  const { t } = useI18n();
  const [section, setSection] = useState<Section>("Providers");
  return (
    <div className="flex h-full bg-background">
      {sidebarOpen && <div className="flex w-60 shrink-0 flex-col bg-sidebar">
        <div className="px-2 pb-2">
          <Input placeholder={t("search_settings")} />
        </div>
        <nav className="flex flex-col gap-0.5 px-2">
          {sections.map(([key, s]) => (
            <button
              key={s}
              onClick={() => setSection(s)}
              className={cn(
                "rounded-md px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground",
                section === s && "bg-accent text-foreground"
              )}
            >
              {t(key as any)}
            </button>
          ))}
        </nav>
        <div className="mt-auto p-2">
          <Button variant="ghost" className="w-full justify-start gap-2 font-normal" onClick={onBack}>
            <ArrowLeft className="size-4" /> {t("back")}
          </Button>
        </div>
      </div>}
      {sidebarOpen && <div className="w-px shrink-0 bg-border" />}
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
      const response = await fetch(`${url.replace(/\/$/, "")}/api/v1/projects`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setStatus("Connected");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <div>
        <h2 className="text-xl font-medium">Server</h2>
        <p className="mt-1 text-sm text-muted-foreground">留空使用 Electron 本地模式；填写地址后 Web 和 Electron 将连接远程 Pi Server。</p>
      </div>
      <label className="flex flex-col gap-2 text-sm">
        Server URL
        <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://omo.example.com" />
      </label>
      <label className="flex flex-col gap-2 text-sm">
        Access token
        <Input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Bearer token" />
      </label>
      {status && <p className="text-sm text-muted-foreground">{status}</p>}
      <div className="flex gap-2">
        <Button variant="outline" disabled={!url} onClick={test}>Test connection</Button>
        <Button onClick={() => save(url, token)}>Save and reconnect</Button>
        {current.url && <Button variant="ghost" onClick={() => save("", "")}>Use local</Button>}
      </div>
    </div>
  );
}

function AppearanceSection() {
  const { t, lang, setLang } = useI18n();
  const { theme, setTheme } = useTheme();
  const row = (label: string, control: React.ReactNode) => (
    <div className="flex items-center justify-between border-b border-border py-3 last:border-0">
      <span className="text-sm">{label}</span>
      {control}
    </div>
  );
  return (
    <div className="flex flex-col gap-5">
      <h2 className="text-xl font-medium">{t("section_appearance")}</h2>
      <div>
        {row(
          t("theme"),
          <div className="flex gap-1">
            {(["dark", "light", "system"] as Theme[]).map((v) => (
              <Button key={v} variant={theme === v ? "secondary" : "ghost"} size="sm" onClick={() => setTheme(v)}>
                {t(v === "dark" ? "theme_dark" : v === "light" ? "theme_light" : "theme_system")}
              </Button>
            ))}
          </div>
        )}
        {row(
          t("language"),
          <div className="flex gap-1">
            {(["en", "zh"] as Lang[]).map((v) => (
              <Button key={v} variant={lang === v ? "secondary" : "ghost"} size="sm" onClick={() => setLang(v)}>
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
  const [active, setActive] = useState(skills[0].id);
  const skill = skills.find((s) => s.id === active)!;
  return (
    <div className="flex gap-6">
      <div className="flex w-64 flex-col gap-2">
        <Input placeholder="Search skills…" />
        <div className="flex flex-col gap-0.5">
          {skills.map((s) => (
            <button
              key={s.id}
              onClick={() => setActive(s.id)}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                active === s.id && "bg-accent"
              )}
            >
              <Package className="size-4 shrink-0" />
              <span className="min-w-0">
                <span className="block truncate font-medium">{s.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{s.desc}</span>
              </span>
            </button>
          ))}
        </div>
        <Button variant="outline" size="sm">
          + Install
        </Button>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-semibold">{skill.name}</h3>
            <p className="text-sm text-muted-foreground">{skill.desc}</p>
          </div>
          <Switch
            checked={skill.enabled}
            onCheckedChange={(v) =>
              setSkills((prev) => prev.map((x) => (x.id === skill.id ? { ...x, enabled: v === true } : x)))
            }
          />
        </div>
        <div className="text-sm">
          <span className="text-muted-foreground">安装量 </span>
          {skill.installs}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm">
            Open SKILL.md
          </Button>
          <Button variant="outline" size="sm">
            Update
          </Button>
          <Button variant="destructive" size="sm" className="ml-auto">
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
}

function UsageSection() {
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof omo.usage.snapshot>> | null>(null);
  useEffect(() => {
    omo.usage.snapshot().then(setUsage).catch((error) => console.error("Usage unavailable", error));
  }, []);
  const t = usage?.totals ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const fmt = (n: number) => n.toLocaleString();
  const stats = [
    ["Processed tokens", fmt(t.input + t.output + t.cacheWrite)],
    ["Cached input", fmt(t.cacheRead)],
    ["Uncached input", fmt(t.input)],
    ["Output", fmt(t.output)],
    ["Cache savings", `$${t.cost.toFixed(2)}`],
  ];
  const providers = usage?.providers ?? [];
  const { quotas: quotaItems, refresh: refreshQuotas } = useQuotas();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Usage</h2>
        <Badge variant="secondary">Last 30 days</Badge>
      </div>
      <div>
        <div className="text-xs text-muted-foreground">RAW TOKEN COST</div>
        <div className="text-3xl font-semibold">${usage ? t.cost.toFixed(2) : "…"}*</div>
        <div className="text-xs text-muted-foreground">* if billed at full API rate</div>
      </div>
      <div className="grid grid-cols-5 divide-x rounded-lg border">
        {stats.map(([label, value]) => (
          <div key={label} className="p-4">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="text-xl">{value}</div>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">订阅配额</h3>
          <Button variant="ghost" size="sm" onClick={() => refreshQuotas(true)}>刷新</Button>
        </div>
        {quotaItems.filter((q) => q.success && q.windows.length).length === 0 ? (
          <div className="text-sm text-muted-foreground">暂无配额数据（仅订阅制 OAuth provider 支持）</div>
        ) : (
          quotaItems.filter((q) => q.success && q.windows.length).map((q) => (
            <div key={q.provider} className="flex flex-col gap-1 border-b border-border py-2 last:border-0">
              <span className="text-sm">{q.label}</span>
              {q.windows.map((w) => (
                <div key={w.label} className="flex items-center gap-3">
                  <span className="w-28 truncate text-xs text-muted-foreground">{w.label}</span>
                  <Progress value={w.usedPercent} className="flex-1">
                    <ProgressTrack className="h-1.5 bg-accent">
                      <ProgressIndicator className={w.usedPercent > 90 ? "bg-red-400" : w.usedPercent > 70 ? "bg-amber-400" : "bg-neutral-400"} />
                    </ProgressTrack>
                  </Progress>
                  <span className="w-32 text-right text-xs text-muted-foreground">
                    {Math.round(w.usedPercent)}% used · {formatReset(w.resetsAt)}
                  </span>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">按模型统计</h3>
        {providers.length === 0 ? <div className="text-sm text-muted-foreground">暂无已记录的 token 消耗</div> : providers.map((p) => (
          <div key={`${p.provider}/${p.model}`} className="flex items-center justify-between border-b py-2 text-sm">
            <span>{p.provider} / {p.model}</span><span>{fmt(p.tokens)} tokens · ${p.cost.toFixed(4)}</span>
          </div>
        ))}
      </div>
      <div>
        <h3 className="mb-2 text-sm font-medium">上下文使用分析</h3>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>会话</TableHead>
              <TableHead>峰值 ctx%</TableHead>
              <TableHead>系统提示</TableHead>
              <TableHead>工具结果</TableHead>
              <TableHead>优化建议</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>实现 SaaS blog MVP</TableCell>
              <TableCell>92%</TableCell>
              <TableCell>8k</TableCell>
              <TableCell>45k ⚠</TableCell>
              <TableCell>工具输出过大, 建议截断</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function PackagesSection() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Packages</h2>
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
              <Button variant="ghost" size="sm">
                更新
              </Button>
              <Button variant="ghost" size="sm">
                删除
              </Button>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}
