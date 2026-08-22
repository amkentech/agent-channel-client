-- Plan values on agentchan_people, updated for the three tiers (2026-08-20, applied live the same day).
-- The original check allowed only free|pro; the tier build's admin endpoint writes team|org, which the old
-- constraint rejected — caught by the live test of the org flow, not by review. 'pro' stays valid for legacy
-- rows and is read as 'team' by src/plans.js.
alter table agentchan_people
  add column if not exists plan text not null default 'free';

alter table agentchan_people drop constraint if exists agentchan_people_plan_check;
alter table agentchan_people add constraint agentchan_people_plan_check
  check (plan = any (array['free','pro','team','org']));
