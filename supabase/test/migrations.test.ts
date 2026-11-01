import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, computeWeight, scoreEntity, effectiveWeight, type ScoringEvent } from "@waggle/core";

// Runs every migration against an in-process Postgres (PGlite + pgvector +
// pg_trgm) and exercises the RPC surface, append-only guarantees, and the
// waggle_api role's lack of table access.

const dir = join(import.meta.dirname, "..", "migrations");
let db: PGlite;

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<T>(sql, params);
  return r.rows[0] as T;
}

function weightFor(): Record<string, unknown> {
  return computeWeight(
    { entityType: "tool", evidenceSource: "platform_read", runCountBand: "2_10", contributorReputation: 1, accountAgeDays: 30, plausibilityPenalties: 0 },
    DEFAULT_CONFIG,
  ) as unknown as Record<string, unknown>;
}

function eventPayload(over: Record<string, unknown> = {}) {
  const wc = weightFor();
  return {
    kind: "observation",
    industry_group: "home_services_trades",
    buyer: "smb",
    score: 0.8,
    weight: wc.weight,
    weight_components: wc,
    evidence_source: "platform_read",
    rating: "good",
    run_count_band: "2_10",
    dimensions: { accuracy: 0.9 },
    failure_modes: [],
    rationale: "Found owner contacts for most local trades businesses with a fallback for gaps.",
    observed_at: new Date().toISOString(),
    status: "accepted",
    screen_results: {},
    ...over,
  };
}

beforeAll(async () => {
  db = await PGlite.create({ extensions: { vector, pg_trgm } });
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(dir, f), "utf8"));
  }
});

describe("migrations", () => {
  it("seed the taxonomy and config", async () => {
    const fns = await one<{ n: number }>("select count(*)::int as n from waggle.taxonomy where parent_id is null");
    expect(fns.n).toBe(14);
    const rules = await one<{ r: { taxonomy: unknown[]; rules_version: number } }>("select waggle.api_get_rules() as r");
    expect(rules.r.rules_version).toBe(1);
    expect(rules.r.taxonomy).toHaveLength(14);
  });

  it("supports the full write path through RPC", async () => {
    const work = await one<{ id: string }>("select waggle.api_ensure_subscriber(gen_random_uuid(), 'matt@superproductive.co', false) as id");
    const other = await one<{ id: string }>("select waggle.api_ensure_subscriber(gen_random_uuid(), 'ops@example-agency.com', false) as id");

    // Propose a new tool entity with an accepted first rating -> active.
    const res = await one<{ r: { entity_id: string; status: string } }>(
      "select waggle.api_submit_event($1, $2, $3, $4) as r",
      [
        work.id,
        eventPayload(),
        {
          type: "tool",
          slug: "maps-scrape-enrich",
          name: "Maps scrape + enrichment",
          description: "Scrape local listings then enrich owner contacts with a fallback provider.",
          primary_function: "gtm_engineering",
          primary_subfunction: "list_building",
          secondary_subfunctions: ["enrichment"],
        },
        ["local-trades"],
      ],
    );
    expect(res.r.status).toBe("accepted");
    const entityId = res.r.entity_id;

    await db.query("select waggle.api_submit_event($1, $2)", [other.id, eventPayload({ entity_id: entityId, score: 0.6, rating: "usable" })]);

    const resolved = await one<{ r: { slug: string; status: string; taxonomy: unknown[]; tags: string[] } }>(
      "select waggle.api_resolve_entity(null, 'maps-scrape-enrich') as r",
    );
    expect(resolved.r.status).toBe("active");
    expect(resolved.r.taxonomy).toHaveLength(2);
    expect(resolved.r.tags).toEqual(["local-trades"]);

    // Search is fuzzy and taxonomy-alias aware.
    const found = await db.query<{ slug: string }>("select slug from waggle.api_search_entities(p_query => 'maps enrichment')");
    expect(found.rows.map((r) => r.slug)).toContain("maps-scrape-enrich");
    const byFn = await db.query<{ slug: string }>("select slug from waggle.api_search_entities(p_function => 'gtm_engineering', p_subfunction => 'enrichment')");
    expect(byFn.rows.map((r) => r.slug)).toEqual(["maps-scrape-enrich"]);

    // Scoring rows feed core's compute-on-read scorer.
    const rows = await db.query<{ id: string; subscriber_id: string; voice_key: string; score: number; base_weight: number; reputation: number; observed_at: Date }>(
      "select * from waggle.api_get_scoring_events($1)",
      [[entityId]],
    );
    expect(rows.rows).toHaveLength(2);
    const events: ScoringEvent[] = rows.rows.map((r) => ({
      id: r.id,
      subscriberId: r.subscriber_id,
      voiceKey: r.voice_key,
      score: r.score,
      weight: effectiveWeight(r.base_weight, r.reputation, DEFAULT_CONFIG),
      observedAt: new Date(r.observed_at),
      context: {},
    }));
    const s = scoreEntity(events, { entityType: "tool", now: new Date(), cfg: DEFAULT_CONFIG });
    expect(s.eventCount).toBe(2);
    expect(s.composite).toBeGreaterThan(0.5);
    expect(rows.rows[0]!.voice_key).toMatch(/^domain:/);
  });

  it("keeps events append-only", async () => {
    await expect(db.exec("update waggle.events set score = 1")).rejects.toThrow(/append-only/);
    await expect(db.exec("delete from waggle.events")).rejects.toThrow(/append-only/);
    await expect(db.exec("truncate waggle.events")).rejects.toThrow();
    await expect(db.exec("truncate waggle.api_calls")).rejects.toThrow(/append-only/);
  });

  it("routes awaiting_approval through a decision, and hides via moderation", async () => {
    const sub = await one<{ id: string }>("select waggle.api_ensure_subscriber(gen_random_uuid(), 'cautious@example.org', false) as id");
    const entity = await one<{ id: string }>("select id from waggle.entities where slug = 'maps-scrape-enrich'");
    const r = await one<{ r: { event_id: string; status: string } }>("select waggle.api_submit_event($1, $2, null, null, null, $3) as r", [
      sub.id,
      eventPayload({ entity_id: entity.id, status: "awaiting_approval", score: 0.2, rating: "failed" }),
      "tokenhash-1",
    ]);
    const countAccepted = async () =>
      (await one<{ n: number }>("select count(*)::int as n from waggle.scoring_events where entity_id = $1", [entity.id])).n;
    expect(await countAccepted()).toBe(2);

    const d = await one<{ r: { status: string } }>("select waggle.api_decide_approval('tokenhash-1', 'approve') as r");
    expect(d.r.status).toBe("accepted");
    expect(await countAccepted()).toBe(3);

    await db.query("insert into waggle.moderation_actions (action, target_event_id, reason) values ('hide_event', $1, 'test')", [r.r.event_id]);
    expect(await countAccepted()).toBe(2);
    await db.query("insert into waggle.moderation_actions (action, target_event_id, reason) values ('unhide_event', $1, 'test')", [r.r.event_id]);
    expect(await countAccepted()).toBe(3);
  });

  it("derives use state from readouts", async () => {
    const sub = await one<{ id: string }>("select id from waggle.subscribers where email = 'matt@superproductive.co'");
    const entity = await one<{ id: string }>("select id from waggle.entities where slug = 'maps-scrape-enrich'");
    const plan = { entity_type: "tool", readouts: [{ stage: "single", due_from: new Date().toISOString(), due_by: new Date().toISOString() }] };
    const use = await one<{ id: string }>("select waggle.api_insert_use($1, $2, $3, null, now(), $4, now() + interval '120 days') as id", [
      sub.id,
      entity.id,
      { industry_group: "agency" },
      plan,
    ]);
    const open = await db.query<{ u: { status: string } }>("select waggle.api_open_uses($1) as u", [sub.id]);
    expect(open.rows).toHaveLength(1);

    await db.query("select waggle.api_submit_event($1, $2)", [sub.id, eventPayload({ kind: "readout", use_id: use.id, readout_stage: "single" })]);
    const after = await one<{ u: { status: string; industry_group: string } }>("select waggle.api_get_use($1, $2) as u", [use.id, sub.id]);
    expect(after.u.status).toBe("closed");
    const readout = await one<{ industry_group: string }>("select industry_group from waggle.events where use_id = $1", [use.id]);
    expect(readout.industry_group).toBe("agency");
  });

  it("enforces per-subscriber rate limits", async () => {
    const sub = await one<{ id: string }>("select waggle.api_ensure_subscriber(gen_random_uuid(), 'busy@example.net', false) as id");
    const entity = await one<{ id: string }>("select id from waggle.entities where slug = 'maps-scrape-enrich'");
    for (let i = 0; i < DEFAULT_CONFIG.limits.eventsPerDay; i++) {
      await db.query("select waggle.api_submit_event($1, $2)", [sub.id, eventPayload({ entity_id: entity.id })]);
    }
    await expect(db.query("select waggle.api_submit_event($1, $2)", [sub.id, eventPayload({ entity_id: entity.id })])).rejects.toThrow(/rate_limited/);
  });

  it("gives waggle_api RPC access only", async () => {
    await db.exec("set role waggle_api");
    try {
      await expect(db.query("select * from waggle.events")).rejects.toThrow(/permission denied/);
      await expect(db.query("select * from waggle.subscribers")).rejects.toThrow(/permission denied/);
      await expect(db.query("insert into waggle.moderation_actions (action, target_event_id) values ('hide_event', gen_random_uuid())")).rejects.toThrow(/permission denied/);
      await expect(db.query("select waggle.setting_int(array['x'], 1)")).rejects.toThrow(/permission denied/);
      const rules = await one<{ r: { rules_version: number } }>("select waggle.api_get_rules() as r");
      expect(rules.r.rules_version).toBe(1);
    } finally {
      await db.exec("reset role");
    }
  });

  it("rejects summaries that cite events from another entity", async () => {
    const entity = await one<{ id: string }>("select id from waggle.entities where slug = 'maps-scrape-enrich'");
    await expect(
      db.query("insert into waggle.entity_summaries (entity_id, summary, cited_event_ids, model) values ($1, 'x', array[gen_random_uuid()], 'm')", [entity.id]),
    ).rejects.toThrow(/cited event/);
  });
});
