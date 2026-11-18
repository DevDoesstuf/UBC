"use client";
// The box screen in a browser, at exactly 800 x 480: the same layout, colours, fonts and motion as the ESP32
// renderer (firmware/kiosk_screen/ui.cpp). Coordinates below are the firmware's; text is placed by baseline
// like the firmware does (top = baseline - ascent of the firmware font). Motion is CSS: entrances are keyframes
// whose resting style is the final state, numbers roll, the lock ring drains from the clock. If the box and
// this page ever differ, the firmware is the reference.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import type { KioskButton, KioskCard, KioskScreen } from "@/lib/kiosk";
import { avatarHash } from "@/lib/boxText";

// ---------------------------------------------------------------- tokens + fonts (same as ui.cpp)

const P = {
  canvas: "#F6F3EA", card: "#FFFDF8", well: "#EEEAE0", rule: "#E2DDD0", ruleStrong: "#CFC8B8", ink: "#10261C",
  ink2: "#3E5247", muted: "#616D64", accent: "#12A150", deep: "#0B7A3E", lime: "#7CCB4E", yes: "#1468FF",
  yes600: "#0B57E6", no: "#FF6B00", no600: "#B84300", hot: "#E5484D", gold: "#E8A33D", white: "#FFFFFF",
  accentTint: "#E3F2E7",
};
const GRAD = `linear-gradient(90deg, ${P.deep}, ${P.accent} 50%, ${P.lime})`;

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

const LIT = ["#0B7A3E", "#0E8743", "#109448", "#12A150", "#2BAA4F", "#43B24F", "#5BBB4E", "#7CCB4E", "#9BCF45", "#BFC93F", "#D9B43C", "#E8A33D"];
/** The Huddle mark: the box's LED ring from above. */
function Mark({ cx, cy, R, lit = 1, spin = false }: { cx: number; cy: number; R: number; lit?: number; spin?: boolean }) {
  return (
    <svg className={`hk-abs ${spin ? "hk-spin" : ""}`} style={{ left: r2(cx - R * 1.3), top: r2(cy - R * 1.3) }} width={r2(R * 2.6)} height={r2(R * 2.6)} viewBox={`${r2(-R * 1.3)} ${r2(-R * 1.3)} ${r2(R * 2.6)} ${r2(R * 2.6)}`} aria-hidden="true">
      {Array.from({ length: 12 }, (_, i) => {
        const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
        const on = spin ? i < 3 : i < lit;
        return <circle key={i} cx={r2(R * Math.cos(a))} cy={r2(R * Math.sin(a))} r={r2(on ? R * 0.25 : R * 0.17)} fill={on ? LIT[spin ? 3 + i * 2 : lit === 1 ? 3 : i] : P.ruleStrong} />;
      })}
    </svg>
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
        <div className="hk-abs" style={{ left: 40, top: 22, width: 212, height: 212, borderRadius: 18, background: P.white, display: "grid", placeItems: "center" }}>
          {qr && (
            <svg width={scale * qr.size} height={scale * qr.size} viewBox={`0 0 ${qr.size} ${qr.size}`} shapeRendering="crispEdges" role="img" aria-label="Join QR code">
              {qr.rows.flatMap((row, r) => [...row].map((c, col) => (c === "1" ? <rect key={`${r}-${col}`} x={col} y={r} width="1" height="1" fill={P.ink} /> : null)))}
            </svg>
          )}
        </div>
        <T f="H3" x={146} y={264} w={280} align="center" color={P.white}>Tap your phone here</T>
        <T f="B2" x={146} y={288} w={280} align="center" color="rgba(255,255,255,.9)">or scan the code to join</T>
        <T f="B3" x={146} y={316} w={280} align="center" color="rgba(255,255,255,.86)">Party code</T>
        <div className="hk-abs hk-code" style={{ left: 0, top: 326, width: 292 }} aria-label={`Party code ${s.code}`}>
          {(s.code ?? "").split("").map((ch, i) => (
            <span key={i} className="hk-pop hk-head hk-w800" style={d(320 + i * 90)}>{ch}</span>
          ))}
        </div>
        <T f="B3" x={146} y={420} w={270} align="center" color="rgba(255,255,255,.86)">{s.joinUrl}</T>
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
        {start && <Button b={start} style="brand" f="H3" x={x0 + (cancel ? 136 : 0)} y={400} w={800 - 14 - x0 - (cancel ? 136 : 0)} h={66} r={22} onTouch={onTouch} pending={pending === start.id} />}
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

function OutcomeTile({ s, yes, x, y, w, h, locked, delay }: { s: KioskScreen; yes: boolean; x: number; y: number; w: number; h: number; locked: boolean; delay: number }) {
  const v = yes ? s.yes ?? 50 : s.no ?? 50;
  const fg = yes ? P.white : P.ink;
  const dir = (yes ? s.move ?? 0 : -(s.move ?? 0)) || 0;
  const pays = money(Math.floor(10000 / Math.max(1, v)));
  const digits = String(v);
  return (
    <div className="hk-abs hk-pop" style={{ left: x, top: y, width: w, height: h, ...d(delay) }}>
      <div key={`${v}`} className={`hk-tile hk-lift ${dir ? "hk-kick" : ""}`} style={{ background: yes ? P.yes : P.no, color: fg }}>
        <T f="H3" x={18} y={34} color={fg}>{yes ? "Yes" : "No"}</T>
        <Roll f="N1" x={16} y={120} text={digits} color={fg} />
        <T f="N3" x={20 + digits.length * 41} y={66} color={fg}>¢</T>
        {dir !== 0 && <Arrow cx={w - 28} cy={28} s={1.1} up={dir > 0} color={fg} className="hk-arrow" />}
        <T f="B1" x={18} y={h - 16} color={fg} style={{ opacity: 0.92 }}>$1 pays {pays}</T>
        {locked && <i className="hk-veil" />}
      </div>
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
  // Same rule as the firmware: the big face when the question fits in two lines of it.
  const [big, setBig] = useState(q.length <= 44);
  useEffect(() => {
    let alive = true;
    void document.fonts.ready.then(() => {
      const n = wrapLines("800 44px 'HK Bricolage'", q, 532);
      if (alive && n !== null) setBig(n <= 2);
    });
    return () => {
      alive = false;
    };
  }, [q]);
  const LX = 32, LW = 532, tw = (LW - 12) / 2;
  const hist = s.history ?? [];
  const diff = hist.length ? (s.yes ?? 50) - hist[0] : 0;
  const lockW = lockB ? Math.round(lockB.label.length * 10.6) + 40 : 0;
  const right = 800 - 16 - 26 - (lockB && !locked ? lockW + 12 : 0);
  // Width budget (same rule as the firmware): the badge, the amount and "traded" stop 12 px before the
  // scorebug / code chip. "Question 10 of 12" becomes "Q10 of 12", then "traded", then the amount drop out.
  const title = s.title || "Market open";
  const [shortBadge, setShortBadge] = useState(false);
  const [fit, setFit] = useState<0 | 1 | 2>(2);
  const badgeRef = useRef<HTMLDivElement>(null);
  const amtRef = useRef<HTMLSpanElement>(null);
  const wordRef = useRef<HTMLSpanElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const bug = rightRef.current?.getBoundingClientRect();
    const badge = badgeRef.current?.getBoundingClientRect();
    if (!bug || !badge || !bug.width) return;
    const k = (badgeRef.current?.offsetWidth ?? 0) > 0 ? badge.width / badgeRef.current!.offsetWidth : 1;
    const limit = bug.left - 12 * k;
    const amt = amtRef.current?.getBoundingClientRect();
    const word = wordRef.current?.getBoundingClientRect();
    if (!shortBadge && (!word || word.right > limit) && /^Question \d/.test(title)) setShortBadge(true);
    const next: 0 | 1 | 2 = word && word.right <= limit ? 2 : amt && amt.right <= limit ? 1 : 0;
    if (next !== fit) setFit(next);
  });
  return (
    <div key={q} className="hk-fill">
      <div className="hk-drop hk-abs" style={{ left: 16, top: 12, height: 38, display: "flex", alignItems: "center", gap: 12, whiteSpace: "nowrap" }}>
        {locked ? (
          <div ref={badgeRef} className="hk-badge hk-pop">
            <svg width="20" height="22" viewBox="-10 -11 20 24" aria-hidden="true"><path d="M-5.5 -0.5 V-3 A5.5 5.5 0 0 1 5.5 -3 V-0.5" fill="none" stroke="#fff" strokeWidth="2.6" /><rect x="-9" y="-0.5" width="18" height="13" rx="3" fill="#fff" /></svg>
            <span className="hk-body hk-w700">Trading closed</span>
          </div>
        ) : (
          <div ref={badgeRef} className="hk-badge" style={{ background: GRAD }} aria-label={title}>
            <svg width="14" height="20" viewBox="-7 -10 14 20" aria-hidden="true"><path d="M2 -9 L-6 1.5 L1 1.5 Z M-2 9 L6 -1.5 L-1 -1.5 Z" fill="#fff" /></svg>
            <span className="hk-body hk-w700">{shortBadge ? title.replace(/^Question /, "Q") : title}</span>
          </div>
        )}
        <div className="hk-traded" aria-label={s.volume !== undefined ? `${money(s.volume)} traded` : s.traded}>
          <span ref={amtRef} className="hk-num hk-w700 hk-c90" style={{ visibility: fit >= 1 ? "visible" : "hidden" }}>{s.volume !== undefined ? money(s.volume) : ""}</span>{" "}
          <span ref={wordRef} className="hk-body hk-w400" style={{ visibility: fit >= 2 ? "visible" : "hidden" }}>{s.volume !== undefined ? "traded" : s.traded}</span>
        </div>
      </div>
      <LiveDot cx={776} cy={30} fresh={fresh} />
      {lockB && !locked && <Button b={lockB} x={800 - 16 - 26 - lockW} y={10} w={lockW} h={42} r={21} onTouch={onTouch} pending={pending === "lock"} />}
      {s.score ? <Scorebug s={s} rx={right} y={10} h={42} elRef={rightRef} /> : s.code ? <CodeChip code={s.code} rx={right} elRef={rightRef} /> : null}

      <div className={`hk-abs hk-stage hk-zoom hk-lift ${urgent ? "hk-urgent-edge" : ""}`} style={{ left: 12, top: 64, width: 776, height: 404 }}>
        <i className="hk-ribbon" style={{ background: GRAD, height: 7 }} />
        <i className="hk-sweep" />
        {locked && <i className="hk-flashout" />}
      </div>
      <Kinetic f={big ? "H1" : "H2"} x={LX} y={big ? 116 : 106} w={LW} lines={big ? 2 : 3} lh={big ? 46 : 34} text={q} delay={140} />
      <OutcomeTile s={s} yes x={LX} y={196} w={tw} h={166} locked={locked} delay={380} />
      <OutcomeTile s={s} yes={false} x={LX + tw + 12} y={196} w={tw} h={166} locked={locked} delay={460} />
      <div className="hk-abs hk-fade" style={{ left: LX, top: 370, width: LW, height: 32, ...d(560) }}>
        {typeof s.model === "number" && <Arrow cx={(LW * s.model) / 100} cy={7} s={1} up={false} color={P.ink} className="hk-marker" />}
        {s.gemini && (
          <svg className="hk-abs hk-marker" style={{ left: (LW * s.gemini.cents) / 100 - 7, top: 2 }} width="14" height="11" viewBox="0 0 14 11" aria-hidden="true">
            <path d="M0 0 H14 L7 10 Z M3.4 1.8 L7 7 L10.6 1.8 Z" fill={P.ink} fillRule="evenodd" />
          </svg>
        )}
        <div className="hk-split" style={{ top: 14 }}>
          <i className="hk-split-yes" style={{ width: `${Math.min(98, Math.max(2, s.yes ?? 50))}%` }} />
          {locked && <i className="hk-veil" style={{ borderRadius: 8 }} />}
        </div>
      </div>
      <div className="hk-abs hk-fade hk-pros" style={{ left: LX, top: 422, width: LW, ...d(640) }}>
        {typeof s.model === "number" || s.gemini ? (
          <>
            <span className="hk-body hk-w400">Room </span><b className="hk-num hk-w700 hk-c90" style={{ color: P.deep }}>{s.yes}¢</b>
            {typeof s.model === "number" && (<><span className="hk-tri" /> <span className="hk-body hk-w400">Model </span><b className="hk-num hk-w700 hk-c90">{s.model}¢</b></>)}
            {s.gemini && (<><span className="hk-tri hk-hollow" /> <span className="hk-body hk-w400">Gemini </span><b className="hk-num hk-w700 hk-c90">{s.gemini.cents}¢</b>{!s.gemini.live && <small> (last seen)</small>}</>)}
          </>
        ) : (
          <span className="hk-body hk-w400">{locked ? s.subtitle : "Buy YES or NO on your phone. A winning share pays $1"}</span>
        )}
      </div>

      <div className="hk-abs hk-rise" style={{ left: 0, top: 0, ...d(240) }}>
        <LockRing cx={678} cy={172} R={76} rem={rem} tot={tot} locked={locked} manual={manual} />
      </div>
      {locked ? (
        <div className="hk-rise" style={d(200)}>
          {yesB && <Button b={yesB} x={584} y={280} w={188} h={70} r={20} onTouch={onTouch} pending={pending === yesB.id} />}
          {noB && <Button b={noB} x={584} y={362} w={188} h={70} r={20} onTouch={onTouch} pending={pending === noB.id} />}
          {!yesB && !noB && <T f="B2" x={678} y={300} w={188} align="center" color={P.ink2}>Watch the play.</T>}
        </div>
      ) : (
        <div className="hk-rise" style={d(700)}>
          <T f="B3" x={584} y={276} color={P.ink2}>Yes price</T>
          <T f="N4" x={772} y={277} w={100} align="right" color={diff > 0 ? P.yes600 : diff < 0 ? P.no600 : P.muted}>{diff === 0 ? "Flat" : `${diff > 0 ? "+" : ""}${diff} pts`}</T>
          <Sparkline x={584} y={286} w={188} h={54} hist={hist} />
          {(s.trades ?? []).length === 0 ? (
            <>
              <T f="B3" x={584} y={376} color={P.muted}>No trades yet.</T>
              <T f="B3" x={584} y={396} color={P.muted}>Phones buy YES or NO.</T>
            </>
          ) : (
            (s.trades ?? []).slice(0, 3).map((t, i) => (
              <div key={`${t.name}${t.cents}${t.side}${hist.length - i}`} className={`hk-abs hk-trade ${i === 0 ? "hk-slide-r" : ""}`} style={{ left: 584, top: 356 + i * 34, width: 188, height: 28 }}>
                <span className="hk-avatar hk-body hk-w600" style={{ width: 22, height: 22, fontSize: 13, background: AVATAR[hash(t.name) % 8] }} aria-hidden="true">{(t.name.trim()[0] ?? "?").toUpperCase()}</span>
                <span className="hk-body hk-w600 hk-name">{t.name}</span>
                <span className="hk-body hk-w600" style={{ color: t.side === "yes" ? P.yes600 : P.no600 }}>{t.side === "yes" ? "▲ Yes" : "▼ No"}</span>
                <b className="hk-num hk-w700 hk-c90">{money(t.cents)}</b>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function People({ x, y, w, h, title, win, rows, empty, delay }: {
  x: number; y: number; w: number; h: number; title: string; win: boolean; rows: { name: string; label: string }[]; empty: string; delay: number;
}) {
  return (
    <div className="hk-abs hk-card hk-lift hk-rise" style={{ left: x, top: y, width: w, height: h, borderRadius: 20, ...d(delay) }}>
      <Arrow cx={20} cy={21} s={0.8} up={win} color={win ? P.yes600 : P.no600} />
      <T f="B1" x={34} y={28} color={win ? P.yes600 : P.no600}>{title}</T>
      <div className="hk-scroll" style={{ left: 0, top: 38, width: w, height: h - 44 }}>
        {rows.length === 0 && <T f="B2" x={16} y={24} color={P.ink2}>{empty}</T>}
        <div style={{ position: "relative", height: rows.length * 34 }}>
          {rows.map((r, i) => (
            <div key={i} className={`hk-abs ${win ? "hk-shine" : ""}`} style={{ left: 0, top: i * 34, width: w, height: 34, ...d(delay + 400 + i * 180) }}>
              <Avatar name={r.name} cx={28} cy={16} r={12} dim={!win} />
              <T f="B1" x={48} y={23} w={w - 170} color={win ? P.ink : P.ink2}>{r.name}</T>
              <T f="N4" x={w - 14} y={23} w={120} align="right" color={win ? P.ink2 : P.muted}>{r.label}</T>
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
  const win = voided ? P.well : yes ? P.yes : P.no;
  const on = voided ? P.ink : yes ? P.white : P.ink;
  let share = s.lockYes != null ? s.lockYes / 100 : yes ? (s.yes ?? 50) / 100 : (s.no ?? 50) / 100;
  if (!yes && s.lockYes != null) share = 1 - s.lockYes / 100;
  share = Math.min(0.95, Math.max(0.05, share));
  const next = s.buttons.find((b) => b.id === "next");
  const end = s.buttons.find((b) => b.id === "end");
  const allCalls = s.calls ?? s.buttons.filter((b) => b.id.startsWith("moment:"));
  const winners = s.winners ?? (s.lines ?? []).map((l) => ({ name: l, cents: 0, profit: 0 }));
  const losers = s.losers ?? [];
  const trailing = (s.volume !== undefined ? `${money(s.volume)} traded` : s.traded) ?? "";
  let x = 36;
  let x1 = 764;
  // With Call it! buttons in the row, Next and End shrink to their labels so the calls get the room (firmware too).
  const has = allCalls.length > 0;
  const nextW = next ? (has ? Math.min(230, labelW(next.label, 20) + 62) : 230) : 0;
  const endW = end ? (has ? Math.min(120, labelW(end.label, 20) + 44) : next ? 120 : 230) : 0;
  if (next) x += nextW + 12;
  if (end) x1 -= endW + 12;
  const { shown: calls, bw, small, noIcon } = callRow(allCalls, x1 - x);
  return (
    <div key={s.question} className="hk-fill">
      <Wordmark x={20} y={40} />
      <LiveDot cx={776} cy={30} fresh={fresh} />
      {s.score ? <Scorebug s={s} rx={758} y={10} h={42} /> : s.code ? <CodeChip code={s.code} rx={758} /> : null}
      <div className="hk-abs hk-stage hk-zoom hk-lift" style={{ left: 12, top: 64, width: 776, height: 404, color: on }}>
        <i className="hk-flood" style={{ background: win, transformOrigin: yes || voided ? "left" : "right", ["--from" as string]: share } as CSSProperties} />
      </div>
      <div className="hk-fade" style={{ ...d(120), color: on }}>
        <T f="B2" x={36} y={98} color="inherit">{voided ? "Voided" : "Result"}</T>
        <div className="hk-t hk-head hk-w700 hk-clamp2" style={{ left: 36, top: 128 - 23, width: 720, fontSize: 24, lineHeight: "28px", color: "inherit", whiteSpace: "normal" }}>{s.question}</div>
      </div>
      <div className="hk-stamp" style={{ ...d(380), color: on }}>
        {!voided && (
          <svg className="hk-abs" style={{ left: 44, top: 196 }} width="54" height="44" viewBox="-27 -22 54 44" aria-hidden="true">
            <path d="M-21 0 L-6.5 15.6 L23.4 -18.2" fill="none" stroke="currentColor" strokeWidth="8.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        <T f={voided ? "H1" : "HERO"} x={voided ? 36 : 112} y={voided ? 232 : 262} color="inherit">{voided ? "Refunded" : yes ? "YES" : "NO"}</T>
      </div>
      <div className="hk-fade" style={{ ...d(600), color: on }}>
        <T f="N3" x={760} y={218} w={400} align="right" color="inherit">{trailing}</T>
        <T f="B1" x={760} y={248} w={400} align="right" color="inherit" style={{ opacity: 0.9 }}>
          {winners.length || losers.length ? `${winners.length} ${winners.length === 1 ? "winner" : "winners"}` : "Winning shares pay $1"}
        </T>
      </div>
      {!voided && winners.length > 0 && <Burst count={Math.min(48, 18 + winners.length * 6)} x={240} y={230} delay={520} colors={[P.gold, P.lime, P.white, P.accent, yes ? "#9CC2FF" : "#FFC08A"]} />}
      {s.winners !== undefined || !(s.lines ?? []).length ? (
        <>
          <People x={36} y={274} w={358} h={112} title="Called it" win rows={winners.map((w) => ({ name: w.name, label: `${money(Math.max(0, w.profit), true)} won` }))} empty="Nobody. Brutal." delay={760} />
          <People x={406} y={274} w={358} h={112} title="Cooked" win={false} rows={losers.map((l) => ({ name: l.name, label: `${money(l.cents)} lost` }))} empty="Clean sweep." delay={840} />
        </>
      ) : (
        <People x={36} y={274} w={728} h={112} title="Called it" win rows={(s.lines ?? []).map((l) => ({ name: l, label: "" }))} empty="" delay={760} />
      )}
      <div className="hk-rise" style={d(900)}>
        {next && <Button b={next} style={voided ? "brand" : "ink"} x={36} y={396} w={nextW} h={62} r={20} onTouch={onTouch} pending={pending === next.id} />}
        {calls.map((c, i) => (
          <Button key={c.id} b={{ ...c, style: "primary" }} style="call" small={small} noIcon={noIcon} x={x + i * (bw + 8)} y={396} w={bw} h={62} r={18} onTouch={onTouch} pending={pending === c.id} />
        ))}
        {end && <Button b={end} style={next ? "white" : "ink"} x={764 - endW} y={396} w={endW} h={62} r={20} onTouch={onTouch} pending={pending === end.id} />}
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
        {(s.screen === "market" || s.screen === "locked") && <Market {...ctx} locked={s.screen === "locked"} />}
        {s.screen === "result" && <Result {...ctx} />}
        {s.screen === "ended" && <Ended {...ctx} />}
        {!["select", "lobby", "market", "locked", "result", "ended"].includes(s.screen) && <Message {...ctx} />}
      </div>
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
      <Wordmark x={32} y={60} />
      <T f="H1" x={32} y={140}>Getting ready</T>
      <T f="B1" x={32} y={224}>Reaching the site...</T>
      <T f="B3" x={32} y={354} color={P.muted}>A hosted site can take 30 s to wake up.</T>
      <Mark cx={612} cy={240} R={110} spin />
      <T f="H3" x={612} y={248} w={200} align="center">huddle</T>
    </div>
  );
}
