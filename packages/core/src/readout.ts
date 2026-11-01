import type { WaggleConfig } from "./config";
import type { EntityType, MetricKind } from "./enums";

// §6.1 readout plans and schedule prompts for logged uses.

const DAY_MS = 86_400_000;

export type ReadoutStage = "single" | MetricKind;

export interface ReadoutWindow {
  stage: ReadoutStage;
  due_from: string;
  due_by: string;
}

export interface ReadoutPlan {
  entity_type: EntityType;
  readouts: ReadoutWindow[];
  expires_at: string;
}

const WINDOWS: Record<EntityType, Array<{ stage: ReadoutStage; fromDays: number; byDays: number }>> = {
  // Tools are rated immediately; a use is still allowed, it just reads out at once.
  tool: [{ stage: "single", fromDays: 0, byDays: 1 }],
  workflow: [{ stage: "single", fromDays: 1, byDays: 3 }],
  tactic: [
    { stage: "leading", fromDays: 7, byDays: 14 },
    { stage: "lagging", fromDays: 30, byDays: 90 },
  ],
};

export function readoutPlan(type: EntityType, appliedAt: Date, cfg: WaggleConfig): ReadoutPlan {
  const at = (days: number) => new Date(appliedAt.getTime() + days * DAY_MS).toISOString();
  return {
    entity_type: type,
    readouts: WINDOWS[type].map((w) => ({ stage: w.stage, due_from: at(w.fromDays), due_by: at(w.byDays) })),
    expires_at: at(cfg.useExpiryDays),
  };
}

/** The first readout whose window has opened and that has not been submitted yet. */
export function dueReadouts(plan: ReadoutPlan, completedStages: readonly ReadoutStage[], now: Date): ReadoutWindow[] {
  return plan.readouts.filter((w) => !completedStages.includes(w.stage) && new Date(w.due_from).getTime() <= now.getTime());
}

const STAGE_HINT: Record<ReadoutStage, string> = {
  single: "read the results",
  leading: "read the leading results (opens, replies, CTR)",
  lagging: "read the lagging results (meetings, pipeline, conversions)",
};

/**
 * A ready-to-register prompt the agent can save as its own scheduled task.
 * It contains only Waggle identifiers, never the user's data.
 */
export function schedulePrompts(entitySlug: string, useId: string, plan: ReadoutPlan): string[] {
  return plan.readouts.map((w) => {
    const date = w.due_from.slice(0, 10);
    return (
      `On ${date}, ${STAGE_HINT[w.stage]} from the connected platform for the work that applied ` +
      `Waggle entity \`${entitySlug}\`. Compare against the control or prior baseline, pick the relative band, ` +
      `and submit a Waggle readout with waggle_report (kind "readout", use_id "${useId}"). ` +
      `Share relative results only, never the numbers.`
    );
  });
}
