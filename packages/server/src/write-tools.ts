import {
  checkPlausibility,
  computeWeight,
  hasQuarantine,
  readoutPlan,
  requiresApproval,
  schedulePrompts,
  scoreFromLiftBand,
  scoreFromRating,
  scrubReport,
  scrubText,
  validateOutcomeForType,
  type EntityType,
  type FieldIssue,
  type LogUseInput,
  type ReadoutStage,
  type ReportInput,
  type ScrubIssue,
} from "@waggle/core";
import { WaggleError, type RequestContext } from "./context";
import type { EntityRecord, NewEntityPayload, ProposedNodePayload, SearchHit, UseRecord } from "./db";

// §5 contribution pipeline: validate → screen → stage → accept, and §6.1 uses.

const DAY_MS = 86_400_000;

export async function logUse(ctx: RequestContext, input: LogUseInput) {
  const entity = await ctx.db.resolveEntity(input.entity);
  if (!entity || entity.status !== "active")
    throw new WaggleError("not_found", "No active Waggle entity matches that reference. Use waggle_check to find it.");
  const appliedAt = input.applied_at ? new Date(input.applied_at) : ctx.now;
  if (appliedAt.getTime() > ctx.now.getTime() + DAY_MS) throw new WaggleError("invalid", "applied_at is in the future.");
  const plan = readoutPlan(entity.type, appliedAt, ctx.cfg);
  const useId = await ctx.db.insertUse({
    subscriberId: ctx.subscriber.id,
    entityId: entity.id,
    context: input.context,
    testDesign: input.test_design,
    appliedAt,
    plan,
  });
  return {
    use_id: useId,
    entity: entity.slug,
    readout_plan: plan,
    schedule_prompts: schedulePrompts(entity.slug, useId, plan),
    next_step:
      entity.type === "tool"
        ? "Tools are rated right away: after the run, submit waggle_report with kind \"readout\" and this use_id."
        : "If your client supports scheduled tasks, register each schedule prompt. Otherwise Waggle will remind you via notices.due_readouts.",
  };
}

export type ReportResult =
  | { status: "rejected"; errors: FieldIssue[]; close_matches?: Array<{ slug: string; name: string; type: string }> }
  | {
      status: "accepted" | "awaiting_approval" | "quarantined";
      event_id: string;
      entity: { id: string; slug: string; status: string };
      flags?: string[];
      close_matches?: Array<{ slug: string; name: string; type: string }>;
      message: string;
    };

export async function report(ctx: RequestContext, r: ReportInput): Promise<ReportResult> {
  // 1. Resolve the entity (and the use, for readouts).
  let entity: EntityRecord | null = null;
  let use: UseRecord | null = null;
  let entityType: EntityType;
  let closeMatches: SearchHit[] = [];

  if (r.kind === "readout") {
    use = await ctx.db.getUse(r.use_id!, ctx.subscriber.id);
    if (!use) return rejected([{ path: "use_id", message: "No logged use with that id on this account. Check waggle_open_tests." }]);
    if (use.status !== "open") return rejected([{ path: "use_id", message: `That use is ${use.status}; it can't take more readouts.` }]);
    entityType = use.entity_type;
  } else if (r.entity) {
    entity = await ctx.db.resolveEntity(r.entity);
    if (!entity || entity.status !== "active") return rejected([{ path: "entity", message: "No active Waggle entity matches that reference. Use waggle_check, or propose_entity if it's new." }]);
    entityType = entity.type;
  } else {
    const p = r.propose_entity!;
    entityType = p.type;
    const slug = p.slug ?? slugify(p.name);
    const existing = await ctx.db.resolveEntity({ slug });
    if (existing) return rejected([{ path: "propose_entity.slug", message: `An entity with slug "${existing.slug}" already exists. Report against it with entity: { slug: "${existing.slug}" }.` }]);
    closeMatches = (
      await ctx.db.searchEntities({ query: p.name, type: p.type, embedding: await ctx.embedder.embed(`${p.name}. ${p.description}`), includePending: true, limit: 5 })
    ).filter((h) => h.match_score >= 0.45);
  }

  // 2. Outcome fields must fit the entity type.
  const typeIssues = validateOutcomeForType(r, entityType);
  if (typeIssues.length) return rejected(typeIssues);

  // 3. Rule-based scrubbing (zero-token). Injection quarantines; the rest is fixable.
  const scrub = scrubReport(r, { denylist: ctx.denylist });
  const quarantine = hasQuarantine(scrub);
  if (!quarantine && scrub.length) return rejected(scrub.map(toFieldIssue), closeMatches);

  // 4. Plausibility.
  const plaus = checkPlausibility(r, { entityType, now: ctx.now, useAppliedAt: use ? new Date(use.applied_at) : undefined });
  if (plaus.hardRejects.length) return rejected(plaus.hardRejects.map((m) => ({ path: "(combination)", message: m })));

  // 5. Score and server-side weight.
  const harmful = r.failure_modes?.includes("injection_attempt");
  const s = harmful ? 0 : r.lift_band ? scoreFromLiftBand(r.lift_band) : scoreFromRating(r.rating!);
  const tenureDays = (ctx.now.getTime() - new Date(ctx.subscriber.tenure_start).getTime()) / DAY_MS;
  const weight = computeWeight(
    {
      entityType,
      evidenceSource: r.evidence_source,
      metricKind: r.metric_kind,
      sampleBand: r.sample_band,
      runCountBand: r.run_count_band,
      contributorReputation: ctx.subscriber.reputation,
      accountAgeDays: tenureDays,
      isPersonalDomain: ctx.subscriber.is_personal_domain,
      plausibilityPenalties: plaus.penalties.length,
    },
    ctx.cfg,
  );

  // 6. Status: quarantine, or the subscriber's contribution policy (§6.4).
  const isNewEntity = !!r.propose_entity;
  let isFirstTacticObservation = false;
  if (entityType === "tactic" && r.kind === "observation" && entity) {
    const prior = await ctx.db.getScoringEvents([entity.id]);
    isFirstTacticObservation = !prior.some((e) => e.subscriber_id === ctx.subscriber.id && e.kind === "observation");
  }
  const status = quarantine
    ? "quarantined"
    : requiresApproval({ policy: ctx.subscriber.policy, kind: r.kind, entityType, isNewEntity, isFirstTacticObservation })
      ? "awaiting_approval"
      : "accepted";

  // 7. Readout stage from the use's plan.
  const stage = use ? pickStage(use, r.metric_kind, ctx.now) : undefined;

  const eventId = crypto.randomUUID();
  const embedding = await ctx.embedder.embed(r.rationale);
  const context = r.kind === "observation" ? r.context ?? {} : {};
  const newEntity = r.propose_entity ? await newEntityPayload(ctx, r) : undefined;
  const proposedNode: ProposedNodePayload | undefined = r.proposed_subfunction
    ? {
        parent_function: r.proposed_subfunction.parent_function,
        slug: slugify(r.proposed_subfunction.name).replace(/-/g, "_"),
        name: r.proposed_subfunction.name,
        description: r.proposed_subfunction.description,
      }
    : undefined;

  let result: { event_id: string; entity_id: string; status: string };
  try {
    result = await ctx.db.submitEvent({
      subscriberId: ctx.subscriber.id,
      event: {
        id: eventId,
        kind: r.kind,
        entity_id: entity?.id,
        use_id: use?.id,
        readout_stage: stage,
        ...context,
        score: s,
        weight: weight.weight,
        weight_components: weight as unknown as Record<string, unknown>,
        evidence_source: r.evidence_source,
        rating: r.rating,
        run_count_band: r.run_count_band,
        lift_band: r.lift_band,
        metric_kind: r.metric_kind,
        sample_band: r.sample_band,
        dimensions: r.dimensions as Record<string, number> | undefined,
        failure_modes: r.failure_modes,
        rationale: r.rationale,
        rationale_embedding: embedding ? `[${embedding.join(",")}]` : undefined,
        observed_at: new Date(r.observed_at).toISOString(),
        status,
        screen_results: {
          scrub: scrub.map((i) => ({ field: i.field, code: i.code })),
          plausibility_penalties: plaus.penalties,
          injection: quarantine,
        },
      },
      newEntity,
      tags: r.tags,
      proposedNode,
      approvalTokenHash: status === "awaiting_approval" ? await approvalTokenHash(ctx.deps.approvalSecret, eventId) : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("rate_limited")) throw new WaggleError("rate_limited", "Daily Waggle contribution limit reached for this account. Try again tomorrow.");
    if (msg.includes("unknown taxonomy") || msg.includes("unknown parent function"))
      return rejected([{ path: "propose_entity.primary_function", message: "Unknown function/subfunction. Call waggle_get_rules for the current taxonomy, or use proposed_subfunction." }]);
    throw err;
  }

  const entitySlug = entity?.slug ?? use?.entity_slug ?? newEntity!.slug;
  return {
    status: status as "accepted" | "awaiting_approval" | "quarantined",
    event_id: result.event_id,
    entity: { id: result.entity_id, slug: entitySlug, status: isNewEntity ? (status === "accepted" ? "active" : "pending") : "active" },
    flags: plaus.penalties.length ? plaus.penalties : undefined,
    close_matches: closeMatches.length ? closeMatches.map((h) => ({ slug: h.slug, name: h.name, type: h.type })) : undefined,
    message:
      status === "accepted"
        ? "Thanks. Your finding is in Waggle and counts toward scores now."
        : status === "awaiting_approval"
          ? "Saved. The user's contribution policy needs their sign-off; they'll get an approval email. Nothing else to do."
          : "This submission contained instruction-like content and was quarantined. It will not be shown to other agents.",
  };
}

function rejected(errors: FieldIssue[], closeMatches: SearchHit[] = []): ReportResult {
  return {
    status: "rejected",
    errors,
    ...(closeMatches.length ? { close_matches: closeMatches.map((h) => ({ slug: h.slug, name: h.name, type: h.type })) } : {}),
  };
}

function toFieldIssue(i: ScrubIssue): FieldIssue {
  return { path: i.field, message: i.message };
}

function pickStage(use: UseRecord, metricKind: ReportInput["metric_kind"], now: Date): ReadoutStage {
  const pending = use.readout_plan.readouts.filter((w) => !use.completed_stages.includes(w.stage));
  const byKind = metricKind ? pending.find((w) => w.stage === metricKind) : undefined;
  if (byKind) return byKind.stage;
  const due = pending.find((w) => new Date(w.due_from).getTime() <= now.getTime());
  return (due ?? pending[0] ?? use.readout_plan.readouts[0]!).stage;
}

async function newEntityPayload(ctx: RequestContext, r: ReportInput): Promise<NewEntityPayload> {
  const p = r.propose_entity!;
  const embedding = await ctx.embedder.embed(`${p.name}. ${p.description}`);
  return {
    type: p.type,
    slug: p.slug ?? slugify(p.name),
    name: p.name,
    description: p.description,
    primary_function: r.proposed_subfunction ? r.proposed_subfunction.parent_function : p.primary_function,
    primary_subfunction: p.primary_subfunction,
    secondary_subfunctions: p.secondary_subfunctions,
    attributes: p.workflow_steps ? { workflow_steps: p.workflow_steps } : {},
    embedding: embedding ? `[${embedding.join(",")}]` : undefined,
  };
}

export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * Approval links carry token = base64url(HMAC-SHA256(secret, event_id)); the
 * DB stores only sha256(token). The approval-email job recomputes the token
 * from the event id, so the raw token never needs to be stored.
 */
export async function approvalToken(secret: string, eventId: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(eventId)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function approvalTokenHash(secret: string, eventId: string): Promise<string> {
  const token = await approvalToken(secret, eventId);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}
