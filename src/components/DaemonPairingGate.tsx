import { PiIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/lib/i18n";
import { connectRemoteDaemon } from "@/lib/omo-v2";
import { setLocalServerToken } from "@/lib/servers";

export function DaemonPairingGate({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const url =
    window.__OMO_DAEMON_URL__ || window.__OMO_SERVER_URL__ || location.origin;

  const pair = async () => {
    if (!(code.trim() && !busy)) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const config = await connectRemoteDaemon(url, code.trim());
      await setLocalServerToken(config.token);
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  return (
    <main className="flex h-screen items-center justify-center bg-background p-6 text-foreground">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="text-center">
          <HugeiconsIcon
            className="mx-auto mb-4 size-8 text-foreground"
            icon={PiIcon}
            strokeWidth={1.6}
          />
          <h1 className="font-medium text-xl">{t("onboarding_title")}</h1>
          <p className="mt-2 text-muted-foreground text-sm">
            {t("daemon_remote_desc")}
          </p>
        </div>
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-5">
          <div className="truncate rounded-md bg-muted px-2.5 py-1.5 text-muted-foreground text-xs">
            {url}
          </div>
          <Input
            autoFocus
            onChange={(event) => setCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                pair().catch(() => undefined);
              }
            }}
            placeholder={t("daemon_remote_code")}
            value={code}
          />
          {error ? <p className="text-destructive text-sm">{error}</p> : null}
          <Button disabled={!code.trim()} loading={busy} onClick={pair}>
            {t("onboarding_continue")}
          </Button>
        </div>
      </div>
    </main>
  );
}
