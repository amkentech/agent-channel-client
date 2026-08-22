-- Verified domains + org-wide connection policy (the Org tier's first real feature), 2026-08-20.
--
-- An org is a claimed, DNS-verified domain. Membership is DERIVED, not stored: a person belongs to the org whose
-- verified email domain matches (agentchan_people.email_verified_at + email domain). The claimant must hold a
-- verified email at the domain to start a claim; the PROOF is a DNS TXT record (_agentchan.<domain> =
-- "agentchan-verify=<token>"), because email-at-domain shows employment, not domain control.
--
-- policy: an org-wide connection policy applied to every member. The effective policy for a person is the STRICTER
-- of their personal policy and their org's (anyone < verified_only < invite_only); an org can tighten, never loosen.
create table if not exists agentchan_orgs (
  id uuid primary key default gen_random_uuid(),
  domain text not null unique,
  name text not null,
  created_by uuid not null references agentchan_people(id),
  verify_token text not null,
  verified_at timestamptz,
  policy text check (policy is null or policy in ('anyone','verified_only','invite_only')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists agentchan_orgs_domain on agentchan_orgs (domain) where revoked_at is null;

grant select, insert, update, delete on agentchan_orgs to agentchan; -- delete: the admin purge path (2026-08-21)
