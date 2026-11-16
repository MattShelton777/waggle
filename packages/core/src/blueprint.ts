import { z } from "zod";
import { scrubText, type ScrubIssue, type ScrubOptions } from "./scrub";

// Blueprints (docs/blueprints.md): the structured how-to on a tool or workflow.
// They relax three report rules, and only inside a blueprint:
// - configuration numbers (thresholds, settings, limits) are allowed; outcome
//   numbers are not, and money stays in cost bands;
// - URLs are allowed only in docs[].url, over https, on the entity's vendor domains;
// - vendor names are allowed; customer, client and company names are not (denylist).
// Injection patterns still quarantine.

const txt = (max = 400) => z.string().trim().min(1).max(max);
const SOURCE = z.enum(["first_hand", "docs", "inferred"]);
const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(64);
const settingValue = z.union([z.string().max(120), z.number(), z.boolean()]);

export const BLUEPRINT_COST_BANDS = ["free", "lt_50", "50_250", "250_1k", "gt_1k"] as const;
export const BLUEPRINT_SETUP_BANDS = ["lt_1h", "1_4h", "1_day", "gt_1_day"] as const;
export const BLUEPRINT_RUN_BANDS = ["lt_15m", "15m_1h", "1_4h", "gt_4h"] as const;
export const BLUEPRINT_RUN_COUNT_BANDS = ["0", "1", "2_10", "11_50", "gt_50"] as const;

export const BlueprintSchema = z.strictObject({
  blueprint_version: z.literal(1),
  entity: slug,
  summary: txt(600),
  use_when: z.array(txt(200)).max(8).default([]),
  avoid_when: z.array(txt(200)).max(8).default([]),
  inputs: z
    .array(z.strictObject({ name: txt(60), kind: z.enum(["text", "list", "csv", "url", "number", "json"]), required: z.boolean(), note: txt(200).optional() }))
    .max(12)
    .default([]),
  outputs: z
    .array(z.strictObject({ name: txt(60), format: z.enum(["csv", "json", "table", "text", "records"]), fields: z.array(txt(60)).max(30).default([]), note: txt(200).optional() }))
    .max(8)
    .default([]),
  setup: z.array(z.strictObject({ do: txt(300), source: SOURCE })).max(12).default([]),
  steps: z
    .array(
      z.strictObject({
        n: z.number().int().min(1).max(30),
        do: txt(400),
        tool: slug.nullable().default(null),
        settings: z.record(z.string().max(60), settingValue).default({}),
        check: txt(200).optional(),
        gotchas: z.array(txt(300)).max(6).default([]),
        source: SOURCE,
      }),
    )
    .max(20)
    .default([]),
  thresholds: z.array(z.strictObject({ name: txt(80), value: txt(60), why: txt(300), source: SOURCE })).max(12).default([]),
  pitfalls: z.array(z.strictObject({ issue: txt(300), fix: txt(300), source: SOURCE })).max(12).default([]),
  quality_bar: z.array(txt(200)).max(8).default([]),
  cost: z
    .strictObject({
      band: z.enum(BLUEPRINT_COST_BANDS),
      per: z.enum(["run", "month", "1k_records"]),
      drivers: z.array(txt(200)).max(6).default([]),
      free_alternatives: z.array(txt(200)).max(6).default([]),
      source: SOURCE,
    })
    .optional(),
  time: z.strictObject({ setup: z.enum(BLUEPRINT_SETUP_BANDS).optional(), per_run: z.enum(BLUEPRINT_RUN_BANDS).optional() }).optional(),
  limits: z.array(z.strictObject({ what: txt(120), note: txt(300), source: SOURCE })).max(10).default([]),
  docs: z
    .array(
      z.strictObject({
        title: txt(120),
        url: z.string().url().max(300),
        covers: z.array(z.enum(["api", "pricing", "limits", "setup", "changelog", "concepts"])).min(1).max(6),
        checked: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }),
    )
    .max(10)
    .default([]),
  verify_live: z.array(txt(200)).max(10).default([]),
  related: z.array(slug).max(10).default([]),
  evidence: z.strictObject({ first_hand_runs: z.enum(BLUEPRINT_RUN_COUNT_BANDS), last_first_hand: z.string().regex(/^\d{4}-\d{2}$/).nullable() }),
});
export type Blueprint = z.infer<typeof BlueprintSchema>;

export interface BlueprintIssue {
  field: string;
  code: ScrubIssue["code"] | "doc_url_host" | "doc_url_scheme";
  severity: "reject" | "quarantine";
  message: string;
}

// Report rules that blueprints relax: numbers in settings and thresholds, and
// imperative step text ("Search for...") which is the point of a how-to.
const RELAXED = new Set<ScrubIssue["code"]>(["absolute_number", "long_number", "decimal_percent", "imperative", "url", "domain"]);
const DOMAIN_RE = /\b(?:[a-z0-9-]+\.)+[a-z]{2,24}\b/gi;

function hostAllowed(host: string, domains: readonly string[]) {
  const h = host.toLowerCase();
  return domains.some((d) => h === d.toLowerCase() || h.endsWith(`.${d.toLowerCase()}`));
}

/** Every free-text string in a blueprint, with its path (docs URLs excluded). */
function textFields(bp: Blueprint): [string, string][] {
  const out: [string, string][] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") out.push([path, v]);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        if (path === "" && (k === "entity" || k === "related" || k === "evidence")) continue;
        if (/^docs\[\d+\]$/.test(path) && (k === "url" || k === "checked" || k === "covers")) continue;
        walk(x, path ? `${path}.${k}` : k);
      }
  };
  walk(bp, "");
  return out;
}

/**
 * Check a parsed blueprint against Waggle's content rules in blueprint mode.
 * `vendorDomains` are the domains docs links may point to (the tool's own, or a
 * workflow's step tools plus any standards pages it cites).
 */
export function checkBlueprint(bp: Blueprint, vendorDomains: readonly string[], opts: ScrubOptions = {}): BlueprintIssue[] {
  const issues: BlueprintIssue[] = [];
  for (const [field, text] of textFields(bp)) {
    for (const i of scrubText(field, text, opts)) if (!RELAXED.has(i.code)) issues.push(i);
    if (/\b(?:https?:\/\/|www\.)\S+/i.test(text))
      issues.push({ field, code: "url", severity: "reject", message: "Links belong in docs[].url only." });
    else if (scrubText(field, text).some((i) => i.code === "domain") && [...text.matchAll(DOMAIN_RE)].some((m) => !hostAllowed(m[0], vendorDomains)))
      issues.push({ field, code: "domain", severity: "reject", message: "Only the tool vendor's own domain may be named in a blueprint." });
  }
  bp.docs.forEach((d, i) => {
    const u = new URL(d.url);
    if (u.protocol !== "https:") issues.push({ field: `docs[${i}].url`, code: "doc_url_scheme", severity: "reject", message: "Doc links must use https." });
    if (!hostAllowed(u.hostname, vendorDomains))
      issues.push({ field: `docs[${i}].url`, code: "doc_url_host", severity: "reject", message: "Doc links must be on the tool vendor's own domain." });
    if (u.search || u.hash || u.username || u.password)
      issues.push({ field: `docs[${i}].url`, code: "doc_url_host", severity: "reject", message: "Doc links take no query, fragment or credentials." });
  });
  return issues;
}

/** Parse and check; returns the blueprint or the problems. */
export function validateBlueprint(raw: unknown, vendorDomains: readonly string[], opts: ScrubOptions = {}) {
  const parsed = BlueprintSchema.safeParse(raw);
  if (!parsed.success) return { ok: false as const, issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  const issues = checkBlueprint(parsed.data, vendorDomains, opts);
  return issues.length ? { ok: false as const, issues: issues.map((i) => `${i.field}: ${i.message}`) } : { ok: true as const, blueprint: parsed.data };
}
