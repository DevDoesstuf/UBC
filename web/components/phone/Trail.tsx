"use client";
// The phone's memory of each question it watched: the YES price line and how it went for me. The server's
// results list carries only text, outcome, volume and payouts, so the Results tab reads this to draw a
// sparkline and a per-question P&L. Kept per party in sessionStorage so a reload keeps the night.
import { useEffect, useRef, useState } from "react";
import { myResult, type Lobby } from "./derive";

export type TrailEntry = { text: string; points: number[]; net: number | null; kind: "won" | "lost" | "refunded" | "none" };
export type Trail = Record<string, TrailEntry>;

const keyOf = (code: string) => `huddle:trail:${code}`;

function load(code: string): Trail {
  try {
    const raw = sessionStorage.getItem(keyOf(code));
    return raw ? (JSON.parse(raw) as Trail) : {};
  } catch {
    return {};
  }
}

export function useTrail(l: Lobby | null): Trail {
  const code = l?.code ?? "";
  const [trail, setTrail] = useState<Trail>({});
  const loaded = useRef("");
  useEffect(() => {
    if (!code || loaded.current === code) return;
    loaded.current = code;
    setTrail(load(code));
  }, [code]);

  const m = l?.market;
  const sig = m ? `${m.text}|${m.history.length}|${m.outcome ?? ""}|${l?.phase}|${l?.me?.position?.spent ?? 0}|${l?.me?.payout ?? 0}` : "";
  useEffect(() => {
    if (!l || !m || !code) return;
    const res = myResult(l);
    const net = res.kind === "won" || res.kind === "lost" ? res.net : res.kind === "refunded" ? 0 : null;
    const points = m.history.length ? m.history.map((c) => c / 100) : [m.priceYes];
    setTrail((prev) => {
      const old = prev[m.text];
      const entry: TrailEntry = {
        text: m.text,
        points: points.length >= (old?.points.length ?? 0) ? points : old!.points,
        net: m.outcome ? net : old?.net ?? null,
        kind: m.outcome ? res.kind : old?.kind ?? "none",
      };
      const next = { ...prev, [m.text]: entry };
      try {
        sessionStorage.setItem(keyOf(code), JSON.stringify(next));
      } catch {
        /* storage off: the trail lives for this page only */
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  return trail;
}
