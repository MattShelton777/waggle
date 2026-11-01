-- Waggle core schema (plan §11).
-- Enum CHECK lists mirror packages/core/src/enums.ts; keep them in sync.
-- Embedding dimension 384 matches Supabase's built-in gte-small model
-- (verify before relying on it; change all vector(384) columns together).

create schema if not exists extensions;
create extension if not exists vector with schema extensions;
create extension if not exists pg_trgm with schema extensions;

create schema if not exists waggle;

-- ---------------------------------------------------------------- config
-- Single row. `settings` holds DeepPartial<WaggleConfig> overrides.
create table waggle.config (
  id            int primary key default 1 check (id = 1),
  settings      jsonb not null default '{}'::jsonb,
  rules_version int not null default 1,
  rules_text    text not null default '',
  denylist      text[] not null default '{}',
  updated_at    timestamptz not null default now()
);

-- ----------------------------------------------------------- subscribers
create table waggle.subscribers (
  id                  uuid primary key default gen_random_uuid(),
  -- Supabase Auth user (auth.users.id) that signs in via magic link. No FK so
  -- the schema also runs outside Supabase (tests); the API keeps them in step.
  auth_user_id        uuid unique,
  email               text not null unique check (email = lower(email) and position('@' in email) > 1),
  email_domain        text not null check (email_domain = lower(email_domain)),
  is_personal_domain  boolean not null default false,
  newsletter_status   text not null default 'active'
                      check (newsletter_status in ('active', 'inactive', 'unsubscribed', 'unknown')),
  -- When they joined the newsletter (from the newsletter API). Tenure for
  -- probation/anchoring counts from here, so long-time readers on personal
  -- mailboxes are established the day they connect.
  newsletter_subscribed_at timestamptz,
  created_at          timestamptz not null default now(),
  connected_at        timestamptz,
  last_seen_at        timestamptz,
  last_contributed_at timestamptz,
  reputation          numeric(4,3) not null default 1.0 check (reputation between 0.3 and 1.5),
  policy              text not null default 'auto_low_risk'
                      check (policy in ('ask_always', 'auto_low_risk', 'auto_all')),
  banned_at           timestamptz,
  rules_version_seen  int
);
create index subscribers_domain_idx on waggle.subscribers (email_domain);

-- -------------------------------------------------------------- taxonomy
-- Two levels: function (parent_id null) -> subfunction. Data, not code (§3.5).
create table waggle.taxonomy (
  id          uuid primary key default gen_random_uuid(),
  parent_id   uuid references waggle.taxonomy (id),
  slug        text not null check (slug ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  name        text not null,
  description text not null default '',
  aliases     text[] not null default '{}',
  status      text not null default 'active' check (status in ('active', 'proposed', 'deprecated')),
  merged_into uuid references waggle.taxonomy (id),
  proposed_by uuid references waggle.subscribers (id),
  created_at  timestamptz not null default now(),
  promoted_at timestamptz
);
create unique index taxonomy_function_slug_uq on waggle.taxonomy (slug) where parent_id is null;
create unique index taxonomy_subfunction_slug_uq on waggle.taxonomy (parent_id, slug) where parent_id is not null;
create index taxonomy_name_trgm on waggle.taxonomy using gin (name extensions.gin_trgm_ops);

-- -------------------------------------------------------------- entities
create table waggle.entities (
  id           uuid primary key default gen_random_uuid(),
  type         text not null check (type in ('tool', 'workflow', 'tactic')),
  slug         text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name         text not null check (char_length(name) between 2 and 80),
  description  text not null check (char_length(description) <= 400),
  attributes   jsonb not null default '{}'::jsonb,
  status       text not null default 'pending' check (status in ('pending', 'active', 'merged', 'hidden')),
  merged_into  uuid references waggle.entities (id),
  embedding    extensions.vector(384),
  proposed_by  uuid references waggle.subscribers (id),
  created_at   timestamptz not null default now(),
  activated_at timestamptz,
  check ((status = 'merged') = (merged_into is not null)),
  check (merged_into is distinct from id)
);
create index entities_type_status_idx on waggle.entities (type, status);
create index entities_name_trgm on waggle.entities using gin (name extensions.gin_trgm_ops);
create index entities_slug_trgm on waggle.entities using gin (slug extensions.gin_trgm_ops);

create table waggle.entity_taxonomy (
  entity_id   uuid not null references waggle.entities (id),
  taxonomy_id uuid not null references waggle.taxonomy (id),
  is_primary  boolean not null default false,
  primary key (entity_id, taxonomy_id)
);
create unique index entity_taxonomy_one_primary on waggle.entity_taxonomy (entity_id) where is_primary;

create table waggle.entity_tags (
  id            bigint generated always as identity primary key,
  entity_id     uuid not null references waggle.entities (id),
  tag           text not null check (tag ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(tag) <= 32),
  subscriber_id uuid references waggle.subscribers (id),
  created_at    timestamptz not null default now()
);
create index entity_tags_tag_idx on waggle.entity_tags (tag);
create index entity_tags_entity_idx on waggle.entity_tags (entity_id);

-- ------------------------------------------------------------------ uses
-- Append-only. Open/closed/expired is derived in waggle.uses_state.
create table waggle.uses (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references waggle.entities (id),
  subscriber_id  uuid not null references waggle.subscribers (id),
  industry_group text check (industry_group in ('b2b_saas','home_services_trades','ecommerce','agency','fintech','healthcare','professional_services','other')),
  buyer          text check (buyer in ('smb','mid_market','enterprise','consumer')),
  acv_band       text check (acv_band in ('lt_1k','1k_5k','5k_25k','25k_100k','gt_100k','na')),
  motion         text check (motion in ('plg','sales_led','hybrid','na')),
  region         text check (region in ('na','emea','apac','latam','global')),
  test_design    text check (test_design in ('ab_test', 'before_after', 'no_control')),
  applied_at     timestamptz not null,
  readout_plan   jsonb not null,
  expires_at     timestamptz not null,
  created_at     timestamptz not null default now()
);
create index uses_subscriber_idx on waggle.uses (subscriber_id, created_at desc);

-- ---------------------------------------------------------------- events
-- The append-only evidence log (§3.3). Every score derives from this table.
create table waggle.events (
  id                  uuid primary key default gen_random_uuid(),
  kind                text not null check (kind in ('observation', 'readout')),
  entity_id           uuid not null references waggle.entities (id),
  subscriber_id       uuid not null references waggle.subscribers (id),
  use_id              uuid references waggle.uses (id),
  readout_stage       text check (readout_stage in ('single', 'leading', 'lagging')),
  industry_group      text check (industry_group in ('b2b_saas','home_services_trades','ecommerce','agency','fintech','healthcare','professional_services','other')),
  buyer               text check (buyer in ('smb','mid_market','enterprise','consumer')),
  acv_band            text check (acv_band in ('lt_1k','1k_5k','5k_25k','25k_100k','gt_100k','na')),
  motion              text check (motion in ('plg','sales_led','hybrid','na')),
  region              text check (region in ('na','emea','apac','latam','global')),
  score               numeric(4,3) not null check (score between 0 and 1),
  weight              numeric(6,5) not null check (weight > 0 and weight <= 1),
  weight_components   jsonb not null check (weight_components ? 'base_weight'),
  evidence_source     text not null check (evidence_source in ('platform_read', 'self_reported', 'inspection_only')),
  rating              text check (rating in ('flawless','good','usable','mostly_unhelpful','failed','harmful')),
  run_count_band      text check (run_count_band in ('1', '2_10', 'gt_10')),
  lift_band           text check (lift_band in ('loss_large','loss_moderate','loss_small','no_difference','win_small','win_moderate','win_large')),
  metric_kind         text check (metric_kind in ('leading', 'lagging')),
  sample_band         text check (sample_band in ('lt_100', '100_1k', '1k_5k', 'gt_5k')),
  dimensions          jsonb not null default '{}'::jsonb check (jsonb_typeof(dimensions) = 'object'),
  failure_modes       text[] not null default '{}' check (failure_modes <@ array[
                        'low_coverage','stale_data','bounced','wrong_person','rate_limited','schema_drift',
                        'timeout','expensive','injection_attempt','no_effect','negative_effect','other']::text[]),
  rationale           text not null check (char_length(rationale) <= 600),
  rationale_embedding extensions.vector(384),
  voice_key           text not null,
  observed_at         timestamptz not null,
  created_at          timestamptz not null default now(),
  status              text not null check (status in ('accepted', 'awaiting_approval', 'quarantined', 'rejected')),
  screen_results      jsonb not null default '{}'::jsonb,
  rules_version       int not null,
  check ((kind = 'readout') = (use_id is not null)),
  check ((kind = 'readout') = (readout_stage is not null)),
  check (rating is null or lift_band is null)
);
create index events_entity_idx on waggle.events (entity_id, observed_at desc);
create index events_subscriber_idx on waggle.events (subscriber_id, created_at desc);
create index events_use_idx on waggle.events (use_id) where use_id is not null;

-- ------------------------------------------------- approvals (§6.4, §5.5)
-- An event that lands awaiting_approval gets a row here; the human's one-click
-- decision is appended to approval_decisions. Events themselves never change.
create table waggle.approvals (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null unique references waggle.events (id),
  subscriber_id uuid not null references waggle.subscribers (id),
  token_hash    text not null unique,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  emailed_at    timestamptz
);

create table waggle.approval_decisions (
  id         bigint generated always as identity primary key,
  event_id   uuid not null references waggle.events (id),
  decision   text not null check (decision in ('approve', 'discard')),
  decided_at timestamptz not null default now()
);
create index approval_decisions_event_idx on waggle.approval_decisions (event_id, decided_at desc);

-- ------------------------------------------------------ moderation (§5.6)
create table waggle.moderation_actions (
  id                   bigint generated always as identity primary key,
  action               text not null check (action in ('hide_event','unhide_event','hide_entity','unhide_entity','ban_subscriber','purge_subscriber')),
  target_event_id      uuid references waggle.events (id),
  target_entity_id     uuid references waggle.entities (id),
  target_subscriber_id uuid references waggle.subscribers (id),
  reason               text not null default '',
  actor                text not null default 'admin',
  created_at           timestamptz not null default now(),
  check (num_nonnulls(target_event_id, target_entity_id, target_subscriber_id) = 1)
);

-- ------------------------------------------------------ summaries (§11)
-- Optional nightly LLM narratives. Every cited event must exist and belong
-- to the entity (enforced by trigger in the next migration).
create table waggle.entity_summaries (
  id              bigint generated always as identity primary key,
  entity_id       uuid not null references waggle.entities (id),
  summary         text not null check (char_length(summary) <= 1200),
  cited_event_ids uuid[] not null check (cardinality(cited_event_ids) > 0),
  model           text not null,
  created_at      timestamptz not null default now()
);

-- ------------------------------------------------------- playbooks (§10)
create table waggle.playbooks (
  id           uuid primary key default gen_random_uuid(),
  source_id    text not null unique,
  title        text not null,
  url          text not null,
  published_at timestamptz,
  ingested_at  timestamptz not null default now()
);

create table waggle.playbook_chunks (
  id          bigint generated always as identity primary key,
  playbook_id uuid not null references waggle.playbooks (id) on delete cascade,
  chunk_index int not null,
  content     text not null,
  embedding   extensions.vector(384),
  unique (playbook_id, chunk_index)
);

-- ----------------------------------------------------------- analytics
create table waggle.api_calls (
  id            bigint generated always as identity primary key,
  subscriber_id uuid references waggle.subscribers (id),
  tool          text not null,
  ts            timestamptz not null default now(),
  latency_ms    int,
  result_count  int,
  ok            boolean not null default true
);
create index api_calls_ts_idx on waggle.api_calls (ts desc);
create index api_calls_subscriber_idx on waggle.api_calls (subscriber_id, ts desc);

create table waggle.llm_spend (
  id         bigint generated always as identity primary key,
  purpose    text not null check (purpose in ('screen', 'summary', 'embedding')),
  usd        numeric(10,5) not null check (usd >= 0),
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------- auth (§7.1)
-- OAuth clients, tokens, and magic links live in Supabase Auth (OAuth 2.1
-- server + email magic links). waggle.subscribers.auth_user_id links to it.
