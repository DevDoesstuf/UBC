// GET /api/kiosk/state?kiosk=1  -> the screen the kiosk should draw (polled about once a second).
import { baseUrl, handle, json } from "@/lib/http";
import { kioskScreen } from "@/lib/kiosk";
import { normKiosk } from "@/lib/lobby";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    const kiosk = normKiosk(new URL(req.url).searchParams.get("kiosk"));
    return json(await kioskScreen(kiosk, baseUrl(req)));
  });
}
