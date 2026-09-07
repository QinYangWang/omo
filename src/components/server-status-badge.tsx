import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/lib/i18n";
import type { ServerStatus } from "@/lib/servers";
import { cn } from "@/lib/utils";

export function ServerStatusBadge({ status }: { status?: ServerStatus }) {
  const { t } = useI18n();
  const state = status?.state ?? "checking";
  let stateLabel = t("server_checking");
  if (state === "online") {
    stateLabel = t("server_online");
  } else if (state === "offline") {
    stateLabel = t("server_offline");
  }
  return (
    <Badge className="gap-1.5" title={status?.error} variant="secondary">
      <span
        className={cn(
          "size-1.5 rounded-full",
          state === "online" && "bg-success",
          state === "offline" && "bg-destructive",
          state === "checking" && "animate-pulse bg-warning"
        )}
      />
      {stateLabel}
      {state === "online" && typeof status?.latencyMs === "number"
        ? ` · ${status.latencyMs}ms`
        : null}
    </Badge>
  );
}
