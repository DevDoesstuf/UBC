"use client";
import type { CSSProperties, ReactNode } from "react";
import { Icon } from "./Icon";
import { useReplayClass } from "./motion";
import { Roll } from "./Roll";

export type LockState = "open" | "urgent" | "locked";

/**
 * ring-drain / last-call / lock-snap: the lock countdown drawn as the box's LED ring. One pixel goes dark (and
 * shrinks) per 1/n of the window; the seconds roll down and condense (variable-font width) as time runs out.
 * In the last 5 s the ring turns hot, throbs and glows once a second and every tick stamps. Locked: the
 * padlock snaps in.
 */
export function LockRing({ fraction, label, state, size = "10rem", dots = 24, caption, compact = false, className = "" }: {
  /** 1 at open, 0 at lock. */
  fraction: number;
  /** Seconds text ("14", "1:20"). */
  label: string;
  state: LockState;
  size?: string;
  dots?: number;
  caption?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  const f = Math.min(1, Math.max(0, fraction));
  const n = compact ? Math.min(dots, 16) : dots;
  const lit = state === "locked" ? 0 : Math.ceil(f * n);
  const beat = useReplayClass(state === "urgent" ? label : null, "hd-beat");
  const urgent = state === "urgent";
  const stretch = 62 + Math.round(38 * f); // the number tightens as the window closes
  const r = 44;
  const on = urgent ? "var(--hd-ring-urgent)" : "var(--hd-ring-on)";
  return (
    <div
      className={`hd-ring ${className}`}
      data-state={state}
      style={{ width: size, height: size }}
      role="timer"
      aria-live="off"
      aria-label={state === "locked" ? "Trading locked" : `${label} seconds until trading locks`}
    >
      <span className="hd-ring-glow" aria-hidden="true" />
      <svg viewBox="0 0 100 100" className="hd-ring-svg" aria-hidden="true">
        <g className="hd-ring-dots">
          {Array.from({ length: n }, (_, i) => {
            const a = (i / n) * Math.PI * 2 - Math.PI / 2;
            const isOn = i < lit;
            return (
              <circle
                key={i}
                className="hd-ring-dot"
                data-on={isOn}
                cx={50 + r * Math.cos(a)}
                cy={50 + r * Math.sin(a)}
                r={compact ? 4.6 : urgent ? 3.7 : 3.3}
                fill={isOn ? on : "var(--hd-ring-off)"}
              />
            );
          })}
        </g>
      </svg>
      <div className="hd-ring-face">
        {state === "locked" ? (
          <span key="locked" className="hd-ring-locked hd-snap">
            <Icon name="lock" style={{ width: `calc(${size} * 0.26)`, height: `calc(${size} * 0.26)` }} strokeWidth={2.4} />
            {!compact && <span style={{ fontSize: `calc(${size} * 0.13)` }}>Locked</span>}
          </span>
        ) : (
          <>
            <span
              className={`hd-num hd-ring-num ${beat}`}
              style={
                {
                  fontSize: `calc(${size} * ${label.length > 2 ? 0.3 : compact ? 0.4 : 0.44})`,
                  fontStretch: `${stretch}%`,
                  fontWeight: urgent ? 900 : 800,
                  color: urgent ? "var(--hd-ring-urgent)" : undefined,
                } as CSSProperties
              }
            >
              <Roll text={label} flash={false} duration={320} />
            </span>
            {caption && !compact && <span className="hd-ring-cap" style={{ fontSize: `calc(${size} * 0.1)` }}>{caption}</span>}
          </>
        )}
      </div>
    </div>
  );
}
