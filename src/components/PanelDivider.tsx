import type React from "react";
import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function PanelDivider({
  className,
  onDrag,
}: {
  className?: string;
  onDrag: (dx: number) => void;
}) {
  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      const startX = event.clientX;
      let lastOffset = 0;
      const move = (moveEvent: PointerEvent) => {
        const offset = moveEvent.clientX - startX;
        onDrag(offset - lastOffset);
        lastOffset = offset;
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [onDrag]
  );

  return (
    <Button
      aria-label="Resize panel"
      className="group relative m-0 h-full w-px shrink-0 cursor-col-resize rounded-none border-0 bg-transparent p-0 active:translate-y-0"
      onPointerDown={onPointerDown}
      type="button"
      variant="ghost"
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 -right-1 -left-1"
      />
      <span
        aria-hidden="true"
        className={cn(
          "absolute bottom-0 left-0 w-px",
          className ?? "top-0 bg-border/60 group-hover:bg-ring"
        )}
      />
    </Button>
  );
}
