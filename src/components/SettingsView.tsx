import {
  Add01Icon,
  Archive01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ChartColumnIcon,
  Copy01Icon,
  CpuIcon,
  Delete02Icon,
  KeyRoundIcon,
  Loading03Icon,
  PackageIcon,
  PaintBoardIcon,
  PencilEdit01Icon,
  PiIcon,
  RotateCcwIcon,
  ServerStack01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { PanelDivider } from "@/components/PanelDivider";
import { ProvidersSection } from "@/components/ProvidersSection";
import { ServerTabs, useSelectedServer } from "@/components/ServerTabs";
import { ServerStatusBadge } from "@/components/server-status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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
import { Textarea } from "@/components/ui/textarea";
import { type I18nKey, type Lang, useI18n } from "@/lib/i18n";
import {
  addRemoteServer,
  getServerApi,
  type OmoServer,
  removeRemoteServer,
  type ServerStatus,
  testServerConnection,
  updateRemoteServer,
  useServerStatuses,
  useServers,
} from "@/lib/servers";
import { setSessionPref, useSessionPrefs } from "@/lib/session-prefs";
import {
  exportThemeCss,
  type OverrideMode,
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
  ["section_appearance", "Appearance", PaintBoardIcon],
  ["section_archived", "Archived", Archive01Icon],
  ["section_servers", "Servers", ServerStack01Icon],
  ["section_providers", "Providers", KeyRoundIcon],
  ["section_models", "Models", CpuIcon],
  ["section_skills", "Skills", PiIcon],
  ["section_usage", "Usage", ChartColumnIcon],
  ["section_packages", "Packages", PackageIcon],
] as const;
type Section = (typeof sections)[number][1];
const themeLabels: Record<Theme, I18nKey> = {
  dark: "theme_dark",
  light: "theme_light",
  system: "theme_system",
};
const tokenNamePattern = /^--/;

export function SettingsView({
  onBack,
  onResizeSidebar,
  sidebarOpen = true,
  sidebarWidth = 310,
}: {
  onBack: () => void;
  onResizeSidebar: (dx: number) => void;
  sidebarOpen?: boolean;
  sidebarWidth?: number;
}) {
  const { t } = useI18n();
  const [section, setSection] = useState<Section>("Servers");
  return (
    <div className="relative flex h-full min-h-0 overflow-hidden bg-sidebar">
      {sidebarOpen ? (
        <div
          className="flex shrink-0 flex-col bg-sidebar text-sidebar-foreground"
          style={{ width: sidebarWidth }}
        >
          <nav className="flex flex-col gap-1 p-2">
            {sections.map(([key, s, Icon]) => (
              <Button
                className={cn(
                  "h-8 justify-start gap-2 rounded-lg px-2 font-normal text-sidebar-foreground text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  section === s &&
                    "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                )}
                key={s}
                onClick={() => setSection(s)}
                variant="ghost"
              >
                <HugeiconsIcon className="size-4 shrink-0" icon={Icon} />
                {t(key as I18nKey)}
              </Button>
            ))}
          </nav>
          <div className="mt-auto p-2">
            <Button
              className="h-8 w-full justify-start gap-2 px-2 font-normal text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              onClick={onBack}
              type="button"
              variant="ghost"
            >
              <HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />{" "}
              {t("back")}
            </Button>
          </div>
        </div>
      ) : null}
      {sidebarOpen ? (
        <PanelDivider
          className="top-0 bg-transparent hover:bg-transparent group-hover:bg-transparent"
          onDrag={onResizeSidebar}
        />
      ) : null}
      <div className="flex min-w-0 flex-1 p-2">
        <main className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-xl border bg-background shadow-sm/5">
          <ScrollArea className="h-full">
            <div className="mx-auto w-full max-w-3xl px-6 py-8">
              {section === "Servers" && <ServersSection />}
              {section === "Providers" && <ProvidersSection />}
              {section === "Models" && <ModelsSection />}
              {section === "Skills" && <SkillsSection />}
              {section === "Usage" && <UsageSection />}
              {section === "Packages" && <PackagesSection />}
              {section === "Appearance" && <AppearanceSection />}
              {section === "Archived" && <ArchivedSection />}
            </div>
          </ScrollArea>
        </main>
      </div>
    </div>
  );
}

function ArchivedSection() {
  const { t } = useI18n();
  const prefs = useSessionPrefs();
  const archived = Object.entries(prefs).filter(([, pref]) => pref.archived);
  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <div>
        <h2 className="font-medium text-xl">{t("section_archived")}</h2>
        <p className="mt-1 text-muted-foreground text-sm">
          {t("archived_desc")}
        </p>
      </div>
      {archived.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("archived_empty")}</p>
      ) : (
        <div className="flex flex-col gap-1">
          {archived.map(([key, pref]) => (
            <div
              className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
              key={key}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">
                  {pref.title || t("untitled")}
                </div>
                {pref.project ? (
                  <div className="truncate text-muted-foreground text-xs">
                    {pref.project}
                  </div>
                ) : null}
              </div>
              <Button
                className="shrink-0"
                onClick={() => setSessionPref(key, { archived: false })}
                size="sm"
                variant="outline"
              >
                {t("restore")}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
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
      <DialogContent className="max-w-md">
        <DialogHeader className="pb-4">
          <div className="flex items-start gap-3 pr-8">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">
              <HugeiconsIcon className="size-5" icon={ServerStack01Icon} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <DialogTitle>
                {server ? t("server_edit") : t("server_add")}
              </DialogTitle>
              <DialogDescription>{t("servers_desc")}</DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (url && !busy) {
              save();
            }
          }}
        >
          <DialogPanel className="flex flex-col gap-4">
            <label
              className="flex flex-col gap-2 font-medium text-sm"
              htmlFor="server-name"
            >
              {t("server_name")}
              <Input
                disabled={server?.kind === "local" || busy}
                id="server-name"
                onChange={(event) => setName(event.target.value)}
                placeholder="omo @ example"
                value={name}
              />
            </label>
            <label
              className="flex flex-col gap-2 font-medium text-sm"
              htmlFor="server-url"
            >
              {t("server_url")}
              <Input
                disabled={server?.kind === "local" || busy}
                id="server-url"
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://omo.example.com"
                value={url}
              />
            </label>
            <label
              className="flex flex-col gap-2 font-medium text-sm"
              htmlFor="server-token"
            >
              {t("server_token")}
              <Input
                disabled={busy}
                id="server-token"
                onChange={(event) => setToken(event.target.value)}
                placeholder="Bearer token"
                type="password"
                value={token}
              />
            </label>
            {status ? (
              <p className="rounded-lg bg-muted px-3 py-2 text-muted-foreground text-sm">
                {status}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter variant="bare">
            <DialogClose render={<Button type="button" variant="outline" />}>
              {t("cancel")}
            </DialogClose>
            <Button
              disabled={!url || busy}
              onClick={test}
              type="button"
              variant="outline"
            >
              {t("server_test")}
            </Button>
            <Button disabled={!url || busy} type="submit">
              {busy ? (
                <HugeiconsIcon
                  className="animate-spin"
                  data-icon="inline-start"
                  icon={Loading03Icon}
                />
              ) : null}
              {t("server_save")}
            </Button>
          </DialogFooter>
        </form>
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
          <HugeiconsIcon className="size-4" icon={Add01Icon} />{" "}
          {t("server_add")}
        </Button>
      </div>
      <div className="flex flex-col divide-y divide-border">
        {servers.map((server) => (
          <div
            className="flex min-h-14 items-center gap-3 py-2"
            key={server.id}
          >
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
                  <HugeiconsIcon className="size-3.5" icon={PencilEdit01Icon} />
                </Button>
                {server.removable ? (
                  <Button
                    aria-label="Remove server"
                    onClick={() => removeRemoteServer(server.id)}
                    size="icon"
                    variant="ghost"
                  >
                    <HugeiconsIcon className="size-3.5" icon={Delete02Icon} />
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
        {servers.every((server) => server.kind === "local") ? (
          <p className="py-3 text-muted-foreground text-sm">
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
    typeof getComputedStyle === "undefined"
      ? ""
      : getComputedStyle(document.documentElement)
          .getPropertyValue(name)
          .trim();
  const base = computed || fallback || "";
  const value = override ?? base;
  const numeric = slider ? parseNumericValue(value) : null;
  const color =
    !slider && looksLikeColor(value) ? normalizeColorToHex(value) : null;
  const save = (next: string) =>
    setOverride(name, next === base ? null : next, mode);
  let control: React.ReactNode;
  if (color !== null) {
    control = (
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
    );
  } else if (numeric && slider) {
    control = (
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
    );
  } else {
    control = (
      <span
        aria-hidden="true"
        className="size-7 shrink-0 rounded-md border border-border/40"
      />
    );
  }
  return (
    <div className="flex items-center gap-2 py-1.5">
      <span
        className="w-40 shrink-0 truncate font-mono text-muted-foreground text-xs"
        title={name}
      >
        {name.replace(tokenNamePattern, "")}
      </span>
      {control}
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
        <HugeiconsIcon className="size-3.5" icon={RotateCcwIcon} />
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
            <Button
              onClick={() => setPasteOpen(true)}
              size="sm"
              variant="outline"
            >
              {t("theme_import")}
            </Button>
            <Button
              className="gap-1.5"
              onClick={exportTheme}
              size="sm"
              variant="outline"
            >
              <HugeiconsIcon className="size-3.5" icon={Copy01Icon} />{" "}
              {t("theme_export")}
            </Button>
            <Button
              aria-label={t("theme_reset")}
              onClick={() => resetOverrides()}
              size="sm"
              variant="ghost"
            >
              <HugeiconsIcon className="size-3.5" icon={RotateCcwIcon} />
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
          <DialogHeader className="pb-4">
            <div className="flex items-start gap-3 pr-8">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">
                <HugeiconsIcon className="size-5" icon={PaintBoardIcon} />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <DialogTitle>{t("theme_import")}</DialogTitle>
                <DialogDescription>{t("theme_paste_desc")}</DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault();
              if (pasteCss.trim()) {
                applyPasted();
              }
            }}
          >
            <DialogPanel>
              <Textarea
                autoFocus
                className="h-56 resize-none font-mono text-xs"
                onChange={(event) => setPasteCss(event.target.value)}
                placeholder={
                  ":root {\n  --background: oklch(1 0 0);\n  ...\n}\n\n.dark {\n  --background: oklch(0.145 0 0);\n  ...\n}"
                }
                value={pasteCss}
              />
            </DialogPanel>
            <DialogFooter variant="bare">
              <DialogClose render={<Button type="button" variant="outline" />}>
                {t("cancel")}
              </DialogClose>
              <Button disabled={!pasteCss.trim()} type="submit">
                {t("theme_import_apply")}
              </Button>
            </DialogFooter>
          </form>
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
        <p className="mt-1 text-muted-foreground text-sm">{t("skills_desc")}</p>
      </div>
      <Input
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("search")}
        value={query}
      />
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
      <div className="flex flex-col divide-y divide-border">
        {visible.map((skill) => (
          <div
            className="flex min-h-14 items-center gap-3 py-2"
            key={skill.filePath}
          >
            <HugeiconsIcon
              className="size-4 shrink-0 text-muted-foreground"
              icon={PackageIcon}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-sm">{skill.name}</div>
              <div className="truncate text-muted-foreground text-xs">
                {skill.description || skill.filePath}
              </div>
            </div>
          </div>
        ))}
        {visible.length === 0 && !error ? (
          <p className="py-3 text-muted-foreground text-sm">
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
  const [collapsedGroups, setCollapsedGroups] = useState<
    Record<string, boolean>
  >({});
  const groups = new Map<string, AgentModelInfo[]>();
  for (const model of visible) {
    const group = groups.get(model.provider) ?? [];
    group.push(model);
    groups.set(model.provider, group);
  }
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="font-medium text-xl">{t("section_models")}</h2>
        <p className="mt-1 text-muted-foreground text-sm">{t("models_desc")}</p>
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
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
      <div className="flex flex-col gap-5">
        {[...groups].map(([provider, items]) => (
          <Collapsible
            key={provider}
            onOpenChange={(open) =>
              setCollapsedGroups((current) => ({
                ...current,
                [provider]: !open,
              }))
            }
            open={!collapsedGroups[provider]}
          >
            <section>
              <CollapsibleTrigger className="group flex w-full items-center justify-between px-1 pb-1.5 text-muted-foreground text-xs">
                <span className="flex items-center gap-1.5">
                  <HugeiconsIcon
                    className="size-3.5 transition-transform group-aria-expanded:rotate-90"
                    icon={ArrowRight01Icon}
                  />
                  <span className="font-medium uppercase tracking-wide">
                    {provider}
                  </span>
                </span>
                <span>
                  {items.filter((model) => model.enabled).length}/{items.length}
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="flex flex-col divide-y divide-border rounded-lg border">
                  {items.map((model) => (
                    <div
                      className="flex min-h-12 items-center gap-3 px-3 py-2"
                      key={`${model.provider}/${model.id}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-sm">
                          {model.name}
                        </div>
                        <div className="truncate text-muted-foreground text-xs">
                          {model.id}
                        </div>
                      </div>
                      <Switch
                        checked={model.enabled}
                        disabled={busy}
                        onCheckedChange={() => toggle(model)}
                      />
                    </div>
                  ))}
                </div>
              </CollapsibleContent>
            </section>
          </Collapsible>
        ))}
        {visible.length === 0 ? (
          <p className="py-3 text-muted-foreground text-sm">
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

  const installPackage = () =>
    run(async () => {
      const next = await getServerApi(serverId).packages.install(source.trim());
      setInstallOpen(false);
      setSource("");
      return next;
    });

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
          <HugeiconsIcon className="size-4" icon={Add01Icon} />{" "}
          {t("package_install")}
        </Button>
      </div>
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
      <div>
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
                  {pkg.installedVersion ?? pkg.version ?? "n/a"}
                </TableCell>
                <TableCell>{pkg.kind}</TableCell>
                <TableCell className="text-right">
                  <Button
                    aria-label="Remove package"
                    disabled={busy}
                    onClick={() =>
                      run(() =>
                        getServerApi(serverId).packages.remove(pkg.source)
                      )
                    }
                    size="icon"
                    variant="ghost"
                  >
                    <HugeiconsIcon className="size-3.5" icon={Delete02Icon} />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {packages.length === 0 ? (
          <p className="py-3 text-muted-foreground text-sm">
            {t("packages_empty")}
          </p>
        ) : null}
      </div>
      <Dialog onOpenChange={setInstallOpen} open={installOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader className="pb-4">
            <div className="flex items-start gap-3 pr-8">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">
                <HugeiconsIcon className="size-5" icon={PackageIcon} />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <DialogTitle>{t("package_install")}</DialogTitle>
                <DialogDescription>
                  {t("package_install_desc")}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault();
              if (source.trim() && !busy) {
                installPackage();
              }
            }}
          >
            <DialogPanel>
              <Input
                autoFocus
                disabled={busy}
                onChange={(event) => setSource(event.target.value)}
                placeholder="npm:@scope/pkg@1.0.0"
                value={source}
              />
            </DialogPanel>
            <DialogFooter variant="bare">
              <DialogClose render={<Button type="button" variant="outline" />}>
                {t("cancel")}
              </DialogClose>
              <Button disabled={!source.trim() || busy} type="submit">
                {busy ? (
                  <HugeiconsIcon
                    className="animate-spin"
                    data-icon="inline-start"
                    icon={Loading03Icon}
                  />
                ) : null}
                {t("package_install")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

type UsageSnapshot = Awaited<ReturnType<omoApi["usage"]["snapshot"]>>;

function ServerUsageCard({
  server,
  status,
}: {
  server: OmoServer;
  status?: ServerStatus;
}) {
  const { lang, t } = useI18n();
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
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
    savings: 0,
  };
  const fmt = (n: number) =>
    new Intl.NumberFormat(lang, {
      maximumFractionDigits: 1,
      notation: "compact",
    }).format(n);
  const stats = [
    [
      t("usage_processed_tokens"),
      fmt(totals.input + totals.output + totals.cacheWrite),
    ],
    [t("usage_cached_input"), fmt(totals.cacheRead)],
    [t("usage_uncached_input"), fmt(totals.input)],
    [t("usage_output"), fmt(totals.output)],
    [t("usage_cache_savings"), `$${totals.savings.toFixed(2)}`],
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
        {stats.map(([statLabel, statValue]) => (
          <div className="min-w-0 p-4" key={statLabel}>
            <div className="truncate text-muted-foreground text-xs">
              {statLabel}
            </div>
            <div className="truncate text-xl" title={statValue}>
              {statValue}
            </div>
          </div>
        ))}
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
