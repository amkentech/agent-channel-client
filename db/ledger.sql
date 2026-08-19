-- Agent Channel ledger DDL, dumped from the live database on 2026-08-19 (pg_get_functiondef / pg_get_triggerdef).
-- Reference copy so the append-only and hash-chain claims can be checked against what actually runs.

-- table agentchan_audit
--   seq bigint default nextval('agentchan_audit_seq_seq'::regclass) not null
--   id uuid default gen_random_uuid() not null
--   at timestamp with time zone default now() not null
--   actor_person uuid
--   actor_agent uuid
--   actor_handle text
--   subject_person uuid
--   subject_handle text
--   action text not null
--   object_type text
--   object_id uuid
--   payload jsonb default '{}'::jsonb not null
--   prev_hash text
--   hash text

CREATE OR REPLACE FUNCTION public.agentchan_audit_chain()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare prev text; body text;
begin
  -- serialize writers so the chain is linear
  perform pg_advisory_xact_lock(hashtext('agentchan_audit'));
  select hash into prev from agentchan_audit order by seq desc limit 1;
  new.prev_hash := prev;
  new.at := coalesce(new.at, now());
  body := coalesce(prev,'') || '|' || new.seq::text || '|' || to_char(new.at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' ||
          coalesce(new.actor_person::text,'') || '|' || coalesce(new.actor_agent::text,'') || '|' || coalesce(new.subject_person::text,'') || '|' ||
          new.action || '|' || coalesce(new.object_type,'') || '|' || coalesce(new.object_id::text,'') || '|' || new.payload::text;
  new.hash := encode(sha256(convert_to(body,'UTF8')),'hex');
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.agentchan_audit_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin raise exception 'agentchan_audit is append-only'; end $function$;

CREATE OR REPLACE FUNCTION public.agentchan_audit_verify(from_seq bigint DEFAULT 1, to_seq bigint DEFAULT NULL::bigint)
 RETURNS TABLE(ok boolean, checked bigint, first_bad bigint)
 LANGUAGE plpgsql
 STABLE
AS $function$
declare r record; prev text; body text; h text; n bigint := 0;
begin
  select hash into prev from agentchan_audit where seq < from_seq order by seq desc limit 1;
  for r in select * from agentchan_audit where seq >= from_seq and (to_seq is null or seq <= to_seq) order by seq loop
    body := coalesce(prev,'') || '|' || r.seq::text || '|' || to_char(r.at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' ||
            coalesce(r.actor_person::text,'') || '|' || coalesce(r.actor_agent::text,'') || '|' || coalesce(r.subject_person::text,'') || '|' ||
            r.action || '|' || coalesce(r.object_type,'') || '|' || coalesce(r.object_id::text,'') || '|' || r.payload::text;
    h := encode(sha256(convert_to(body,'UTF8')),'hex');
    if h <> r.hash or r.prev_hash is distinct from prev then return query select false, n, r.seq; return; end if;
    prev := r.hash; n := n + 1;
  end loop;
  return query select true, n, null::bigint;
end $function$;

CREATE OR REPLACE FUNCTION public.agentchan_housekeep()
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  update public.agentchan_proposals set status='expired', updated_at=now() where status in ('pending','countered','draft') and expires_at < now();
  delete from public.agentchan_messages m where m.expires_at < now()
    and (m.proposal_id is null or not exists (select 1 from public.agentchan_proposals p where p.id = m.proposal_id and p.status in ('draft','pending','countered','accepted','returned')));
  delete from public.agentchan_artifacts a where a.expires_at < now()
    and (a.proposal_id is null or not exists (select 1 from public.agentchan_proposals p where p.id = a.proposal_id and p.status in ('draft','pending','countered','accepted','returned')));
  delete from public.agentchan_links where expires_at < now() - interval '1 day' or (revoked_at is not null and revoked_at < now() - interval '1 day');
  delete from public.agentchan_invites where expires_at < now() and used_at is null;
  delete from public.agentchan_verifications where expires_at < now() - interval '1 day';
  delete from public.agentchan_oauth_codes where expires_at < now() - interval '1 hour';
  delete from public.agentchan_oauth_tokens where (revoked_at is not null and revoked_at < now() - interval '7 days') or (coalesce(refresh_expires_at, expires_at) < now() - interval '7 days');
$function$;

CREATE TRIGGER agentchan_audit_chain_trg BEFORE INSERT ON public.agentchan_audit FOR EACH ROW EXECUTE FUNCTION agentchan_audit_chain();
CREATE TRIGGER agentchan_audit_immutable_trg BEFORE DELETE OR UPDATE ON public.agentchan_audit FOR EACH ROW EXECUTE FUNCTION agentchan_audit_immutable();

-- grants on agentchan_audit
--   agentchan: SELECT
--   agentchan: INSERT
