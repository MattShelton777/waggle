-- Blueprints (docs/blueprints.md): structured how-to for tools and workflows.
-- Append-only revisions; the current blueprint is the newest accepted version.
-- v1 blueprints are curated by migration. Agent contributions come later and
-- land as 'pending'.

create table waggle.blueprints (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references waggle.entities (id),
  version        int not null check (version >= 1),
  body           jsonb not null check (jsonb_typeof(body) = 'object'),
  origin         text not null default 'curated' check (origin in ('curated', 'contributed')),
  status         text not null default 'accepted' check (status in ('accepted', 'pending', 'rejected')),
  contributed_by uuid references waggle.subscribers (id),
  created_at     timestamptz not null default now(),
  unique (entity_id, version)
);
create index blueprints_entity_idx on waggle.blueprints (entity_id, version desc);

create trigger blueprints_append_only before update or delete on waggle.blueprints
  for each row execute function waggle.forbid_mutation();
create trigger blueprints_no_truncate before truncate on waggle.blueprints
  for each statement execute function waggle.forbid_mutation();
alter table waggle.blueprints enable row level security;

create view waggle.current_blueprints with (security_invoker = true) as
  select distinct on (b.entity_id) b.entity_id, b.version, b.body, b.created_at
  from waggle.blueprints b
  join waggle.entities e on e.id = b.entity_id
  where b.status = 'accepted' and e.type in ('tool', 'workflow')
  order by b.entity_id, b.version desc;

-- The current blueprint for an entity (following merges), or null.
create function waggle.api_get_blueprint(p_entity_id uuid) returns jsonb
language sql stable security definer set search_path = waggle, extensions, pg_temp as $$
  select jsonb_build_object('version', cb.version, 'updated_at', cb.created_at, 'body', cb.body)
  from waggle.current_blueprints cb
  where cb.entity_id = waggle.canonical_entity_id(p_entity_id);
$$;

-- Entities that have a current blueprint, so search results can flag them.
create function waggle.api_blueprint_entity_ids() returns uuid[]
language sql stable security definer set search_path = waggle, extensions, pg_temp as $$
  select coalesce(array_agg(entity_id), '{}') from waggle.current_blueprints;
$$;

revoke execute on function waggle.api_get_blueprint(uuid) from public;
revoke execute on function waggle.api_blueprint_entity_ids() from public;
grant execute on function waggle.api_get_blueprint(uuid) to waggle_api;
grant execute on function waggle.api_blueprint_entity_ids() to waggle_api;

-- Rules v2: blueprints relax three content rules, inside blueprints only.
update waggle.config
set rules_version = 2,
    rules_text = rules_text || $rules$
Blueprints
- Tools and workflows can carry a blueprint: setup, steps with settings,
  thresholds, pitfalls, cost and time bands, a quality bar, and links to the
  vendor's official docs. Read it with waggle_inspect.
- Inside a blueprint only: configuration numbers (settings, thresholds, limits)
  are allowed; links are allowed only to the tool vendor's own documentation;
  the tool vendor may be named. Outcome numbers, money amounts, and customer,
  client or company names are still never allowed.
- Every blueprint line says where it came from: first_hand, docs, or inferred.
  Re-check anything listed in verify_live against the linked docs before
  relying on it.
$rules$,
    updated_at = now()
where id = 1;
