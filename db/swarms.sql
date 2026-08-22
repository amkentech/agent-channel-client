-- Swarms phase 1-2 DDL (docs/SWARMS.md steps 1-2), applied to the live database 2026-08-19.
-- Reference copy. Pattern matches the rest of the schema: postgres owns, RLS on with no policies,
-- the scoped `agentchan` role (BYPASSRLS) gets select/insert/update. No deletes: items are cancelled, not erased.

create table if not exists agentchan_teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  purpose text,
  lead_person uuid not null references agentchan_people(id),  -- exactly one accountable human
  created_by_agent uuid references agentchan_agents(id),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create unique index if not exists agentchan_teams_name_live on agentchan_teams (lower(name)) where archived_at is null;

create table if not exists agentchan_team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references agentchan_teams(id),
  person_id uuid not null references agentchan_people(id),
  role text not null default 'member' check (role in ('lead','member')),
  status text not null default 'invited' check (status in ('invited','active','declined','removed','left')),
  invited_by uuid references agentchan_people(id),
  invite_attestation text,   -- the lead's words inviting
  accept_attestation text,   -- the member's words joining (attested both ways)
  created_at timestamptz not null default now(),
  joined_at timestamptz,
  left_at timestamptz,
  unique (team_id, person_id)
);

-- A queue is the authority envelope: a standing grant held by a team instead of one person.
create table if not exists agentchan_queues (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references agentchan_teams(id),
  name text not null,
  brief text,
  mode text not null default 'assist' check (mode in ('assist','take')),
  repos jsonb not null default '[]'::jsonb,
  paths jsonb not null default '[]'::jsonb,
  max_size text,
  policy text not null default 'pull' check (policy in ('pull','push')),  -- push routing is phase 5
  envelope_attestation text not null,  -- the lead's words creating the envelope
  created_by_agent uuid references agentchan_agents(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index if not exists agentchan_queues_team_name_live on agentchan_queues (team_id, lower(name)) where revoked_at is null;

create table if not exists agentchan_work_items (
  id uuid primary key default gen_random_uuid(),
  queue_id uuid not null references agentchan_queues(id),
  team_id uuid not null references agentchan_teams(id),
  parent_contract uuid references agentchan_proposals(id),  -- authority flows down from an approved parent contract
  source text not null default 'human' check (source in ('human','system')),
  type text,                       -- 'story', 'alert', 'task', free
  title text not null,
  brief text,                      -- what done looks like for this slice
  context_refs jsonb not null default '[]'::jsonb,  -- repo/branch/PR/artifact ids: references, never contents
  priority int not null default 3 check (priority between 1 and 5),
  deadline timestamptz,
  state text not null default 'open' check (state in ('open','claimed','returned','done','cancelled')),
  claimant uuid references agentchan_people(id),   -- the human handle that holds it, null while unclaimed
  claimed_at timestamptz,
  claim_attestation text,          -- claims are human decisions
  return_ref jsonb,
  disposition jsonb,               -- the lead's accept/reject {decision, note, attestation, at}
  created_by_agent uuid references agentchan_agents(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists agentchan_work_items_queue_state on agentchan_work_items (queue_id, state);
create index if not exists agentchan_work_items_claimant on agentchan_work_items (claimant) where state in ('claimed','returned');

alter table agentchan_teams enable row level security;
alter table agentchan_team_members enable row level security;
alter table agentchan_queues enable row level security;
alter table agentchan_work_items enable row level security;

grant select, insert, update, delete on agentchan_teams, agentchan_team_members, agentchan_queues, agentchan_work_items to agentchan; -- delete: the admin purge path (2026-08-21)

-- phases 3-5 additions, applied live 2026-08-19 (same night, "nothing gets deferred unless I say so"):
--   signals: once-per-episode churn/SLA flags {stale, unreviewed, deadline: <ts>} written by sweepSwarmSignals();
--            cleared by every state change; the signals-only update never touches updated_at
--   queues.context_refs: queue-level bundle references every item inherits
--   queues.review_policy: 'lead' (default) | 'maker_checker' (a QA pass by a non-claimant is required before accept)
--   work_items.routing: push-routing record {policy, how, to, at} when an item was routed instead of claimed
--   work_items.qa: the checker's verdict {verdict, note, attestation, by, by_person, at}
alter table agentchan_work_items add column if not exists signals jsonb not null default '{}'::jsonb;
alter table agentchan_work_items add column if not exists routing jsonb;
alter table agentchan_work_items add column if not exists qa jsonb;
alter table agentchan_queues add column if not exists context_refs jsonb not null default '[]'::jsonb;
alter table agentchan_queues add column if not exists review_policy text not null default 'lead' check (review_policy in ('lead','maker_checker'));

-- point-in-time authority, added 2026-08-20. An action is judged against the authority AS IT STOOD AT ITS OWN
-- TIMESTAMP; revocation is a fact from that moment forward, never a retroactive unauthorization. Membership rows
-- mutate in place, so the frozen snapshot is the only reliable record of what the roster said at that instant.
--   work_items.authority: {source, how, queue{id,name,created_at,envelope,attestation}, team, membership, parent_contract, by, valid_at}
--   proposals.authority:  the standing grant as it stood when it auto-activated a proposal
alter table agentchan_work_items add column if not exists authority jsonb;
alter table agentchan_proposals add column if not exists authority jsonb;

-- conditional thresholds, added 2026-08-20 ("humans remain in control, not in the loop" — adapted from Blue's
-- conditional mandates). The lead writes the rules into the envelope ONCE, attested; routine actions proceed
-- automatically, threshold-crossing ones stop for the human's words. Keys:
--   auto_claim (bool)                  claims need no fresh attestation within thresholds; authority = envelope + joining words
--   attestation_above_priority (1-5)   items with priority <= N (more urgent) still need the human's words
--   max_held (int)                     holding >= N items in the team -> escalate (attestation required)
--   auto_qa_close (bool)               maker_checker only: a QA pass by the second human closes the item under the lead's rule
alter table agentchan_queues add column if not exists conditions jsonb not null default '{}'::jsonb;

-- one new message type for all swarm notices (body.event distinguishes)
alter table agentchan_messages drop constraint agentchan_messages_type_check;
alter table agentchan_messages add constraint agentchan_messages_type_check
  check (type = any (array['response'::text,'return'::text,'checks'::text,'blocked'::text,'note'::text,'human'::text,'connect'::text,'artifact'::text,'contract'::text,'grant'::text,'team'::text]));
