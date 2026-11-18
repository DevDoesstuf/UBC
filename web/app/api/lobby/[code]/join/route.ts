// POST /api/lobby/ABCD/join  {"name":"Sam"} -> {"playerId","token"}  (the phone keeps the token)
import { handle, json, readBody } from "@/lib/http";
import { join, mutate } from "@/lib/lobby";
import type { Player } from "@/lib/types";

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return handle(async () => {
    const { code } = await params;
    const body = await readBody(req);
    let p: Player | null = null;
    await mutate(code, (l, now) => {
      p = join(l, body.name, now);
    });
    const player = p as unknown as Player;
    return json({ ok: true, playerId: player.id, token: player.token, name: player.name });
  });
}
