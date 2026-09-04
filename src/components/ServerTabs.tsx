import { useState } from "react";
import { Button } from "@/components/ui/button";
import { type I18nKey, useI18n } from "@/lib/i18n";
import { getDefaultServerId, type OmoServer, useServers } from "@/lib/servers";

/** Display name for a server, with i18n labels for the local entry. */
export function useServerLabel() {
  const { t } = useI18n();
  const hosted = !!window.__OMO_SERVER_URL__ && !window.omoSecure;
  return (server: OmoServer) =>
    server.kind === "remote"
      ? server.name
      : t((hosted ? "server_hosted" : "server_local") as I18nKey);
}

/** Selected server state that stays valid when the list changes. */
export function useSelectedServer(): [string, (id: string) => void] {
  const servers = useServers();
  const [serverId, setServerId] = useState(getDefaultServerId());
  const active = servers.some((server) => server.id === serverId)
    ? serverId
    : (servers[0]?.id ?? getDefaultServerId());
  return [active, setServerId];
}

export function ServerTabs({
  onChange,
  value,
}: {
  onChange: (id: string) => void;
  value: string;
}) {
  const servers = useServers();
  const label = useServerLabel();
  if (servers.length <= 1) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {servers.map((server) => (
        <Button
          key={server.id}
          onClick={() => onChange(server.id)}
          size="sm"
          variant={value === server.id ? "secondary" : "ghost"}
        >
          {label(server)}
        </Button>
      ))}
    </div>
  );
}
