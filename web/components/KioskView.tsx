"use client";
// The box screen in a browser, at exactly 800 x 480: the same layout, colours, fonts and motion as the ESP32
// renderer (firmware/kiosk_screen/ui.cpp). Coordinates below are the firmware's; text is placed by baseline
// like the firmware does (top = baseline - ascent of the firmware font). Motion is CSS: entrances are keyframes
// whose resting style is the final state, numbers roll, the lock ring drains from the clock. If the box and
// this page ever differ, the firmware is the reference.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref, type RefObject } from "react";
import type { KioskButton, KioskCard, KioskScreen } from "@/lib/kiosk";
import { avatarHash } from "@/lib/boxText";
import { MARK_BODIES, MARK_HEADS } from "@/components/huddle/Mark";

// ---------------------------------------------------------------- tokens + fonts (same as ui.cpp)

const P = {
  // Same as the firmware defaults (ui.cpp) and the palette lib/kiosk.ts sends: black, beige ink, muted green/red.
  canvas: "#000000", card: "#111111", well: "#1A1A1A", rule: "#262626", ruleStrong: "#3A3A3A", ink: "#E9DFC9",
  ink2: "#BDB4A2", muted: "#8A8479", accent: "#E9DFC9", deep: "#CFC3A8", lime: "#1FD67F", yes: "#1FD67F",
  yes600: "#17B067", no: "#FF5148", no600: "#D93A33", hot: "#FF5148", gold: "#D9B36C", white: "#0A0A0A",
  accentTint: "#26231C", yesTint: "#0B2E1E", noTint: "#36130F",
};
const GRAD = `linear-gradient(90deg, ${P.deep}, ${P.accent} 50%, ${P.lime})`;
/** The question badge: one even blend from beige to green across the whole pill (matches the firmware). */
const BADGE_GRAD = `linear-gradient(90deg, ${P.accent}, ${P.lime})`;

type FontKey = "HERO" | "H1" | "H2" | "H3" | "B1" | "B2" | "B3" | "N1" | "N2" | "N3" | "N4";
/** Firmware fonts (firmware/tools/mkfonts.py): px size, ascent, descent. */
const F: Record<FontKey, { size: number; asc: number; desc: number; cls: string }> = {
  HERO: { size: 96, asc: 90, desc: 26, cls: "hk-head hk-w800" },
  H1: { size: 44, asc: 41, desc: 12, cls: "hk-head hk-w800" },
  H2: { size: 31, asc: 29, desc: 9, cls: "hk-head hk-w800" },
  H3: { size: 24, asc: 23, desc: 7, cls: "hk-head hk-w700" },
  B1: { size: 20, asc: 20, desc: 7, cls: "hk-body hk-w700" },
  B2: { size: 18, asc: 18, desc: 6, cls: "hk-body hk-w400" },
  B3: { size: 15, asc: 15, desc: 5, cls: "hk-body hk-w600" },
  N1: { size: 92, asc: 81, desc: 20, cls: "hk-num hk-w800 hk-c75" },
  N2: { size: 60, asc: 53, desc: 13, cls: "hk-num hk-w800 hk-c75" },
  N3: { size: 32, asc: 29, desc: 7, cls: "hk-num hk-w800 hk-c82" },
  N4: { size: 21, asc: 19, desc: 5, cls: "hk-num hk-w700 hk-c90" },
};

/** Rounded trig results, so server and client render the same SVG numbers (no hydration mismatch). */
const r2 = (n: number) => Math.round(n * 100) / 100;
const d = (ms: number) => ({ ["--d" as string]: `${ms}ms` }) as CSSProperties;

function money(cents: number, sign = false): string {
  const neg = cents < 0;
  const c = Math.abs(Math.round(cents));
  const pre = neg ? "-" : sign ? "+" : "";
  return c % 100 === 0 && c >= 1000 ? `${pre}$${c / 100}` : `${pre}$${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
}

let measureCtx: CanvasRenderingContext2D | null = null;
/** Lines the firmware's greedy word wrap needs for `text` in `font` at `maxW` (null on the server). */
function wrapLines(font: string, text: string, maxW: number): number | null {
  if (typeof document === "undefined") return null;
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return null;
  measureCtx.font = font;
  let lines = 0;
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && measureCtx.measureText(next).width > maxW) {
      lines++;
      line = word;
    } else line = next;
  }
  return lines + (line ? 1 : 0);
}

/** Same hash as the firmware (UTF-8 bytes of the box-safe name) and the phone/TV avatars. */
const hash = avatarHash;
const AVATAR = ["#0B7A3E", "#127C71", "#6D4AD6", "#B4235A", "#5B6B2F", "#8C5A1B", "#2F4858", "#9A3412"];

// ---------------------------------------------------------------- primitives

/** Text placed by baseline, like the firmware. */
function T({ f, x, y, w, align = "left", color = P.ink, children, className = "", style, title }: {
  f: FontKey; x: number; y: number; w?: number; align?: "left" | "center" | "right"; color?: string;
  children: ReactNode; className?: string; style?: CSSProperties; title?: string;
}) {
  const ft = F[f];
  const left = align === "left" ? x : align === "center" ? x - (w ?? 0) / 2 : x - (w ?? 0);
  return (
    <div
      className={`hk-t ${ft.cls} ${className}`}
      title={title}
      style={{
        left, top: y - ft.asc, width: w, height: ft.asc + ft.desc, lineHeight: `${ft.asc + ft.desc}px`,
        fontSize: ft.size, color, textAlign: align, ...style,
      }}
    >
      {children}
    </div>
  );
}

function Box({ x, y, w, h, r, bg, className = "", style, children, shadow = false }: {
  x: number; y: number; w: number; h: number; r: number; bg?: string; className?: string; style?: CSSProperties;
  children?: ReactNode; shadow?: boolean;
}) {
  return (
    <div className={`hk-abs ${shadow ? "hk-lift" : ""} ${className}`} style={{ left: x, top: y, width: w, height: h, borderRadius: r, background: bg, ...style }}>
      {children}
    </div>
  );
}

function Avatar({ name, cx, cy, r, dim = false }: { name: string; cx: number; cy: number; r: number; dim?: boolean }) {
  const ch = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <div
      className={`hk-abs hk-avatar ${r >= 20 ? "hk-body hk-w700" : "hk-body hk-w600"}`}
      style={{ left: cx - r, top: cy - r, width: 2 * r, height: 2 * r, background: AVATAR[hash(name) % 8], fontSize: r >= 20 ? 20 : 15, opacity: dim ? 0.6 : 1 }}
      aria-hidden="true"
    >
      {ch}
    </div>
  );
}

/**
 * The Huddle mark (components/huddle/Mark.tsx): three people in a ring. Same size as the firmware's markLogo:
 * the heads reach 1.25 R from the centre. `spin` turns it smoothly (the firmware turns it by the clock).
 */
function Mark({ cx, cy, R, spin = false }: { cx: number; cy: number; R: number; lit?: number; spin?: boolean }) {
  const k = (1.25 * R) / 19.5;
  return (
    <svg className={`hk-abs ${spin ? "hk-mark-spin" : ""}`} style={{ left: r2(cx - 20 * k), top: r2(cy - 20 * k) }} width={r2(40 * k)} height={r2(40 * k)} viewBox="0 0 40 40" fill={P.lime} aria-hidden="true">
      <path d={MARK_BODIES} />
      {MARK_HEADS.map(([x, y, r]) => <circle key={`${x},${y}`} cx={x} cy={y} r={r} />)}
    </svg>
  );
}

/** "huddle" small, inline at the start of a top line (market, locked, result). */
function MiniBrand() {
  return (
    <span className="hk-mini" translate="no">
      <svg width="22" height="22" viewBox="0 0 40 40" fill={P.lime} aria-hidden="true">
        <path d={MARK_BODIES} />
        {MARK_HEADS.map(([x, y, r]) => <circle key={`${x},${y}`} cx={x} cy={y} r={r} />)}
      </svg>
      <span className="hk-head hk-w800">huddle</span>
    </span>
  );
}

function Wordmark({ x, y, lit = 1 }: { x: number; y: number; lit?: number }) {
  return (
    <>
      <Mark cx={x + 13} cy={y - 9} R={11} lit={lit} />
      <T f="H3" x={x + 32} y={y}>huddle</T>
    </>
  );
}

function LiveDot({ cx, cy, fresh }: { cx: number; cy: number; fresh: boolean }) {
  return (
    <span className={`hk-abs hk-dot ${fresh ? "hk-fresh" : ""}`} style={{ left: cx - 5, top: cy - 5, background: fresh ? P.accent : P.gold }} aria-label={fresh ? "Connected" : "Waiting for the site"} role="img" />
  );
}

function Bolt({ cx, cy, s = 1, color }: { cx: number; cy: number; s?: number; color: string }) {
  return (
    <svg className="hk-abs" style={{ left: cx - 7 * s, top: cy - 10 * s }} width={14 * s} height={20 * s} viewBox="-7 -10 14 20" aria-hidden="true">
      <path d="M2 -9 L-6 1.5 L1 1.5 Z M-2 9 L6 -1.5 L-1 -1.5 Z" fill={color} />
    </svg>
  );
}
function Lock({ cx, cy, s = 1, color, className = "" }: { cx: number; cy: number; s?: number; color: string; className?: string }) {
  return (
    <svg className={`hk-abs ${className}`} style={{ left: cx - 10 * s, top: cy - 11 * s }} width={20 * s} height={24 * s} viewBox="-10 -11 20 24" aria-hidden="true">
      <path d="M-5.5 -0.5 V-3 A5.5 5.5 0 0 1 5.5 -3 V-0.5" fill="none" stroke={color} strokeWidth="2.6" />
      <rect x="-9" y="-0.5" width="18" height="13" rx="3" fill={color} />
    </svg>
  );
}
function Arrow({ cx, cy, s = 1, up, color, className = "" }: { cx: number; cy: number; s?: number; up: boolean; color: string; className?: string }) {
  return (
    <svg className={`hk-abs ${className}`} style={{ left: cx - 7 * s, top: cy - 6 * s }} width={14 * s} height={12 * s} viewBox="-7 -6 14 12" aria-hidden="true">
      <path d={up ? "M0 -6 L-7 5 L7 5 Z" : "M0 6 L-7 -5 L7 -5 Z"} fill={color} />
    </svg>
  );
}

/** Rolling digits: each digit is a 0-9 strip; the number flashes its direction colour. */
function Roll({ f, x, y, text, color, up, down, dir, ms = 560 }: {
  f: FontKey; x: number; y: number; text: string; color: string; up?: string; down?: string; dir?: number; ms?: number;
}) {
  const ft = F[f];
  const prev = useRef(text);
  const [flash, setFlash] = useState(0);
  useEffect(() => {
    if (prev.current !== text) {
      prev.current = text;
      setFlash((n) => n + 1);
    }
  }, [text]);
  const flashColor = dir && dir > 0 ? up : dir && dir < 0 ? down : undefined;
  const h = ft.asc + ft.desc;
  return (
    <div
      key={flash}
      className={`hk-t hk-roll ${ft.cls} ${flash && flashColor ? "hk-flash" : ""}`}
      style={{ left: x, top: y - ft.asc, height: h, lineHeight: `${h}px`, fontSize: ft.size, color, ["--flash" as string]: flashColor ?? color, ["--roll" as string]: `${ms}ms` } as CSSProperties}
      aria-label={text}
    >
      {[...text].map((ch, i) =>
        /\d/.test(ch) ? (
          <span key={`${text.length - i}`} className="hk-digit" style={{ height: h }} aria-hidden="true">
            <span className="hk-sizer">0</span>
            <span className="hk-strip" style={{ transform: `translateY(${-Number(ch) * h}px)`, transitionDelay: `${(text.length - 1 - i) * 28}ms` }}>
              {"0123456789".split("").map((n) => (
                <span key={n} style={{ height: h }}>{n}</span>
              ))}
            </span>
          </span>
        ) : (
          <span key={`c${text.length - i}`} aria-hidden="true">{ch}</span>
        ),
      )}
    </div>
  );
}

/** Kinetic text: each word rises out of its own baseline mask, staggered. Replays when `text` changes. */
function Kinetic({ f, x, y, w, lines, lh, text, color = P.ink, delay = 0, stagger = 45 }: {
  f: FontKey; x: number; y: number; w: number; lines: number; lh: number; text: string; color?: string; delay?: number; stagger?: number;
}) {
  const ft = F[f];
  const words = text.split(/\s+/).filter(Boolean);
  return (
    <div
      key={text}
      className={`hk-t hk-kinetic ${ft.cls}`}
      style={{ left: x, top: y - ft.asc, width: w, fontSize: ft.size, lineHeight: `${lh}px`, color, whiteSpace: "normal", maxHeight: lines * lh + 2, WebkitLineClamp: lines } as CSSProperties}
      aria-label={text}
    >
      {words.map((wd, i) => (
        <span key={i} aria-hidden="true">
          <span className="hk-wm">
            <span className="hk-w" style={d(delay + i * stagger)}>{wd}</span>
          </span>{" "}
        </span>
      ))}
    </div>
  );
}

const STYLE: Record<string, { bg: string; fg: string; cls?: string }> = {
  primary: { bg: P.accent, fg: P.white },
  yes: { bg: P.yes, fg: P.white },
  no: { bg: P.no, fg: P.ink },
  brand: { bg: GRAD, fg: P.white },
  call: { bg: P.accentTint, fg: P.deep, cls: "hk-call" },
  ink: { bg: P.ink, fg: P.white },
  white: { bg: P.white, fg: P.ink },
  plain: { bg: P.card, fg: P.ink, cls: "hk-plain" },
};

/** Rough label width (the firmware measures; the preview estimates). */
const labelW = (label: string, size: number) => label.length * size * 0.5;

/**
 * Same rule as the firmware's callRow: as many Call it! buttons as fit with their whole label and bolt
 * (at most 4, at least 2), all in one face.
 */
function callRow<T extends { label: string }>(calls: T[], width: number): { shown: T[]; bw: number; small: boolean; noIcon: boolean } {
  let n = Math.min(calls.length, 4);
  const bwFor = (k: number) => (width - (k - 1) * 8) / k;
  // keep a button only while every label fits whole in the small face
  while (n > 2 && calls.slice(0, n).some((c) => labelW(c.label, 15) > bwFor(n) - 20)) n--;
  const shown = calls.slice(0, n);
  const bw = n ? bwFor(n) : 0;
  // one face, and the bolt on all of them or none, so the row matches
  const small = shown.some((c) => labelW(c.label, 20) > bw - 30 - 18);
  return { shown, bw, small, noIcon: small && shown.some((c) => labelW(c.label, 15) > bw - 20 - 18) };
}

function Button({ b, x, y, w, h, f = "B1", r = 18, style, onTouch, pending, small: forceSmall, noIcon }: {
  b: KioskButton & { enabled?: boolean }; x: number; y: number; w: number; h: number; f?: FontKey; r?: number;
  style?: string; onTouch: (id: string) => void; pending?: boolean; small?: boolean; noIcon?: boolean;
}) {
  const st = STYLE[style ?? b.style ?? "plain"] ?? STYLE.plain;
  const enabled = b.enabled !== false;
  const call = (style ?? b.style) === "call";
  const font = F[f];
  // same fallback as the firmware: long label on a narrow button -> small face, then no icon
  const small = forceSmall ?? labelW(b.label, font.size) > w - 30 - (b.id === "start" || b.id === "next" || call ? 18 : 0);
  const iconFits = !noIcon && (!small || labelW(b.label, 15) <= w - 20 - 18);
  const play = (b.id === "start" || b.id === "next") && iconFits;
  return (
    <button
      type="button"
      className={`hk-btn ${st.cls ?? ""} ${enabled ? "" : "hk-off"} ${small ? "hk-body hk-w600" : font.cls}`}
      style={{ left: x, top: y, width: w, height: h, borderRadius: r, background: enabled ? st.bg : P.well, color: enabled ? st.fg : P.muted, fontSize: small ? 15 : font.size }}
      onClick={() => enabled && onTouch(b.id)}
      disabled={!enabled}
    >
      {call && iconFits && <svg width="14" height="20" viewBox="-7 -10 14 20" aria-hidden="true"><path d="M2 -9 L-6 1.5 L1 1.5 Z M-2 9 L6 -1.5 L-1 -1.5 Z" fill={enabled ? P.accent : P.muted} /></svg>}
      <span className="hk-label">{b.label}</span>
      {play && <svg width="14" height="16" viewBox="-6 -8 13 16" aria-hidden="true"><path d="M-5 -7 L-5 7 L7 0 Z" fill="currentColor" /></svg>}
      {pending && <span className="hk-pending" aria-hidden="true"><i /><i /><i /></span>}
    </button>
  );
}

// ---------------------------------------------------------------- shared pieces

/**
 * A scrolling list with the firmware's edge fades (ui.cpp picker): canvas fades in at the top once scrolled and
 * at the bottom while there is more below, so a long list (10+ players) visibly continues.
 */
function ScrollList({ x, y, w, h, label, live, children }: { x: number; y: number; w: number; h: number; label: string; live?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ top: false, bottom: false });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const top = el.scrollTop > 2;
      const bottom = el.scrollTop < el.scrollHeight - el.clientHeight - 2;
      setEdge((e) => (e.top === top && e.bottom === bottom ? e : { top, bottom }));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, []);
  return (
    <div className="hk-abs" style={{ left: x, top: y, width: w, height: h }}>
      <div ref={ref} className="hk-scroll" style={{ left: 0, top: 0, width: w, height: h }} aria-label={label} aria-live={live ? "polite" : undefined}>
        {children}
      </div>
      <i className={`hk-edge top ${edge.top ? "on" : ""}`} aria-hidden="true" />
      <i className={`hk-edge bottom ${edge.bottom ? "on" : ""}`} aria-hidden="true" />
    </div>
  );
}

/**
 * Like ui.cpp: `home*` on the left, `away*` on the right. The server sends the teams in drawing order, so for
 * "Away at Home" games (`swapped`) the left team is the real away team: the label then reads "49ers 0 at Cowboys 0".
 */
function Scorebug({ s, rx, y, h, elRef }: { s: KioskScreen; rx: number; y: number; h: number; elRef?: Ref<HTMLDivElement> }) {
  const sc = s.score!;
  const live = sc.status === "live";
  const sub = sc.status === "final" ? "Final" : sc.period || (live ? "Live" : "Pre");
  const label = `${sc.home} ${sc.homeScore}${sc.swapped ? " at " : ", "}${sc.away} ${sc.awayScore}, ${sc.clock}`;
  return (
    <div ref={elRef} className="hk-abs hk-lift hk-scorebug hk-drop" style={{ right: 800 - rx, top: y, height: h, borderRadius: h / 2 }} aria-label={label}>
      <i className="hk-bar" style={{ background: sc.homeColor ?? P.ink2 }} />
      <b className="hk-body hk-w700">{sc.homeShort || "HOME"}</b>
      <span className="hk-score hk-num hk-w700 hk-c90">{sc.homeScore}</span>
      <span className="hk-clock">
        <span className="hk-num hk-w700 hk-c90">{sc.clock}</span>
        <small className="hk-body hk-w600">{live && <i className="hk-live" />}{sub}</small>
      </span>
      <span className="hk-score hk-num hk-w700 hk-c90">{sc.awayScore}</span>
      <b className="hk-body hk-w700">{sc.awayShort || "AWAY"}</b>
      <i className="hk-bar" style={{ background: sc.awayColor ?? P.muted }} />
    </div>
  );
}

function CodeChip({ code, rx, elRef }: { code: string; rx: number; elRef?: Ref<HTMLDivElement> }) {
  return (
    <div ref={elRef} className="hk-abs hk-lift hk-chip" style={{ right: 800 - rx, top: 12, height: 38 }}>
      <span className="hk-body hk-w600" style={{ fontSize: 15, color: P.ink2 }}>Join</span>
      <b className="hk-body hk-w700" style={{ fontSize: 20 }}>{code}</b>
    </div>
  );
}

function Burst({ count, x, y, colors, delay }: { count: number; x: number; y: number; colors: string[]; delay: number }) {
  let r = 2463534242;
  const rnd = () => {
    r ^= r << 13;
    r ^= r >>> 17;
    r ^= r << 5;
    return ((r >>> 0) % 10000) / 10000;
  };
  return (
    <div className="hk-burst" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => {
        const ang = -Math.PI / 2 + (rnd() - 0.5) * 2.6;
        const sp = 380 + rnd() * 520;
        return (
          <i
            key={i}
            style={{
              left: x, top: y, background: colors[i % colors.length],
              ["--dx" as string]: `${Math.cos(ang) * sp * 1.4}px`, ["--dy" as string]: `${Math.sin(ang) * sp * 0.9}px`,
              ["--d" as string]: `${delay}ms`, ["--rot" as string]: `${(rnd() - 0.5) * 1440}deg`,
            } as CSSProperties}
          />
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- screens

/** Title + subtitle on one baseline after the wordmark (firmware: title at x 176, subtitle 16 px after it). */
function TitleRow({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="hk-abs hk-titlerow" style={{ left: 176, top: 42 - 29, width: 800 - 176 - 42, height: 38 }}>
      <span className="hk-head hk-w800" style={{ fontSize: 31 }}>{title}</span>
      <span className="hk-body hk-w400" style={{ fontSize: 18, color: P.ink2 }}>{subtitle}</span>
    </div>
  );
}

type Ctx = { s: KioskScreen; onTouch: (id: string) => void; pending?: string | null; fresh: boolean };

function Select({ s, onTouch, fresh }: Ctx) {
  const cards: KioskCard[] = s.cards ?? (s.tiles ?? []).map((t) => ({ id: t.id, title: t.label, sub: t.sub, enabled: t.enabled }));
  return (
    <>
      <Wordmark x={20} y={40} />
      <TitleRow title={s.title || "Pick a game"} subtitle={s.subtitle} />
      <LiveDot cx={776} cy={30} fresh={fresh} />
      <ScrollList x={0} y={62} w={800} h={418} label="Games">
        <div style={{ position: "relative", height: 6 + Math.ceil(cards.length / 3) * 196 + 4 }}>
          {cards.map((c, i) => {
            const x = 16 + (i % 3) * 260;
            const y = 6 + Math.floor(i / 3) * 196;
            const teams = c.home && c.away;
            const replay = c.kind === "replay";
            // US style "Away at Home" (away on top); soccer "Home v Away". Old servers: NFL only.
            const at = c.at ?? c.league === "NFL";
            const [t1, t2] = teams ? (at ? [c.away!, c.home!] : [c.home!, c.away!]) : [];
            const c1 = at ? c.away?.color ?? P.ink2 : c.home?.color ?? c.color ?? P.accent;
            const c2 = at ? c.home?.color ?? c.color ?? P.accent : c.away?.color ?? P.ink2;
            return (
              <button
                key={c.id}
                type="button"
                className={`hk-card hk-rise ${c.enabled ? "hk-lift" : "hk-off"}`}
                style={{ left: x, top: y, width: 248, height: 184, ...d(80 + i * 60) }}
                onClick={() => c.enabled && onTouch(c.id)}
                aria-disabled={!c.enabled}
                aria-label={`${c.title}${c.enabled ? "" : ", coming soon"}`}
              >
                <i className="hk-ribbon" style={{ background: teams ? `linear-gradient(90deg, ${c1} 50%, ${c2} 50%)` : c.color ?? P.accent }} />
                {c.league && <span className="hk-pill hk-body hk-w600" style={{ left: 14, top: 18, background: c.enabled ? P.well : P.rule, color: P.ink2 }}>{c.league}</span>}
                {!c.enabled ? (
                  <span className="hk-pill hk-body hk-w600" style={{ right: 14, top: 18, background: P.rule, color: P.muted }}>Soon</span>
                ) : replay ? (
                  <span className="hk-pill hk-body hk-w600" style={{ right: 14, top: 18, background: P.accentTint, color: P.deep }}>Replay</span>
                ) : (
                  <span className="hk-pill hk-body hk-w600" style={{ right: 14, top: 18, background: P.ink, color: P.white }}><i className="hk-live" /> Live</span>
                )}
                {teams ? (
                  <>
                    <i className="hk-swatch" style={{ left: 14, top: 58, background: c1 }} />
                    <T f="H3" x={30} y={80} w={204} color={c.enabled ? P.ink : P.muted}>{t1!.nick || t1!.name}</T>
                    <T f="B3" x={30} y={102} color={P.muted}>{at ? "at" : "v"}</T>
                    <i className="hk-swatch" style={{ left: 14, top: 108, background: c2 }} />
                    <T f="H3" x={30} y={130} w={204} color={c.enabled ? P.ink : P.muted}>{t2!.nick || t2!.name}</T>
                  </>
                ) : (
                  <>
                    <T f="H2" x={14} y={86} w={220} color={c.enabled ? P.ink : P.muted}>{c.title}</T>
                    <div className="hk-t hk-body hk-w400 hk-clamp2" style={{ left: 14, top: 120 - 18, width: 220, fontSize: 18, lineHeight: "24px", color: P.ink2 }}>{c.sub}</div>
                  </>
                )}
                {c.gemini && (
                  <span className="hk-pill hk-body hk-w600" style={{ right: 14, top: 144, background: P.ink, color: P.white }}>
                    <svg width="13" height="12" viewBox="0 0 12 11" aria-hidden="true"><path d="M0 0 H12 L6 11 Z M3 1.5 L6 6.5 L9 1.5 Z" fill="#fff" fillRule="evenodd" /></svg> Gemini odds
                  </span>
                )}
                {(c.date || (teams && c.sub)) && <T f="B3" x={14} y={163} w={c.gemini ? 92 : 220} color={P.muted}>{c.date || c.sub}</T>}
              </button>
            );
          })}
        </div>
      </ScrollList>
    </>
  );
}

function Lobby({ s, onTouch, pending, fresh }: Ctx) {
  const roster = s.roster ?? (s.players ?? []).map((p) => ({ name: p, cents: 0, deposited: -1 }));
  const pot = s.pot ?? roster.reduce((a, p) => a + Math.max(0, p.deposited), 0);
  const calls = s.calls ?? s.buttons.filter((b) => b.id.startsWith("moment:")).map((b) => ({ ...b, enabled: true }));
  const start = s.buttons.find((b) => b.id === "start");
  const cancel = s.buttons.find((b) => b.id === "cancel");
  const moneyB = s.buttons.find((b) => b.id.startsWith("money:"));
  const startX = (cancel ? 136 : 0) + (moneyB ? 164 : 0);
  const x0 = 322;
  const w = 800 - 14 - x0;
  const listY = 190;
  const listBottom = calls.length ? 302 : 392;
  const colW = (w - 10) / 2;
  const qr = s.qr;
  const scale = qr ? Math.max(1, Math.floor(192 / qr.size)) : 1;
  return (
    <>
      <div className="hk-abs hk-slide-l hk-join" style={{ left: 12, top: 12, width: 292, height: 456, borderRadius: 30, background: GRAD }}>
        <div className="hk-abs" style={{ left: 40, top: 22, width: 212, height: 212, borderRadius: 18, background: P.ink, display: "grid", placeItems: "center" }}>
          {qr && (
            <svg width={scale * qr.size} height={scale * qr.size} viewBox={`0 0 ${qr.size} ${qr.size}`} shapeRendering="crispEdges" role="img" aria-label="Join QR code">
              {qr.rows.flatMap((row, r) => [...row].map((c, col) => (c === "1" ? <rect key={`${r}-${col}`} x={col} y={r} width="1" height="1" fill="#0A0A0A" /> : null)))}
            </svg>
          )}
        </div>
        <T f="H3" x={146} y={264} w={280} align="center" color={P.ink}>Tap your phone here</T>
        <T f="B2" x={146} y={288} w={280} align="center" color="rgba(255,255,255,.9)">or scan the code to join</T>
        <T f="B3" x={146} y={316} w={280} align="center" color="rgba(255,255,255,.86)">Party code</T>
        <div className="hk-abs hk-code" style={{ left: 0, top: 326, width: 292 }} aria-label={`Party code ${s.code}`}>
          {(s.code ?? "").split("").map((ch, i) => (
            <span key={i} className="hk-pop hk-head hk-w800" style={d(320 + i * 90)}>{ch}</span>
          ))}
        </div>
        <T f="B3" x={146} y={420} w={270} align="center" color="rgba(255,255,255,.86)">{s.joinUrl}</T>
        <Mark cx={105} cy={447} R={11} />
        <T f="H3" x={124} y={456} color={P.ink}>huddle</T>
      </div>

      <Kinetic f="H2" x={x0} y={46} w={w - 40} lines={1} lh={34} text={s.game?.title || s.title} delay={120} />
      <LiveDot cx={776} cy={30} fresh={fresh} />
      <T f="B2" x={x0} y={76} w={w} color={P.ink2} className="hk-rise" style={d(360)}>{s.subtitle}</T>

      <Box x={x0} y={90} w={(w - 12) / 2} h={88} r={20} bg={P.card} shadow className="hk-rise" style={d(420)}>
        <i className="hk-abs hk-dotgold" style={{ left: 16, top: 15 }} />
        <T f="B3" x={34} y={26} color={P.ink2}>In the pot</T>
        <Roll f="N2" x={16} y={78} text={money(pot)} color={P.ink} up={P.deep} dir={1} ms={900} />
      </Box>
      <Box x={x0 + (w - 12) / 2 + 12} y={90} w={(w - 12) / 2} h={88} r={20} bg={P.card} shadow className="hk-rise" style={d(500)}>
        <T f="B3" x={16} y={26} color={P.ink2}>{roster.length === 1 ? "Player" : "Players"}</T>
        <Roll f="N2" x={16} y={78} text={String(roster.length)} color={P.accent} up={P.deep} dir={1} ms={700} />
        <Mark cx={(w - 12) / 2 - 34} cy={50} R={18} lit={Math.max(1, Math.min(12, roster.length))} />
      </Box>

      <ScrollList x={x0 - 6} y={listY} w={w + 12} h={listBottom - listY} label="Players in the room" live>
        <div style={{ position: "relative", height: Math.ceil(roster.length / 2) * 60 }}>
          {roster.length === 0 && (
            <div className="hk-abs hk-rise hk-empty" style={{ left: 6, top: 2, width: w, height: 64, ...d(560) }}>
              <i className="hk-breathe" />
              <T f="B1" x={40} y={31}>Waiting for the first player</T>
              <T f="B3" x={40} y={52} color={P.ink2}>Tap a phone on the box or scan the code</T>
            </div>
          )}
          {roster.map((p, i) => {
            const amt = p.deposited === 0 ? "adding..." : p.deposited > 0 ? money(p.cents) : "";
            return (
              <div key={p.name + i} className="hk-abs hk-row hk-lift hk-slide-r" style={{ left: 6 + (i % 2) * (colW + 10), top: Math.floor(i / 2) * 60, width: colW, height: 52 }}>
                <Avatar name={p.name} cx={26} cy={26} r={17} />
                <T f="B1" x={52} y={33} w={colW - 130}>{p.name}</T>
                {amt && (amt.startsWith("$") ? <T f="N4" x={colW - 14} y={33} w={90} align="right" color={P.ink2}>{amt}</T> : <T f="B3" x={colW - 14} y={32} w={90} align="right" color={P.muted}>{amt}</T>)}
              </div>
            );
          })}
        </div>
      </ScrollList>

      {calls.length > 0 && (
        <div className="hk-rise" style={d(600)}>
          <Bolt cx={x0 + 8} cy={316} s={0.75} color={P.accent} />
          <T f="B3" x={x0 + 20} y={322} color={P.ink2}>Call it! Tap the moment it happens on TV</T>
          {(() => {
            const row = callRow(calls, w);
            return row.shown.map((c, i) => (
              <Button key={c.id} b={{ ...c, style: "primary" }} style="call" small={row.small} noIcon={row.noIcon} x={x0 + i * (row.bw + 8)} y={330} w={row.bw} h={60} r={16} onTouch={onTouch} pending={pending === c.id} />
            ));
          })()}
        </div>
      )}
      <div className="hk-rise" style={d(680)}>
        {cancel && <Button b={cancel} x={x0} y={400} w={124} h={66} r={20} onTouch={onTouch} pending={pending === cancel.id} />}
        {moneyB && <Button b={moneyB} x={x0 + (cancel ? 136 : 0)} y={400} w={152} h={66} r={20} onTouch={onTouch} pending={pending === moneyB.id} />}
        {start && <Button b={start} style="brand" f="H3" x={x0 + startX} y={400} w={800 - 14 - x0 - startX} h={66} r={22} onTouch={onTouch} pending={pending === start.id} />}
      </div>
    </>
  );
}

/** Remaining ms to lock, from the screen's lockInMs and when it arrived (same as the firmware). */
function useRemaining(s: KioskScreen) {
  const base = useRef({ rem: 0, at: 0, q: "" });
  const est = s.lockInMs ?? (s.lockIn ?? 0) * 1000;
  const now = Date.now();
  const cur = base.current.rem - (now - base.current.at);
  if (base.current.q !== s.question || Math.abs(est - cur) > 400 || s.screen !== "market") base.current = { rem: est, at: now, q: s.question ?? "" };
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 100);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, base.current.rem - (Date.now() - base.current.at));
}

function LockRing({ cx, cy, R, rem, tot, locked, manual }: { cx: number; cy: number; R: number; rem: number; tot: number; locked: boolean; manual: boolean }) {
  const N = 24;
  const urgent = !locked && !manual && rem <= 5000;
  const frac = tot > 0 ? Math.min(1, Math.max(0, rem / tot)) : 1;
  const lit = locked ? 0 : manual ? N : Math.ceil(frac * N);
  const secs = Math.ceil(rem / 1000);
  const label = secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : String(secs);
  return (
    <div className={`hk-abs hk-ring ${urgent ? "hk-urgent" : ""}`} style={{ left: cx - R - 14, top: cy - R - 14, width: 2 * R + 28, height: 2 * R + 28 }} role="timer" aria-live="off" aria-label={locked ? "Locked" : manual ? "Locks on the play" : `${secs} seconds to lock`}>
      {!locked && <i className="hk-glow" style={{ inset: 14 + R * 0.38 }} />}
      <svg className="hk-ring-dots" width={2 * R + 28} height={2 * R + 28} viewBox={`${-R - 14} ${-R - 14} ${2 * R + 28} ${2 * R + 28}`} aria-hidden="true">
        {Array.from({ length: N }, (_, i) => {
          const a = (i / N) * Math.PI * 2 - Math.PI / 2;
          const on = i < lit;
          return <circle key={i} cx={r2(R * Math.cos(a))} cy={r2(R * Math.sin(a))} r={urgent ? 7.2 : 6.4} className="hk-ring-dot" data-on={on} fill={on ? (urgent ? P.hot : P.accent) : P.rule} />;
        })}
      </svg>
      {locked ? (
        <>
          <div className="hk-snap" style={{ position: "absolute", left: 0, right: 0, top: R - 12 }}>
            <Lock cx={R + 14} cy={14} s={2.1} color={P.ink} />
          </div>
          <T f="B1" x={R + 14} y={R + 14 + 38} w={120} align="center" className="hk-snap">Locked</T>
        </>
      ) : manual ? (
        <>
          <T f="B1" x={R + 14} y={R + 16} w={120} align="center">Locks on</T>
          <T f="B1" x={R + 14} y={R + 38} w={120} align="center">the play</T>
        </>
      ) : (
        <>
          <T f={label.length > 2 ? "N3" : "N2"} x={R + 14} y={R + 14 + (label.length > 2 ? 10 : 16)} w={140} align="center" color={urgent ? P.hot : P.ink} className={urgent ? "hk-beat" : ""} key={urgent ? label : "n"}>
            {label}
          </T>
          <T f="B3" x={R + 14} y={R + 14 + 42} w={120} align="center" color={urgent ? P.hot : P.muted}>{urgent ? "Last call" : "to lock"}</T>
        </>
      )}
    </div>
  );
}

function Sparkline({ x, y, w, h, hist }: { x: number; y: number; w: number; h: number; hist: number[] }) {
  if (!hist.length) return null;
  let lo = Math.min(...hist), hi = Math.max(...hist);
  const mid = Math.floor((lo + hi) / 2), span = Math.max(24, hi - lo + 8);
  lo = Math.max(0, mid - Math.floor(span / 2));
  hi = Math.min(100, lo + span);
  const m = Math.max(2, hist.length);
  const px = (i: number) => (i * (w - 8)) / (m - 1);
  const py = (v: number) => h - 3 - ((v - lo) * (h - 6)) / Math.max(1, hi - lo);
  let path = "";
  for (let i = 0; i < m; i++) {
    const v = hist[Math.min(i, hist.length - 1)];
    path += i === 0 ? `M${px(i)},${py(v)}` : `H${px(i)}V${py(v)}`;
  }
  const last = hist[hist.length - 1];
  return (
    <svg className="hk-abs" style={{ left: x, top: y }} width={w} height={h} overflow="visible" aria-hidden="true">
      <path d={`${path}V${h}H0Z`} fill="rgba(20,104,255,.13)" />
      <path key={hist.length} d={path} fill="none" stroke={P.yes} strokeWidth="2.6" className="hk-draw" pathLength={1} />
      <circle cx={px(m - 1)} cy={py(last)} r="4.5" fill={P.yes} />
      <circle cx={px(m - 1)} cy={py(last)} r="4.5" fill={P.yes} className="hk-ping" />
    </svg>
  );
}

// Kalshi-style market (mirrors drawMarket): slim top bar, calm title, huge "67% chance", a clean YES chart
// (room solid, model dashed, Gemini quiet), a right rail with a thin countdown, slim Yes / No tiles, trades.
const clampPct = (v: number | null | undefined, def = 50) => Math.min(100, Math.max(0, typeof v === "number" && Number.isFinite(v) ? v : def));

function HeroChart({ s, x, y, w, h, locked }: { s: KioskScreen; x: number; y: number; w: number; h: number; locked: boolean }) {
  const c = s.chart;
  const vals = (c?.room?.length ? c.room : s.history ?? []).slice(-64).map((v) => clampPct(v));
  const span = c ? Math.min(100, Math.max(5, c.span ?? 100)) : 100;
  const px0 = 0, px1 = w - 44, py0 = 24, py1 = h - 22;
  const PY = (v: number) => py1 - (v * (py1 - py0)) / 100;
  const n = vals.length;
  const PX = (i: number) => (n <= 1 ? px0 : px0 + ((px1 - px0) * span * i) / (100 * (n - 1)));
  const lineC = locked ? P.muted : P.yes;
  let path = "";
  vals.forEach((v, i) => {
    path += i === 0 ? `M${r2(PX(i))} ${r2(PY(v))}` : ` H${r2(PX(i))} V${r2(PY(v))}`;
  });
  if (n === 1) path += ` H${px0 + 40}`;
  const endX = n === 1 ? px0 + 40 : PX(n - 1);
  const gem = c?.gemini;
  let gpath = "";
  if (gem) gem.slice(-64).forEach((g, i) => { if (g !== null && g !== undefined) gpath += `${gpath && gem[i - 1] != null ? " L" : " M"}${r2(PX(i))} ${r2(PY(clampPct(g)))}`; });
  const model = typeof c?.model === "number" ? clampPct(c.model) : null;
  return (
    <div className="hk-abs hk-fade" style={{ left: x, top: y, width: w, height: h, ...d(260) }}>
      <div className="hk-abs hk-legend" style={{ left: 0, top: 0 }}>
        <span><i style={{ background: lineC }} />Room</span>
        {model !== null && <span><i className="hk-dash" />Model</span>}
        {gpath && <span><i style={{ background: P.ink2, opacity: 0.6, height: 1.5 }} />Gemini</span>}
      </div>
      {locked && (
        <div className="hk-abs hk-lockbadge hk-pop" style={{ right: 44, top: -7 }}>
          <Lock cx={0} cy={0} s={0.55} color={P.ink} />Locked
        </div>
      )}
      <svg className="hk-abs" style={{ left: 0, top: 0 }} width={w} height={h} aria-hidden="true">
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1={px0} x2={px1} y1={PY(v) + 0.5} y2={PY(v) + 0.5} stroke={v === 50 ? P.ruleStrong : P.rule} strokeDasharray="2 4" />
            <text x={px1 + 8} y={PY(v) + 5} className="hk-axis">{v}%</text>
          </g>
        ))}
        <text x={px0} y={py1 + 18} className="hk-axis">{c?.x0 || "Open"}</text>
        <text x={px1} y={py1 + 18} className="hk-axis" textAnchor="end">{locked ? "Locked" : c?.x1 || "Now"}</text>
        {n === 0 && <text x={(px0 + px1) / 2} y={(py0 + py1) / 2 + 6} className="hk-axis" textAnchor="middle">No trades yet</text>}
        {model !== null && <line x1={px0} x2={px1} y1={PY(model)} y2={PY(model)} stroke={P.ink2} strokeWidth="1.4" strokeDasharray="6 6" opacity="0.66" />}
        {n >= 2 && endX - px0 >= 80 && <path d={`${path} V${py1} H${px0} Z`} fill={lineC} opacity="0.1" stroke="none" />}
        {gpath && <path d={gpath} fill="none" stroke={P.ink2} strokeWidth="1.4" opacity="0.6" className="hk-draw" pathLength={1} />}
        {n > 0 && <path key={n} d={path} fill="none" stroke={lineC} strokeWidth="2.6" className="hk-draw" pathLength={1} />}
        {n > 0 && <circle cx={endX} cy={PY(vals[n - 1])} r="4.5" fill={lineC} />}
        {n > 0 && !locked && <circle cx={endX} cy={PY(vals[n - 1])} r="4.5" fill={P.yes} className="hk-ping" />}
      </svg>
    </div>
  );
}

function PriceTile({ s, yes, x, y, w, h, locked }: { s: KioskScreen; yes: boolean; x: number; y: number; w: number; h: number; locked: boolean }) {
  const v = Math.round(clampPct(yes ? s.yes : s.no));
  const c = yes ? P.yes : P.no;
  return (
    <div className={`hk-abs hk-ptile ${locked ? "hk-dim" : ""}`} style={{ left: x, top: y, width: w, height: h, borderRadius: h / 2, background: yes ? P.yesTint : P.noTint, borderColor: c, color: c }}>
      <T f="B1" x={22} y={h / 2 + 7} color={c}>{yes ? "Yes" : "No"}</T>
      <T f="N3" x={w - 20} y={h / 2 + 11} w={120} align="right" color={c}>{`${v}¢`}</T>
    </div>
  );
}

function Market({ s, onTouch, pending, fresh, locked }: Ctx & { locked: boolean }) {
  const rem = useRemaining(s);
  const tot = (s.lockTotal ?? 0) * 1000 || Math.max(rem, (s.lockIn ?? 0) * 1000);
  const manual = !locked && (s.lockIn === undefined || tot <= 0);
  const urgent = !locked && !manual && rem <= 5000;
  const lockB = s.buttons.find((b) => b.id === "lock");
  const yesB = s.buttons.find((b) => b.id === "resolve:yes");
  const noB = s.buttons.find((b) => b.id === "resolve:no");
  const q = s.question ?? "";
  const [two, setTwo] = useState(q.length > 40);
  useEffect(() => {
    let alive = true;
    void document.fonts.ready.then(() => {
      const n = wrapLines("700 24px 'HK Bricolage'", q, 508);
      if (alive && n !== null) setTwo(n >= 2);
    });
    return () => {
      alive = false;
    };
  }, [q]);
  const hist = s.history ?? [];
  const yesP = Math.round(clampPct(s.yes));
  const diff = hist.length ? yesP - hist[0] : 0;
  const lockW = lockB ? Math.round(lockB.label.length * 9.4) + 32 : 0;
  const right = 800 - 16 - 26 - (lockB && !locked ? lockW + 10 : 0);
  const title = locked ? "Trading closed" : (s.title || "Market open").replace(/^Question /, "Q");
  const heroY = two ? 190 : 162;
  const secs = Math.ceil(rem / 1000);
  const frac = tot > 0 ? Math.min(1, Math.max(0, rem / tot)) : 0;
  // "chance" sits a fixed gap after the big number, measured (digit widths differ by font and while it loads).
  const heroRef = useRef<HTMLDivElement>(null);
  const [numW, setNumW] = useState(0);
  useLayoutEffect(() => {
    const measure = () => {
      const el = heroRef.current?.firstElementChild as HTMLElement | null;
      if (el) setNumW(el.offsetWidth);
    };
    measure();
    void document.fonts.ready.then(measure);
  }, [yesP]);
  return (
    <div key={q} className="hk-fill">
      <div className="hk-abs hk-fade hk-topline" style={{ left: 20, top: 16 }}>
        <MiniBrand />
        {locked ? (
          // Its own slot in the row (Lock is absolutely positioned), so it never sits on the logo.
          <span style={{ position: "relative", display: "inline-block", width: 12, height: 15, flex: "none" }}>
            <Lock cx={6} cy={6.6} s={0.6} color={P.ink2} />
          </span>
        ) : <i className="hk-dot" />}
        <span className="hk-body">{title}</span>
        {s.volume !== undefined ? <span className="hk-body hk-muted">{money(s.volume)} vol</span> : s.traded ? <span className="hk-body hk-muted">{s.traded}</span> : null}
      </div>
      <LiveDot cx={776} cy={30} fresh={fresh} />
      {lockB && !locked && <Button b={lockB} f="B2" x={800 - 16 - 26 - lockW} y={12} w={lockW} h={36} r={18} onTouch={onTouch} pending={pending === "lock"} />}
      {s.score ? <Scorebug s={s} rx={right} y={10} h={40} /> : s.code ? <CodeChip code={s.code} rx={right} /> : null}
      <i className="hk-abs hk-hr" style={{ left: 16, top: 58, width: 768 }} />
      <Kinetic f="H3" x={24} y={94} w={508} lines={2} lh={29} text={q} delay={80} stagger={30} />
      <div ref={heroRef} className="hk-abs hk-rise" style={{ left: 0, top: 0, ...d(200) }}>
        <Roll f="N2" x={22} y={heroY} text={`${yesP}%`} color={locked ? P.ink2 : P.ink} up={P.yes} down={P.no} dir={Math.sign(s.move ?? 0)} ms={700} />
        <T f="B1" x={22 + (numW || `${yesP}%`.length * 36) + 12} y={heroY - 2} color={P.ink2}>
          chance
          {diff !== 0 && <span style={{ color: diff > 0 ? P.yes : P.no, marginLeft: 14, fontSize: 18 }}>{diff > 0 ? "▲" : "▼"} {Math.abs(diff)}</span>}
        </T>
      </div>
      <HeroChart s={s} x={24} y={heroY + 20} w={508} h={446 - heroY - 20} locked={locked} />
      {(s.betsIn?.of ?? 0) > 0 && (
        <div className="hk-abs hk-bets" style={{ left: 24, top: 456 }}>
          {Array.from({ length: Math.min(14, s.betsIn!.of) }, (_, i) => <i key={i} className={i < s.betsIn!.n ? "on" : ""} />)}
          <span className="hk-body" style={{ color: s.betsIn!.n >= s.betsIn!.of ? P.yes : P.muted }}>{s.betsIn!.n} of {s.betsIn!.of} in</span>
        </div>
      )}

      <div className="hk-abs hk-card hk-fade" style={{ left: 544, top: 70, width: 248, height: 382, borderRadius: 18, ...d(160) }} />
      <div className="hk-abs hk-fade" style={{ left: 0, top: 0, ...d(160) }}>
        <div className="hk-abs hk-cd" style={{ left: 560, top: 84, width: 216 }} role="timer" aria-label={locked ? "Trading closed" : manual ? "Open until the host locks" : `${secs} seconds to lock`}>
          {locked ? (
            <span className="hk-body" style={{ color: P.ink }}>Trading closed</span>
          ) : manual ? (
            <span className="hk-body hk-ink2">Open until the host locks</span>
          ) : (
            <>
              <span className="hk-body hk-ink2">Closes in</span>
              <b className="hk-num" style={{ color: urgent ? P.hot : P.ink }}>{secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : `${secs}s`}</b>
            </>
          )}
          <i className="hk-cd-bar"><i style={{ width: `${locked || manual ? 0 : frac * 100}%`, background: urgent ? P.hot : P.ink }} /></i>
        </div>
        <PriceTile s={s} yes x={556} y={132} w={224} h={58} locked={locked} />
        <PriceTile s={s} yes={false} x={556} y={200} w={224} h={58} locked={locked} />
        {locked ? (
          <>
            {(yesB || noB) && <T f="B3" x={560} y={292} color={P.muted}>Settle it</T>}
            {yesB && <Button b={yesB} f="B2" x={556} y={304} w={224} h={48} r={24} onTouch={onTouch} pending={pending === yesB.id} />}
            {noB && <Button b={noB} f="B2" x={556} y={362} w={224} h={48} r={24} onTouch={onTouch} pending={pending === noB.id} />}
            {!yesB && !noB && <T f="B3" x={560} y={300} color={P.ink2}>Watch the play.</T>}
          </>
        ) : (
          <>
            <T f="B3" x={560} y={290} color={P.muted}>Recent trades</T>
            {(s.trades ?? []).length === 0 && <T f="B3" x={560} y={322} color={P.muted}>No trades yet</T>}
            {(s.trades ?? []).slice(0, 3).map((t, i) => (
              <div key={`${t.name}${t.cents}${t.side}${hist.length - i}`} className={`hk-abs hk-trade hk-trow ${i === 0 ? "hk-slide-r" : ""}`} style={{ left: 556, top: 300 + i * 32, width: 224, height: 30 }}>
                <span className="hk-avatar hk-body hk-w600" style={{ width: 20, height: 20, fontSize: 12, background: AVATAR[hash(t.name) % 8] }} aria-hidden="true">{(t.name.trim()[0] ?? "?").toUpperCase()}</span>
                <span className="hk-body hk-name">{t.name}</span>
                <span className="hk-body" style={{ color: t.side === "yes" ? P.yes : P.no }}>{t.side === "yes" ? "Yes" : "No"}</span>
                <b className="hk-body hk-ink2">{money(t.cents)}</b>
              </div>
            ))}
          </>
        )}
        {s.tip && (
          <div className="hk-abs hk-tipchip" style={{ left: 556, top: 414, width: 224, height: 30 }}>
            <i /><b>{s.tip.label || "Inside info"}</b><span>{s.tip.text}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function People({ x, y, w, h, title, win, rows, empty, delay }: {
  x: number; y: number; w: number; h: number; title: string; win: boolean; rows: { name: string; label: string }[]; empty: string; delay: number;
}) {
  return (
    <div className="hk-abs hk-rise" style={{ left: x, top: y, width: w, height: h, ...d(delay) }}>
      <T f="B3" x={4} y={16} color={P.muted}>{title}</T>
      {rows.length > 0 && <T f="B3" x={w - 4} y={16} w={60} align="right" color={P.muted}>{String(rows.length)}</T>}
      <div className="hk-scroll" style={{ left: 0, top: 26, width: w, height: h - 26 }}>
        {rows.length === 0 && <T f="B2" x={4} y={26} color={P.ink2}>{empty}</T>}
        <div style={{ position: "relative", height: rows.length * 36 }}>
          {rows.map((r, i) => (
            <div key={i} className="hk-abs hk-prow" style={{ left: 0, top: i * 36, width: w, height: 36 }}>
              <Avatar name={r.name} cx={16} cy={18} r={12} dim={!win} />
              <T f="B2" x={36} y={24} w={w - 120} color={win ? P.ink : P.ink2}>{r.name}</T>
              <T f="N4" x={w - 4} y={25} w={110} align="right" color={win ? P.yes : P.muted}>{r.label}</T>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Result({ s, onTouch, pending, fresh }: Ctx) {
  const yes = s.result === "YES";
  const voided = !s.result;
  const oc = voided ? P.ink : yes ? P.yes : P.no;
  const fin = Math.round(clampPct(s.lockYes ?? s.yes));
  const next = s.buttons.find((b) => b.id === "next");
  const end = s.buttons.find((b) => b.id === "end");
  const allCalls: (KioskButton & { enabled?: boolean })[] = s.calls ?? s.buttons.filter((b) => b.id.startsWith("moment:"));
  const winners = s.winners ?? (s.lines ?? []).map((l) => ({ name: l, cents: 0, profit: 0 }));
  const losers = s.losers ?? [];
  const summary = s.volume !== undefined ? `${money(s.volume)} traded  ·  ${winners.length} ${winners.length === 1 ? "winner" : "winners"}` : s.traded ?? "";
  let x = 24;
  let x1 = 776;
  const has = allCalls.length > 0;
  const nextW = next ? (has ? Math.min(230, labelW(next.label, 20) + 62) : 230) : 0;
  const endW = end ? (has ? Math.min(120, labelW(end.label, 20) + 44) : next ? 120 : 230) : 0;
  if (next) x += nextW + 10;
  if (end) x1 -= endW + 10;
  const { shown: calls, bw, small, noIcon } = callRow(allCalls, x1 - x);
  const wordW = voided ? 0 : yes ? 166 : 128;
  const wh = losers.length ? 168 : 290;
  return (
    <div key={s.question} className="hk-fill">
      <div className="hk-abs hk-topline" style={{ left: 20, top: 16 }}>
        <MiniBrand />
        <span style={{ color: oc }}>✓</span><span className="hk-body hk-ink2">{voided ? "Voided" : "Resolved"}</span>
      </div>
      <LiveDot cx={776} cy={30} fresh={fresh} />
      {s.score ? <Scorebug s={s} rx={758} y={10} h={40} /> : s.code ? <CodeChip code={s.code} rx={758} /> : null}
      <i className="hk-abs hk-hr" style={{ left: 16, top: 58, width: 768 }} />
      <div className="hk-fade" style={d(80)}>
        <div className="hk-t hk-head hk-w700 hk-clamp2" style={{ left: 24, top: 96 - 23, width: 500, fontSize: 24, lineHeight: "29px", color: P.ink, whiteSpace: "normal" }}>{s.question}</div>
      </div>
      <div className="hk-rise" style={d(300)}>
        <T f={voided ? "H1" : "HERO"} x={20} y={voided ? 236 : 252} color={oc}>{voided ? "Refunded" : yes ? "YES" : "NO"}</T>
        {!voided && (
          <>
            <T f="N3" x={38 + wordW} y={212} color={P.ink}>{`${yes ? fin : 100 - fin}%`}</T>
            <T f="B3" x={38 + wordW} y={236} color={P.muted}>final chance</T>
          </>
        )}
      </div>
      <div className="hk-fade" style={d(560)}>
        <T f="B2" x={24} y={292} color={P.ink2}>{summary}</T>
        <div className="hk-abs hk-endbar" style={{ left: 24, top: 316, width: 500, background: voided ? P.rule : undefined }}>
          <i style={{ width: `${fin}%`, opacity: yes || voided ? 1 : 0.45, background: voided ? P.muted : P.yes }} />
        </div>
        <T f="B3" x={24} y={346} color={P.muted}>Yes at lock</T>
        <T f="B3" x={524} y={346} w={100} align="right" color={P.muted}>{`${fin}%`}</T>
      </div>
      {!voided && winners.length > 0 && <Burst count={Math.min(24, 10 + winners.length * 3)} x={160} y={200} delay={520} colors={[P.gold, P.yes, P.ink]} />}
      <div className="hk-abs hk-card" style={{ left: 544, top: 70, width: 248, height: 314, borderRadius: 18 }} />
      {s.winners !== undefined || !(s.lines ?? []).length ? (
        <>
          <People x={556} y={80} w={224} h={wh} title="Called it" win rows={winners.map((w) => ({ name: w.name, label: money(Math.max(0, w.profit), true) }))} empty="Nobody. Brutal." delay={600} />
          {(losers.length > 0 || winners.length > 0) && <People x={556} y={80 + wh + 8} w={224} h={290 - wh - 2} title="Cooked" win={false} rows={losers.map((l) => ({ name: l.name, label: `-${money(l.cents)}` }))} empty="Clean sweep." delay={680} />}
        </>
      ) : (
        <People x={556} y={80} w={224} h={290} title="Called it" win rows={(s.lines ?? []).map((l) => ({ name: l, label: "" }))} empty="" delay={600} />
      )}
      <div className="hk-fade" style={d(760)}>
        {next && <Button b={next} style={voided ? "brand" : "ink"} x={24} y={400} w={nextW} h={56} r={28} onTouch={onTouch} pending={pending === next.id} />}
        {calls.map((c, i) => (
          <Button key={c.id} b={{ ...c, style: "primary" }} style="call" small={small} noIcon={noIcon} x={x + i * (bw + 8)} y={400} w={bw} h={56} r={28} onTouch={onTouch} pending={pending === c.id} />
        ))}
        {end && <Button b={end} style={next ? "white" : "ink"} x={776 - endW} y={400} w={endW} h={56} r={28} onTouch={onTouch} pending={pending === end.id} />}
      </div>
    </div>
  );
}

function Ended({ s, onTouch, pending, fresh }: Ctx) {
  const board =
    s.leaderboard ??
    (s.lines ?? []).map((l) => {
      const m = /^\d+\.\s+(.*?)\s+\$([\d.]+)$/.exec(l);
      return { name: m ? m[1] : l, cents: m ? Math.round(Number(m[2]) * 100) : 0, pnl: 0 };
    });
  // rank and lead come from the server (lib/standings.ts: shared rank on a tie, no leader on a tie at the top).
  // Older servers send neither: fall back to the position, a tie on worth meaning no leader.
  const rankAt = (i: number): number => {
    const r = (board[i] as { rank?: number }).rank;
    if (typeof r === "number") return r;
    let k = i;
    while (k > 0 && board[k - 1].cents === board[i].cents) k--;
    return k + 1;
  };
  const leadAt = (i: number): boolean => {
    const l = (board[i] as { lead?: boolean }).lead;
    if (typeof l === "boolean") return l;
    return i === 0 && board[0].cents > 0 && !(board[1] && board[1].cents === board[0].cents);
  };
  const nw = s.buttons.find((b) => b.id === "new");
  const slots = [
    { rank: 2, x: 24, h: 104, delay: 300 },
    { rank: 1, x: 150, h: 156, delay: 520 },
    { rank: 3, x: 276, h: 72, delay: 120 },
  ];
  const base = 452;
  return (
    <>
      <Wordmark x={20} y={40} />
      <TitleRow title={s.title || "Session over"} subtitle={s.subtitle} />
      <LiveDot cx={776} cy={30} fresh={fresh} />
      {slots.map(({ rank, x, h, delay }) => {
        const p = board[rank - 1];
        if (!p) return null;
        return (
          <div key={rank}>
            <div className="hk-abs hk-podium" style={{ left: x, top: base - h, width: 112, height: h, background: rank === 1 ? GRAD : rank === 2 ? P.ink : P.card, boxShadow: rank === 3 ? `inset 0 0 0 1px ${P.rule}` : undefined, ...d(delay) }}>
              {h > 50 && <T f="N2" x={56} y={58} w={112} align="center" color={rank === 3 ? P.ink : P.white}>{String(rankAt(rank - 1))}</T>}
            </div>
            <div className="hk-rise" style={d(delay + 260)}>
              {rank === 1 && leadAt(0) && (
                <svg className="hk-abs" style={{ left: x + 56 - 14, top: base - h - 92 - 26 }} width="28" height="22" viewBox="-12 -11 24 20" aria-hidden="true">
                  <path d="M-11 3 L-11 -8 L-3 3 Z M-6 3 L0 -10 L6 3 Z M11 3 L11 -8 L3 3 Z" fill={P.gold} /><rect x="-11" y="2" width="22" height="6" rx="2" fill={P.gold} />
                </svg>
              )}
              <Avatar name={p.name} cx={x + 56} cy={base - h - 92 + 22} r={22} />
              <T f="B1" x={x + 56} y={base - h - 92 + 66} w={124} align="center">{p.name}</T>
              <T f="N4" x={x + 56} y={base - h - 92 + 88} w={124} align="center" color={rank === 1 ? P.deep : P.ink2}>{money(p.cents)}</T>
            </div>
          </div>
        );
      })}
      <i className="hk-abs" style={{ left: 16, top: base, width: 380, height: 2, background: P.ruleStrong }} />
      {s.scorecard?.verdict && <T f="B3" x={16} y={472} w={380} color={P.ink2}>{s.scorecard.verdict}</T>}
      <T f="H3" x={412} y={92}>Final standings</T>
      <div className="hk-scroll" style={{ left: 408, top: 104, width: 384, height: 286 }} aria-label="Final standings">
        <div style={{ position: "relative", height: board.length * 62 }}>
          {board.map((p, i) => {
            const lead = leadAt(i);
            return (
              <div key={p.name + i} className={`hk-abs hk-row hk-slide-r ${lead ? "hk-lead" : "hk-lift"}`} style={{ left: 4, top: i * 62, width: 372, height: 56, ...d(300 + i * 70) }}>
                <T f="N4" x={20} y={35} w={30} align="center" color={lead ? P.gold : P.muted}>{String(rankAt(i))}</T>
                <Avatar name={p.name} cx={54} cy={28} r={17} />
                <T f="B1" x={80} y={35} w={180} color={lead ? P.white : P.ink}>{p.name}</T>
                {p.pnl ? (
                  <>
                    <T f="N4" x={358} y={27} w={100} align="right" color={lead ? P.white : P.ink}>{money(p.cents)}</T>
                    <T f="B3" x={358} y={47} w={100} align="right" color={lead ? P.lime : p.pnl > 0 ? P.yes600 : P.no600}>{p.pnl > 0 ? "▲ " : "▼ "}{money(p.pnl, true)}</T>
                  </>
                ) : (
                  <T f="N4" x={358} y={36} w={100} align="right" color={lead ? P.white : P.ink}>{money(p.cents)}</T>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {nw && (
        <div className="hk-rise" style={d(700)}>
          <Button b={nw} style="brand" f="H3" x={412} y={400} w={372} h={66} r={22} onTouch={onTouch} pending={pending === nw.id} />
        </div>
      )}
      {board.length > 0 && <Burst count={40} x={206} y={230} delay={900} colors={[P.gold, P.lime, P.accent, P.yes, P.no]} />}
    </>
  );
}

function Message({ s, onTouch, pending, fresh }: Ctx) {
  const n = s.buttons.length;
  const w = n ? (800 - 32 - (n - 1) * 12) / n : 0;
  return (
    <>
      <Wordmark x={20} y={40} />
      <LiveDot cx={776} cy={30} fresh={fresh} />
      <Kinetic f="H1" x={40} y={190} w={720} lines={2} lh={48} text={s.title} delay={80} />
      <div className="hk-t hk-body hk-w700" style={{ left: 40, top: 250, width: 720, fontSize: 20, lineHeight: "28px", whiteSpace: "normal", color: P.ink2 }}>{s.subtitle}</div>
      {s.buttons.map((b, i) => (
        <Button key={b.id} b={b} style={i === 0 && (b.style ?? "plain") === "plain" ? "brand" : undefined} x={16 + i * (w + 12)} y={396} w={w} h={66} r={20} onTouch={onTouch} pending={pending === b.id} />
      ))}
    </>
  );
}

// ---------------------------------------------------------------- pages (market / locked / result scroll down)
//
// Same layout as ui.cpp drawPage: the first 480 px are the screen as it always was; under it the odds graph,
// "Odds right now", recent trades + standings and Back to top. Snap points, the slim header that slides in once
// the view is scrolled away (tap = top), the "more below" tab and the scrollbar match the firmware.

type Chart = NonNullable<KioskScreen["chart"]>;
type Odds = NonNullable<KioskScreen["odds"]>[number];

const hasPage = (s: KioskScreen) =>
  (s.screen === "market" || s.screen === "locked" || s.screen === "result") && ((s.chart?.room.length ?? 0) > 0 || (s.odds?.length ?? 0) > 0 || (s.standings?.length ?? 0) > 0);

function pageLayout(s: KioskScreen) {
  const chartY = 480 + 8;
  const chartH = (s.chart?.room.length ?? 0) > 0 ? 348 : 0;
  const oddsY = chartY + (chartH ? chartH + 20 : 0);
  const nOdds = Math.min(10, s.odds?.length ?? 0);
  const oddsH = 64 + Math.max(1, nOdds) * 66;
  const listY = oddsY + oddsH + 12;
  const rows = Math.min(8, Math.max(1, Math.min(8, s.trades?.length ?? 0), s.standings?.length ?? 0));
  const listH = 58 + rows * 38 + 10;
  const endY = listY + listH + 20;
  return { chartY, chartH, oddsY, oddsH, listY, listH, endY, contentH: endY + 62 + 18 };
}

/** True once a good part of the element has been on screen inside the page (the firmware's seen()). */
function useSeen(root: RefObject<HTMLDivElement | null>, h: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const need = Math.min(h / 3, 150) / h;
    const io = new IntersectionObserver((es) => es.some((e) => e.intersectionRatio >= need - 0.01) && setSeen(true), { root: root.current, threshold: [need] });
    io.observe(el);
    return () => io.disconnect();
  }, [root, h, seen]);
  return { ref, seen };
}

function ChartSection({ c, question, market, y, h, root }: { c: Chart; question: string; market: boolean; y: number; h: number; root: RefObject<HTMLDivElement | null> }) {
  const { ref, seen } = useSeen(root, h);
  const room = c.room.length === 1 ? [c.room[0], c.room[0]] : c.room;
  const n = room.length;
  const gem = c.gemini && c.gemini.some((g) => g !== null) ? c.gemini : null;
  const span = Math.max(1, c.span);
  const px0 = 72, px1 = 668, py0 = 96, py1 = 300;
  const PY = (v: number) => py1 - Math.trunc((v * (py1 - py0)) / 100);
  const PX = (i: number) => px0 + Math.trunc(((px1 - px0) * span * i) / (100 * (n - 1)));
  const spanX = px0 + Math.trunc(((px1 - px0) * span) / 100);
  const future = market && spanX < px1 - 2;
  let path = "";
  for (let i = 0; i < n; i++) path += i === 0 ? `M${PX(0)},${PY(room[0])}` : `H${PX(i)}V${PY(room[i])}`;
  const ex = PX(n - 1), ey = PY(room[n - 1]);
  const gemPath = gem
    ? gem.map((g, i) => (g === null ? "" : `${i > 0 && gem[i - 1] !== null ? "L" : "M"}${PX(i)},${PY(g)}`)).join("")
    : "";
  const lockX = c.lock !== null && !(c.outcome && c.lock >= 96) ? px0 + Math.trunc(((px1 - px0) * c.lock) / 100) : null;
  // value tags at the right, kept 30 px apart (firmware: same rule)
  const lastGem = gem ? [...gem].reverse().find((g) => g !== null) ?? null : null;
  const tags = [
    { y: PY(room[n - 1]), v: room[n - 1], kind: 0 },
    ...(lastGem !== null ? [{ y: PY(lastGem), v: lastGem, kind: 1 }] : []),
    ...(c.model !== null ? [{ y: PY(c.model), v: c.model, kind: 2 }] : []),
  ].sort((a, b) => a.y - b.y);
  const ty: number[] = [];
  tags.forEach((t, i) => ty.push(i ? Math.max(t.y, ty[i - 1] + 30) : Math.max(t.y, py0 - 8)));
  const over = ty[ty.length - 1] - (py1 + 8);
  if (over > 0) for (let i = 0; i < ty.length; i++) ty[i] -= over;
  const yes = c.outcome === "YES";
  const oy = PY(yes ? 100 : 0);
  return (
    <div ref={ref} className={`hk-abs hk-card hk-lift hk-chart ${seen ? "hk-in" : ""}`} style={{ left: 12, top: y, width: 776, height: h, borderRadius: 26, cursor: "default" }} role="img" aria-label={`Odds graph: room ${room[n - 1]}%${lastGem !== null ? `, Gemini ${lastGem}%` : ""}${c.model !== null ? `, model ${c.model}%` : ""}${c.outcome ? `, it was ${c.outcome}` : ""}`}>
      <T f="H3" x={20} y={40}>Odds graph</T>
      <T f="B2" x={20} y={66} w={736} color={P.ink2}>{question}</T>
      <div className="hk-abs hk-legend hk-body hk-w600" style={{ right: 20, top: 24 }}>
        <span><i style={{ background: P.yes, height: 3.4 }} />Room</span>
        {c.model !== null && <span><i className="hk-dash" />Model</span>}
        {gem && <span><i style={{ background: P.ink, height: 2.4 }} /><b className="hk-tri hk-hollow" />Gemini</span>}
      </div>
      <svg className="hk-abs" style={{ left: -12, top: 0 }} width={800} height={h} viewBox={`0 0 800 ${h}`} aria-hidden="true">
        <defs>
          <clipPath id="hk-reveal">
            <rect className="hk-reveal" x={px0 - 8} y={py0 - 24} width={spanX - px0 + 52} height={py1 - py0 + 48} />
          </clipPath>
        </defs>
        {future && <rect x={spanX} y={py0} width={px1 - spanX} height={py1 - py0} fill={P.well} opacity={0.67} />}
        {[0, 25, 50, 75, 100].map((v) => (
          <rect key={v} x={px0} y={PY(v)} width={px1 - px0} height={1} fill={v === 50 ? P.ruleStrong : P.rule} />
        ))}
        {lockX !== null && <line x1={lockX} y1={py0 + 4} x2={lockX} y2={py1} stroke={P.ink} strokeOpacity={0.55} strokeWidth={2} strokeDasharray="5 5" />}
        {c.model !== null && <line className="hk-fadein" x1={px0} y1={PY(c.model)} x2={px1} y2={PY(c.model)} stroke={P.ink} strokeOpacity={0.67} strokeWidth={2.2} strokeDasharray="8 6" />}
        <g clipPath="url(#hk-reveal)">
          <path d={`${path}V${py1}H${PX(0)}Z`} fill={P.yes} fillOpacity={0.12} />
          {gem && <path d={gemPath} fill="none" stroke={P.ink} strokeWidth={2.4} strokeLinejoin="round" />}
          <path d={path} fill="none" stroke={P.yes} strokeWidth={3.2} strokeLinejoin="round" />
        </g>
        <g className="hk-late">
          {market && <circle cx={ex} cy={ey} r={5.5} fill={P.yes} className="hk-ping" />}
          <circle cx={ex} cy={ey} r={5.5} fill={P.yes} />
          <circle cx={ex} cy={ey} r={2.4} fill={P.card} />
          {c.outcome && (
            <>
              <line x1={ex} y1={Math.min(ey, oy) + 6} x2={ex} y2={Math.max(ey, oy) - 6} stroke={yes ? P.yes : P.no600} strokeWidth={2} strokeDasharray="4 5" />
              <circle cx={ex} cy={oy} r={12} fill="none" stroke={yes ? P.yes : P.no} strokeWidth={2.5} strokeOpacity={0.5} />
              <circle cx={ex} cy={oy} r={8} fill={yes ? P.yes : P.no} />
            </>
          )}
          {tags.map((t, i) => {
            // Flat from the line, bending only next to the tag (same as the firmware), so it never reads as a price move.
            const fx = t.kind === 0 ? ex + 8 : (t.kind === 2 ? px1 : spanX) + 4;
            const bx = Math.max(fx, 666);
            return (
              <polyline key={`l${i}`} points={`${fx},${t.y} ${bx},${t.y} 682,${ty[i]}`} fill="none" stroke={t.kind === 0 ? P.yes : P.ink} strokeOpacity={0.33} strokeWidth={1.2} />
            );
          })}
        </g>
      </svg>
      {lockX !== null && <Lock cx={lockX - 12} cy={py0 - 6} s={0.6} color={P.ink} />}
      {[0, 25, 50, 75, 100].map((v) => (
        <T key={v} f="B3" x={px0 - 10 - 12} y={PY(v) + 5} w={60} align="right" color={P.muted}>{`${v}%`}</T>
      ))}
      <T f="B3" x={px0 - 12} y={py1 + 26} color={P.muted}>{c.x0 || "Open"}</T>
      <T f="B3" x={px1 - 12} y={py1 + 26} w={120} align="right" color={P.muted}>{c.x1 || "Now"}</T>
      {lockX !== null && lockX - px0 > 70 && px1 - lockX > 70 && <T f="B3" x={lockX - 12} y={py1 + 26} w={80} align="center" color={P.ink2}>Locked</T>}
      {future && px1 - spanX > 150 && <T f="B3" x={(spanX + px1) / 2 - 12} y={py1 - 14} w={220} align="center" color={P.muted}>Trading until the lock</T>}
      <div className="hk-late">
        {c.outcome && (
          <T f="B1" x={(lockX !== null && lockX < ex - 18 && ex - 18 - lockX < 150 ? lockX - 10 : ex - 18) - 12} y={oy + (yes ? 24 : -10)} w={200} align="right" color={yes ? P.yes600 : P.no600}>
            {yes ? "It was YES" : "It was NO"}
          </T>
        )}
        {tags.map((t, i) => (
          <span key={i} className="hk-abs hk-tag hk-num hk-w700 hk-c90" style={{ left: 684 - 12, top: ty[i] - 13, background: t.kind === 0 ? P.yes : t.kind === 1 ? P.ink : P.card, color: t.kind === 2 ? P.ink : P.white, boxShadow: t.kind === 2 ? `inset 0 0 0 2px ${P.ink}` : undefined }}>
            {t.v}%
          </span>
        ))}
      </div>
    </div>
  );
}

function MiniLine({ v, x, y, w, h, color, stepped }: { v: number[]; x: number; y: number; w: number; h: number; color: string; stepped: boolean }) {
  const n = v.length;
  if (n < 2) return null;
  let lo = Math.min(...v), hi = Math.max(...v);
  const mid = Math.trunc((lo + hi) / 2), sp = Math.max(20, hi - lo + 6);
  lo = Math.min(Math.max(0, mid - Math.trunc(sp / 2)), Math.max(0, 100 - sp));
  hi = lo + sp;
  const py = (val: number) => h - 2 - Math.trunc(((val - lo) * (h - 4)) / Math.max(1, hi - lo));
  const px = (i: number) => Math.trunc((i * (w - 6)) / (n - 1));
  let d = `M${px(0)},${py(v[0])}`;
  for (let i = 1; i < n; i++) d += stepped ? `H${px(i)}V${py(v[i])}` : `L${px(i)},${py(v[i])}`;
  return (
    <svg className="hk-abs" style={{ left: x, top: y }} width={w} height={h} overflow="visible" aria-hidden="true">
      <path d={d} fill="none" stroke={color} strokeWidth={2.2} strokeLinejoin="round" />
      <circle cx={px(n - 1)} cy={py(v[n - 1])} r={3.6} fill={color} />
    </svg>
  );
}

function OddsSection({ odds, note, y, h, root }: { odds: Odds[]; note: string; y: number; h: number; root: RefObject<HTMLDivElement | null> }) {
  const { ref, seen } = useSeen(root, h);
  return (
    <div ref={ref} className="hk-abs" style={{ left: 0, top: y, width: 800, height: h }}>
      <T f="H3" x={24} y={30}>Odds right now</T>
      {note && <T f="B3" x={24} y={52} w={752} color={P.muted}>{note}</T>}
      {odds.length === 0 && (
        <div className="hk-abs hk-row hk-lift" style={{ left: 16, top: 64, width: 768, height: 58, borderRadius: 18 }}>
          <T f="B2" x={18} y={36} color={P.ink2}>No odds to show yet.</T>
        </div>
      )}
      {odds.slice(0, 10).map((o, i) => {
        const room = o.source === "room";
        const spark = (o.hist?.length ?? 0) >= 2;
        // chip widths as drawn (firmware: label + 24, Gemini + its mark 36); the browser's pill runs a few px wider
        const chipW = room ? 62 : 94;
        const valL = 768 - 16 - 86;
        const sparkX = valL - 164;
        return (
          <div key={`${o.label}${i}`} className={`hk-abs hk-row hk-lift ${seen ? "hk-slide-r" : ""}`} style={{ left: 16, top: 64 + i * 66, width: 768, height: 58, borderRadius: 18, boxShadow: room ? `inset 0 0 0 2px rgba(18,161,80,.47)` : undefined, ...d(60 + i * 70) }}>
            {room ? (
              <span className="hk-pill hk-body hk-w600" style={{ left: 14, top: 16, background: P.accentTint, color: P.deep }}>Room</span>
            ) : (
              <span className="hk-pill hk-body hk-w600" style={{ left: 14, top: 16, background: P.ink, color: P.white }}>
                <svg width="13" height="12" viewBox="0 0 12 11" aria-hidden="true"><path d="M0 0 H12 L6 11 Z M3 1.5 L6 6.5 L9 1.5 Z" fill="#fff" fillRule="evenodd" /></svg> Gemini
              </span>
            )}
            <T f="B1" x={14 + chipW + 12} y={36} w={(spark ? sparkX - 18 : valL - 10) - (14 + chipW + 12)}>{o.label}</T>
            {spark && <MiniLine v={o.hist!} x={sparkX} y={12} w={150} h={34} color={room ? P.yes : P.ink2} stepped={room} />}
            <T f="N3" x={768 - 16} y={41} w={100} align="right" color={room ? P.yes600 : P.ink}>{`${o.p}%`}</T>
          </div>
        );
      })}
    </div>
  );
}

function ListsSection({ s, y, h, root }: { s: KioskScreen; y: number; h: number; root: RefObject<HTMLDivElement | null> }) {
  const { ref, seen } = useSeen(root, h);
  const trades = (s.trades ?? []).slice(0, 8);
  const board = (s.standings ?? []).slice(0, 8);
  const tie = board.length > 0 && !board[0].lead;
  return (
    <div ref={ref} className="hk-abs" style={{ left: 0, top: y, width: 800, height: h }}>
      {[0, 1].map((side) => (
        <div key={side} className={`hk-abs hk-card hk-lift ${seen ? "hk-rise" : ""}`} style={{ left: side ? 406 : 16, top: 0, width: 378, height: h, borderRadius: 22, cursor: "default", ...d(side * 90) }}>
          <T f="H3" x={18} y={36}>{side ? "Standings" : "Recent trades"}</T>
          {side === 0 && trades.length === 0 && <T f="B2" x={18} y={80} color={P.ink2}>No trades yet. Phones buy YES or NO.</T>}
          {side === 1 && board.length === 0 && <T f="B2" x={18} y={80} color={P.ink2}>No players yet.</T>}
          {side === 0 &&
            trades.map((t, i) => {
              const ry = 54 + i * 38;
              const col = t.side === "yes" ? P.yes600 : P.no600;
              return (
                <div key={i}>
                  <Avatar name={t.name} cx={30} cy={ry + 15} r={13} />
                  <T f="B1" x={52} y={ry + 22} w={126}>{t.name}</T>
                  <Arrow cx={192} cy={ry + 14} s={0.6} up={t.side === "yes"} color={col} />
                  <T f="B3" x={202} y={ry + 20} color={col}>{t.side === "yes" ? "Yes" : "No"}</T>
                  {t.price >= 0 && <T f="B3" x={240} y={ry + 20} color={P.muted}>{`@${t.price}%`}</T>}
                  <T f="N4" x={378 - 16} y={ry + 22} w={100} align="right">{money(t.cents)}</T>
                </div>
              );
            })}
          {side === 1 &&
            board.map((p, i) => {
              const ry = 54 + i * 38;
              const lead = i === 0 && !tie;
              return (
                <div key={i}>
                  {lead && <i className="hk-abs" style={{ left: 8, top: ry - 4, width: 362, height: 36, borderRadius: 12, background: P.ink }} />}
                  <T f="N4" x={28} y={ry + 22} w={30} align="center" color={lead ? P.gold : P.muted}>{String(p.rank || i + 1)}</T>
                  <Avatar name={p.name} cx={60} cy={ry + 14} r={13} />
                  <T f="B1" x={82} y={ry + 22} w={150} color={lead ? P.white : P.ink}>{p.name}</T>
                  {p.pnl !== 0 && <T f="B3" x={378 - 16 - 78} y={ry + 21} w={100} align="right" color={lead ? P.lime : p.pnl > 0 ? P.yes600 : P.no600}>{money(p.pnl, true)}</T>}
                  <T f="N4" x={378 - 16} y={ry + 22} w={100} align="right" color={lead ? P.white : P.ink}>{money(p.cents)}</T>
                </div>
              );
            })}
        </div>
      ))}
    </div>
  );
}

/** The slim header that slides in once the view is scrolled away (firmware pageChrome). Tap = back to the top. */
function PageHeader({ s, k, rem, onTop }: { s: KioskScreen; k: number; rem: number; onTop: () => void }) {
  const badge = /^Question \d+/.test(s.title) ? `Q${/^Question (\d+)/.exec(s.title)![1]}` : s.title || "Live";
  const secs = Math.ceil(rem / 1000);
  const clock = secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : `${secs}s`;
  const result = s.result === "YES" ? { t: "YES", bg: P.yes, fg: P.white } : s.result === "NO" ? { t: "NO", bg: P.no, fg: P.ink } : { t: "Void", bg: P.well, fg: P.ink };
  return (
    <button type="button" className="hk-pagehead" style={{ opacity: k, transform: `translateY(${(k - 1) * 24}px)`, pointerEvents: k > 0.5 ? "auto" : "none" }} onClick={onTop} aria-label="Back to the top">
      {s.screen === "market" ? (
        <span className="hk-badge hk-body hk-w700" style={{ background: GRAD, height: 34 }}>
          <svg width="12" height="18" viewBox="-7 -10 14 20" aria-hidden="true"><path d="M2 -9 L-6 1.5 L1 1.5 Z M-2 9 L6 -1.5 L-1 -1.5 Z" fill="#fff" /></svg>
          {badge}
        </span>
      ) : s.screen === "locked" ? (
        <span className="hk-badge hk-body hk-w700" style={{ background: P.ink, height: 34 }}>
          <svg width="16" height="18" viewBox="-10 -11 20 24" aria-hidden="true"><path d="M-5.5 -0.5 V-3 A5.5 5.5 0 0 1 5.5 -3 V-0.5" fill="none" stroke="#fff" strokeWidth="2.6" /><rect x="-9" y="-0.5" width="18" height="13" rx="3" fill="#fff" /></svg>
          Closed
        </span>
      ) : (
        <span className="hk-badge hk-body hk-w700" style={{ background: result.bg, color: result.fg, height: 34 }}>{result.t}</span>
      )}
      <span className="hk-body hk-w700 hk-q">{s.question}</span>
      {s.screen === "market" && s.lockIn !== undefined && (s.lockTotal ?? 0) > 0 && (
        <span className="hk-num hk-w700 hk-c90" style={{ fontSize: 21, color: secs <= 5 ? P.hot : P.ink, display: "inline-flex", alignItems: "center", gap: 8 }}>
          <svg width="12" height="14" viewBox="-10 -11 20 24" aria-hidden="true"><path d="M-5.5 -0.5 V-3 A5.5 5.5 0 0 1 5.5 -3 V-0.5" fill="none" stroke="currentColor" strokeWidth="2.6" /><rect x="-9" y="-0.5" width="18" height="13" rx="3" fill="currentColor" /></svg>
          {clock}
        </span>
      )}
      {s.screen !== "result" && <span className="hk-badge hk-body hk-w700" style={{ background: P.yes, height: 34 }}>Yes {s.yes}¢</span>}
      <span className="hk-body hk-w600" style={{ fontSize: 15, color: P.ink2 }}>▲ Top</span>
    </button>
  );
}

function Page({ s, children, onTouch, pending }: { s: KioskScreen; children: ReactNode; onTouch: (id: string) => void; pending?: string | null }) {
  const L = pageLayout(s);
  const root = useRef<HTMLDivElement>(null);
  const [y, setY] = useState(0);
  const [moving, setMoving] = useState(0);
  const rem = useRemaining(s);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      setY(el.scrollTop);
      setMoving(Date.now());
      clearTimeout(t);
      t = setTimeout(() => setMoving(0), 1200);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    // A page left scrolled down glides home after a minute without a touch (the box is shared), like the firmware.
    let idle: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => el.scrollTo({ top: 0, behavior: "smooth" }), 60_000);
    };
    arm();
    el.addEventListener("pointerdown", arm);
    el.addEventListener("scroll", arm, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("pointerdown", arm);
      el.removeEventListener("scroll", arm);
      clearTimeout(t);
      clearTimeout(idle);
    };
  }, []);
  const top = () => root.current?.scrollTo({ top: 0, behavior: "smooth" });
  const more = () => root.current?.scrollTo({ top: L.chartH ? L.chartY - 66 : L.oddsY - 66, behavior: "smooth" });
  const touch = (id: string) => (id === "ui:top" ? top() : onTouch(id));
  const maxOff = Math.max(1, L.contentH - 480);
  const barH = Math.max(36, (480 * 480) / L.contentH);
  const snaps = [0, ...(L.chartH ? [L.chartY - 66] : []), L.oddsY - 66, L.listY - 66];
  return (
    <div className="hk-fill">
      <div ref={root} className="hk-pagescroll" aria-label="Box screen, scrolls down to the odds graph">
        <div style={{ position: "relative", height: L.contentH }}>
          {snaps.map((v) => <i key={v} className="hk-snapat" style={{ top: v }} aria-hidden="true" />)}
          <div className="hk-abs" style={{ left: 0, top: 0, width: 800, height: 480 }}>{children}</div>
          {L.chartH > 0 && s.chart && <ChartSection c={s.chart} question={s.question ?? ""} market={s.screen === "market"} y={L.chartY} h={L.chartH} root={root} />}
          <OddsSection odds={s.odds ?? []} note={s.oddsNote ?? ""} y={L.oddsY} h={L.oddsH} root={root} />
          <ListsSection s={s} y={L.listY} h={L.listH} root={root} />
          <Button b={{ id: "ui:top", label: "Back to top", style: "plain" }} x={250} y={L.endY} w={300} h={62} r={22} onTouch={touch} pending={pending === "ui:top"} />
          <Arrow cx={290} cy={L.endY + 31} s={0.7} up color={P.ink2} />
        </div>
      </div>
      <i className="hk-pagebar" style={{ top: ((480 - barH) * Math.min(1, Math.max(0, y / maxOff))) + 3, height: barH - 6, opacity: moving ? 0.47 : 0.18 }} aria-hidden="true" />
      {y < 60 && (
        <button type="button" className="hk-moretab hk-body hk-w600" style={{ opacity: 1 - y / 60 }} onClick={more}>
          {L.chartH ? "Odds graph" : "More"}
          <svg width="10" height="9" viewBox="-7 -6 14 12" aria-hidden="true"><path d="M0 6 L-7 -5 L7 -5 Z" fill="currentColor" /></svg>
        </button>
      )}
      {y > 150 && <PageHeader s={s} k={Math.min(1, (y - 150) / 40)} rem={rem} onTop={top} />}
    </div>
  );
}

// ---------------------------------------------------------------- Solana Pay card (on top of any screen)

function PayCard({ pay, onTouch, pending }: { pay: NonNullable<KioskScreen["pay"]>; onTouch: (id: string) => void; pending?: string | null }) {
  const base = useRef({ left: pay.leftMs, at: Date.now() });
  const cur = base.current.left - (Date.now() - base.current.at);
  if (Math.abs(pay.leftMs - cur) > 1500) base.current = { left: pay.leftMs, at: Date.now() };
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, base.current.left - (Date.now() - base.current.at));
  const secs = Math.ceil(left / 1000);
  const expired = !pay.paid && left <= 0;
  const qr = pay.qr;
  const scale = qr ? Math.max(1, Math.floor((352 - 28) / qr.size)) : 1;
  return (
    <div className="hk-paywrap" role="dialog" aria-modal="true" aria-label={pay.paid ? "Payment received" : "Pay with Solana"}>
      <div className="hk-abs hk-card hk-lift hk-rise" style={{ left: 60, top: 40, width: 680, height: 400, borderRadius: 30, cursor: "default", ...d(60) }}>
        {!pay.paid ? (
          <div className="hk-abs" style={{ left: 24, top: 24, width: 352, height: 352, borderRadius: 22, background: P.ink, boxShadow: `inset 0 0 0 2px ${P.rule}`, display: "grid", placeItems: "center" }}>
            {qr ? (
              <svg width={scale * qr.size} height={scale * qr.size} viewBox={`0 0 ${qr.size} ${qr.size}`} shapeRendering="crispEdges" role="img" aria-label="Solana Pay QR code">
                {qr.rows.flatMap((row, r) => [...row].map((c, col) => (c === "1" ? <rect key={`${r}-${col}`} x={col} y={r} width="1" height="1" fill="#0A0A0A" /> : null)))}
              </svg>
            ) : (
              <div style={{ textAlign: "center" }}>
                <div className="hk-body hk-w700" style={{ fontSize: 20, color: P.ink2 }}>Pay from your phone</div>
                <div className="hk-body hk-w600" style={{ fontSize: 15, color: P.muted }}>This request does not fit a QR</div>
              </div>
            )}
            {expired && <div className="hk-abs hk-head hk-w800" style={{ inset: 0, borderRadius: 22, background: "rgba(255,255,255,.75)", display: "grid", placeItems: "center", fontSize: 31 }}>Expired</div>}
          </div>
        ) : (
          <div className="hk-abs hk-paid" style={{ left: 24, top: 24, width: 352, height: 352, borderRadius: 22, background: P.accentTint }}>
            <svg width="352" height="352" viewBox="-176 -176 352 352" aria-hidden="true">
              <circle className="hk-paid-ring" r="104" fill="none" stroke={P.accent} strokeWidth="5" />
              <circle className="hk-paid-dot" r="104" fill={P.accent} />
              <path className="hk-paid-check" d="M-56 0 L-17.5 42 L63 -49" fill="none" stroke="#fff" strokeWidth="14.3" strokeLinecap="round" strokeLinejoin="round" pathLength={1} />
            </svg>
          </div>
        )}
        <span className="hk-pill hk-body hk-w600" style={{ left: 400, top: 26, height: 28, background: P.ink, color: P.white }}>
          <i style={{ width: 18, height: 10, borderRadius: 3, background: "linear-gradient(90deg,#9945FF,#5A8CE6,#14F195)" }} /> Solana Pay
        </span>
        {!pay.paid ? (
          <>
            <div className="hk-t hk-head hk-w700" style={{ left: 400, top: 136 - 23 - 40, width: 256, fontSize: 24, lineHeight: "30px", whiteSpace: "normal" }}>Scan with any Solana wallet</div>
            <T f="B3" x={400} y={210 - 40} color={P.muted}>Paying in</T>
            <T f="B1" x={400} y={236 - 40} w={256}>{pay.name || "Player"}</T>
            <T f="N2" x={400} y={304 - 40}>{money(pay.cents)}</T>
            <i className="hk-abs" style={{ left: 401, top: 289, width: 10, height: 10, borderRadius: 9, background: expired ? P.hot : P.accent }} />
            <T f="B2" x={418} y={340 - 40} color={P.ink2}>{expired ? "This request expired" : `Expires in ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`}</T>
            <Button b={{ id: "pay:close", label: "Close", style: "plain" }} x={400} y={320} w={256} h={58} r={20} onTouch={onTouch} pending={pending === "pay:close"} />
          </>
        ) : (
          <div className="hk-fade" style={d(360)}>
            <T f="H1" x={400} y={160 - 40} color={P.deep}>Paid!</T>
            <T f="N2" x={400} y={236 - 40}>{money(pay.cents)}</T>
            <T f="B1" x={400} y={274 - 40} w={256} color={P.ink2}>{`added for ${pay.name || "the player"}`}</T>
            <T f="B3" x={400} y={302 - 40} color={P.muted}>It shows on their phone now.</T>
            <Button b={{ id: "pay:close", label: "Done" }} style="brand" x={400} y={320} w={256} h={58} r={20} onTouch={onTouch} pending={pending === "pay:close"} />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the view

export function KioskView({ s, pressed, error, stale, onTouch }: {
  s: KioskScreen;
  pressed?: string | null;
  error?: string | null;
  stale?: boolean;
  onTouch: (id: string) => void;
}) {
  const ctx: Ctx = { s, onTouch, pending: pressed, fresh: !stale };
  return (
    <div className="hk" role="application" aria-label="Huddle box screen preview">
      {/* Locking keeps the market mounted (the lock snaps in); every other screen change enters fresh. */}
      <div key={s.screen === "locked" ? "market" : s.screen} className="hk-fill">
        {s.screen === "select" && <Select {...ctx} />}
        {s.screen === "lobby" && <Lobby {...ctx} />}
        {hasPage(s) ? (
          // Market, locked and result scroll down to the odds graph (the page stays where it is when trading locks).
          <Page key={s.question} s={s} onTouch={onTouch} pending={pressed}>
            {s.screen === "result" ? <Result {...ctx} /> : <Market {...ctx} locked={s.screen === "locked"} />}
          </Page>
        ) : (
          <>
            {(s.screen === "market" || s.screen === "locked") && <Market {...ctx} locked={s.screen === "locked"} />}
            {s.screen === "result" && <Result {...ctx} />}
          </>
        )}
        {s.screen === "ended" && <Ended {...ctx} />}
        {!["select", "lobby", "market", "locked", "result", "ended"].includes(s.screen) && <Message {...ctx} />}
      </div>
      {s.pay && <PayCard key={s.pay.until} pay={s.pay} onTouch={onTouch} pending={pressed} />}
      {error && (
        <div className="hk-toast hk-body hk-w700" role="alert">
          <i>!</i>
          {error}
        </div>
      )}
      {stale && (
        <div className="hk-reconnect hk-body hk-w700" role="status">
          <Mark cx={24} cy={22} R={9} spin />
          Reconnecting to the site...
        </div>
      )}
    </div>
  );
}

/** Shown before the first screen arrives (the firmware's connection page, short version). */
export function KioskConnecting() {
  return (
    <div className="hk" role="status" aria-label="Connecting">
      <T f="H1" x={32} y={140}>Getting ready</T>
      <T f="B1" x={32} y={224}>Reaching the site...</T>
      <T f="B3" x={32} y={354} color={P.muted}>A hosted site can take 30 s to wake up.</T>
      <Mark cx={612} cy={206} R={92} spin />
      <T f="H1" x={612} y={392} w={300} align="center">huddle</T>
    </div>
  );
}
