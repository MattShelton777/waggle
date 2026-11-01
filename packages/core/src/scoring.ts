import type { WaggleConfig } from "./config";
import { CONTEXT_FIELDS, type Dimension, type EntityType, type ScoreLabel } from "./enums";
import type { Context } from "./schemas";

// §4.3 aggregation: time-decayed Beta with shrinkage toward 0.5.
// Computed on read from the evidence log, so it is order-independent,
// handles late readouts naturally, and can be replayed from scratch.

const DAY_MS = 86_400_000;

export interface ScoringEvent {
  id: string;
  subscriberId: string;
  /**
   * The "voice" this event speaks with for independence (§4.4): the email
   * domain for work addresses, `acct:<subscriber_id>` for personal domains.
   */
  voiceKey: string;
  score: number;
  /** Effective weight in (0, 1], including the contributor's current reputation. */
  weight: number;
  /** When the run or test happened, not when it was reported. */
  observedAt: Date;
  context: Context;
  dimensions?: Partial<Record<Dimension, number>> | undefined;
  /** A personal-mailbox account that isn't established yet (see probation in config). */
  probationary?: boolean | undefined;
}

export interface Aggregate {
  alpha: number;
  beta: number;
  mu: number;
  nEff: number;
  confidence: number;
  composite: number;
  eventCount: number;
}

export interface EntityScore extends Aggregate {
  label: ScoreLabel;
  dimensions: Partial<Record<Dimension, Aggregate>>;
  /** True when a context filter was applied and its evidence was too thin. */
  contextThin: boolean;
  /** The unfiltered score, returned alongside a thin context-filtered score. */
  global?: EntityScore;
}

export function decayFactor(ageDays: number, halfLifeDays: number): number {
  const lambda = Math.LN2 / halfLifeDays;
  return Math.exp(-lambda * Math.max(0, ageDays));
}

export interface WeightedPoint {
  score: number;
  weight: number;
  observedAt: Date;
}

export function aggregate(points: readonly WeightedPoint[], now: Date, halfLifeDays: number, cfg: WaggleConfig): Aggregate {
  let a = 0;
  let b = 0;
  for (const p of points) {
    const ageDays = (now.getTime() - p.observedAt.getTime()) / DAY_MS;
    const d = decayFactor(ageDays, halfLifeDays);
    a += p.weight * p.score * d;
    b += p.weight * (1 - p.score) * d;
  }
  const alpha = cfg.alpha0 + a;
  const beta = cfg.beta0 + b;
  const mu = alpha / (alpha + beta);
  const nEff = a + b;
  const confidence = nEff / (nEff + cfg.shrinkageK);
  const composite = confidence * mu + (1 - confidence) * 0.5;
  return { alpha, beta, mu, nEff, confidence, composite, eventCount: points.length };
}

/**
 * One domain, one voice (§4.4). Within the events being scored, each voice
 * keeps only its most recent event per rolling window: walking back from the
 * newest, an older event counts only if it is at least `windowDays` before the
 * last one kept. Dropped events stay in the log; they just don't count.
 *
 * The key is (voice) within whatever selection is being scored (one entity,
 * optionally one context filter). That is stricter than keying on the full
 * context tuple: a domain cannot gain extra voices by varying unfiltered
 * context fields.
 */
export function dedupeByVoice<T extends Pick<ScoringEvent, "id" | "voiceKey" | "observedAt">>(
  events: readonly T[],
  windowDays: number,
): T[] {
  const byVoice = new Map<string, T[]>();
  for (const e of events) {
    const list = byVoice.get(e.voiceKey);
    if (list) list.push(e);
    else byVoice.set(e.voiceKey, [e]);
  }
  const windowMs = windowDays * DAY_MS;
  const kept: T[] = [];
  for (const list of byVoice.values()) {
    list.sort((x, y) => y.observedAt.getTime() - x.observedAt.getTime() || (x.id < y.id ? 1 : -1));
    let lastKept: number | undefined;
    for (const e of list) {
      const t = e.observedAt.getTime();
      if (lastKept === undefined || lastKept - t >= windowMs) {
        kept.push(e);
        lastKept = t;
      }
    }
  }
  return kept;
}

export function matchesContext(eventContext: Context, filter: Context | undefined): boolean {
  if (!filter) return true;
  return CONTEXT_FIELDS.every((f) => filter[f] === undefined || eventContext[f] === filter[f]);
}

export function hasContextFilter(filter: Context | undefined): boolean {
  return !!filter && CONTEXT_FIELDS.some((f) => filter[f] !== undefined);
}

export interface ScoreOptions {
  entityType: EntityType;
  now: Date;
  context?: Context | undefined;
  cfg: WaggleConfig;
}

/**
 * Score one entity from its accepted, non-hidden events. The caller is
 * responsible for filtering out moderated/non-accepted events and for
 * supplying effective weights.
 */
export function scoreEntity(events: readonly ScoringEvent[], opts: ScoreOptions): EntityScore {
  const { cfg, now, entityType, context } = opts;
  const halfLife = cfg.halfLifeDays[entityType];
  const selected = capProbationary(
    dedupeByVoice(
      events.filter((e) => matchesContext(e.context, context)),
      cfg.domainDedupeWindowDays,
    ),
    now,
    halfLife,
    cfg,
  );

  const overall = aggregate(selected, now, halfLife, cfg);

  const dimensions: Partial<Record<Dimension, Aggregate>> = {};
  const dimNames = new Set<Dimension>();
  for (const e of selected) for (const k of Object.keys(e.dimensions ?? {})) dimNames.add(k as Dimension);
  for (const dim of dimNames) {
    const pts: WeightedPoint[] = [];
    for (const e of selected) {
      const v = e.dimensions?.[dim];
      if (v !== undefined) pts.push({ score: v, weight: e.weight, observedAt: e.observedAt });
    }
    dimensions[dim] = aggregate(pts, now, halfLife, cfg);
  }

  const result: EntityScore = {
    ...overall,
    label: labelFor(overall.confidence, cfg),
    dimensions,
    contextThin: false,
  };

  if (hasContextFilter(context) && overall.nEff < cfg.contextThinNEff) {
    result.contextThin = true;
    result.global = scoreEntity(events, { ...opts, context: undefined });
  }
  return result;
}

/**
 * Scale probationary voices down so their combined (decayed) weight is at most
 * max(floorNEff, ratio × established weight) on this selection.
 */
export function capProbationary<T extends ScoringEvent>(events: T[], now: Date, halfLifeDays: number, cfg: WaggleConfig): T[] {
  let established = 0;
  let probationary = 0;
  for (const e of events) {
    const w = e.weight * decayFactor((now.getTime() - e.observedAt.getTime()) / DAY_MS, halfLifeDays);
    if (e.probationary) probationary += w;
    else established += w;
  }
  const cap = Math.max(cfg.probation.floorNEff, cfg.probation.ratio * established);
  if (probationary <= cap) return events;
  const scale = cap / probationary;
  return events.map((e) => (e.probationary ? { ...e, weight: e.weight * scale } : e));
}

export function labelFor(confidence: number, cfg: WaggleConfig): ScoreLabel {
  return confidence >= cfg.recommendationFloor ? "recommended" : "unconfirmed";
}
