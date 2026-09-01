// Local seen-markers for waiting items the hook shows but nothing ever acks (proposals, contracts, unfetched
// files: the /peek summary lines with no read_at path). Before 2026-08-27 these re-fired the banner verbatim on
// every prompt until resolved server-side, which for a proposal the human is thinking over could be days. Shown
// in full once, then muted to a count line, re-shown after renagMs so a forgotten item cannot rot silently.
// This is DISPLAY state only, per runtime, in a local file next to peek-cache: it must never write server state,
// because read_at is load-bearing for delivery and belongs to the addressee runtime alone.

/**
 * splitSurfaced(map, keys, now, renagMs, limit) -> { fresh, muted, next }
 * fresh: keys never shown, or shown longer than renagMs ago (stamp refreshed - the re-nag), capped at limit.
 * muted: keys shown within the window (original stamp kept, so the window is measured from first display).
 * next:  the map to persist - live keys only, so resolved items are pruned and the file cannot grow unbounded.
 * limit (2026-08-27 round 3): the hook displays only the first N fresh lines, and stamping MORE than it
 * displays muted items 6h behind "shown earlier" that never were shown. fresh is capped at the display
 * limit and overflow keys stay unstamped (and out of next), so they surface on the very next prompt.
 */
export function splitSurfaced(map, keys, now, renagMs, limit = Infinity) {
  const fresh = [], muted = [], next = {};
  for (const k of keys) {
    const ts = map[k];
    if (ts !== undefined && now - ts < renagMs) { muted.push(k); next[k] = ts; }
    else if (fresh.length < limit) { fresh.push(k); next[k] = now; }
  }
  return { fresh, muted, next };
}
