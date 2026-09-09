"use client";

// The value bubble that follows the pointer over the map.
//
// A speech bubble with a tail, exactly where the cursor is, is the difference
// between a picture of the ocean and something you can read a number off. It
// flips to the other side of the cursor near the viewport edges so it never
// runs off screen.

import { usePointer } from "@/state/usePointer";
import { IconRaindrop } from "@/components/ui/icons";

export default function HoverBubble() {
  const { x, y, value, units, label, visible } = usePointer();

  if (!visible) return null;

  const flipX = typeof window !== "undefined" && x > window.innerWidth - 220;
  const flipY = y < 90;

  return (
    <div
      className="pointer-events-none absolute z-40"
      style={{
        left: x,
        top: y,
        transform: `translate(${flipX ? "-100%" : "0"}, ${flipY ? "16px" : "calc(-100% - 16px)"})`,
      }}
    >
      <div
        className="ze-panel relative flex items-center gap-2.5 px-3 py-2"
        data-testid="hover-bubble"
      >
        <IconRaindrop className="h-4 w-4 text-[color:var(--ze-accent)]" />
        <div className="leading-tight">
          <div className="whitespace-nowrap text-[13px] text-[color:var(--ze-text)]">
            {label}
          </div>
          <div className="whitespace-nowrap font-mono text-[12px] text-[color:var(--ze-text-dim)]">
            {value === null ? "no data" : `${value.toFixed(2)} ${units}`}
            <span className="ml-1 text-[color:var(--ze-text-faint)]">(synthetic)</span>
          </div>
        </div>
        {/* Tail, drawn on whichever side the bubble is anchored. */}
        <div
          className="absolute h-2.5 w-2.5 rotate-45"
          style={{
            background: "var(--ze-panel)",
            [flipY ? "top" : "bottom"]: "-4px",
            [flipX ? "right" : "left"]: "18px",
          }}
        />
      </div>
    </div>
  );
}
