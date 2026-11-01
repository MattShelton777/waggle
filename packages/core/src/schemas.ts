import { z } from "zod";
import {
  ACV_BANDS,
  BUYERS,
  DIMENSIONS,
  ENTITY_TYPES,
  EVIDENCE_SOURCES,
  FAILURE_MODES,
  INDUSTRY_GROUPS,
  LIFT_BANDS,
  METRIC_KINDS,
  MOTIONS,
  RATINGS,
  REGIONS,
  RUN_COUNT_BANDS,
  SAMPLE_BANDS,
  TACTIC_DIMENSIONS,
  TOOL_DIMENSIONS,
  type EntityType,
} from "./enums";

// Zod schemas for every MCP tool input (§5.1). All objects are strict:
// unknown fields are rejected rather than silently dropped.
// Each tool exports its raw shape too, because MCP tool registration takes one.

export const LIMITS = {
  rationale: 600,
  entityDescription: 400,
  entityName: 80,
  query: 300,
  task: 500,
  tag: 32,
  maxTags: 5,
  maxFailureModes: 6,
  maxWorkflowSteps: 12,
} as const;

const kebab = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const snake = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

export const Slug = z.string().min(2).max(80).regex(kebab, "slug must be lowercase kebab-case");
export const TaxonomySlug = z.string().min(2).max(48).regex(snake, "taxonomy slugs are lowercase snake_case");
export const Tag = z
  .string()
  .min(2)
  .max(LIMITS.tag)
  .regex(kebab, "tags must be short, lowercase kebab-case");
const Timestamp = z.iso.datetime({ offset: true });

export const ContextShape = {
  industry_group: z.enum(INDUSTRY_GROUPS).optional(),
  buyer: z.enum(BUYERS).optional(),
  acv_band: z.enum(ACV_BANDS).optional(),
  motion: z.enum(MOTIONS).optional(),
  region: z.enum(REGIONS).optional(),
};
export const ContextSchema = z.strictObject(ContextShape);
export type Context = z.infer<typeof ContextSchema>;

export const EntityRefSchema = z.union([
  z.strictObject({ entity_id: z.uuid() }),
  z.strictObject({ slug: Slug }),
]);
export type EntityRef = z.infer<typeof EntityRefSchema>;

export const ProposedEntitySchema = z.strictObject({
  type: z.enum(ENTITY_TYPES),
  name: z.string().min(2).max(LIMITS.entityName),
  slug: Slug.optional(),
  description: z.string().min(10).max(LIMITS.entityDescription),
  primary_function: TaxonomySlug,
  primary_subfunction: TaxonomySlug.optional(),
  secondary_subfunctions: z.array(TaxonomySlug).max(3).optional(),
  /** Workflows only: the ordered tool steps, as existing tool slugs. */
  workflow_steps: z.array(Slug).min(2).max(LIMITS.maxWorkflowSteps).optional(),
});
export type ProposedEntity = z.infer<typeof ProposedEntitySchema>;

export const ProposedSubfunctionSchema = z.strictObject({
  parent_function: TaxonomySlug,
  name: z.string().min(2).max(48),
  description: z.string().min(10).max(160),
});

const DimensionsSchema = z.partialRecord(z.enum(DIMENSIONS), z.number().min(0).max(1));

// Outcome fields shared by observations and readouts. Which ones are required
// depends on the entity type, which the server only knows after resolving the
// entity, so that check lives in validateOutcomeForType().
const OutcomeShape = {
  evidence_source: z.enum(EVIDENCE_SOURCES),
  rating: z.enum(RATINGS).optional(),
  run_count_band: z.enum(RUN_COUNT_BANDS).optional(),
  lift_band: z.enum(LIFT_BANDS).optional(),
  metric_kind: z.enum(METRIC_KINDS).optional(),
  sample_band: z.enum(SAMPLE_BANDS).optional(),
  dimensions: DimensionsSchema.optional(),
  failure_modes: z.array(z.enum(FAILURE_MODES)).max(LIMITS.maxFailureModes).optional(),
  rationale: z.string().min(20).max(LIMITS.rationale),
  observed_at: Timestamp,
};

export const ReportShape = {
  kind: z.enum(["observation", "readout"]),
  /** Observation: the existing entity being rated. */
  entity: EntityRefSchema.optional(),
  /** Observation: a new entity to create (lands as pending). */
  propose_entity: ProposedEntitySchema.optional(),
  /** Readout: the use this closes. */
  use_id: z.uuid().optional(),
  context: ContextSchema.optional(),
  ...OutcomeShape,
  tags: z.array(Tag).max(LIMITS.maxTags).optional(),
  proposed_subfunction: ProposedSubfunctionSchema.optional(),
  rules_version_seen: z.number().int().nonnegative().optional(),
};

export const ReportInputSchema = z.strictObject(ReportShape).superRefine((r, ctx) => {
  if (r.kind === "observation") {
    const refs = Number(!!r.entity) + Number(!!r.propose_entity);
    if (refs !== 1) ctx.addIssue({ code: "custom", path: ["entity"], message: "An observation needs exactly one of `entity` or `propose_entity`." });
    if (r.use_id) ctx.addIssue({ code: "custom", path: ["use_id"], message: "`use_id` belongs on a readout. Set kind to \"readout\"." });
    if (!r.context) ctx.addIssue({ code: "custom", path: ["context"], message: "An observation needs a `context` (use coarse enums only)." });
  } else {
    if (!r.use_id) ctx.addIssue({ code: "custom", path: ["use_id"], message: "A readout needs the `use_id` returned by waggle_log_use." });
    if (r.entity || r.propose_entity)
      ctx.addIssue({ code: "custom", path: ["entity"], message: "A readout takes its entity and context from the logged use; omit `entity`/`propose_entity`." });
  }
  if (r.failure_modes?.includes("injection_attempt") && r.rating && r.rating !== "harmful")
    ctx.addIssue({ code: "custom", path: ["rating"], message: "Content that tried to instruct the agent must be rated `harmful`." });
});
export type ReportInput = z.infer<typeof ReportInputSchema>;

export interface FieldIssue {
  path: string;
  message: string;
}

/** Cross-check outcome fields against the resolved entity type (§4.1). */
export function validateOutcomeForType(
  r: Pick<ReportInput, "rating" | "lift_band" | "metric_kind" | "sample_band" | "run_count_band" | "dimensions">,
  type: EntityType,
): FieldIssue[] {
  const issues: FieldIssue[] = [];
  if (type === "tactic") {
    if (!r.lift_band) issues.push({ path: "lift_band", message: "Tactic results need a relative `lift_band` (variant vs. control)." });
    if (!r.metric_kind) issues.push({ path: "metric_kind", message: "Tactic results need `metric_kind`: leading (opens, replies, CTR) or lagging (meetings, pipeline, conversions)." });
    if (!r.sample_band) issues.push({ path: "sample_band", message: "Tactic results need a `sample_band`." });
    if (r.rating) issues.push({ path: "rating", message: "Tactics use `lift_band`, not `rating`." });
    if (r.run_count_band) issues.push({ path: "run_count_band", message: "Tactics use `sample_band`, not `run_count_band`." });
    for (const d of Object.keys(r.dimensions ?? {}))
      if (!(TACTIC_DIMENSIONS as readonly string[]).includes(d))
        issues.push({ path: `dimensions.${d}`, message: `Tactics only take the dimension: ${TACTIC_DIMENSIONS.join(", ")}.` });
  } else {
    if (!r.rating) issues.push({ path: "rating", message: `A ${type} rating needs a rubric \`rating\`.` });
    if (r.lift_band || r.metric_kind || r.sample_band)
      issues.push({ path: "lift_band", message: `${type}s are rated with \`rating\` and \`run_count_band\`; lift/metric/sample fields are for tactics.` });
    for (const d of Object.keys(r.dimensions ?? {}))
      if (!(TOOL_DIMENSIONS as readonly string[]).includes(d))
        issues.push({ path: `dimensions.${d}`, message: `${type}s take the dimensions: ${TOOL_DIMENSIONS.join(", ")}.` });
  }
  return issues;
}

// ---- Read tools ----

export const CheckShape = {
  query: z.string().max(LIMITS.query).optional(),
  type: z.enum(ENTITY_TYPES).optional(),
  function: TaxonomySlug.optional(),
  subfunction: TaxonomySlug.optional(),
  tags: z.array(Tag).max(LIMITS.maxTags).optional(),
  context: ContextSchema.optional(),
  recommended_only: z.boolean().optional(),
  limit: z.number().int().min(1).max(25).optional(),
  rules_version_seen: z.number().int().nonnegative().optional(),
};
export const CheckInputSchema = z.strictObject(CheckShape);
export type CheckInput = z.infer<typeof CheckInputSchema>;

export const DiscoverShape = {
  task: z.string().min(10).max(LIMITS.task),
  type: z.enum(ENTITY_TYPES).optional(),
  context: ContextSchema.optional(),
  limit: z.number().int().min(1).max(25).optional(),
  rules_version_seen: z.number().int().nonnegative().optional(),
};
export const DiscoverInputSchema = z.strictObject(DiscoverShape);
export type DiscoverInput = z.infer<typeof DiscoverInputSchema>;

export const InspectShape = {
  entity: EntityRefSchema,
  context: ContextSchema.optional(),
  rules_version_seen: z.number().int().nonnegative().optional(),
};
export const InspectInputSchema = z.strictObject(InspectShape);
export type InspectInput = z.infer<typeof InspectInputSchema>;

export const PlaybooksShape = {
  query: z.string().min(2).max(LIMITS.query),
  limit: z.number().int().min(1).max(10).optional(),
  rules_version_seen: z.number().int().nonnegative().optional(),
};
export const PlaybooksInputSchema = z.strictObject(PlaybooksShape);
export type PlaybooksInput = z.infer<typeof PlaybooksInputSchema>;

export const OpenTestsShape = {
  include: z.enum(["due", "open", "all"]).optional(),
  rules_version_seen: z.number().int().nonnegative().optional(),
};
export const OpenTestsInputSchema = z.strictObject(OpenTestsShape);
export type OpenTestsInput = z.infer<typeof OpenTestsInputSchema>;

export const GetRulesShape = {};
export const GetRulesInputSchema = z.strictObject(GetRulesShape);

// ---- Write tools ----

export const TEST_DESIGNS = ["ab_test", "before_after", "no_control"] as const;

export const LogUseShape = {
  entity: EntityRefSchema,
  context: ContextSchema,
  applied_at: Timestamp.optional(),
  test_design: z.enum(TEST_DESIGNS).optional(),
  rules_version_seen: z.number().int().nonnegative().optional(),
};
export const LogUseInputSchema = z.strictObject(LogUseShape);
export type LogUseInput = z.infer<typeof LogUseInputSchema>;

/** Turn a ZodError into the short, fixable messages agents get back. */
export function formatZodIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((i) => ({ path: i.path.join(".") || "(root)", message: i.message }));
}
