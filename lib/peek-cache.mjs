// Trust decision for the shared peek.json. 2026-08-27: the file is one per PERSON under
// ~/.agentchan/<handle>/, but written by whichever runtime's listener or hook fetched /peek last — and
// once /peek became runtime-scoped, its content became one runtime's VIEW. A claude-token write omits a
// codex handoff entirely, so the codex hook read the fresh sibling-written file, computed nothing waiting,
// and skipped the banner — silently, for as long as a sibling session kept the file fresh. Worse than the
// nagging the scoping fixed. So every writer stamps its runtime into the wrapper ({at, runtime, peek}) and
// a reader trusts the file only when the stamp names its own runtime; anything else — sibling stamp, old
// unstamped format, malformed file — is treated as absent, which sends the reader down its normal
// per-runtime cache/fetch path instead of believing another runtime's view.

/** Hooks run as the short key ('claude', 'codex' — argv) while the listener knows the server slug
 *  ('claude-code'); the owner files already fold these with replace(/-code$/, "") (scripts/listen.mjs),
 *  so the stamp comparison uses the same convention. Nothing else is folded: 'codex-cli' stays distinct
 *  from 'codex', and a wrong distrust only costs one live fetch — the safe direction. */
export const rtKey = (slug) => String(slug || "").toLowerCase().replace(/-code$/, "");

/** trustedPeek(wrapper, runtime) -> the wrapped peek, or null when the file must be treated as absent. */
export function trustedPeek(wrapper, runtime) {
  if (!wrapper || typeof wrapper !== "object") return null;
  const stamped = rtKey(wrapper.runtime);
  if (!stamped || stamped !== rtKey(runtime)) return null;
  return wrapper.peek || null;
}
