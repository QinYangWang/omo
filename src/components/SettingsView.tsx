import {
  ArrowLeft,
  ChartColumn,
  Copy,
  Cpu,
  KeyRound,
  Package,
  Palette,
  Pencil,
  Plus,
  RotateCcw,
  Server,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  formatReset,
  ProvidersSection,
  quotaColor,
  useQuotas,
} from "@/components/ProvidersSection";
import {
  ServerTabs,
  useSelectedServer,
} from "@/components/ServerTabs";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Progress,
  ProgressIndicator,
  ProgressTrack,
} from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type I18nKey, type Lang, useI18n } from "@/lib/i18n";
import {
  addRemoteServer,
  getServerApi,
  type OmoServer,
  removeRemoteServer,
  type ServerStatus,
  testServerConnection,
  updateRemoteServer,
  useServers,
  useServerStatuses,
} from "@/lib/servers";
import {
  type OverrideMode,
  exportThemeCss,
  type Theme,
  useTheme,
} from "@/lib/theme";
import {
  looksLikeColor,
  normalizeColorToHex,
  parseNumericValue,
  type SliderMeta,
  themeTokenGroups,
} from "@/lib/theme-tokens";
import { cn } from "@/lib/utils";

const sections = [
  ["section_appearance", "Appearance", Palette],
  ["section_servers", "Servers", Server],
  ["section_providers", "Providers", KeyRound],
  ["section_models", "Models", Cpu],
  ["section_skills", "Skills", Sparkles],
  ["section_usage", "Usage", ChartColumn],
  ["section_packages", "Packages", Package],
] as const;
type Section = (typeof sections)[number][1];
const themeLabels: Record<Theme, I18nKey> = {
  dark: "theme_dark",
  light: "theme_light",
  system: "theme_system",
};

export function SettingsView({
  onBack,
  sidebarOpen = true,
}: {
  onBack: () => void;
  sidebarOpen?: boolean;
}) {
  const { t } = useI18n();
  const [section, setSection] = useState<Section>("Servers");
  return (
    <div className="flex h-full bg-background">
      {sidebarOpen ? (
        <div className="flex w-60 shrink-0 flex-col bg-sidebar">
          <div className="px-2 pb-2">
            <Input placeholder={t("search_settings")} />
          </div>
          <nav className="flex flex-col gap-0.5 px-2">
            {sections.map(([key, s, Icon]) => (
              <button
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-left text-muted-foreground text-sm hover:bg-accent hover:text-foreground",
                  section === s && "bg-accent text-foreground"
                )}
                key={s}
                onClick={() => setSection(s)}
                type="button"
              >
                <Icon className="size-4 shrink-0" />
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
        <div className="mx-auto w-full max-w-3xl px-6 py-8">
          {section === "Servers" && <ServersSection />}
          {section === "Providers" && <ProvidersSection />}
          {section === "Models" && <ModelsSection />}
          {section === "Skills" && <SkillsSection />}
          {section === "Usage" && <UsageSection />}
          {section === "Packages" && <PackagesSection />}
          {section === "Appearance" && <AppearanceSection />}
        </div>
      </ScrollArea>
    </div>
  );
}

export function ServerStatusBadge({ status }: { status?: ServerStatus }) {
  const { t } = useI18n();
  const state = status?.state ?? "checking";
  return (
    <Badge className="gap-1.5" title={status?.error} variant="secondary">
      <span
        className={cn(
          "size-1.5 rounded-full",
          state === "online" && "bg-emerald-500",
          state === "offline" && "bg-red-400",
          state === "checking" && "animate-pulse bg-amber-400"
        )}
      />
      {state === "online"
        ? t("server_online")
        : state === "offline"
          ? t("server_offline")
          : t("server_checking")}
      {state === "online" && typeof status?.latencyMs === "number"
        ? ` · ${status.latencyMs}ms`
        : null}
    </Badge>
  );
}

function serverLabel(server: OmoServer, hosted: boolean) {
  if (server.kind === "remote") {
    return server.name;
  }
  return hosted ? "server_hosted" : "server_local";
}

function ServerFormDialog({
  onOpenChange,
  open,
  server,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  server: OmoServer | null;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName(server?.name ?? "");
      setUrl(server?.url ?? "");
      setToken(server?.token ?? "");
      setStatus("");
    }
  }, [open, server]);

  const test = async () => {
    setBusy(true);
    setStatus("…");
    try {
      const { latencyMs } = await testServerConnection(url, token);
      setStatus(`${t("server_online")} · ${latencyMs}ms`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setStatus("");
    try {
      if (server) {
        await updateRemoteServer(server.id, { name, token, url });
      } else {
        await addRemoteServer({ name, token, url });
      }
      onOpenChange(false);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {server ? t("server_edit") : t("server_add")}
          </DialogTitle>
          <DialogDescription>{t("servers_desc")}</DialogDescription>
        </DialogHeader>
        <label className="flex flex-col gap-2 text-sm" htmlFor="server-name">
          {t("server_name")}
          <Input
            disabled={server?.kind === "local"}
            id="server-name"
            onChange={(event) => setName(event.target.value)}
            placeholder="omo @ example"
            value={name}
          />
        </label>
        <label className="flex flex-col gap-2 text-sm" htmlFor="server-url">
          {t("server_url")}
          <Input
            disabled={server?.kind === "local"}
            id="server-url"
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://omo.example.com"
            value={url}
          />
        </label>
        <label className="flex flex-col gap-2 text-sm" htmlFor="server-token">
          {t("server_token")}
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
        <DialogFooter>
          <Button disabled={!url || busy} onClick={test} variant="outline">
            {t("server_test")}
          </Button>
          <Button disabled={!url || busy} onClick={save}>
            {t("server_save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ServersSection() {
  const { t } = useI18n();
  const servers = useServers();
  const statuses = useServerStatuses();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<OmoServer | null>(null);
  const hosted = !!window.__OMO_SERVER_URL__ && !window.omoSecure;

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-medium text-xl">{t("section_servers")}</h2>
          <p className="mt-1 text-muted-foreground text-sm">
            {t("servers_desc")}
          </p>
        </div>
        <Button
          className="shrink-0 gap-1.5"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
          size="sm"
        >
          <Plus className="size-4" /> {t("server_add")}
        </Button>
      </div>
      <div className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {servers.map((server) => (
          <div className="flex min-h-14 items-center gap-3 px-4 py-2" key={server.id}>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-sm">
                {server.kind === "local"
                  ? t(serverLabel(server, hosted) as I18nKey)
                  : server.name}
              </div>
              <div className="truncate text-muted-foreground text-xs">
                {server.kind === "local"
                  ? server.url || t("server_local_desc")
                  : server.url}
              </div>
            </div>
            <ServerStatusBadge status={statuses[server.id]} />
            {server.removable || server.url ? (
              <div className="flex gap-1">
                <Button
                  aria-label={t("server_edit")}
                  onClick={() => {
                    setEditing(server);
                    setDialogOpen(true);
                  }}
                  size="icon"
                  variant="ghost"
                >
                  <Pencil className="size-3.5" />
                </Button>
                {server.removable ? (
                  <Button
                    aria-label="Remove server"
                    onClick={() => removeRemoteServer(server.id)}
                    size="icon"
                    variant="ghost"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
        {servers.every((server) => server.kind === "local") ? (
          <p className="px-4 py-3 text-muted-foreground text-sm">
            {t("server_no_remote")}
          </p>
        ) : null}
      </div>
      <ServerFormDialog
        onOpenChange={setDialogOpen}
        open={dialogOpen}
        server={editing}
      />
    </div>
  );
}

function TokenEditor({
  mode,
  name,
  fallback,
  slider,
}: {
  fallback?: string;
  mode: OverrideMode;
  name: string;
  slider?: SliderMeta;
}) {
  const { overrides, setOverride } = useTheme();
  const override = overrides[mode][name];
  const computed =
    typeof getComputedStyle !== "undefined"
      ? getComputedStyle(document.documentElement).getPropertyValue(name).trim()
      : "";
  const base = computed || fallback || "";
  const value = override ?? base;
  const numeric = slider ? parseNumericValue(value) : null;
  const color =
    !slider && looksLikeColor(value) ? normalizeColorToHex(value) : null;
  const save = (next: string) =>
    setOverride(name, next === base ? null : next, mode);
  return (
    <div className="flex items-center gap-2 py-1.5">
      <span
        className="w-40 shrink-0 truncate font-mono text-muted-foreground text-xs"
        title={name}
      >
        {name.replace(/^--/, "")}
      </span>
      {color !== null ? (
        <label
          className="relative size-7 shrink-0 cursor-pointer overflow-hidden rounded-md border border-border"
          style={{ background: value }}
          title={value}
        >
          <input
            aria-label={name}
            className="absolute inset-0 cursor-pointer opacity-0"
            onChange={(event) => {
              const picked = event.target.value;
              const alpha = color.length === 9 ? color.slice(7) : "";
              save(`${picked}${alpha}`);
            }}
            type="color"
            value={color.slice(0, 7)}
          />
        </label>
      ) : numeric && slider ? (
        <input
          aria-label={name}
          className="h-7 w-36 shrink-0 accent-primary"
          max={slider.max}
          min={slider.min}
          onChange={(event) => save(`${event.target.value}${numeric.unit}`)}
          step={slider.step}
          type="range"
          value={numeric.num}
        />
      ) : (
        <span
          aria-hidden="true"
          className="size-7 shrink-0 rounded-md border border-border/40"
        />
      )}
      <Input
        className="h-7 flex-1 font-mono text-xs"
        onChange={(event) => save(event.target.value)}
        placeholder={base}
        value={value}
      />
      <Button
        aria-label="Reset token"
        className={cn("size-7", override === undefined && "invisible")}
        onClick={() => setOverride(name, null, mode)}
        size="icon"
        variant="ghost"
      >
        <RotateCcw className="size-3.5" />
      </Button>
    </div>
  );
}

function AppearanceSection() {
  const { t, lang, setLang } = useI18n();
  const {
    theme,
    setTheme,
    resolvedTheme,
    overrides,
    importCss,
    resetOverrides,
  } = useTheme();
  const [editMode, setEditMode] = useState<"dark" | "light">(resolvedTheme);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteCss, setPasteCss] = useState("");
  const [notice, setNotice] = useState("");
  const row = (label: string, control: React.ReactNode) => (
    <div className="flex items-center justify-between border-border border-b py-3 last:border-0">
      <span className="text-sm">{label}</span>
      {control}
    </div>
  );

  const exportTheme = async () => {
    await navigator.clipboard.writeText(exportThemeCss(overrides));
    setNotice(t("theme_copied"));
  };

  const applyPasted = () => {
    const count = importCss(pasteCss);
    setNotice(
      count > 0
        ? t("theme_imported", { count: String(count) })
        : t("theme_import_none")
    );
    if (count > 0) {
      setPasteOpen(false);
      setPasteCss("");
    }
  };

  return (
    <div className="flex flex-col gap-6">
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
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="font-medium text-sm">{t("theme_custom")}</h3>
            <p className="mt-1 text-muted-foreground text-xs">
              {t("theme_custom_desc")}
            </p>
          </div>
          <div className="flex shrink-0 gap-1">
            <Button onClick={() => setPasteOpen(true)} size="sm" variant="outline">
              {t("theme_import")}
            </Button>
            <Button
              className="gap-1.5"
              onClick={exportTheme}
              size="sm"
              variant="outline"
            >
              <Copy className="size-3.5" /> {t("theme_export")}
            </Button>
            <Button
              aria-label={t("theme_reset")}
              onClick={() => resetOverrides()}
              size="sm"
              variant="ghost"
            >
              <RotateCcw className="size-3.5" />
            </Button>
          </div>
        </div>
        {notice ? (
          <p className="text-muted-foreground text-xs">{notice}</p>
        ) : null}
        <div className="flex gap-1">
          {(["dark", "light"] as const).map((mode) => (
            <Button
              key={mode}
              onClick={() => setEditMode(mode)}
              size="sm"
              variant={editMode === mode ? "secondary" : "ghost"}
            >
              {t(themeLabels[mode])}
              {Object.keys(overrides[mode]).length > 0
                ? ` · ${Object.keys(overrides[mode]).length}`
                : ""}
            </Button>
          ))}
        </div>
        {themeTokenGroups.map((group) => (
          <div key={group.key}>
            <h4 className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
              {t(group.key as I18nKey)}
            </h4>
            <div className="divide-y divide-border/50">
              {group.tokens.map((token) => (
                <TokenEditor
                  fallback={token.fallback}
                  key={token.name}
                  mode={token.shared ? "shared" : editMode}
                  name={token.name}
                  slider={token.slider}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <Dialog onOpenChange={setPasteOpen} open={pasteOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("theme_import")}</DialogTitle>
            <DialogDescription>{t("theme_paste_desc")}</DialogDescription>
          </DialogHeader>
          <textarea
            autoFocus
            className="h-56 w-full resize-none rounded-md border border-border bg-background p-3 font-mono text-xs"
            onChange={(event) => setPasteCss(event.target.value)}
            placeholder={":root {\n  --background: oklch(1 0 0);\n  ...\n}\n\n.dark {\n  --background: oklch(0.145 0 0);\n  ...\n}"}
            value={pasteCss}
          />
          <DialogFooter>
            <Button onClick={() => setPasteOpen(false)} variant="ghost">
              Cancel
            </Button>
            <Button disabled={!pasteCss.trim()} onClick={applyPasted}>
              {t("theme_import_apply")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SkillsSection() {
  const [serverId, setServerId] = useSelectedServer();
  return (
    <div className="flex flex-col gap-5">
      <ServerTabs onChange={setServerId} value={serverId} />
      <ServerSkills key={serverId} serverId={serverId} />
    </div>
  );
}

function ServerSkills({ serverId }: { serverId: string }) {
  const { t } = useI18n();
  const [skills, setSkills] = useState<AgentSkillInfo[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    getServerApi(serverId)
      .skills.list()
      .then(setSkills)
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : String(cause))
      );
  }, [serverId]);
  const visible = skills.filter((skill) =>
    `${skill.name} ${skill.description}`
      .toLowerCase()
      .includes(query.toLowerCase())
  );
  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <div>
        <h2 className="font-medium text-xl">{t("section_skills")}</h2>
        <p className="mt-1 text-muted-foreground text-sm">
          {t("skills_desc")}
        </p>
      </div>
      <Input
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("search")}
        value={query}
      />
      {error ? <p className="text-red-400 text-sm">{error}</p> : null}
      <div className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {visible.map((skill) => (
          <div className="flex min-h-14 items-center gap-3 px-4 py-2" key={skill.filePath}>
            <Package className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-sm">{skill.name}</div>
              <div className="truncate text-muted-foreground text-xs">
                {skill.description || skill.filePath}
              </div>
            </div>
          </div>
        ))}
        {visible.length === 0 && !error ? (
          <p className="px-4 py-3 text-muted-foreground text-sm">
            {t("skills_empty")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ModelsSection() {
  const [serverId, setServerId] = useSelectedServer();
  return (
    <div className="flex flex-col gap-5">
      <ServerTabs onChange={setServerId} value={serverId} />
      <ServerModels key={serverId} serverId={serverId} />
    </div>
  );
}

function ServerModels({ serverId }: { serverId: string }) {
  const { t } = useI18n();
  const [models, setModels] = useState<AgentModelInfo[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getServerApi(serverId)
      .models.list()
      .then(setModels)
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : String(cause))
      );
  }, [serverId]);

  const apply = async (next: AgentModelInfo[]) => {
    setBusy(true);
    setError("");
    try {
      setModels(
        await getServerApi(serverId).models.setEnabled(
          next
            .filter((model) => model.enabled)
            .map((model) => `${model.provider}/${model.id}`)
        )
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (target: AgentModelInfo) =>
    apply(
      models.map((model) =>
        model === target ? { ...model, enabled: !model.enabled } : model
      )
    );
  const setAll = (enabled: boolean) =>
    apply(models.map((model) => ({ ...model, enabled })));

  const visible = models.filter((model) =>
    `${model.provider} ${model.name} ${model.id}`
      .toLowerCase()
      .includes(query.toLowerCase())
  );
  const enabledCount = models.filter((model) => model.enabled).length;
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="font-medium text-xl">{t("section_models")}</h2>
        <p className="mt-1 text-muted-foreground text-sm">
          {t("models_desc")}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Input
          className="flex-1"
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("search")}
          value={query}
        />
        <Button
          disabled={busy}
          onClick={() => setAll(true)}
          size="sm"
          variant="ghost"
        >
          {t("models_enable_all")}
        </Button>
        <Button
          disabled={busy}
          onClick={() => setAll(false)}
          size="sm"
          variant="ghost"
        >
          {t("models_disable_all")}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        {t("models_enabled_count", {
          enabled: String(enabledCount),
          total: String(models.length),
        })}
      </p>
      {error ? <p className="text-red-400 text-sm">{error}</p> : null}
      <div className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {visible.map((model) => (
          <div
            className="flex min-h-12 items-center gap-3 px-4 py-2"
            key={`${model.provider}/${model.id}`}
          >
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-sm">{model.name}</div>
              <div className="truncate text-muted-foreground text-xs">
                {model.provider}/{model.id}
              </div>
            </div>
            <Switch
              checked={model.enabled}
              disabled={busy}
              onCheckedChange={() => toggle(model)}
            />
          </div>
        ))}
        {visible.length === 0 ? (
          <p className="px-4 py-3 text-muted-foreground text-sm">
            {t("models_empty")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function PackagesSection() {
  const [serverId, setServerId] = useSelectedServer();
  return (
    <div className="flex flex-col gap-5">
      <ServerTabs onChange={setServerId} value={serverId} />
      <ServerPackages key={serverId} serverId={serverId} />
    </div>
  );
}

function ServerPackages({ serverId }: { serverId: string }) {
  const { t } = useI18n();
  const [packages, setPackages] = useState<AgentPackageInfo[]>([]);
  const [error, setError] = useState("");
  const [installOpen, setInstallOpen] = useState(false);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getServerApi(serverId)
      .packages.list()
      .then(setPackages)
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : String(cause))
      );
  }, [serverId]);

  const run = async (action: () => Promise<AgentPackageInfo[]>) => {
    setBusy(true);
    setError("");
    try {
      setPackages(await action());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-medium text-xl">{t("section_packages")}</h2>
          <p className="mt-1 text-muted-foreground text-sm">
            {t("packages_desc")}
          </p>
        </div>
        <Button
          className="shrink-0 gap-1.5"
          onClick={() => setInstallOpen(true)}
          size="sm"
        >
          <Plus className="size-4" /> {t("package_install")}
        </Button>
      </div>
      {error ? <p className="text-red-400 text-sm">{error}</p> : null}
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("server_name")}</TableHead>
              <TableHead>{t("package_version")}</TableHead>
              <TableHead>{t("package_source")}</TableHead>
              <TableHead className="text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {packages.map((pkg) => (
              <TableRow key={pkg.source}>
                <TableCell className="font-medium">{pkg.name}</TableCell>
                <TableCell>
                  {pkg.installedVersion ?? pkg.version ?? "—"}
                </TableCell>
                <TableCell>{pkg.kind}</TableCell>
                <TableCell className="text-right">
                  <Button
                    aria-label="Remove package"
                    disabled={busy}
                    onClick={() =>
                      run(() => getServerApi(serverId).packages.remove(pkg.source))
                    }
                    size="icon"
                    variant="ghost"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {packages.length === 0 ? (
          <p className="px-4 py-3 text-muted-foreground text-sm">
            {t("packages_empty")}
          </p>
        ) : null}
      </div>
      <Dialog onOpenChange={setInstallOpen} open={installOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("package_install")}</DialogTitle>
            <DialogDescription>{t("package_install_desc")}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            onChange={(event) => setSource(event.target.value)}
            onKeyDown={(event) =>
              event.key === "Enter" &&
              source &&
              run(async () => {
                const next = await getServerApi(serverId).packages.install(source.trim());
                setInstallOpen(false);
                setSource("");
                return next;
              })
            }
            placeholder="npm:@scope/pkg@1.0.0"
            value={source}
          />
          <DialogFooter>
            <Button
              disabled={!source.trim() || busy}
              onClick={() =>
                run(async () => {
                  const next = await getServerApi(serverId).packages.install(source.trim());
                  setInstallOpen(false);
                  setSource("");
                  return next;
                })
              }
            >
              {t("package_install")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

type UsageSnapshot = Awaited<
  ReturnType<omoApi["usage"]["snapshot"]>
>;

function ServerUsageCard({
  server,
  status,
}: {
  server: OmoServer;
  status?: ServerStatus;
}) {
  const { lang, t } = useI18n();
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const { quotas: quotaItems, refresh: refreshQuotas } = useQuotas(server.id);
  const offline = status?.state === "offline";
  useEffect(() => {
    if (offline) {
      setUsage(null);
      return;
    }
    getServerApi(server.id)
      .usage.snapshot()
      .then(setUsage)
      .catch((error) => console.error("Usage unavailable", error));
  }, [server.id, offline]);
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
  const hosted = !!window.__OMO_SERVER_URL__ && !window.omoSecure;
  const label =
    server.kind === "local"
      ? t(serverLabel(server, hosted) as I18nKey)
      : server.name;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold text-lg">{label}</h2>
          <ServerStatusBadge status={status} />
        </div>
        <Badge variant="secondary">{t("usage_period")}</Badge>
      </div>
      {offline ? (
        <div className="text-muted-foreground text-sm">
          {status?.error || t("server_offline")}
        </div>
      ) : null}
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

function UsageSection() {
  const servers = useServers();
  const statuses = useServerStatuses();
  return (
    <div className="flex flex-col gap-10">
      {servers.map((server) => (
        <div key={server.id}>
          <ServerUsageCard server={server} status={statuses[server.id]} />
        </div>
      ))}
    </div>
  );
}


