import type { ContributionPolicy, EntityType } from "./enums";

// Defaults from plan §16. The live values are stored in waggle.config and
// loaded by the server; this object is the fallback and the source for tests.
export interface WaggleConfig {
  alpha0: number;
  beta0: number;
  /** Shrinkage constant k in c = n_eff / (n_eff + k). */
  shrinkageK: number;
  halfLifeDays: Record<EntityType, number>;
  /** Entities below this confidence are never "recommended". */
  recommendationFloor: number;
  /** Context-filtered scores with n_eff below this also return the global score. */
  contextThinNEff: number;
  domainDedupeWindowDays: number;
  newAccountDays: number;
  /** Personal-mailbox accounts stay "new" longer: they are cheap to create. */
  newAccountDaysPersonal: number;
  newAccountFactor: number;
  reputation: {
    /**
     * Reputation is judged against an anchored consensus: work-domain voices
     * plus personal-mailbox accounts at least this old. A fresh farm of
     * personal accounts can't vouch for itself.
     */
    anchorTenureDays: number;
    startWork: number;
    startPersonal: number;
    min: number;
    max: number;
    /** Events must be at least this old before they count toward reputation. */
    matureAfterDays: number;
    agreeThreshold: number;
    stepUp: number;
    stepDown: number;
    injectionMultiplier: number;
  };
  /**
   * Probationary voices (personal mailboxes younger than anchorTenureDays)
   * still count, but on any one entity their combined weight is capped at
   * max(floorNEff, ratio × established weight). They can add evidence; they
   * can't outvote the established raters.
   */
  probation: { floorNEff: number; ratio: number };
  plausibilityPenalty: number;
  limits: {
    eventsPerDay: number;
    newEntitiesPerDay: number;
    maxTags: number;
  };
  useExpiryDays: number;
  giveToGet: {
    enabled: boolean;
    graceDays: number;
    windowDays: number;
    reducedResultCount: number;
  };
  defaultPolicy: ContributionPolicy;
  taxonomyPromotion: { minDomains: number; windowDays: number };
  llm: { screenEnabled: boolean; summariesEnabled: boolean; monthlyBudgetUsd: number };
}

export const DEFAULT_CONFIG: WaggleConfig = {
  alpha0: 1,
  beta0: 1,
  shrinkageK: 3,
  halfLifeDays: { tool: 30, workflow: 60, tactic: 180 },
  recommendationFloor: 0.3,
  contextThinNEff: 1,
  domainDedupeWindowDays: 30,
  newAccountDays: 7,
  newAccountDaysPersonal: 30,
  newAccountFactor: 0.5,
  reputation: {
    anchorTenureDays: 90,
    startWork: 1.0,
    startPersonal: 0.7,
    min: 0.3,
    max: 1.5,
    matureAfterDays: 14,
    agreeThreshold: 0.25,
    stepUp: 0.02,
    stepDown: 0.04,
    injectionMultiplier: 0.5,
  },
  probation: { floorNEff: 2, ratio: 0.25 },
  plausibilityPenalty: 0.5,
  limits: { eventsPerDay: 20, newEntitiesPerDay: 5, maxTags: 5 },
  useExpiryDays: 120,
  giveToGet: { enabled: true, graceDays: 30, windowDays: 30, reducedResultCount: 3 },
  defaultPolicy: "auto_low_risk",
  taxonomyPromotion: { minDomains: 5, windowDays: 60 },
  llm: { screenEnabled: false, summariesEnabled: false, monthlyBudgetUsd: 0 },
};

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** Deep-merge a partial override (e.g. the row in waggle.config) onto the defaults. */
export function resolveConfig(overrides: DeepPartial<WaggleConfig> = {}): WaggleConfig {
  return deepMerge(DEFAULT_CONFIG, overrides);
}

function deepMerge<T>(base: T, over: DeepPartial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(over as Record<string, unknown>)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] =
      value && typeof value === "object" && !Array.isArray(value) && current && typeof current === "object"
        ? deepMerge(current, value as DeepPartial<typeof current>)
        : value;
  }
  return out as T;
}
