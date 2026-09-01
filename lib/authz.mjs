// Authorization decisions that were embedded in SQL predicates and inline expressions, pulled out so they can
// be tested and so there is ONE of each. An adversarial audit on 2026-08-27 mutated 24 pieces of route and
// tool-handler logic and ran the full suite against every one: 24 of 24 survived. Four were authorization
// boundaries - deleting the org-escrow domain filter, deleting the audit_trail party check, deleting the /ack
// runtime boundary, and returning whole email addresses instead of domains all passed a green suite.
//
// None of those were broken. Nothing could catch them BECOMING broken, which for an authorization boundary is
// the same problem one incident later. Two of the four were also written twice (the org scope in two routes,
// the runtime boundary in three places), and a rule with two copies is a rule that will eventually have two
// behaviours - the exact drift that /peek and my_inbox had already shipped.
//
// SQL fragments live here as exported constants rather than as prose duplicated across call sites: the query
// text is the implementation, so sharing the text is what actually prevents the drift. Fitness tests assert
// the call sites use them, because no harness in this repo can execute a route.

/** The runtime boundary. A message addressed to a specific runtime belongs to THAT runtime: unaddressed mail
 *  (to_runtime null) is everyone's, addressed mail is one session's. read_at is load-bearing for delivery, so
 *  if any of a person's runtimes could mark another's handoff read, the addressee would simply never see it.
 *  Enforced identically by /peek (as a JS partition in peekMessagesView), my_inbox's UPDATE, and POST /ack.
 *  Exact equality, never a prefix match: real slugs prefix each other (claude/claude-code, codex/codex-cli). */
export const RUNTIME_SCOPE_SQL = "(m.to_runtime is null or m.to_runtime = $RUNTIME$)";

/** An artifact is fetchable while its TTL has not passed, OR while it is bound to an open contract.
 *  Housekeep uses the same open-status list; listing/download must not be stricter or a bound file
 *  vanishes at 3 days while the contract is still live. */
export const ARTIFACT_LIVE_SQL = "(ar.expires_at > now() or (ar.proposal_id is not null and exists (select 1 from agentchan_proposals p where p.id = ar.proposal_id and p.status in ('draft','pending','countered','accepted','returned'))))";

/** Org escrow scope. A verified org claimant may see an encrypted artifact when EITHER party has a verified
 *  address at that domain - a file a member sent out, and a file an outsider sent in, are both the employer's
 *  business. Both halves are load-bearing: dropping the domain test exposes every artifact on the server to
 *  any claimant, and narrowing to the recipient alone silently drops everything a member sent. `verified` is
 *  required on the side being matched, or an unverified self-assigned address would mint org access. */
export const ORG_SCOPE_SQL =
  "(   (tp.email_verified_at is not null and lower(split_part(tp.email,'@',2)) = $DOMAIN$)\n" +
  "             or (fp.email_verified_at is not null and lower(split_part(fp.email,'@',2)) = $DOMAIN$))";

/** The domain of a verified address, and NOTHING else. who_is_working is visible to everyone on the channel;
 *  it answers "who is this person's employer" and must never answer "what is this person's email address".
 *  Unverified means no claim at all - an unverified address is a string the user typed. */
export function emailDomain(email, verifiedAt) {
  if (!verifiedAt) return undefined;
  const at = String(email || "").lastIndexOf("@");
  if (at === -1 || at === String(email).length - 1) return undefined;
  return String(email).slice(at + 1).toLowerCase() || undefined;
}

/** Only a party may read an object's timeline. "Party" means this handle appears as the actor or the subject
 *  of at least one entry. An EMPTY timeline is not a denial: there is nothing to leak, and the object may
 *  simply not exist, so it returns true and the caller answers with an empty list rather than a 403 that
 *  would confirm the id belongs to someone else. */
export function isPartyTo(rows, handle) {
  if (!Array.isArray(rows) || !rows.length) return true;
  if (!handle) return false;
  return rows.some((r) => r.actor_handle === handle || r.subject_handle === handle);
}
