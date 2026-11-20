// NFC entry point. The NFC sticker on the kiosk holds a fixed link: https://<site>/k/1
// It sends the phone to whatever lobby kiosk 1 is running right now.
import { NextResponse } from "next/server";
import { baseUrl } from "@/lib/http";
import { getKioskLobby, normKiosk } from "@/lib/lobby";
import { anyPending } from "@/lib/hw";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ kiosk: string }> }) {
  const { kiosk } = await params;
  const id = normKiosk(kiosk);
  const l = await getKioskLobby(id).catch(() => null);
  // A bet waiting for a tap (lib/hw.ts): ?tap=1 lets the phone page confirm it with the token in localStorage.
  const tap = l && anyPending(l, Date.now()) ? "?tap=1" : "";
  // After the final whistle a tap on the box collects your winnings (?collect=1, the phone page cashes out).
  const to = !l ? `/?nokiosk=${encodeURIComponent(id)}` : l.phase === "ended" ? `/l/${l.code}?collect=1` : `/l/${l.code}${tap}`;
  return NextResponse.redirect(`${baseUrl(req)}${to}`, 302);
}
