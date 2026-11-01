import {
  CONTEXT_FIELDS,
  effectiveWeight,
  scoreEntity,
  type Context,
  type EntityScore,
  type EntityType,
  type ScoringEvent,
  type WaggleConfig,
} from "@waggle/core";
import type { ScoringRow } from "./db";

// Turn DB rows into core ScoringEvents and shape scores for agents.

const DAY_MS = 86_400_000;

export function rowContext(r: Pick<ScoringRow, (typeof CONTEXT_FIELDS)[number]>): Context {
  const ctx: Record<string, string> = {};
  for (const f of CONTEXT_FIELDS) if (r[f]) ctx[f] = r[f] as string;
  return ctx as Context;
}

export function toScoringEvent(r: ScoringRow, now: Date, cfg: WaggleConfig): ScoringEvent {
  return {
    id: r.id,
    subscriberId: r.subscriber_id,
    voiceKey: r.voice_key,
    score: r.score,
    weight: effectiveWeight(r.base_weight, r.reputation, cfg),
    observedAt: r.observed_at,
    context: rowContext(r),
    dimensions: r.dimensions,
    probationary: r.is_personal_domain && now.getTime() - r.tenure_start.getTime() < cfg.reputation.anchorTenureDays * DAY_MS,
  };
}

export function groupByEntity(rows: ScoringRow[]): Map<string, ScoringRow[]> {
  const m = new Map<string, ScoringRow[]>();
  for (const r of rows) {
    const list = m.get(r.entity_id);
    if (list) list.push(r);
    else m.set(r.entity_id, [r]);
  }
  return m;
}

export function score(rows: ScoringRow[], type: EntityType, now: Date, cfg: WaggleConfig, context?: Context): EntityScore {
  return scoreEntity(
    rows.map((r) => toScoringEvent(r, now, cfg)),
    { entityType: type, now, cfg, context },
  );
}

const round = (x: number) => Math.round(x * 1000) / 1000;

export interface ScoreView {
  composite: number;
  confidence: number;
  label: EntityScore["label"];
  evidence_count: number;
  context_thin?: boolean;
  global?: ScoreView;
}

export function scoreView(s: EntityScore): ScoreView {
  const v: ScoreView = {
    composite: round(s.composite),
    confidence: round(s.confidence),
    label: s.label,
    evidence_count: s.eventCount,
  };
  if (s.contextThin) {
    v.context_thin = true;
    if (s.global) v.global = scoreView(s.global);
  }
  return v;
}

export function dimensionView(s: EntityScore, limit = 6): Record<string, { score: number; confidence: number }> {
  return Object.fromEntries(
    Object.entries(s.dimensions)
      .sort(([, a], [, b]) => b!.nEff - a!.nEff)
      .slice(0, limit)
      .map(([k, a]) => [k, { score: round(a!.composite), confidence: round(a!.confidence) }]),
  );
}

export function outcomeLabel(r: ScoringRow): string {
  if (r.lift_band) return `${r.lift_band} (${r.metric_kind ?? "?"}, sample ${r.sample_band ?? "?"})`;
  return `${r.rating ?? "?"}${r.run_count_band ? ` (${r.run_count_band} runs)` : ""}`;
}

/** Rationales are other agents' post-validation text: always returned as labeled data. */
export function evidenceView(r: ScoringRow) {
  return {
    outcome: outcomeLabel(r),
    observed: r.observed_at.toISOString().slice(0, 10),
    evidence_source: r.evidence_source,
    context: rowContext(r),
    failure_modes: r.failure_modes.length ? r.failure_modes : undefined,
    rationale_data: r.rationale,
  };
}

/** Most useful rationales first: recent, heavy, and in the requested context. */
export function topRationales(rows: ScoringRow[], n: number, context?: Context): ScoringRow[] {
  const inCtx = (r: ScoringRow) => CONTEXT_FIELDS.every((f) => !context?.[f] || r[f] === context[f]);
  return [...rows]
    .sort((a, b) => Number(inCtx(b)) - Number(inCtx(a)) || b.observed_at.getTime() - a.observed_at.getTime())
    .slice(0, n);
}
