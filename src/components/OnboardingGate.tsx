import { Asterisk, Server } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/lib/i18n";
import { normalizeBaseUrl } from "@/lib/remote-api";
import {
  addRemoteServer,
  setLocalServerToken,
  testServerConnection,
} from "@/lib/servers";

function HostedLogin({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [token, setToken] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const url = normalizeBaseUrl(window.__OMO_SERVER_URL__ || "");

  const login = async () => {
    setBusy(true);
    setStatus("…");
    try {
      await testServerConnection(url, token);
      await setLocalServerToken(token);
      onDone();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 font-medium text-sm">
        <Server className="size-4" /> {t("onboarding_hosted_login")}
      </div>
      <div className="truncate rounded-md bg-muted px-2.5 py-1.5 text-muted-foreground text-xs">
        {url}
      </div>
      <Input
        autoFocus
        onChange={(event) => setToken(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && token && login()}
        placeholder={t("server_token")}
        type="password"
        value={token}
      />
      {status ? (
        <p className="text-muted-foreground text-sm">{status}</p>
      ) : null}
      <Button disabled={!token || busy} onClick={login}>
        {t("onboarding_continue")}
      </Button>
    </div>
  );
}

function RemoteForm({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setStatus("…");
    try {
      await testServerConnection(url, token);
      await addRemoteServer({ name, token, url });
      onDone();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 font-medium text-sm">
        <Server className="size-4" /> {t("onboarding_add_remote")}
      </div>
      <Input
        onChange={(event) => setName(event.target.value)}
        placeholder={t("server_name")}
        value={name}
      />
      <Input
        autoFocus
        onChange={(event) => setUrl(event.target.value)}
        placeholder="https://omo.example.com"
        value={url}
      />
      <Input
        onChange={(event) => setToken(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && url && save()}
        placeholder={t("server_token")}
        type="password"
        value={token}
      />
      {status ? (
        <p className="text-muted-foreground text-sm">{status}</p>
      ) : null}
      <Button disabled={!url || busy} onClick={save}>
        {t("server_add")}
      </Button>
    </div>
  );
}

export function OnboardingGate({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const hosted = !!window.__OMO_SERVER_URL__;
  const [showRemote, setShowRemote] = useState(!hosted);
  return (
    <main className="flex h-screen items-center justify-center bg-background p-6 text-foreground">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="text-center">
          <Asterisk
            className="mx-auto mb-4 size-8 text-foreground"
            strokeWidth={1.6}
          />
          <h1 className="font-medium text-xl">{t("onboarding_title")}</h1>
          <p className="mt-2 text-muted-foreground text-sm">
            {t(hosted ? "onboarding_desc" : "onboarding_static_desc")}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-5">
          {hosted && !showRemote ? (
            <HostedLogin onDone={onDone} />
          ) : (
            <RemoteForm onDone={onDone} />
          )}
        </div>
        {hosted ? (
          <Button
            onClick={() => setShowRemote((value) => !value)}
            size="sm"
            variant="ghost"
          >
            {showRemote
              ? t("onboarding_hosted_login")
              : t("onboarding_add_remote")}
          </Button>
        ) : null}
      </div>
    </main>
  );
}
