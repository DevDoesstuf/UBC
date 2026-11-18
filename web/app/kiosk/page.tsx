"use client";
// Web version of the kiosk touchscreen: /kiosk?id=1 (add &key=... if KIOSK_KEY is set).
// Uses the exact API the ESP32 uses, so it is the reference for the firmware and a fallback
// (open it full screen on a tablet or a Raspberry Pi in kiosk mode).
import { useEffect, useState } from "react";
import { KioskView } from "@/components/KioskView";
import { api, useNow, usePoll, useQueryParam, type KioskScreen } from "@/components/client";

export default function KioskPage() {
  const id = useQueryParam("id");
  const key = useQueryParam("key");
  const [ready, setReady] = useState(false);
  const [scale, setScale] = useState(1);
  const [pressed, setPressed] = useState<string | null>(null);
  const [error, setError] = useState<{ text: string; until: number } | null>(null);
  const [override, setOverride] = useState<KioskScreen | null>(null);
  const now = useNow(500);

  useEffect(() => setReady(true), []);
  useEffect(() => {
    const fit = () => setScale(Math.min(window.innerWidth / 800, window.innerHeight / 480));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  const kiosk = id || "1";
  const headers: Record<string, string> = key ? { "x-kiosk-key": key } : {};
  const { data, lastOk } = usePoll(ready ? () => api<KioskScreen>(`/api/kiosk/state?kiosk=${encodeURIComponent(kiosk)}`, { headers }) : null, 1000);

  useEffect(() => setOverride(null), [data]);

  async function touch(target: string) {
    setPressed(target);
    try {
      const s = await api<KioskScreen>("/api/kiosk/touch", { body: { kiosk, id: target }, headers });
      setOverride(s);
    } catch (e) {
      const d = (e as { data?: KioskScreen & { error?: string } }).data;
      if (d && d.screen) setOverride(d);
      setError({ text: (e as Error).message, until: Date.now() + 3000 });
    } finally {
      setTimeout(() => setPressed(null), 150);
    }
  }

  const s = override ?? data;
  return (
    <div className="kiosk-stage">
      <div style={{ transform: `scale(${scale})` }}>
        {s ? (
          <KioskView
            s={s}
            pressed={pressed}
            error={error && error.until > now ? error.text : null}
            stale={lastOk > 0 && now - lastOk > 6000}
            onTouch={touch}
          />
        ) : (
          <div className="kiosk" style={{ display: "grid", placeItems: "center", fontSize: 26 }}>Connecting…</div>
        )}
      </div>
    </div>
  );
}
