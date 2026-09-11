"use client";

// Shell primitives for the Zoom Earth-style chrome.
//
// Every floating surface in the app is one of these, so the visual language
// lives in exactly two places: the tokens in globals.css and the four
// components here.

import { useEffect, useRef, type ReactNode } from "react";
import { useIsMobile } from "@/state/useMediaQuery";
import { IconClose } from "./icons";

export function Panel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`ze-panel ${className}`}>{children}</div>;
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="ze-section-label">{children}</div>;
}

/**
 * A menu row wrapping a real radio or checkbox.
 *
 * The input is visually hidden but present, so the row keeps keyboard
 * behaviour, group semantics and an accessible name -- which is also what
 * lets the browser smoke test address these by label rather than by position.
 */
export function MenuRow({
  label,
  icon,
  checked,
  onChange,
  type = "checkbox",
  name,
  title,
  disabled = false,
  detail,
  reselectable = false,
  className = "",
}: {
  label: string;
  icon?: ReactNode;
  checked: boolean;
  onChange: () => void;
  type?: "checkbox" | "radio";
  name?: string;
  title?: string;
  /** Offered, but not selectable -- with `title` saying why. */
  disabled?: boolean;
  /** A second line under the label. Implies the taller stacked row. */
  detail?: ReactNode;
  /**
   * Let a radio report a click on the row that is ALREADY selected.
   *
   * A radio group cannot be emptied by the browser, so clicking the active row
   * fires no `change` and `onChange` never runs -- which is why "click it again
   * to turn it off" silently did nothing. `click` does fire, so the reselect is
   * caught there; a click that genuinely changes the selection is left to
   * `change`, or both would run and cancel each other out.
   */
  reselectable?: boolean;
  className?: string;
}) {
  return (
    <label
      className={`ze-row ${detail ? "ze-row-stack" : ""} ${className}`.trim()}
      data-active={checked}
      data-disabled={disabled || undefined}
      title={title}
    >
      <input
        type={type}
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        onClick={reselectable && checked ? () => onChange() : undefined}
        aria-label={label}
      />
      <span className="flex w-full items-center gap-3">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      {detail}
    </label>
  );
}

/** Labelled slider, ZE-thin, with the value shown on the right. */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  return (
    <div className="px-4 py-1.5">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[12px] text-[color:var(--ze-text-dim)]">{label}</span>
        <span className="font-mono text-[12px] text-[color:var(--ze-text)]">
          {format ? format(value) : value}
        </span>
      </div>
      <input
        type="range"
        className="ze-slider"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
      />
    </div>
  );
}

/**
 * Popover anchored to a rail button.
 *
 * Closes on Escape and on a click outside. `anchor` decides which edge it
 * grows from, because the rail runs down the right side and a popover that
 * opens rightwards would leave the viewport.
 */
export function Popover({
  title,
  onClose,
  children,
  className = "",
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mobile = useIsMobile();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      const el = ref.current;
      if (!el) return;
      const target = e.target as Node;
      // The rail button that opened this popover toggles it itself; ignoring
      // the whole rail here stops the two handlers fighting.
      if (el.contains(target)) return;
      if ((target as HTMLElement).closest?.("[data-rail]")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  return (
    <>
      {mobile && <div className="ze-scrim z-30" onClick={onClose} aria-hidden />}
    <div
      ref={ref}
      // Marks this as a transient surface that owns Escape while it is open.
      // Without it, one Escape both closed a popover and cleared the region
      // behind it -- two undos for one keypress.
      data-transient=""
      className={
        mobile
          ? `ze-panel ze-sheet z-40 ${className}`
          : `ze-panel w-[280px] overflow-hidden ${className}`
      }
    >
      {mobile && <span className="ze-sheet-handle" aria-hidden />}
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <div className="ze-section-label !m-0 !p-0">{title}</div>
        <button
          onClick={onClose}
          aria-label={`Close ${title}`}
          className="grid h-6 w-6 place-items-center rounded-md text-[color:var(--ze-text-dim)] hover:bg-white/10 hover:text-white"
        >
          <IconClose className="h-4 w-4" />
        </button>
      </div>
      <div className={mobile ? "pb-3" : "ze-scroll max-h-[70vh] overflow-y-auto pb-3"}>
        {children}
      </div>
    </div>
    </>
  );
}

export function Chip({
  name,
  detail,
  tone = "default",
  title,
}: {
  name: string;
  detail?: string;
  tone?: "default" | "warn";
  title?: string;
}) {
  return (
    <span
      className="ze-chip"
      title={title}
      style={
        tone === "warn"
          ? { color: "#f6d283", background: "rgba(72, 54, 16, 0.86)" }
          : undefined
      }
    >
      <b className="font-semibold tracking-wide">{name}</b>
      {detail && (
        <span style={{ color: tone === "warn" ? "#d9b268" : "var(--ze-text-dim)" }}>
          {detail}
        </span>
      )}
    </span>
  );
}
