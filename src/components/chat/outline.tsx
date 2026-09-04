import { useEffect, useRef } from "react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import type { TurnMeta } from "@/lib/conversation-turns";
import { cn } from "@/lib/utils";

const OUTLINE_MAX_VISIBLE = 24;

/**
 * Chapter minimap for the conversation. One tick per user message.
 * - The visible slice uses a hysteresis window: it only shifts when the
 *   active chapter leaves it, so clicking a visible tick never reshuffles.
 * - Each tick is a fixed-size hit target wrapping the visual line.
 * - Hovering shows the user message preview in a portal-based card.
 */
export function Outline({
  activeId,
  metas,
  onJump,
}: {
  activeId?: string;
  metas: TurnMeta[];
  onJump: (turnId: string) => void;
}) {
  const activeIndex = metas.findIndex((meta) => meta.id === activeId);
  const wheelIndex = useRef(activeIndex);
  const windowStart = useRef(0);

  useEffect(() => {
    wheelIndex.current =
      activeIndex >= 0 ? activeIndex : Math.max(0, metas.length - 1);
  }, [activeIndex, metas.length]);

  if (!metas.length) {
    return null;
  }

  const maxVisible = Math.min(OUTLINE_MAX_VISIBLE, metas.length);
  const maxStart = Math.max(0, metas.length - maxVisible);
  let start = windowStart.current;
  if (activeIndex >= 0) {
    if (activeIndex < start) {
      start = activeIndex;
    } else if (activeIndex >= start + maxVisible) {
      start = activeIndex - maxVisible + 1;
    }
  } else {
    start = maxStart;
  }
  start = Math.max(0, Math.min(maxStart, start));
  if (start !== windowStart.current) {
    windowStart.current = start;
  }
  const visible = metas.slice(start, start + maxVisible);

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (
      event.ctrlKey ||
      event.deltaY === 0 ||
      Math.abs(event.deltaX) > Math.abs(event.deltaY)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    let currentIndex = wheelIndex.current;
    if (currentIndex < 0) {
      currentIndex = activeIndex >= 0 ? activeIndex : metas.length - 1;
    }
    const nextIndex = Math.max(
      0,
      Math.min(metas.length - 1, currentIndex + (event.deltaY > 0 ? 1 : -1))
    );
    const nextMeta = metas[nextIndex];
    if (!nextMeta || nextIndex === currentIndex) {
      return;
    }
    wheelIndex.current = nextIndex;
    onJump(nextMeta.id);
  };

  return (
    <aside className="pointer-events-none absolute top-1/2 right-4 z-10 -translate-y-1/2">
      <div
        className="pointer-events-auto flex max-h-[min(24rem,70vh)] flex-col items-end justify-center gap-1 py-2"
        onWheel={handleWheel}
      >
        {visible.map((meta) => {
          const active = meta.id === activeId;
          const tick = (
            <button
              aria-label="Go to user message"
              className="group/tick flex h-3 w-10 items-center justify-end"
              onClick={() => onJump(meta.id)}
              type="button"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "h-px rounded-full transition-all duration-150",
                  active
                    ? "w-6 bg-primary group-hover/tick:w-10"
                    : "w-4 bg-muted-foreground/40 group-hover/tick:w-10 group-hover/tick:bg-muted-foreground"
                )}
              />
            </button>
          );
          return (
            <div className="flex h-3 items-center justify-end" key={meta.id}>
              {meta.userPreview ? (
                <HoverCard>
                  <HoverCardTrigger render={tick} />
                  <HoverCardContent className="w-64" side="left">
                    <div className="mb-1 text-[11px] text-muted-foreground">
                      User message
                    </div>
                    <p className="line-clamp-4 whitespace-pre-wrap text-foreground text-xs leading-5">
                      {meta.userPreview}
                    </p>
                  </HoverCardContent>
                </HoverCard>
              ) : (
                tick
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
