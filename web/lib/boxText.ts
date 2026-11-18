// Text the kiosk box can draw. The firmware's fonts are Latin-1, so everything the box shows goes through
// boxSafe(): typographic punctuation is swapped, letters outside Latin-1 are transliterated where a plain
// form exists (Ł -> L, ő -> o, Œ -> OE) and anything else is dropped. Shared by the server (lib/kiosk.ts),
// the box preview and the avatar colours, so a player has one colour on the box, the phones and the TV.

const SPECIAL: Record<string, string> = {
  "Ł": "L", "ł": "l", "Đ": "D", "đ": "d", "Ħ": "H", "ħ": "h", "Ŧ": "T", "ŧ": "t", "ı": "i", "Œ": "OE", "œ": "oe",
  "ẞ": "SS", "Ŋ": "N", "ŋ": "n", "ĸ": "k", "ſ": "s",
};

/** Latin-1 only (0x20-0x7E, 0xA0-0xFF). */
export function boxSafe(s: string): string {
  let out = "";
  for (const ch of String(s ?? "")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff)) {
      out += ch;
      continue;
    }
    if (c < 0x100) continue; // control characters
    if (SPECIAL[ch]) {
      out += SPECIAL[ch];
      continue;
    }
    // Strip accents the font cannot draw (ő -> o, č -> c); keep the base letter if it is Latin-1.
    const base = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (base && [...base].every((b) => b.charCodeAt(0) <= 0xff && b.charCodeAt(0) >= 0x20)) out += base;
  }
  return out;
}

/** A player's name as the box draws it: never blank (a name in a script the box cannot draw becomes "Player"). */
export function boxName(name: string): string {
  const s = boxSafe(name).replace(/\s+/g, " ").trim();
  return s || "Player";
}

/** FNV-1a over the UTF-8 bytes of boxName(name): the firmware hashes the same bytes (ui.cpp strHash). */
export function avatarHash(name: string): number {
  const bytes = new TextEncoder().encode(boxName(name));
  let h = 2166136261;
  for (const b of bytes) h = Math.imul(h ^ b, 16777619) >>> 0;
  return h >>> 0;
}
