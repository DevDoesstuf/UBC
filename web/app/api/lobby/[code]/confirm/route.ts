// POST /api/lobby/ABCD/confirm  (header x-player-token): places this player's pending (tap-to-confirm) bet.
import { handle, json, playerToken } from "@/lib/http";
import { confirmPending, mutate, requirePlayer } from "@/lib/lobby";

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return handle(async () => {
    const { code } = await params;
    const token = playerToken(req);
    let result: ReturnType<typeof confirmPending> | null = null;
    await mutate(code, (l, now) => {
      result = confirmPending(l, requirePlayer(l, token), now);
    });
    return json({ ok: true, ...(result ?? {}) });
  });
}
