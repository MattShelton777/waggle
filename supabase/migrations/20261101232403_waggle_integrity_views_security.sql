-- Append-only enforcement, derived-state views, roles, and RLS (§11 DB security).

-- ------------------------------------------------------- append-only
create or replace function waggle.forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'waggle.% is append-only; % is not allowed', tg_table_name, tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['events', 'uses', 'moderation_actions', 'approval_decisions', 'api_calls', 'llm_spend', 'entity_summaries']
  loop
    execute format('create trigger %I before update or delete on waggle.%I for each row execute function waggle.forbid_mutation()', t || '_append_only', t);
    execute format('create trigger %I before truncate on waggle.%I for each statement execute function waggle.forbid_mutation()', t || '_no_truncate', t);
  end loop;
end;
$$;

-- Cited summaries (Cairn): every citation must be a real event on this entity.
create or replace function waggle.check_summary_citations() returns trigger
language plpgsql as $$
begin
  if exists (
    select 1 from unnest(new.cited_event_ids) as c(id)
    where not exists (select 1 from waggle.events e where e.id = c.id and e.entity_id = new.entity_id)
  ) then
    raise exception 'entity_summaries: every cited event must exist and belong to entity %', new.entity_id;
  end if;
  return new;
end;
$$;
create trigger entity_summaries_citations before insert on waggle.entity_summaries
  for each row execute function waggle.check_summary_citations();

-- ------------------------------------------------------ derived state
-- Follow merged_into to the surviving entity so merged evidence rolls up.
create or replace function waggle.canonical_entity_id(p_id uuid) returns uuid
language sql stable as $$
  with recursive chain(id, merged_into, depth) as (
    select id, merged_into, 0 from waggle.entities where id = p_id
    union all
    select e.id, e.merged_into, c.depth + 1
    from waggle.entities e join chain c on e.id = c.merged_into
    where c.depth < 16
  )
  select id from chain where merged_into is null limit 1;
$$;

-- Effective status: awaiting_approval resolves through the latest human decision.
create view waggle.event_status with (security_invoker = true) as
select e.id as event_id,
       case
         when e.status <> 'awaiting_approval' then e.status
         when d.decision = 'approve' then 'accepted'
         when d.decision = 'discard' then 'rejected'
         else 'awaiting_approval'
       end as status
from waggle.events e
left join lateral (
  select ad.decision from waggle.approval_decisions ad
  where ad.event_id = e.id order by ad.decided_at desc, ad.id desc limit 1
) d on true;

-- Hidden by moderation: the latest hide/unhide on the event, or a purge of its author.
create view waggle.hidden_events with (security_invoker = true) as
select e.id as event_id
from waggle.events e
where exists (
        select 1 from waggle.moderation_actions m
        where m.target_subscriber_id = e.subscriber_id and m.action = 'purge_subscriber')
   or (select m.action from waggle.moderation_actions m
       where m.target_event_id = e.id and m.action in ('hide_event', 'unhide_event')
       order by m.created_at desc, m.id desc limit 1) = 'hide_event';

-- What the scoring engine reads: accepted, not hidden, on an active canonical entity.
-- Effective weight = base_weight x the contributor's *current* reputation (computed in core).
create view waggle.scoring_events with (security_invoker = true) as
select e.id,
       c.id as entity_id,
       c.type as entity_type,
       e.entity_id as original_entity_id,
       e.kind,
       e.use_id,
       e.subscriber_id,
       e.voice_key,
       e.score::float8 as score,
       (e.weight_components ->> 'base_weight')::float8 as base_weight,
       s.reputation::float8 as reputation,
       s.is_personal_domain,
       coalesce(s.newsletter_subscribed_at, s.created_at) as tenure_start,
       e.observed_at,
       e.industry_group, e.buyer, e.acv_band, e.motion, e.region,
       e.evidence_source, e.rating, e.run_count_band, e.lift_band, e.metric_kind, e.sample_band,
       e.dimensions,
       e.failure_modes,
       e.rationale,
       e.rationale_embedding,
       e.created_at
from waggle.events e
join waggle.event_status es on es.event_id = e.id and es.status = 'accepted'
join waggle.subscribers s on s.id = e.subscriber_id
join waggle.entities c on c.id = waggle.canonical_entity_id(e.entity_id)
where c.status = 'active'
  and not exists (select 1 from waggle.hidden_events h where h.event_id = e.id);

-- Use state derived from its readouts and expiry (uses are append-only).
create view waggle.uses_state with (security_invoker = true) as
select u.*,
       en.slug as entity_slug,
       en.type as entity_type,
       coalesce(done.stages, '{}') as completed_stages,
       case
         when coalesce(done.stages, '{}') @> array(select jsonb_array_elements(u.readout_plan -> 'readouts') ->> 'stage') then 'closed'
         when now() > u.expires_at then 'expired'
         else 'open'
       end as status
from waggle.uses u
join waggle.entities en on en.id = u.entity_id
left join lateral (
  select array_agg(distinct ev.readout_stage) as stages
  from waggle.events ev
  join waggle.event_status es on es.event_id = ev.id
  where ev.use_id = u.id and es.status in ('accepted', 'awaiting_approval')
) done on true;

-- ----------------------------------------------------------- roles
-- waggle_api: the only DB identity the MCP server uses. It can execute the
-- api_* RPC functions and nothing else (no table access, no UPDATE/DELETE).
-- Admin work uses the owner/service credential, which never leaves the
-- owner's machine or the admin app.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'waggle_api') then
    create role waggle_api nologin noinherit;
  end if;
end;
$$;

revoke all on schema waggle from public;
grant usage on schema waggle to waggle_api;
grant usage on schema extensions to waggle_api;

-- Supabase's API roles get nothing in this schema.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema waggle from %I', r);
      execute format('revoke all on all tables in schema waggle from %I', r);
      execute format('revoke all on all sequences in schema waggle from %I', r);
      execute format('revoke all on all functions in schema waggle from %I', r);
    end if;
  end loop;
end;
$$;

-- ------------------------------------------------------------- RLS
-- Enabled everywhere with no policies: only the owner (used by SECURITY
-- DEFINER functions and admin) can read or write rows.
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'waggle'
  loop
    execute format('alter table waggle.%I enable row level security', t);
  end loop;
end;
$$;
