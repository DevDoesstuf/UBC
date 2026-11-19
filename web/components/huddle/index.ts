/**
 * Huddle kit ("Kickoff" design, green + ivory). Shared by the phone, the home page and the TV page.
 * Styles live in `./huddle.css` (imported once by app/layout.tsx); tokens are the `--k-*` CSS
 * variables in app/globals.css. Every motion follows the fail-safe rules: the resting style is the
 * final state, keyframes only describe the journey, CSS (not JS) drives anything that starts
 * invisible, and every `hd-*` animation has a reduced-motion variant.
 *
 * Named motions: kinetic-text (Kinetic), odds-roll (Roll, Pct), seam-glide (SplitBar),
 * price-draw (Sparkline), ring-drain / last-call / lock-snap (LockRing), money-flow (useCoins),
 * result-flood (`hd-flood`), confetti (Burst), board-reorder (useFlip), press (`hd-press`).
 */
export { Icon, type IconName } from "./Icon";
export { Roll, Pct, DirArrow } from "./Roll";
export { SplitBar, SplitMarkers, MarkerShape, toneFor, type SplitPart, type Tone } from "./Split";
export { LockRing, type LockState } from "./LockRing";
export { Mark, Wordmark, MARK_LIT } from "./Mark";
export {
  Kinetic, Burst, Aurora, Avatar, avatarColour, Sparkline, useSeries, useCoins, withAlpha,
  AURORA_DEFAULT, BURST_COLOURS, GOLD_BURST, type AuroraBlob, type SeriesPoint,
} from "./Fx";
export { DUR, EASE, prefersReducedMotion, useReducedMotion, useReplayClass, useDirection, useNewIds, useFlip, delay, vars } from "./motion";
export {
  clampProb, pctText, pctValue, pctLabel, multiplierText, payoutText, normalise, usd, usdShort, signedUsd, ordinal, parseDollars,
} from "./format";
