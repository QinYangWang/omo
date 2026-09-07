import { KeyRoundIcon, Loading03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useState } from "react";
import { ProviderAvatar } from "@/components/provider-icon";
import { ServerTabs, useSelectedServer } from "@/components/ServerTabs";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type Lang, useI18n } from "@/lib/i18n";
import { getServerApi } from "@/lib/servers";
import { cn } from "@/lib/utils";

export const quotaColor = (usedPercent: number) => {
  if (usedPercent > 90) {
    return "bg-destructive";
  }
  if (usedPercent > 70) {
    return "bg-warning";
  }
  return "bg-muted-foreground/50";
};

export function formatReset(iso: string, lang: Lang = "en") {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) {
    return lang === "zh" ? "即将重置" : "soon";
  }
  const h = Math.ceil(diff / 3_600_000);
  if (h < 24) {
    return lang === "zh" ? `${h} 小时后` : `in ${h}h`;
  }
  const d = Math.ceil(diff / 86_400_000);
  if (d < 7) {
    return lang === "zh" ? `${d} 天后` : `in ${d}d`;
  }
  return new Date(iso).toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US", {
    day: "numeric",
    month: "short",
  });
}

export function useQuotas(serverId?: string) {
  const [quotas, setQuotas] = useState<QuotaItem[]>([]);
  const [installed, setInstalled] = useState(true);
  const refresh = useCallback(
    async (force = false) => {
      const result = await getServerApi(serverId).providers.quotas(force);
      setInstalled(result.installed);
      setQuotas(result.items);
    },
    [serverId]
  );
  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);
  return { installed, quotas, refresh };
}

export function ProvidersSection() {
  const [serverId, setServerId] = useSelectedServer();
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-5">
      <ServerTabs onChange={setServerId} value={serverId} />
      <Tabs defaultValue="add" key={serverId}>
        <TabsList>
          <TabsTrigger value="add">{t("providers_add_tab")}</TabsTrigger>
          <TabsTrigger value="quota">{t("providers_quota_tab")}</TabsTrigger>
        </TabsList>
        <TabsContent className="pt-5" value="add">
          <ServerProviders serverId={serverId} />
        </TabsContent>
        <TabsContent className="pt-5" value="quota">
          <ProviderQuotas serverId={serverId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

const formatMoney = (value: number) =>
  `$${value.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;

/** Subscription quota windows and balance for providers with a balance API. */
function ProviderQuotas({ serverId }: { serverId: string }) {
  const { lang, t } = useI18n();
  const { quotas, refresh } = useQuotas(serverId);
  const [refreshing, setRefreshing] = useState(false);
  const items = quotas.filter((q) => q.success && q.windows.length > 0);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          {t("usage_subscription_quota")}
        </p>
        <Button
          disabled={refreshing}
          onClick={async () => {
            setRefreshing(true);
            try {
              await refresh(true);
            } finally {
              setRefreshing(false);
            }
          }}
          size="sm"
          variant="ghost"
        >
          {refreshing ? (
            <HugeiconsIcon
              className="size-3.5 animate-spin"
              icon={Loading03Icon}
            />
          ) : null}
          {t("refresh")}
        </Button>
      </div>
      {items.length === 0 ? (
        <div className="py-6 text-center text-muted-foreground text-sm">
          {t("usage_no_quota")}
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-border">
          {items.map((item) => (
            <div className="flex flex-col gap-2 py-3" key={item.provider}>
              <div className="flex items-center gap-2.5">
                <ProviderAvatar provider={item.provider} size={24} />
                <span className="font-medium text-sm">{item.label}</span>
              </div>
              {item.windows.map((w) =>
                w.isCurrency && w.windowSeconds === 0 ? (
                  // Pure balance window (e.g. OpenRouter credits)
                  <div
                    className="flex items-center gap-3 pl-[34px]"
                    key={w.label}
                  >
                    <span className="w-28 truncate text-muted-foreground text-xs">
                      {w.label}
                    </span>
                    <span className="text-sm tabular-nums">
                      {t("quota_balance")} {formatMoney(w.usedValue)}
                    </span>
                  </div>
                ) : (
                  <div
                    className="flex items-center gap-3 pl-[34px]"
                    key={w.label}
                  >
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
                    <span className="w-44 text-right text-muted-foreground text-xs tabular-nums">
                      {w.isCurrency
                        ? `${formatMoney(w.usedValue)} / ${formatMoney(w.limitValue)} · `
                        : ""}
                      {Math.round(w.usedPercent)}% {t("usage_used")} ·{" "}
                      {formatReset(w.resetsAt, lang)}
                    </span>
                  </div>
                )
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ServerProviders({ serverId }: { serverId: string }) {
  const { t } = useI18n();
  const api = getServerApi(serverId);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState<{ text: string; error?: boolean }>();
  const [authPrompt, setAuthPrompt] =
    useState<Extract<ProviderAuthEvent, { kind: "prompt" }>>();
  const [answer, setAnswer] = useState("");

  const refresh = useCallback(
    () => api.providers.list().then(setProviders),
    [api]
  );
  useEffect(() => {
    refresh();
    return api.providers.onAuthEvent((event) => {
      if (event.kind === "prompt") {
        setAnswer("");
        setAuthPrompt(event);
        return;
      }
      if (event.event.type === "progress" || event.event.type === "info") {
        setMessage({ text: event.event.message });
        return;
      }
      if (event.event.type === "device_code") {
        setMessage({
          text: t("providers_device_code", {
            code: event.event.userCode,
          }),
        });
      }
    });
  }, [refresh, api.providers.onAuthEvent, t]);

  const login = async (provider: ProviderInfo, type: "api_key" | "oauth") => {
    setBusy(provider.id);
    setMessage({
      text: t(
        type === "oauth"
          ? "providers_opening_browser"
          : "providers_waiting_credentials"
      ),
    });
    try {
      await api.providers.login(provider.id, type);
      setMessage({
        text: t("providers_connected_msg", { name: provider.name }),
      });
      await refresh();
    } catch (error) {
      setMessage({
        error: true,
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(undefined);
    }
  };

  const respond = async (value: string) => {
    if (!authPrompt) {
      return;
    }
    await api.providers.respond(authPrompt.requestId, value);
    setAuthPrompt(undefined);
  };

  const visible = providers
    .filter((provider) =>
      `${provider.name} ${provider.id}`
        .toLowerCase()
        .includes(query.toLowerCase())
    )
    .sort(
      (a, b) =>
        Number(b.connected) - Number(a.connected) ||
        a.name.localeCompare(b.name)
    );

  return (
    <div className="flex flex-col gap-5">
      <p className="text-muted-foreground text-sm">
        {t("providers_auth_note")}
      </p>
      <Input
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("providers_search")}
        value={query}
      />
      {message ? (
        <p
          className={cn(
            "text-sm",
            message.error ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {message.text}
        </p>
      ) : null}
      <div className="flex flex-col divide-y divide-border">
        {visible.map((provider) => (
          <div
            className="flex min-h-14 items-center gap-3 py-2"
            key={provider.id}
          >
            <ProviderAvatar provider={provider.id} size={28} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-sm">
                {provider.name}
              </div>
              <div className="truncate text-muted-foreground text-xs">
                {provider.source || provider.id}
              </div>
            </div>
            {provider.connected ? (
              <Badge variant="secondary">{provider.authType}</Badge>
            ) : null}
            {provider.connected ? (
              <Button
                disabled={busy === provider.id}
                onClick={async () => {
                  setBusy(provider.id);
                  try {
                    await api.providers.logout(provider.id);
                    await refresh();
                  } finally {
                    setBusy(undefined);
                  }
                }}
                size="sm"
                variant="ghost"
              >
                {t("providers_disconnect")}
              </Button>
            ) : (
              <div className="flex gap-1">
                {provider.hasOAuth ? (
                  <Button
                    disabled={!!busy}
                    onClick={() => login(provider, "oauth")}
                    size="sm"
                    variant="ghost"
                  >
                    OAuth
                  </Button>
                ) : null}
                {provider.hasApiKey ? (
                  <Button
                    disabled={!!busy}
                    onClick={() => login(provider, "api_key")}
                    size="sm"
                    variant="ghost"
                  >
                    <HugeiconsIcon className="size-3.5" icon={KeyRoundIcon} />{" "}
                    API Key
                  </Button>
                ) : null}
              </div>
            )}
          </div>
        ))}
      </div>

      <Dialog
        onOpenChange={(open) => {
          if (!open && authPrompt) {
            api.providers.cancel(authPrompt.requestId);
            setAuthPrompt(undefined);
          }
        }}
        open={!!authPrompt}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("providers_auth_dialog")}</DialogTitle>
            <DialogDescription>{authPrompt?.prompt.message}</DialogDescription>
          </DialogHeader>
          {authPrompt?.prompt.type === "select" ? (
            <div className="flex flex-col gap-1">
              {authPrompt.prompt.options?.map((option) => (
                <Button
                  className="h-auto justify-start py-2 text-left"
                  key={option.id}
                  onClick={() => respond(option.id)}
                  variant="ghost"
                >
                  <span>
                    <span className="block">{option.label}</span>
                    {option.description ? (
                      <span className="block text-muted-foreground text-xs">
                        {option.description}
                      </span>
                    ) : null}
                  </span>
                </Button>
              ))}
            </div>
          ) : (
            <Input
              autoFocus
              onChange={(event) => setAnswer(event.target.value)}
              onKeyDown={(event) =>
                event.key === "Enter" && answer && respond(answer)
              }
              placeholder={authPrompt?.prompt.placeholder}
              type={authPrompt?.prompt.type === "secret" ? "password" : "text"}
              value={answer}
            />
          )}
          {authPrompt && authPrompt.prompt.type !== "select" ? (
            <DialogFooter>
              <Button disabled={!answer} onClick={() => respond(answer)}>
                {t("providers_continue")}
              </Button>
            </DialogFooter>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
