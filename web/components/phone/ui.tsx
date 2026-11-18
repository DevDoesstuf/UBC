"use client";
// Small phone building blocks: sheet, inline error, code tiles, loading, empty state, money.
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon, Kinetic, Mark, Roll, signedUsd, usd } from "@/components/huddle";

export const d = (ms: number) => ({ ["--d" as string]: `${ms}ms` }) as CSSProperties;
export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/** Money that rolls digit by digit and flashes the direction it moved. */
export function Money({
  cents,
  signed = false,
  className = "",
  flash = true,
  duration,
}: {
  cents: number;
  signed?: boolean;
  className?: string;
  flash?: boolean;
  duration?: number;
}) {
  const text = signed ? signedUsd(cents) : usd(cents);
  return <Roll text={text} value={cents} label={text} className={`hd-num ${className}`} flash={flash} duration={duration} />;
}

/** The ring spinning with three lit pixels + a line that says what is happening. */
export function Loading({ children }: { children?: ReactNode }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 4000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="ph-loading" role="status">
      <Mark size="2rem" spin lit={3} className="ph-loading-mark" />
      <span>
        {children}
        {slow && <span className="ph-loading-slow">Still connecting. This page keeps trying by itself.</span>}
      </span>
    </div>
  );
}

/** What happened and what to do, on a hot-50 field with a hot ring and an icon. */
export function InlineError({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <div className="ph-error hd-rise" role="alert">
      <Icon name="warn" size={18} className="ph-error-icon" />
      <span className="ph-error-text">{text}</span>
      {action}
    </div>
  );
}

/** Empty state: a dashed card that says what happens next. */
export function Empty({ children, mark = false }: { children: ReactNode; mark?: boolean }) {
  return (
    <div className="ph-empty hd-fade">
      {mark && <Mark size="2.5rem" lit={2} className="hd-float ph-empty-mark" />}
      <p>{children}</p>
    </div>
  );
}

/** Section heading: Bricolage, sentence case, an optional count pill. */
export function SectionTitle({ children, count, id, aside }: { children: ReactNode; count?: number; id?: string; aside?: ReactNode }) {
  return (
    <div className="ph-section-h">
      <h2 id={id} className="ph-h2">
        {children}
        {count != null && count > 0 && <span className="ph-count hd-num">{count}</span>}
      </h2>
      {aside && <span className="ph-aside">{aside}</span>}
    </div>
  );
}

/** The join code as letter tiles: card tiles, ink letters, popping in one after another. */
export function CodeTiles({ code, small = false, delay = 0 }: { code: string; small?: boolean; delay?: number }) {
  return (
    <span className={cx("ph-code-tiles", small && "small")} role="img" aria-label={`Code ${code.split("").join(" ")}`} translate="no">
      {code.split("").map((ch, i) => (
        <span key={i} className="ph-code-tile hd-num hd-pop" style={d(delay + i * 90)} aria-hidden="true">
          {ch}
        </span>
      ))}
    </span>
  );
}

/**
 * Bottom sheet. Rises in with a CSS keyframe (open is the resting state, so it can never get stuck
 * hidden) and unmounts at once on close. Tap outside or press Escape to close.
 */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  // The page re-renders several times a second with a new onClose each time: read it through a ref so the
  // effect below runs only when the sheet opens, and focus is never pulled back to the panel mid-use.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    panel.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeRef.current();
        return;
      }
      // aria-modal: Tab and Shift+Tab stay inside the sheet.
      if (e.key !== "Tab" || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(
        (el) => el.offsetParent !== null,
      );
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      const at = document.activeElement;
      if (e.shiftKey && (at === first || at === panel.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !panel.current.contains(at))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.({ preventScroll: true });
    };
  }, [open]);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="ph-sheet-root">
      <div className="ph-scrim hd-fade" onClick={onClose} aria-hidden="true" />
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="ph-sheet">
        <div className="ph-sheet-handle" aria-hidden="true" />
        <div className="ph-sheet-head">
          <Kinetic as="h2" id={titleId} text={title} className="hd-q ph-sheet-title" stagger={40} />
          <button className="hd-btn hd-btn-quiet ph-icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={22} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
