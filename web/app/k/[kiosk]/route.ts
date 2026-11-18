// NFC entry point. The NFC sticker on the kiosk holds a fixed link: https://<site>/k/1
// It sends the phone to whatever lobby kiosk 1 is running right now.
import { NextResponse } from "next/server";
import { baseUrl } from "@/lib/http";
import { getKioskLobby, normKiosk } from "@/lib/lobby";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ kiosk: string }> }) {
  const { kiosk } = await params;
  const id = normKiosk(kiosk);
  const l = await getKioskLobby(id).catch(() => null);
  const to = l && l.phase !== "ended" ? `/l/${l.code}` : `/?nokiosk=${encodeURIComponent(id)}`;
  return NextResponse.redirect(`${baseUrl(req)}${to}`, 302);
}
