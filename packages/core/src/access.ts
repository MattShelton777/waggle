import type { WaggleConfig } from "./config";
import type { ContributionPolicy, EntityType, EventKind } from "./enums";

// §7.3 give-to-get and §6.4 contribution policy. Pure decisions; the server
// supplies the facts.

const DAY_MS = 86_400_000;

export type AccessLevel = "full" | "reduced";

export interface AccessStatus {
  level: AccessLevel;
  reason: "disabled" | "grace_period" | "recent_contribution" | "needs_contribution";
  grace_ends_at?: string;
  message?: string;
}

export function accessStatus(
  connectedAt: Date | null,
  lastAcceptedContributionAt: Date | null,
  now: Date,
  cfg: WaggleConfig,
): AccessStatus {
  const g = cfg.giveToGet;
  if (!g.enabled) return { level: "full", reason: "disabled" };
  const start = connectedAt ?? now;
  const graceEnds = new Date(start.getTime() + g.graceDays * DAY_MS);
  if (now < graceEnds) return { level: "full", reason: "grace_period", grace_ends_at: graceEnds.toISOString() };
  if (lastAcceptedContributionAt && now.getTime() - lastAcceptedContributionAt.getTime() <= g.windowDays * DAY_MS)
    return { level: "full", reason: "recent_contribution" };
  return {
    level: "reduced",
    reason: "needs_contribution",
    message:
      `Waggle is give-to-get. Results are limited to the top ${g.reducedResultCount} without rationales until this account ` +
      `contributes at least once every ${g.windowDays} days. Rating any tool you used recently with waggle_report unlocks full access.`,
  };
}

export interface PolicyDecisionInput {
  policy: ContributionPolicy;
  kind: EventKind;
  entityType: EntityType;
  /** The submission proposes a new entity. */
  isNewEntity: boolean;
  /** This subscriber has no accepted observation of this tactic yet. */
  isFirstTacticObservation: boolean;
}

/** Whether an otherwise-valid write is accepted now or waits for the human (§6.4). */
export function requiresApproval(d: PolicyDecisionInput): boolean {
  switch (d.policy) {
    case "auto_all":
      return false;
    case "ask_always":
      return true;
    case "auto_low_risk":
      if (d.isNewEntity) return true;
      if (d.entityType === "tactic" && d.kind === "observation" && d.isFirstTacticObservation) return true;
      return false;
  }
}
