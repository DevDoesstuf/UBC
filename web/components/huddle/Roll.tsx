"use client";
import type { CSSProperties } from "react";
import { pctLabel, pctText, pctValue } from "./format";
import { useDirection, useReplayClass } from "./motion";
import { Icon } from "./Icon";

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

function Digit({ d, i }: { d: number; i: number }) {
  return (
    <span className="hd-digit" style={{ ["--i" as string]: i } as CSSProperties}>
      <span className="hd-digit-sizer">0</span>
      <span className="hd-digit-strip" style={{ transform: `translate3d(0, ${-d * 10}%, 0)` }}>
        {DIGITS.map((n) => (
          <span key={n}>{n}</span>
        ))}
      </span>
    </span>
  );
}

/**
 * odds-roll: a number whose digits roll to their new value (CSS transitions: fail-safe in background
 * tabs, instant under reduced motion) and flash the direction they moved.
 *
 * `text` is the already-formatted string ("73", "$12.50"); digits roll, other characters stay put.
 * `value` drives the direction flash (defaults to the digits in `text`). Screen readers get `label`
 * (or `text`) once, not the digit strips.
 */
export function Roll({
  text,
  value,
  label,
  className = "",
  flash = true,
  arrow = false,
  style,
  duration,
}: {
  text: string;
  value?: number | null;
  label?: string;
  className?: string;
  flash?: boolean;
  arrow?: boolean;
  style?: CSSProperties;
  /** Roll duration in ms (default 560). Short for countdown ticks, long for a big payout. */
  duration?: number;
}) {
  const parsed = Number.parseFloat(text.replace(/[^0-9.-]/g, ""));
  const numeric = value !== undefined ? value : Number.isFinite(parsed) ? parsed : null;
  const dir = useDirection(numeric);
  const flashClass = useReplayClass(numeric, `hd-flash-${dir ?? "up"}`);
  const chars = [...text];
  let digitIndex = 0;
  return (
    <span
      className={`hd-roll ${flash && dir ? flashClass : ""} ${className}`}
      style={duration ? ({ ...style, ["--roll-dur" as string]: `${duration}ms` } as CSSProperties) : style}
    >
      <span className="hd-sr">{label ?? text}</span>
      <span aria-hidden="true">
        {chars.map((c, i) => {
          const key = chars.length - i; // keyed from the right: the ones digit stays the ones digit
          if (c >= "0" && c <= "9") return <Digit key={`d${key}`} d={Number(c)} i={digitIndex++} />;
          return <span key={`c${key}`}>{c}</span>;
        })}
      </span>
      {arrow && dir && <Icon name={dir} className="hd-arrow" data-dir={dir} />}
    </span>
  );
}

/**
 * A probability as a rolling percentage: "73%". Missing prices show "–", tiny ones "<1", certain
 * ones ">99" (never a bare "%"). The % sign is smaller.
 */
export function Pct({
  p,
  className = "",
  sign = true,
  flash = true,
  arrow = false,
  duration,
}: {
  p: number | null | undefined;
  className?: string;
  sign?: boolean;
  flash?: boolean;
  arrow?: boolean;
  duration?: number;
}) {
  const text = pctText(p);
  return (
    <span className={`hd-roll ${className}`}>
      <Roll text={text} value={pctValue(p)} label={pctLabel(p)} flash={flash} duration={duration} />
      {sign && text !== "–" && (
        <span aria-hidden="true" className="hd-pct-sign">
          %
        </span>
      )}
      {arrow && <DirArrow value={pctValue(p)} />}
    </span>
  );
}

/** Just the up/down mark that appears for a moment after a number moves. */
export function DirArrow({ value, className = "" }: { value: number | null | undefined; className?: string }) {
  const dir = useDirection(value);
  if (!dir) return null;
  return <Icon name={dir} className={`hd-arrow ${className}`} data-dir={dir} />;
}
