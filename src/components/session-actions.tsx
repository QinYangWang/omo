import {
  ArchiveIcon,
  Copy01Icon,
  CopyPlusIcon,
  Edit02Icon,
  MoreHorizontalCircle02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactElement, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/lib/i18n";
import { getServerApi } from "@/lib/servers";

async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

export function SessionDetailsHover({
  children,
  project,
  session,
}: {
  children: ReactElement;
  project: Project;
  session: PiSession;
}) {
  const { t } = useI18n();
  const [details, setDetails] = useState<{ branch: string; cost: number }>();
  const workspaceType =
    session.cwd === project.cwd ? t("local") : t("worktree");
  return (
    <HoverCard
      onOpenChange={(open) => {
        if (open && !details) {
          getServerApi(project.serverId)
            .sessions.details(session.path, session.cwd)
            .then(setDetails)
            .catch(() => undefined);
        }
      }}
    >
      <HoverCardTrigger render={children} />
      <HoverCardContent
        align="start"
        className="w-80 min-w-0 max-w-[calc(100vw-1rem)] overflow-hidden"
        side="right"
      >
        <div className="flex min-w-0 flex-col gap-2">
          <div className="min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap font-medium">
            {session.name || session.firstMessage || t("untitled")}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">{t("session_id")}</dt>
            <dd className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono">
              {session.id}
            </dd>
            <dt className="text-muted-foreground">{t("branch")}</dt>
            <dd className="truncate">{details?.branch || "—"}</dd>
            <dt className="text-muted-foreground">{t("working_directory")}</dt>
            <dd className="min-w-0">
              <span className="mr-1">{workspaceType}</span>
              <span className="break-all text-muted-foreground">
                {session.cwd}
              </span>
            </dd>
            <dt className="text-muted-foreground">{t("session_cost")}</dt>
            <dd>{details ? `$${details.cost.toFixed(4)}` : "…"}</dd>
          </dl>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

export function SessionActions({
  className,
  onArchived,
  onChanged,
  onCloned,
  project,
  session,
}: {
  className?: string;
  onArchived?: () => void;
  onChanged: (name?: string) => Promise<void>;
  onCloned: (path: string) => Promise<void>;
  project: Project;
  session: PiSession;
}) {
  const { t } = useI18n();
  const [renameOpen, setRenameOpen] = useState(false);
  const [name, setName] = useState(session.name || session.firstMessage || "");
  const [busy, setBusy] = useState(false);
  const api = getServerApi(project.serverId);
  const rename = async () => {
    const nextName = name.trim();
    if (!nextName) {
      return;
    }
    setBusy(true);
    try {
      await api.sessions.rename(session.path, nextName);
      setRenameOpen(false);
      await onChanged(nextName);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label={t("session_actions")}
              className={className}
              size="icon"
              title={t("session_actions")}
              type="button"
              variant="ghost"
            />
          }
        >
          <HugeiconsIcon icon={MoreHorizontalCircle02Icon} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => setRenameOpen(true)}>
              <HugeiconsIcon icon={Edit02Icon} />
              {t("rename_session")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={async () => {
                const path = await api.sessions.clone(session.path);
                await onCloned(path);
              }}
            >
              <HugeiconsIcon icon={CopyPlusIcon} />
              {t("clone_session")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={async () => {
                await copyText(await api.sessions.context(session.path));
              }}
            >
              <HugeiconsIcon icon={Copy01Icon} />
              {t("copy_context_markdown")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onArchived} variant="destructive">
              <HugeiconsIcon icon={ArchiveIcon} />
              {t("archive_session")}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog onOpenChange={setRenameOpen} open={renameOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("rename_session")}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                rename().catch(() => undefined);
              }
            }}
            value={name}
          />
          <DialogFooter>
            <Button
              disabled={busy || !name.trim()}
              onClick={rename}
              type="button"
            >
              {t("rename_session")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
