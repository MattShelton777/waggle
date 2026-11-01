import type { EntityType } from "./enums";
import { isLoss, isWin } from "./rubric";
import type { ReportInput } from "./schemas";

// §5.3 plausibility rules. Zero-token. Each penalty halves the event's weight
// (via WeightInput.plausibilityPenalties) and is recorded in screen_results.
// Hard rejects are combinations that cannot be true.

const DAY_MS = 86_400_000;

export interface PlausibilityResult {
  penalties: string[];
  hardRejects: string[];
}

export interface PlausibilityContext {
  entityType: EntityType;
  now: Date;
  /** For readouts: when the linked use was applied. */
  useAppliedAt?: Date | undefined;
}

/** Lagging metrics (meetings, pipeline) rarely settle this soon after a change. */
const MIN_LAGGING_DAYS = 14;
/** Allow modest clock skew on future timestamps. */
const FUTURE_TOLERANCE_MS = DAY_MS;
const MAX_AGE_DAYS = 365;

export function checkPlausibility(r: ReportInput, ctx: PlausibilityContext): PlausibilityResult {
  const penalties: string[] = [];
  const hardRejects: string[] = [];
  const observedAt = new Date(r.observed_at);
  const modes = new Set(r.failure_modes ?? []);

  if (observedAt.getTime() > ctx.now.getTime() + FUTURE_TOLERANCE_MS)
    hardRejects.push("observed_at is in the future. Use when the run or test actually happened.");
  if ((ctx.now.getTime() - observedAt.getTime()) / DAY_MS > MAX_AGE_DAYS)
    penalties.push("observed_at is more than a year old");

  if (ctx.entityType === "tactic" && r.lift_band) {
    if (r.lift_band === "win_large" && r.sample_band === "lt_100") penalties.push("large win claimed on a sample under 100");
    if (r.lift_band === "loss_large" && r.sample_band === "lt_100") penalties.push("large loss claimed on a sample under 100");
    if (isWin(r.lift_band) && (modes.has("no_effect") || modes.has("negative_effect")))
      hardRejects.push("A win cannot also list no_effect or negative_effect as a failure mode.");
    if (r.lift_band === "no_difference" && modes.has("negative_effect")) penalties.push("no_difference reported with negative_effect");
    if (isLoss(r.lift_band) && modes.has("no_effect")) penalties.push("loss reported with no_effect");
    if (r.evidence_source === "inspection_only") penalties.push("tactic result without running it");
  }

  if (ctx.entityType !== "tactic" && r.rating) {
    const severe = ["timeout", "schema_drift", "rate_limited", "bounced", "wrong_person", "injection_attempt"] as const;
    if (r.rating === "flawless" && severe.some((m) => modes.has(m))) penalties.push("flawless rating with a failure mode listed");
    if (r.rating === "harmful" && modes.size === 0) penalties.push("harmful rating without a failure mode");
    if (r.evidence_source === "inspection_only" && r.run_count_band && r.run_count_band !== "1")
      hardRejects.push("inspection_only means the tool was not run, so run_count_band cannot be more than one run.");
  }

  if (r.kind === "readout" && ctx.useAppliedAt) {
    const daysSinceUse = (observedAt.getTime() - ctx.useAppliedAt.getTime()) / DAY_MS;
    if (daysSinceUse < 0) penalties.push("readout observed before the use was applied");
    if (r.metric_kind === "lagging" && daysSinceUse < MIN_LAGGING_DAYS) penalties.push("lagging metric reported unusually soon after the use");
  }

  return { penalties, hardRejects };
}
