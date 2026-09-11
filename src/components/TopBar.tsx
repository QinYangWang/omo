import {
  Add01Icon,
  ArrowLeft02Icon,
  ArrowRight02Icon,
  File01Icon,
  PanelLeftCloseIcon,
  PanelLeftIcon,
  PiIcon,
  XIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type React from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

export interface TopBarTab {
  id: string;
  label: string;
  streaming?: boolean;
  title?: string;
}

export function TopBar({
  activeTabId,
  canGoBack = false,
  canGoForward = false,
  collapsed,
  leftPadding,
  leftWidth,
  onCloseTab,
  onCollapse,
  onGoBack,
  onGoForward,
  onNewTab,
  onSelectTab,
  rightPadding,
  showTabs = true,
  tabs,
}: {
  activeTabId: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  collapsed: boolean;
  leftPadding: string;
  leftWidth: number;
  onCloseTab: (id: string) => void;
  onCollapse: () => void;
  onGoBack?: () => void;
  onGoForward?: () => void;
  onNewTab: () => void;
  onSelectTab: (id: string) => void;
  rightPadding: string;
  showTabs?: boolean;
  tabs: TopBarTab[];
}) {
  const { t } = useI18n();
  return (
    <header
      className="relative z-20 flex h-10 shrink-0 items-center gap-1 overflow-hidden bg-sidebar [-webkit-app-region:drag]"
      style={{
        paddingLeft: leftPadding,
        paddingRight: rightPadding,
      }}
    >
      <div
        className="flex h-full shrink-0 items-center gap-1 pe-1"
        style={{
          width: `max(0px, calc(${leftWidth}px - ${leftPadding}))`,
        }}
      >
        {collapsed ? null : (
          <span
            aria-label="omo"
            className="flex size-8 shrink-0 items-center justify-center text-sidebar-foreground"
            role="img"
          >
            <HugeiconsIcon icon={PiIcon} />
          </span>
        )}
        <span className="min-w-0 flex-1" />
        <Button
          aria-label={collapsed ? t("expand_sidebar") : t("collapse_sidebar")}
          className="size-7"
          onClick={onCollapse}
          size="icon"
          style={noDrag}
          variant="ghost"
        >
          {collapsed ? (
            <HugeiconsIcon icon={PanelLeftIcon} />
          ) : (
            <HugeiconsIcon icon={PanelLeftCloseIcon} />
          )}
        </Button>
        {collapsed || !showTabs ? null : (
          <>
            <Button
              aria-label={t("previous_tab")}
              className="size-7"
              disabled={!canGoBack}
              onClick={onGoBack}
              size="icon"
              style={noDrag}
              variant="ghost"
            >
              <HugeiconsIcon icon={ArrowLeft02Icon} />
            </Button>
            <Button
              aria-label={t("next_tab")}
              className="size-7"
              disabled={!canGoForward}
              onClick={onGoForward}
              size="icon"
              style={noDrag}
              variant="ghost"
            >
              <HugeiconsIcon icon={ArrowRight02Icon} />
            </Button>
          </>
        )}
      </div>

      {showTabs ? (
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div aria-label={t("open_tabs")} className="contents" role="tablist">
            {tabs.map((tab) => {
              const active = tab.id === activeTabId;
              return (
                <div
                  className={cn(
                    "group flex h-8 w-fit min-w-36 max-w-60 shrink-0 items-center rounded-lg border bg-muted/60 px-0.5 transition-colors",
                    active
                      ? "border-sidebar-border bg-background text-foreground shadow-xs/5"
                      : "border-transparent text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  )}
                  key={tab.id}
                >
                  <Button
                    aria-selected={active}
                    className={cn(
                      "h-7 min-w-0 flex-1 justify-start gap-1.5 border-0 px-2 text-xs",
                      active
                        ? "hover:bg-transparent"
                        : "text-sidebar-foreground hover:bg-transparent hover:text-sidebar-accent-foreground"
                    )}
                    onClick={() => onSelectTab(tab.id)}
                    role="tab"
                    style={noDrag}
                    title={tab.title ?? tab.label}
                    variant="ghost"
                  >
                    {tab.streaming ? (
                      <Spinner className="size-3.5 shrink-0" />
                    ) : (
                      <HugeiconsIcon
                        data-icon="inline-start"
                        icon={File01Icon}
                      />
                    )}
                    <span className="min-w-0 truncate">{tab.label}</span>
                  </Button>
                  <Button
                    aria-label={`${t("close_tab")}: ${tab.label}`}
                    className="size-6 shrink-0 opacity-70 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
                    onClick={(event) => {
                      event.stopPropagation();
                      onCloseTab(tab.id);
                    }}
                    size="icon-xs"
                    style={noDrag}
                    title={t("close_tab")}
                    variant="ghost"
                  >
                    <HugeiconsIcon icon={XIcon} />
                  </Button>
                </div>
              );
            })}
          </div>
          <Button
            aria-label={t("add_tab")}
            className="sticky right-0 z-10 size-7 shrink-0 bg-sidebar text-sidebar-foreground hover:bg-sidebar-accent"
            onClick={onNewTab}
            size="icon"
            style={noDrag}
            variant="ghost"
          >
            <HugeiconsIcon icon={Add01Icon} />
          </Button>
        </div>
      ) : (
        <span className="min-w-0 flex-1" />
      )}
    </header>
  );
}
