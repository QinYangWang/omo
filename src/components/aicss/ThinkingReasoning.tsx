"use client";

import { ArrowUp01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import styles from "./ThinkingReasoning.module.css";

export function ThinkingReasoning({
  children,
  status,
}: {
  children?: ReactNode;
  status: "running" | "done";
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(status === "running");
  const previousStatus = useRef(status);
  const running = status === "running";

  useEffect(() => {
    if (running) {
      setOpen(true);
    } else if (previousStatus.current === "running") {
      setOpen(false);
    }
    previousStatus.current = status;
  }, [running, status]);

  return (
    <div className={styles.root}>
      <Button
        aria-expanded={open}
        aria-label={t("toggle_reasoning")}
        className={styles.header}
        disabled={running}
        onClick={() => setOpen((current) => !current)}
        size="sm"
        variant="ghost"
      >
        <span className={cn(styles.label, running && styles.shimmer)}>
          {running ? t("thinking") : t("reasoning")}
        </span>
        {running ? null : (
          <HugeiconsIcon data-icon="inline-end" icon={ArrowUp01Icon} />
        )}
      </Button>
      <div
        className={cn(styles.collapsible, !open && styles.collapsed)}
        data-state={open ? "open" : "closed"}
      >
        <div className={styles.inner}>
          <div className={styles.viewport}>{children}</div>
        </div>
      </div>
    </div>
  );
}
