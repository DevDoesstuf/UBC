// Watch-page shortcut for the laptop/TV: https://<site>/w/1 opens the watch page of kiosk 1's current game,
// so nobody has to type the lobby code. Reload it after starting a new game.
import { NextResponse } from "next/server";
import { baseUrl } from "@/lib/http";
import { getKioskLobby, normKiosk } from "@/lib/lobby";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ kiosk: string }> }) {
  const { kiosk } = await params;
  const id = normKiosk(kiosk);
  const l = await getKioskLobby(id).catch(() => null);
  const to = l ? `/watch/${l.code}` : `/?nokiosk=${encodeURIComponent(id)}`;
  return NextResponse.redirect(`${baseUrl(req)}${to}`, 302);
}
