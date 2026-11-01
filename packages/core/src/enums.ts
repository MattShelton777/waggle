// Every enum Waggle accepts. Structure over free text (plan §5.1): if a value
// is not listed here, an agent cannot submit it. Keep these in sync with the
// CHECK constraints in supabase/migrations.

export const ENTITY_TYPES = ["tool", "workflow", "tactic"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const ENTITY_STATUSES = ["pending", "active", "merged", "hidden"] as const;
export type EntityStatus = (typeof ENTITY_STATUSES)[number];

// §3.2 context. Coarse on purpose: nothing here may fingerprint a company.
export const INDUSTRY_GROUPS = [
  "b2b_saas",
  "home_services_trades",
  "ecommerce",
  "agency",
  "fintech",
  "healthcare",
  "professional_services",
  "other",
] as const;
export const BUYERS = ["smb", "mid_market", "enterprise", "consumer"] as const;
export const ACV_BANDS = ["lt_1k", "1k_5k", "5k_25k", "25k_100k", "gt_100k", "na"] as const;
export const MOTIONS = ["plg", "sales_led", "hybrid", "na"] as const;
export const REGIONS = ["na", "emea", "apac", "latam", "global"] as const;

export type IndustryGroup = (typeof INDUSTRY_GROUPS)[number];
export type Buyer = (typeof BUYERS)[number];
export type AcvBand = (typeof ACV_BANDS)[number];
export type Motion = (typeof MOTIONS)[number];
export type Region = (typeof REGIONS)[number];

export const CONTEXT_FIELDS = ["industry_group", "buyer", "acv_band", "motion", "region"] as const;
export type ContextField = (typeof CONTEXT_FIELDS)[number];

export const EVENT_KINDS = ["observation", "readout"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const EVENT_STATUSES = ["accepted", "awaiting_approval", "quarantined", "rejected"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

// §4.2 base_evidence
export const EVIDENCE_SOURCES = ["platform_read", "self_reported", "inspection_only"] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

export const METRIC_KINDS = ["leading", "lagging"] as const;
export type MetricKind = (typeof METRIC_KINDS)[number];

// §4.1 tool/workflow rubric labels. Agents pick a label; the server maps it to s.
export const RATINGS = ["flawless", "good", "usable", "mostly_unhelpful", "failed", "harmful"] as const;
export type Rating = (typeof RATINGS)[number];

// §4.1 tactic outcome bands. Relative lift only; there is no field for absolute numbers.
export const LIFT_BANDS = [
  "loss_large",
  "loss_moderate",
  "loss_small",
  "no_difference",
  "win_small",
  "win_moderate",
  "win_large",
] as const;
export type LiftBand = (typeof LIFT_BANDS)[number];

export const SAMPLE_BANDS = ["lt_100", "100_1k", "1k_5k", "gt_5k"] as const;
export type SampleBand = (typeof SAMPLE_BANDS)[number];

export const RUN_COUNT_BANDS = ["1", "2_10", "gt_10"] as const;
export type RunCountBand = (typeof RUN_COUNT_BANDS)[number];

export const TOOL_DIMENSIONS = ["accuracy", "coverage", "cost", "latency", "reliability", "token_efficiency"] as const;
export const TACTIC_DIMENSIONS = ["lift"] as const;
export const DIMENSIONS = [...TOOL_DIMENSIONS, ...TACTIC_DIMENSIONS] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const FAILURE_MODES = [
  "low_coverage",
  "stale_data",
  "bounced",
  "wrong_person",
  "rate_limited",
  "schema_drift",
  "timeout",
  "expensive",
  "injection_attempt",
  "no_effect",
  "negative_effect",
  "other",
] as const;
export type FailureMode = (typeof FAILURE_MODES)[number];

// §6.4
export const CONTRIBUTION_POLICIES = ["ask_always", "auto_low_risk", "auto_all"] as const;
export type ContributionPolicy = (typeof CONTRIBUTION_POLICIES)[number];

export const USE_STATUSES = ["open", "closed", "expired"] as const;
export type UseStatus = (typeof USE_STATUSES)[number];

export const TAXONOMY_STATUSES = ["active", "proposed", "deprecated"] as const;
export type TaxonomyStatus = (typeof TAXONOMY_STATUSES)[number];

export const MODERATION_ACTIONS = [
  "hide_event",
  "unhide_event",
  "hide_entity",
  "unhide_entity",
  "ban_subscriber",
  "purge_subscriber",
] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

export const SCORE_LABELS = ["recommended", "unconfirmed"] as const;
export type ScoreLabel = (typeof SCORE_LABELS)[number];
