import type { WaggleConfig } from "./config";
import type { EntityType, EvidenceSource, MetricKind, RunCountBand, SampleBand } from "./enums";

// §4.2: w = base_evidence × metric_factor × sample_factor × contributor_reputation,
// then account-age and plausibility multipliers, clamped to (0, 1].
// Always computed server-side; never accepted from a client.

export const BASE_EVIDENCE: Record<EvidenceSource, number> = {
  platform_read: 1.0,
  self_reported: 0.6,
  inspection_only: 0.3,
};

export const METRIC_FACTOR: Record<MetricKind, number> = {
  leading: 0.6,
  lagging: 1.0,
};

export const SAMPLE_FACTOR: Record<SampleBand, number> = {
  lt_100: 0.3,
  "100_1k": 0.6,
  "1k_5k": 0.85,
  gt_5k: 1.0,
};

export const RUN_COUNT_FACTOR: Record<RunCountBand, number> = {
  "1": 0.5,
  "2_10": 0.8,
  gt_10: 1.0,
};

/** Smallest weight an event can carry, so the (0, 1] interval stays open at 0. */
export const MIN_WEIGHT = 0.001;

export interface WeightInput {
  entityType: EntityType;
  evidenceSource: EvidenceSource;
  metricKind?: MetricKind | undefined;
  sampleBand?: SampleBand | undefined;
  runCountBand?: RunCountBand | undefined;
  contributorReputation: number;
  accountAgeDays: number;
  isPersonalDomain?: boolean | undefined;
  /** Number of plausibility rules this event tripped (§5.3). */
  plausibilityPenalties: number;
}

export interface WeightComponents {
  base_evidence: number;
  metric_factor: number;
  sample_factor: number;
  contributor_reputation: number;
  account_age_factor: number;
  plausibility_factor: number;
  /** Every factor except reputation. Stored so scores can apply *current* reputation at read time. */
  base_weight: number;
  raw: number;
  /** Weight at write time, for the audit trail. */
  weight: number;
}

export function computeWeight(input: WeightInput, cfg: WaggleConfig): WeightComponents {
  const isTactic = input.entityType === "tactic";
  const base_evidence = BASE_EVIDENCE[input.evidenceSource];
  // Tactics missing a metric kind or sample band get the most conservative factor.
  const metric_factor = isTactic ? METRIC_FACTOR[input.metricKind ?? "leading"] : 1.0;
  const sample_factor = isTactic
    ? SAMPLE_FACTOR[input.sampleBand ?? "lt_100"]
    : RUN_COUNT_FACTOR[input.runCountBand ?? "1"];
  const contributor_reputation = clamp(input.contributorReputation, cfg.reputation.min, cfg.reputation.max);
  const newWindow = input.isPersonalDomain ? cfg.newAccountDaysPersonal : cfg.newAccountDays;
  const account_age_factor = input.accountAgeDays < newWindow ? cfg.newAccountFactor : 1.0;
  const plausibility_factor = Math.pow(cfg.plausibilityPenalty, Math.max(0, input.plausibilityPenalties));

  const base_weight = base_evidence * metric_factor * sample_factor * account_age_factor * plausibility_factor;
  const raw = base_weight * contributor_reputation;
  return {
    base_evidence,
    metric_factor,
    sample_factor,
    contributor_reputation,
    account_age_factor,
    plausibility_factor,
    base_weight,
    raw,
    weight: clamp(raw, MIN_WEIGHT, 1),
  };
}

/**
 * Weight used when scoring: the stored base weight times the contributor's
 * reputation *now*. This is what lets a liar's past evidence lose influence
 * as their reputation decays (§4.5), without ever updating an event row.
 */
export function effectiveWeight(baseWeight: number, currentReputation: number, cfg: WaggleConfig): number {
  const rep = clamp(currentReputation, cfg.reputation.min, cfg.reputation.max);
  return clamp(baseWeight * rep, MIN_WEIGHT, 1);
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
