import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress, ProgressIndicator, ProgressTrack } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

export function formatReset(iso: string) {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "soon";
  const h = Math.ceil(diff / 3_600_000);
  if (h < 24) return `in ${h}h`;
  const d = Math.ceil(diff / 86_400_000);
  if (d < 7) return `in ${d}d`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function useQuotas() {
  const [quotas, setQuotas] = useState<QuotaItem[]>([]);
  const [installed, setInstalled] = useState(true);
  const refresh = async (force = false) => {
    const result = await window.omo.providers.quotas(force);
    setInstalled(result.installed);
    setQuotas(result.items);
  };
  useEffect(() => { refresh(); }, []);
  return { quotas, installed, refresh };
}

export function QuotaWindows({ providerId, quotas }: { providerId: string; quotas: QuotaItem[] }) {
  const item = quotas.find((q) => q.provider === providerId);
  if (!item) return null;
  if (!item.success) {
    return item.error?.kind === "not_applicable" ? null : (
      <span className="max-w-48 truncate text-xs text-muted-foreground" title={item.error?.message}>{item.error?.message}</span>
    );
  }
  if (!item.windows.length) return null;
  return (
    <div className="flex w-44 flex-col gap-1">
      {item.windows.slice(0, 2).map((w) => (
        <div key={w.label} className="flex items-center gap-2">
          <Progress value={w.usedPercent} className="flex-1">
            <ProgressTrack className="h-1.5 bg-white/[0.07]">
              <ProgressIndicator className={w.usedPercent > 90 ? "bg-red-400" : w.usedPercent > 70 ? "bg-amber-400" : "bg-neutral-400"} />
            </ProgressTrack>
          </Progress>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {w.label} {Math.round(w.usedPercent)}% · {formatReset(w.resetsAt)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ProvidersSection() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState<{ text: string; error?: boolean }>();
  const [authPrompt, setAuthPrompt] = useState<any>();
  const [answer, setAnswer] = useState("");
  const { quotas, refresh: refreshQuotas } = useQuotas();

  const refresh = () => window.omo.providers.list().then(setProviders);
  useEffect(() => {
    refresh();
    return window.omo.providers.onAuthEvent((event) => {
      if (event.kind === "prompt") {
        setAnswer("");
        setAuthPrompt(event);
      } else if (event.event?.type === "progress" || event.event?.type === "info") {
        setMessage({ text: event.event.message });
      } else if (event.event?.type === "device_code") {
        setMessage({ text: `Enter code ${event.event.userCode} in the opened browser` });
      }
    });
  }, []);

  const login = async (provider: ProviderInfo, type: "api_key" | "oauth") => {
    setBusy(provider.id);
    setMessage({ text: type === "oauth" ? "Opening browser…" : "Waiting for credentials…" });
    try {
      await window.omo.providers.login(provider.id, type);
      setMessage({ text: `${provider.name} connected` });
      await refresh();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : String(error), error: true });
    } finally {
      setBusy(undefined);
    }
  };

  const respond = async (value: string) => {
    await window.omo.providers.respond(authPrompt.requestId, value);
    setAuthPrompt(undefined);
  };

  const visible = providers
    .filter((provider) => `${provider.name} ${provider.id}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name));

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-xl font-medium">Providers</h2>
        <p className="mt-1 text-sm text-muted-foreground">Authentication is managed by Pi and stored in ~/.pi/agent/auth.json.</p>
      </div>
      <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search providers…" />
      {message && <p className={cn("text-sm", message.error ? "text-red-400" : "text-muted-foreground")}>{message.text}</p>}
      <div className="flex flex-col divide-y divide-white/[0.05] overflow-hidden rounded-xl border border-white/[0.06] bg-[#1d1d1d]">
        {visible.map((provider) => (
          <div key={provider.id} className="flex min-h-14 items-center gap-3 px-4 py-2">
            <span className={cn("size-2 rounded-full", provider.connected ? "bg-emerald-500" : "bg-neutral-600")} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{provider.name}</div>
              <div className="truncate text-xs text-muted-foreground">{provider.source || provider.id}</div>
            </div>
            {provider.connected && <Badge variant="secondary">{provider.authType}</Badge>}
            {provider.connected && <QuotaWindows providerId={provider.id} quotas={quotas} />}
            {provider.connected ? (
              <Button variant="ghost" size="sm" disabled={busy === provider.id} onClick={async () => {
                setBusy(provider.id);
                try { await window.omo.providers.logout(provider.id); await refresh(); }
                finally { setBusy(undefined); }
              }}>Logout</Button>
            ) : (
              <div className="flex gap-1">
                {provider.hasOAuth && <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => login(provider, "oauth")}>OAuth</Button>}
                {provider.hasApiKey && <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => login(provider, "api_key")}><KeyRound className="size-3.5" /> API Key</Button>}
              </div>
            )}
          </div>
        ))}
      </div>

      <Dialog open={!!authPrompt} onOpenChange={(open) => {
        if (!open && authPrompt) {
          window.omo.providers.cancel(authPrompt.requestId);
          setAuthPrompt(undefined);
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Provider authentication</DialogTitle>
            <DialogDescription>{authPrompt?.prompt?.message}</DialogDescription>
          </DialogHeader>
          {authPrompt?.prompt?.type === "select" ? (
            <div className="flex flex-col gap-1">
              {authPrompt.prompt.options.map((option: any) => (
                <Button key={option.id} variant="ghost" className="h-auto justify-start py-2 text-left" onClick={() => respond(option.id)}>
                  <span><span className="block">{option.label}</span>{option.description && <span className="block text-xs text-muted-foreground">{option.description}</span>}</span>
                </Button>
              ))}
            </div>
          ) : (
            <Input autoFocus type={authPrompt?.prompt?.type === "secret" ? "password" : "text"} value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder={authPrompt?.prompt?.placeholder} onKeyDown={(event) => event.key === "Enter" && answer && respond(answer)} />
          )}
          {authPrompt?.prompt?.type !== "select" && <DialogFooter><Button disabled={!answer} onClick={() => respond(answer)}>Continue</Button></DialogFooter>}
        </DialogContent>
      </Dialog>
    </div>
  );
}
