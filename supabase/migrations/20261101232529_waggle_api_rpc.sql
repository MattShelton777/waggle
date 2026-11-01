-- RPC surface for the MCP server (§11: "prefer SECURITY DEFINER RPC functions
-- that encode the allowed operations"). The waggle_api role may execute these
-- and nothing else. Validation, scrubbing, plausibility and weight are
-- computed in packages/core before calling api_submit_event; these functions
-- enforce ownership, rate limits, and the append-only shape of the log.

-- ------------------------------------------------------------ helpers
create or replace function waggle.setting_int(p_path text[], p_default int) returns int
language sql stable security definer set search_path = waggle, extensions, pg_temp as $$
  select coalesce((select (settings #>> p_path)::int from waggle.config where id = 1), p_default);
$$;

create or replace function waggle.current_rules_version() returns int
language sql stable security definer set search_path = waggle, extensions, pg_temp as $$
  select coalesce((select rules_version from waggle.config where id = 1), 1);
$$;

-- Resolve a function/subfunction slug or alias to its live node.
create or replace function waggle.resolve_taxonomy(p_function text, p_subfunction text) returns uuid
language plpgsql stable security definer set search_path = waggle, extensions, pg_temp as $$
declare
  v_fn uuid;
  v_sub uuid;
begin
  select coalesce(t.merged_into, t.id) into v_fn from waggle.taxonomy t
  where t.parent_id is null and (t.slug = p_function or p_function = any(t.aliases))
  order by (t.slug = p_function) desc limit 1;
  if v_fn is null then
    return null;
  end if;
  if p_subfunction is null then
    return v_fn;
  end if;
  select coalesce(t.merged_into, t.id) into v_sub from waggle.taxonomy t
  where t.parent_id = v_fn and t.status <> 'deprecated' and (t.slug = p_subfunction or p_subfunction = any(t.aliases))
  order by (t.slug = p_subfunction) desc limit 1;
  return v_sub;
end;
$$;

-- --------------------------------------------------------- read: rules
create or replace function waggle.api_get_rules() returns jsonb
language sql stable security definer set search_path = waggle, extensions, pg_temp as $$
  select jsonb_build_object(
    'rules_version', c.rules_version,
    'rules_text', c.rules_text,
    'taxonomy', coalesce((
      select jsonb_agg(jsonb_build_object(
               'slug', f.slug, 'name', f.name, 'description', f.description, 'aliases', f.aliases,
               'subfunctions', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'slug', s.slug, 'name', s.name, 'description', s.description,
                          'aliases', s.aliases, 'status', s.status) order by s.slug)
                 from waggle.taxonomy s
                 where s.parent_id = f.id and s.status <> 'deprecated' and s.merged_into is null), '[]'::jsonb))
             order by f.slug)
      from waggle.taxonomy f
      where f.parent_id is null and f.status <> 'deprecated' and f.merged_into is null), '[]'::jsonb))
  from waggle.config c where c.id = 1;
$$;

-- Server-only settings (includes the denylist; never sent to agents).
create or replace function waggle.api_get_server_config() returns jsonb
language sql stable security definer set search_path = waggle, extensions, pg_temp as $$
  select jsonb_build_object('settings', settings, 'denylist', to_jsonb(denylist), 'rules_version', rules_version)
  from waggle.config where id = 1;
$$;

-- ---------------------------------------------------- subscribers / auth
-- Called by the OAuth layer after a magic link proves the email and the
-- newsletter API confirms an active subscription.
create or replace function waggle.api_ensure_subscriber(
  p_auth_user_id uuid,
  p_email text,
  p_is_personal_domain boolean,
  p_newsletter_subscribed_at timestamptz default null
) returns uuid
language plpgsql security definer set search_path = waggle, extensions, pg_temp as $$
declare
  v_email text := lower(trim(p_email));
  v_id uuid;
begin
  insert into waggle.subscribers (auth_user_id, email, email_domain, is_personal_domain, reputation,
                                  connected_at, newsletter_status, newsletter_subscribed_at)
  values (p_auth_user_id, v_email, split_part(v_email, '@', 2), p_is_personal_domain,
          case when p_is_personal_domain then 0.7 else 1.0 end, now(), 'active', p_newsletter_subscribed_at)
  on conflict (email) do update
    set auth_user_id = coalesce(waggle.subscribers.auth_user_id, excluded.auth_user_id),
        connected_at = coalesce(waggle.subscribers.connected_at, now()),
        newsletter_status = 'active',
        newsletter_subscribed_at = coalesce(excluded.newsletter_subscribed_at, waggle.subscribers.newsletter_subscribed_at)
  returning id into v_id;
  return v_id;
end;
$$;

-- Map a verified Supabase Auth user (from the OAuth access token) to a subscriber.
create or replace function waggle.api_subscriber_for_auth_user(p_auth_user_id uuid) returns uuid
language sql stable security definer set search_path = waggle, extensions, pg_temp as $$
  select id from waggle.subscribers where auth_user_id = p_auth_user_id;
$$;

create or replace function waggle.api_get_subscriber(p_subscriber_id uuid) returns jsonb
language sql stable security definer set search_path = waggle, extensions, pg_temp as $$
  select jsonb_build_object(
    'id', s.id,
    'email_domain', s.email_domain,
    'is_personal_domain', s.is_personal_domain,
    'newsletter_status', s.newsletter_status,
    'created_at', s.created_at,
    'tenure_start', coalesce(s.newsletter_subscribed_at, s.created_at),
    'connected_at', s.connected_at,
    'reputation', s.reputation,
    'policy', s.policy,
    'banned', s.banned_at is not null,
    'rules_version_seen', s.rules_version_seen,
    'last_accepted_contribution_at', (
      select max(e.created_at) from waggle.events e
      join waggle.event_status es on es.event_id = e.id and es.status = 'accepted'
      where e.subscriber_id = s.id),
    'events_last_24h', (select count(*) from waggle.events e where e.subscriber_id = s.id and e.created_at > now() - interval '24 hours'),
    'entities_proposed_last_24h', (select count(*) from waggle.entities en where en.proposed_by = s.id and en.created_at > now() - interval '24 hours')
  )
  from waggle.subscribers s where s.id = p_subscriber_id;
$$;

create or replace function waggle.api_touch_subscriber(p_subscriber_id uuid, p_rules_version_seen int) returns void
language sql security definer set search_path = waggle, extensions, pg_temp as $$
  update waggle.subscribers
  set last_seen_at = now(),
      rules_version_seen = greatest(coalesce(rules_version_seen, 0), coalesce(p_rules_version_seen, 0))
  where id = p_subscriber_id;
$$;

create or replace function waggle.api_set_policy(p_subscriber_id uuid, p_policy text) returns void
language sql security definer set search_path = waggle, extensions, pg_temp as $$
  update waggle.subscribers set policy = p_policy where id = p_subscriber_id;
$$;

-- ------------------------------------------------------- read: entities
create or replace function waggle.entity_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = waggle, extensions, pg_temp as $$
  select jsonb_build_object(
    'id', e.id, 'type', e.type, 'slug', e.slug, 'name', e.name, 'description', e.description,
    'status', e.status, 'attributes', e.attributes,
    'taxonomy', coalesce((
      select jsonb_agg(jsonb_build_object(
               'function', coalesce(p.slug, t.slug),
               'subfunction', case when t.parent_id is null then null else t.slug end,
               'status', t.status, 'primary', et.is_primary) order by et.is_primary desc)
      from waggle.entity_taxonomy et
      join waggle.taxonomy t on t.id = et.taxonomy_id
      left join waggle.taxonomy p on p.id = t.parent_id
      where et.entity_id = e.id), '[]'::jsonb),
    'tags', coalesce((select jsonb_agg(distinct tg.tag) from waggle.entity_tags tg where tg.entity_id = e.id), '[]'::jsonb))
  from waggle.entities e where e.id = p_id;
$$;

-- Resolve by id or slug, following merges. Returns null if not found or hidden.
create or replace function waggle.api_resolve_entity(p_entity_id uuid, p_slug text) returns jsonb
language plpgsql stable security definer set search_path = waggle, extensions, pg_temp as $$
declare
  v_id uuid;
begin
  select id into v_id from waggle.entities
  where (p_entity_id is not null and id = p_entity_id) or (p_entity_id is null and slug = p_slug);
  if v_id is null then
    return null;
  end if;
  v_id := waggle.canonical_entity_id(v_id);
  if (select status from waggle.entities where id = v_id) = 'hidden' then
    return null;
  end if;
  return waggle.entity_json(v_id);
end;
$$;

-- Alias-aware, fuzzy search across names, slugs, descriptions, tags,
-- taxonomy names/aliases, and (optionally) embeddings (§3.5.6).
create or replace function waggle.api_search_entities(
  p_query text default null,
  p_type text default null,
  p_function text default null,
  p_subfunction text default null,
  p_tags text[] default null,
  p_embedding extensions.vector(384) default null,
  p_include_pending boolean default false,
  p_limit int default 10
) returns table (entity_id uuid, type text, slug text, name text, description text, status text, match_score float8)
language sql stable security definer set search_path = waggle, extensions, pg_temp as $$
  with fn as (
    select t.id from waggle.taxonomy t
    where p_function is not null and t.parent_id is null
      and (t.slug = p_function or p_function = any(t.aliases))
  ),
  nodes as (
    -- Nodes matching the function/subfunction filter, including merged-away aliases.
    select t.id from waggle.taxonomy t
    where (p_subfunction is null and (t.id in (select id from fn) or t.parent_id in (select id from fn)))
       or (p_subfunction is not null and t.parent_id in (select id from fn)
           and (t.slug = p_subfunction or p_subfunction = any(t.aliases)))
    union
    select t.id from waggle.taxonomy t where t.merged_into in (
      select t2.id from waggle.taxonomy t2
      where (p_subfunction is null and t2.id in (select id from fn))
         or (p_subfunction is not null and t2.parent_id in (select id from fn)
             and (t2.slug = p_subfunction or p_subfunction = any(t2.aliases))))
  ),
  candidates as (
    select e.*,
      case when p_query is null then 0 else greatest(
        similarity(e.name, p_query),
        similarity(e.slug, replace(lower(p_query), ' ', '-')),
        word_similarity(p_query, e.description),
        coalesce((select max(similarity(tg.tag, replace(lower(p_query), ' ', '-'))) from waggle.entity_tags tg where tg.entity_id = e.id), 0),
        coalesce((select max(greatest(word_similarity(p_query, t.name), similarity(array_to_string(t.aliases, ' '), p_query)))
                  from waggle.entity_taxonomy et join waggle.taxonomy t on t.id = et.taxonomy_id
                  where et.entity_id = e.id), 0)
      ) end::float8 as text_score,
      case when p_embedding is null or e.embedding is null then 0
           else 1 - (e.embedding <=> p_embedding) end::float8 as vec_score
    from waggle.entities e
    where (e.status = 'active' or (p_include_pending and e.status = 'pending'))
      and (p_type is null or e.type = p_type)
      and (p_function is null or exists (
             select 1 from waggle.entity_taxonomy et where et.entity_id = e.id and et.taxonomy_id in (select id from nodes)))
      and (p_tags is null or exists (
             select 1 from waggle.entity_tags tg where tg.entity_id = e.id and tg.tag = any(p_tags)))
  )
  select c.id, c.type, c.slug, c.name, c.description, c.status, greatest(c.text_score, c.vec_score)
  from candidates c
  where (p_query is null and p_embedding is null) or c.text_score >= 0.15 or c.vec_score >= 0.5
  order by greatest(c.text_score, c.vec_score) desc, c.name
  limit least(greatest(coalesce(p_limit, 10), 1), 50);
$$;

-- Accepted, visible evidence for scoring in core (compute-on-read, §4.3).
create or replace function waggle.api_get_scoring_events(p_entity_ids uuid[])
returns table (
  id uuid, entity_id uuid, entity_type text, kind text, use_id uuid, subscriber_id uuid, voice_key text,
  score float8, base_weight float8, reputation float8, is_personal_domain boolean, tenure_start timestamptz,
  observed_at timestamptz,
  industry_group text, buyer text, acv_band text, motion text, region text,
  evidence_source text, rating text, run_count_band text, lift_band text, metric_kind text, sample_band text,
  dimensions jsonb, failure_modes text[], rationale text, created_at timestamptz
)
language sql stable security definer set search_path = waggle, extensions, pg_temp as $$
  select se.id, se.entity_id, se.entity_type, se.kind, se.use_id, se.subscriber_id, se.voice_key,
         se.score, se.base_weight, se.reputation, se.is_personal_domain, se.tenure_start, se.observed_at,
         se.industry_group, se.buyer, se.acv_band, se.motion, se.region,
         se.evidence_source, se.rating, se.run_count_band, se.lift_band, se.metric_kind, se.sample_band,
         se.dimensions, se.failure_modes, se.rationale, se.created_at
  from waggle.scoring_events se
  where se.entity_id = any(p_entity_ids);
$$;

-- Cairn's discover route: match the task against rationales, group in core.
create or replace function waggle.api_discover(
  p_embedding extensions.vector(384) default null,
  p_query text default null,
  p_type text default null,
  p_limit int default 50
) returns table (event_id uuid, entity_id uuid, rationale text, similarity float8)
language sql stable security definer set search_path = waggle, extensions, pg_temp as $$
  select se.id, se.entity_id, se.rationale,
         case when p_embedding is not null and se.rationale_embedding is not null
              then 1 - (se.rationale_embedding <=> p_embedding)
              else word_similarity(coalesce(p_query, ''), se.rationale) end::float8 as sim
  from waggle.scoring_events se
  where (p_type is null or se.entity_type = p_type)
    and (p_embedding is not null or p_query is not null)
  order by sim desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

create or replace function waggle.api_get_summary(p_entity_id uuid) returns jsonb
language sql stable security definer set search_path = waggle, extensions, pg_temp as $$
  select jsonb_build_object('summary', s.summary, 'cited_event_ids', to_jsonb(s.cited_event_ids), 'created_at', s.created_at)
  from waggle.entity_summaries s where s.entity_id = p_entity_id
  order by s.created_at desc limit 1;
$$;

create or replace function waggle.api_search_playbooks(
  p_embedding extensions.vector(384) default null,
  p_query text default null,
  p_limit int default 5
) returns table (playbook_id uuid, title text, url text, published_at timestamptz, content text, similarity float8)
language sql stable security definer set search_path = waggle, extensions, pg_temp as $$
  select p.id, p.title, p.url, p.published_at, c.content,
         case when p_embedding is not null and c.embedding is not null
              then 1 - (c.embedding <=> p_embedding)
              else word_similarity(coalesce(p_query, ''), c.content) end::float8 as sim
  from waggle.playbook_chunks c join waggle.playbooks p on p.id = c.playbook_id
  where p_embedding is not null or p_query is not null
  order by sim desc
  limit least(greatest(coalesce(p_limit, 5), 1), 20);
$$;

-- ------------------------------------------------------------- uses
create or replace function waggle.api_insert_use(
  p_subscriber_id uuid,
  p_entity_id uuid,
  p_context jsonb,
  p_test_design text,
  p_applied_at timestamptz,
  p_readout_plan jsonb,
  p_expires_at timestamptz
) returns uuid
language plpgsql security definer set search_path = waggle, extensions, pg_temp as $$
declare
  v_id uuid;
begin
  if exists (select 1 from waggle.subscribers where id = p_subscriber_id and banned_at is not null) then
    raise exception 'subscriber is banned' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from waggle.entities where id = p_entity_id and status = 'active') then
    raise exception 'entity % is not active', p_entity_id using errcode = 'no_data_found';
  end if;
  if (select count(*) from waggle.uses where subscriber_id = p_subscriber_id and created_at > now() - interval '24 hours')
     >= waggle.setting_int(array['limits', 'eventsPerDay'], 20) then
    raise exception 'rate_limited: daily use limit reached' using errcode = 'P0001';
  end if;
  insert into waggle.uses (entity_id, subscriber_id, industry_group, buyer, acv_band, motion, region,
                           test_design, applied_at, readout_plan, expires_at)
  values (p_entity_id, p_subscriber_id, p_context ->> 'industry_group', p_context ->> 'buyer', p_context ->> 'acv_band',
          p_context ->> 'motion', p_context ->> 'region', p_test_design, p_applied_at, p_readout_plan, p_expires_at)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function waggle.api_get_use(p_use_id uuid, p_subscriber_id uuid) returns jsonb
language sql stable security definer set search_path = waggle, extensions, pg_temp as $$
  select to_jsonb(u) - 'subscriber_id' from waggle.uses_state u
  where u.id = p_use_id and u.subscriber_id = p_subscriber_id;
$$;

create or replace function waggle.api_open_uses(p_subscriber_id uuid) returns setof jsonb
language sql stable security definer set search_path = waggle, extensions, pg_temp as $$
  select to_jsonb(u) - 'subscriber_id' from waggle.uses_state u
  where u.subscriber_id = p_subscriber_id and u.status = 'open'
  order by u.applied_at;
$$;

-- ------------------------------------------------------------ writes
-- Insert one evidence event (and, optionally, a proposed entity, tags, and a
-- proposed subfunction) in one transaction. The caller has already run
-- validation, scrubbing, plausibility, weight, and policy in packages/core.
--
-- p_event keys: id (optional; the server generates it for approval tokens), kind, entity_id (observations on existing entities), use_id,
--   readout_stage, industry_group, buyer, acv_band, motion, region, score,
--   weight, weight_components, evidence_source, rating, run_count_band,
--   lift_band, metric_kind, sample_band, dimensions, failure_modes, rationale,
--   rationale_embedding (text '[...]'), observed_at, status, screen_results.
-- p_new_entity keys: type, slug, name, description, primary_function,
--   primary_subfunction, secondary_subfunctions[], attributes, embedding.
-- p_proposed_node keys: parent_function, slug, name, description.
create or replace function waggle.api_submit_event(
  p_subscriber_id uuid,
  p_event jsonb,
  p_new_entity jsonb default null,
  p_tags text[] default null,
  p_proposed_node jsonb default null,
  p_approval_token_hash text default null
) returns jsonb
language plpgsql security definer set search_path = waggle, extensions, pg_temp as $$
declare
  v_sub waggle.subscribers%rowtype;
  v_use waggle.uses%rowtype;
  v_entity_id uuid;
  v_entity_status text;
  v_node_id uuid;
  v_parent_id uuid;
  v_event_id uuid;
  v_status text := p_event ->> 'status';
  v_kind text := p_event ->> 'kind';
  v_sub_slug text;
begin
  select * into v_sub from waggle.subscribers where id = p_subscriber_id for update;
  if not found then
    raise exception 'unknown subscriber' using errcode = 'no_data_found';
  end if;
  if v_sub.banned_at is not null then
    raise exception 'subscriber is banned' using errcode = 'insufficient_privilege';
  end if;
  if v_status not in ('accepted', 'awaiting_approval', 'quarantined', 'rejected') then
    raise exception 'invalid status %', v_status;
  end if;

  if (select count(*) from waggle.events where subscriber_id = p_subscriber_id and created_at > now() - interval '24 hours')
     >= waggle.setting_int(array['limits', 'eventsPerDay'], 20) then
    raise exception 'rate_limited: daily contribution limit reached' using errcode = 'P0001';
  end if;

  -- Resolve the entity.
  if v_kind = 'readout' then
    select * into v_use from waggle.uses where id = (p_event ->> 'use_id')::uuid and subscriber_id = p_subscriber_id;
    if not found then
      raise exception 'use not found for this subscriber' using errcode = 'no_data_found';
    end if;
    v_entity_id := v_use.entity_id;
  elsif p_new_entity is not null then
    if (select count(*) from waggle.entities where proposed_by = p_subscriber_id and created_at > now() - interval '24 hours')
       >= waggle.setting_int(array['limits', 'newEntitiesPerDay'], 5) then
      raise exception 'rate_limited: daily new-entity limit reached' using errcode = 'P0001';
    end if;

    insert into waggle.entities (type, slug, name, description, attributes, status, proposed_by, embedding)
    values (p_new_entity ->> 'type', p_new_entity ->> 'slug', p_new_entity ->> 'name', p_new_entity ->> 'description',
            coalesce(p_new_entity -> 'attributes', '{}'::jsonb), 'pending', p_subscriber_id,
            (p_new_entity ->> 'embedding')::extensions.vector(384))
    returning id into v_entity_id;

    -- Primary taxonomy: a proposed subfunction, else the named (sub)function.
    if p_proposed_node is not null then
      v_parent_id := waggle.resolve_taxonomy(p_proposed_node ->> 'parent_function', null);
      if v_parent_id is null then
        raise exception 'unknown parent function %', p_proposed_node ->> 'parent_function' using errcode = 'no_data_found';
      end if;
      select id into v_node_id from waggle.taxonomy where parent_id = v_parent_id and slug = p_proposed_node ->> 'slug';
      if v_node_id is null then
        insert into waggle.taxonomy (parent_id, slug, name, description, status, proposed_by)
        values (v_parent_id, p_proposed_node ->> 'slug', p_proposed_node ->> 'name',
                coalesce(p_proposed_node ->> 'description', ''), 'proposed', p_subscriber_id)
        returning id into v_node_id;
      end if;
    else
      v_node_id := waggle.resolve_taxonomy(p_new_entity ->> 'primary_function', p_new_entity ->> 'primary_subfunction');
      if v_node_id is null then
        raise exception 'unknown taxonomy %/%', p_new_entity ->> 'primary_function', p_new_entity ->> 'primary_subfunction'
          using errcode = 'no_data_found';
      end if;
    end if;
    insert into waggle.entity_taxonomy (entity_id, taxonomy_id, is_primary) values (v_entity_id, v_node_id, true);

    for v_sub_slug in select jsonb_array_elements_text(coalesce(p_new_entity -> 'secondary_subfunctions', '[]'::jsonb))
    loop
      v_node_id := waggle.resolve_taxonomy(p_new_entity ->> 'primary_function', v_sub_slug);
      if v_node_id is not null then
        insert into waggle.entity_taxonomy (entity_id, taxonomy_id, is_primary) values (v_entity_id, v_node_id, false)
        on conflict do nothing;
      end if;
    end loop;
  else
    v_entity_id := waggle.canonical_entity_id((p_event ->> 'entity_id')::uuid);
    select status into v_entity_status from waggle.entities where id = v_entity_id;
    if v_entity_status is distinct from 'active' then
      raise exception 'entity is not active' using errcode = 'no_data_found';
    end if;
  end if;

  insert into waggle.events (
    id, kind, entity_id, subscriber_id, use_id, readout_stage,
    industry_group, buyer, acv_band, motion, region,
    score, weight, weight_components, evidence_source,
    rating, run_count_band, lift_band, metric_kind, sample_band,
    dimensions, failure_modes, rationale, rationale_embedding,
    voice_key, observed_at, status, screen_results, rules_version)
  values (
    coalesce((p_event ->> 'id')::uuid, gen_random_uuid()), v_kind, v_entity_id, p_subscriber_id, v_use.id, p_event ->> 'readout_stage',
    case when v_kind = 'readout' then v_use.industry_group else p_event ->> 'industry_group' end,
    case when v_kind = 'readout' then v_use.buyer else p_event ->> 'buyer' end,
    case when v_kind = 'readout' then v_use.acv_band else p_event ->> 'acv_band' end,
    case when v_kind = 'readout' then v_use.motion else p_event ->> 'motion' end,
    case when v_kind = 'readout' then v_use.region else p_event ->> 'region' end,
    (p_event ->> 'score')::numeric, (p_event ->> 'weight')::numeric, p_event -> 'weight_components',
    p_event ->> 'evidence_source',
    p_event ->> 'rating', p_event ->> 'run_count_band', p_event ->> 'lift_band',
    p_event ->> 'metric_kind', p_event ->> 'sample_band',
    coalesce(p_event -> 'dimensions', '{}'::jsonb),
    coalesce(array(select jsonb_array_elements_text(p_event -> 'failure_modes')), '{}'),
    p_event ->> 'rationale',
    (p_event ->> 'rationale_embedding')::extensions.vector(384),
    case when v_sub.is_personal_domain then 'acct:' || v_sub.id::text else 'domain:' || v_sub.email_domain end,
    (p_event ->> 'observed_at')::timestamptz,
    v_status,
    coalesce(p_event -> 'screen_results', '{}'::jsonb),
    waggle.current_rules_version())
  returning id into v_event_id;

  if p_tags is not null then
    insert into waggle.entity_tags (entity_id, tag, subscriber_id)
    select v_entity_id, t, p_subscriber_id from unnest(p_tags) as t;
  end if;

  if v_status = 'awaiting_approval' then
    if p_approval_token_hash is null then
      raise exception 'awaiting_approval events need an approval token hash';
    end if;
    insert into waggle.approvals (event_id, subscriber_id, token_hash, expires_at)
    values (v_event_id, p_subscriber_id, p_approval_token_hash, now() + interval '14 days');
  end if;

  if v_status = 'accepted' then
    update waggle.subscribers set last_contributed_at = now() where id = p_subscriber_id;
    if p_new_entity is not null then
      update waggle.entities set status = 'active', activated_at = now() where id = v_entity_id;
    end if;
  end if;

  return jsonb_build_object('event_id', v_event_id, 'entity_id', v_entity_id, 'status', v_status);
end;
$$;

-- One-click approve/discard from the approval email (§6.4).
create or replace function waggle.api_decide_approval(p_token_hash text, p_decision text) returns jsonb
language plpgsql security definer set search_path = waggle, extensions, pg_temp as $$
declare
  v_appr waggle.approvals%rowtype;
  v_event waggle.events%rowtype;
begin
  if p_decision not in ('approve', 'discard') then
    raise exception 'invalid decision';
  end if;
  select * into v_appr from waggle.approvals where token_hash = p_token_hash;
  if not found or v_appr.expires_at < now() then
    raise exception 'approval link is invalid or expired' using errcode = 'no_data_found';
  end if;
  if exists (select 1 from waggle.approval_decisions where event_id = v_appr.event_id) then
    return jsonb_build_object('event_id', v_appr.event_id, 'status', 'already_decided');
  end if;

  insert into waggle.approval_decisions (event_id, decision) values (v_appr.event_id, p_decision);
  select * into v_event from waggle.events where id = v_appr.event_id;

  if p_decision = 'approve' then
    update waggle.subscribers set last_contributed_at = now() where id = v_event.subscriber_id;
    update waggle.entities set status = 'active', activated_at = now()
    where id = v_event.entity_id and status = 'pending' and proposed_by = v_event.subscriber_id;
  end if;
  return jsonb_build_object('event_id', v_appr.event_id, 'status', case when p_decision = 'approve' then 'accepted' else 'rejected' end);
end;
$$;

create or replace function waggle.api_log_call(
  p_subscriber_id uuid, p_tool text, p_latency_ms int, p_result_count int, p_ok boolean
) returns void
language sql security definer set search_path = waggle, extensions, pg_temp as $$
  insert into waggle.api_calls (subscriber_id, tool, latency_ms, result_count, ok)
  values (p_subscriber_id, p_tool, p_latency_ms, p_result_count, p_ok);
$$;

-- --------------------------------------------------------- privileges
-- Postgres grants EXECUTE on new functions to PUBLIC by default. Undo that
-- for the whole schema, then grant only the api_* surface to waggle_api.
revoke execute on all functions in schema waggle from public;
alter default privileges in schema waggle revoke execute on functions from public;

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'waggle' and p.proname like 'api\_%'
  loop
    execute format('grant execute on function %s to waggle_api', f.sig);
  end loop;
end;
$$;

-- Supabase's API roles get nothing in this schema, now or for objects created later.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema waggle from %I', r);
      execute format('revoke all on all sequences in schema waggle from %I', r);
      execute format('revoke all on all functions in schema waggle from %I', r);
      execute format('alter default privileges in schema waggle revoke all on tables from %I', r);
      execute format('alter default privileges in schema waggle revoke all on functions from %I', r);
      execute format('alter default privileges in schema waggle revoke all on sequences from %I', r);
    end if;
  end loop;
end;
$$;
