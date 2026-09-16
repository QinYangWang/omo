import { Badge } from "@/components/ui/badge";
import { type I18nKey, useI18n } from "@/lib/i18n";
import type { ServerStatus, ServerStatusState } from "@/lib/servers";
import { cn } from "@/lib/utils";

const stateLabels: Record<ServerStatusState, I18nKey> = {
  checking: "server_checking",
  "credential-error": "server_credential_error",
  "identity-mismatch": "server_identity_mismatch",
  offline: "server_offline",
  online: "server_online",
  unauthorized: "server_unauthorized",
};

export function ServerStatusBadge({ status }: { status?: ServerStatus }) {
  const { t } = useI18n();
  const state = status?.state ?? "checking";
  const label = t(stateLabels[state]);
  return (
    <Badge className="gap-1.5" title={status?.error} variant="secondary">
      <span
        className={cn(
          "size-1.5 rounded-full",
          state === "online" && "bg-success",
          (state === "offline" ||
            state === "unauthorized" ||
            state === "credential-error" ||
            state === "identity-mismatch") &&
            "bg-destructive",
          state === "checking" && "animate-pulse bg-warning"
        )}
      />
      {label}
      {state === "online" && typeof status?.latencyMs === "number"
        ? ` · ${status.latencyMs}ms`
        : null}
    </Badge>
  );
}
