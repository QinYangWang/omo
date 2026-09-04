import { KeyRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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
import type { Lang } from "@/lib/i18n";
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
  return (
    <div className="flex flex-col gap-5">
      <ServerTabs onChange={setServerId} value={serverId} />
      <ServerProviders key={serverId} serverId={serverId} />
    </div>
  );
}

function ServerProviders({ serverId }: { serverId: string }) {
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
          text: `Enter code ${event.event.userCode} in the opened browser`,
        });
      }
    });
  }, [refresh, api.providers.onAuthEvent]);

  const login = async (provider: ProviderInfo, type: "api_key" | "oauth") => {
    setBusy(provider.id);
    setMessage({
      text: type === "oauth" ? "Opening browser…" : "Waiting for credentials…",
    });
    try {
      await api.providers.login(provider.id, type);
      setMessage({ text: `${provider.name} connected` });
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
      <div>
        <h2 className="font-medium text-xl">Providers</h2>
        <p className="mt-1 text-muted-foreground text-sm">
          Authentication is managed by Pi and stored in ~/.pi/agent/auth.json.
        </p>
      </div>
      <Input
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search providers…"
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
            <span
              className={cn(
                "size-2 rounded-full",
                provider.connected ? "bg-success" : "bg-muted-foreground/40"
              )}
            />
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
                Logout
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
                    <KeyRound className="size-3.5" /> API Key
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
            <DialogTitle>Provider authentication</DialogTitle>
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
                Continue
              </Button>
            </DialogFooter>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
