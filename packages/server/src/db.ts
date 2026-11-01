import type { Context, ReadoutPlan } from "@waggle/core";

// Typed access to the waggle.api_* RPC surface. The server's DB identity can
// execute these functions and nothing else (see the security migration), so
// every query here is a single function call.
//
// `Query` abstracts the driver: postgres.js in the Edge Function, PGlite in
// tests. Objects are sent as JSON text and cast in SQL so both behave alike.

export type Query = (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export interface SubscriberInfo {
  id: string;
  email_domain: string;
  is_personal_domain: boolean;
  newsletter_status: string;
  created_at: string;
  tenure_start: string;
  connected_at: string | null;
  reputation: number;
  policy: "ask_always" | "auto_low_risk" | "auto_all";
  banned: boolean;
  rules_version_seen: number | null;
  last_accepted_contribution_at: string | null;
  events_last_24h: number;
  entities_proposed_last_24h: number;
}

export interface TaxonomyRef {
  function: string;
  subfunction: string | null;
  status: string;
  primary: boolean;
}

export interface EntityRecord {
  id: string;
  type: "tool" | "workflow" | "tactic";
  slug: string;
  name: string;
  description: string;
  status: string;
  attributes: Record<string, unknown>;
  taxonomy: TaxonomyRef[];
  tags: string[];
}

export interface SearchHit {
  entity_id: string;
  type: EntityRecord["type"];
  slug: string;
  name: string;
  description: string;
  status: string;
  match_score: number;
}

export interface ScoringRow {
  id: string;
  entity_id: string;
  entity_type: EntityRecord["type"];
  kind: "observation" | "readout";
  use_id: string | null;
  subscriber_id: string;
  voice_key: string;
  score: number;
  base_weight: number;
  reputation: number;
  is_personal_domain: boolean;
  tenure_start: Date;
  observed_at: Date;
  industry_group: string | null;
  buyer: string | null;
  acv_band: string | null;
  motion: string | null;
  region: string | null;
  evidence_source: string;
  rating: string | null;
  run_count_band: string | null;
  lift_band: string | null;
  metric_kind: string | null;
  sample_band: string | null;
  dimensions: Record<string, number>;
  failure_modes: string[];
  rationale: string;
  created_at: Date;
}

export interface UseRecord {
  id: string;
  entity_id: string;
  entity_slug: string;
  entity_type: EntityRecord["type"];
  industry_group: string | null;
  buyer: string | null;
  acv_band: string | null;
  motion: string | null;
  region: string | null;
  test_design: string | null;
  applied_at: string;
  readout_plan: ReadoutPlan;
  expires_at: string;
  completed_stages: string[];
  status: "open" | "closed" | "expired";
}

export interface RulesPayload {
  rules_version: number;
  rules_text: string;
  taxonomy: Array<{
    slug: string;
    name: string;
    description: string;
    aliases: string[];
    subfunctions: Array<{ slug: string; name: string; description: string; aliases: string[]; status: string }>;
  }>;
}

export interface ServerConfigPayload {
  settings: Record<string, unknown>;
  denylist: string[];
  rules_version: number;
}

export interface SubmitEventPayload {
  id: string;
  kind: "observation" | "readout";
  entity_id?: string;
  use_id?: string;
  readout_stage?: string;
  industry_group?: string;
  buyer?: string;
  acv_band?: string;
  motion?: string;
  region?: string;
  score: number;
  weight: number;
  weight_components: Record<string, unknown>;
  evidence_source: string;
  rating?: string;
  run_count_band?: string;
  lift_band?: string;
  metric_kind?: string;
  sample_band?: string;
  dimensions?: Record<string, number>;
  failure_modes?: string[];
  rationale: string;
  rationale_embedding?: string;
  observed_at: string;
  status: "accepted" | "awaiting_approval" | "quarantined" | "rejected";
  screen_results: Record<string, unknown>;
}

export interface NewEntityPayload {
  type: string;
  slug: string;
  name: string;
  description: string;
  primary_function: string;
  primary_subfunction?: string;
  secondary_subfunctions?: string[];
  attributes?: Record<string, unknown>;
  embedding?: string;
}

export interface ProposedNodePayload {
  parent_function: string;
  slug: string;
  name: string;
  description: string;
}

export type Embedding = number[] | null;

const vec = (e: Embedding) => (e ? `[${e.join(",")}]` : null);
const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

export class WaggleDb {
  constructor(private readonly q: Query) {}

  private async scalar<T>(text: string, params: unknown[] = []): Promise<T> {
    const rows = await this.q(text, params);
    return (rows[0]?.r ?? null) as T;
  }

  getRules(): Promise<RulesPayload> {
    return this.scalar("select waggle.api_get_rules() as r");
  }

  getServerConfig(): Promise<ServerConfigPayload> {
    return this.scalar("select waggle.api_get_server_config() as r");
  }

  subscriberForAuthUser(authUserId: string): Promise<string | null> {
    return this.scalar("select waggle.api_subscriber_for_auth_user($1::uuid) as r", [authUserId]);
  }

  ensureSubscriber(authUserId: string, email: string, isPersonal: boolean, newsletterSubscribedAt: Date | null): Promise<string> {
    return this.scalar("select waggle.api_ensure_subscriber($1::uuid, $2, $3, $4::timestamptz) as r", [
      authUserId,
      email,
      isPersonal,
      newsletterSubscribedAt?.toISOString() ?? null,
    ]);
  }

  getSubscriber(id: string): Promise<SubscriberInfo | null> {
    return this.scalar("select waggle.api_get_subscriber($1::uuid) as r", [id]);
  }

  async setPolicy(subscriberId: string, policy: SubscriberInfo["policy"]): Promise<void> {
    await this.q("select waggle.api_set_policy($1::uuid, $2)", [subscriberId, policy]);
  }

  decideApproval(tokenHash: string, decision: "approve" | "discard"): Promise<{ event_id: string; status: string }> {
    return this.scalar("select waggle.api_decide_approval($1, $2) as r", [tokenHash, decision]);
  }

  async touchSubscriber(id: string, rulesVersionSeen: number | undefined): Promise<void> {
    await this.q("select waggle.api_touch_subscriber($1::uuid, $2::int)", [id, rulesVersionSeen ?? null]);
  }

  resolveEntity(ref: { entity_id?: string; slug?: string }): Promise<EntityRecord | null> {
    return this.scalar("select waggle.api_resolve_entity($1::uuid, $2) as r", [ref.entity_id ?? null, ref.slug ?? null]);
  }

  async searchEntities(p: {
    query?: string | undefined;
    type?: string | undefined;
    fn?: string | undefined;
    subfunction?: string | undefined;
    tags?: string[] | undefined;
    embedding?: Embedding;
    includePending?: boolean;
    limit?: number;
  }): Promise<SearchHit[]> {
    const rows = await this.q(
      `select * from waggle.api_search_entities(
         p_query => $1, p_type => $2, p_function => $3, p_subfunction => $4, p_tags => $5::text[],
         p_embedding => $6::extensions.vector, p_include_pending => $7, p_limit => $8)`,
      [p.query ?? null, p.type ?? null, p.fn ?? null, p.subfunction ?? null, p.tags ?? null, vec(p.embedding ?? null), p.includePending ?? false, p.limit ?? 10],
    );
    return rows as unknown as SearchHit[];
  }

  async getScoringEvents(entityIds: string[]): Promise<ScoringRow[]> {
    if (entityIds.length === 0) return [];
    const rows = await this.q("select * from waggle.api_get_scoring_events($1::uuid[])", [entityIds]);
    return rows.map((r) => ({ ...r, observed_at: new Date(r.observed_at as string), tenure_start: new Date(r.tenure_start as string), created_at: new Date(r.created_at as string) })) as unknown as ScoringRow[];
  }

  async discover(p: { embedding: Embedding; query: string; type?: string | undefined; limit?: number }) {
    const rows = await this.q("select * from waggle.api_discover($1::extensions.vector, $2, $3, $4)", [vec(p.embedding), p.query, p.type ?? null, p.limit ?? 60]);
    return rows as unknown as Array<{ event_id: string; entity_id: string; rationale: string; similarity: number }>;
  }

  getSummary(entityId: string): Promise<{ summary: string; cited_event_ids: string[]; created_at: string } | null> {
    return this.scalar("select waggle.api_get_summary($1::uuid) as r", [entityId]);
  }

  async searchPlaybooks(p: { embedding: Embedding; query: string; limit?: number }) {
    const rows = await this.q("select * from waggle.api_search_playbooks($1::extensions.vector, $2, $3)", [vec(p.embedding), p.query, p.limit ?? 5]);
    return rows as unknown as Array<{ playbook_id: string; title: string; url: string; published_at: string | null; content: string; similarity: number }>;
  }

  insertUse(p: {
    subscriberId: string;
    entityId: string;
    context: Context;
    testDesign: string | undefined;
    appliedAt: Date;
    plan: ReadoutPlan;
  }): Promise<string> {
    return this.scalar("select waggle.api_insert_use($1::uuid, $2::uuid, $3::jsonb, $4, $5::timestamptz, $6::jsonb, $7::timestamptz) as r", [
      p.subscriberId,
      p.entityId,
      json(p.context),
      p.testDesign ?? null,
      p.appliedAt.toISOString(),
      json(p.plan),
      p.plan.expires_at,
    ]);
  }

  getUse(useId: string, subscriberId: string): Promise<UseRecord | null> {
    return this.scalar("select waggle.api_get_use($1::uuid, $2::uuid) as r", [useId, subscriberId]);
  }

  async openUses(subscriberId: string): Promise<UseRecord[]> {
    const rows = await this.q("select waggle.api_open_uses($1::uuid) as r", [subscriberId]);
    return rows.map((r) => r.r as UseRecord);
  }

  submitEvent(p: {
    subscriberId: string;
    event: SubmitEventPayload;
    newEntity?: NewEntityPayload | undefined;
    tags?: string[] | undefined;
    proposedNode?: ProposedNodePayload | undefined;
    approvalTokenHash?: string | undefined;
  }): Promise<{ event_id: string; entity_id: string; status: string }> {
    return this.scalar("select waggle.api_submit_event($1::uuid, $2::jsonb, $3::jsonb, $4::text[], $5::jsonb, $6) as r", [
      p.subscriberId,
      json(p.event),
      json(p.newEntity),
      p.tags ?? null,
      json(p.proposedNode),
      p.approvalTokenHash ?? null,
    ]);
  }

  async logCall(subscriberId: string | null, tool: string, latencyMs: number, resultCount: number | null, ok: boolean): Promise<void> {
    await this.q("select waggle.api_log_call($1::uuid, $2, $3, $4, $5)", [subscriberId, tool, latencyMs, resultCount, ok]);
  }
}
