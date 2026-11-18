// Which team is written first. US leagues write "Away at Home" (49ers at Cowboys) and put the away team on
// the left of a scorebug; soccer elsewhere writes "Home v Away" with the home team on the left. One rule for
// the game cards and every scorebug (phone, TV, box).

/** US leagues that play soccer but write "Away at Home". */
const US_SOCCER = /^(mls|major league soccer|nwsl|usl)\b/i;

/** true = draw the away team first ("Away at Home"); false = home first ("Home v Away"). */
export function awayFirst(sport: string | null | undefined, league?: string | null): boolean {
  if (sport === "soccer") return !!league && US_SOCCER.test(league.trim());
  return true;
}

/** The two sides in drawing order: [left, right]. */
export function inOrder<T>(home: T, away: T, at: boolean): [T, T] {
  return at ? [away, home] : [home, away];
}
