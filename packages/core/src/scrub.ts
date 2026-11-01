import type { ReportInput } from "./schemas";

// §5.2 rule-based scrubbing. Zero-token, runs on every write.
// Most problems are "reject" (the agent gets a fixable message and resubmits).
// Prompt-injection patterns are "quarantine": the submission is logged with
// the flag, never shown to other agents, and counts against the contributor.

export type ScrubCode =
  | "email"
  | "phone"
  | "url"
  | "domain"
  | "long_number"
  | "absolute_number"
  | "currency"
  | "decimal_percent"
  | "quoted_copy"
  | "denylisted_name"
  | "injection"
  | "imperative"
  | "encoded_blob"
  | "control_chars";

export interface ScrubIssue {
  field: string;
  code: ScrubCode;
  severity: "reject" | "quarantine";
  message: string;
}

export interface ScrubOptions {
  /** Company/brand names that must never appear in free text (case-insensitive, whole word). */
  denylist?: readonly string[];
  /** Quoted spans longer than this many words are treated as verbatim copy. */
  maxQuotedWords?: number;
}

const COMMON_TLDS =
  "com|io|ai|co|net|org|app|dev|so|xyz|us|uk|de|fr|ca|au|me|gg|biz|info|tech|cloud|ly|to|sh|in|eu|nl|es|it|ch|se|no|fi|dk|be|at|nz|sg|jp|br|mx|site|online|store|shop|agency|team|tools|email|page";

interface Rule {
  code: ScrubCode;
  severity: ScrubIssue["severity"];
  pattern: RegExp;
  message: string;
}

const RULES: Rule[] = [
  { code: "email", severity: "reject", pattern: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i, message: "Remove the email address. Waggle never stores personal data." },
  { code: "url", severity: "reject", pattern: /\b(?:https?:\/\/|www\.)\S+/i, message: "Remove the URL. Name tools by entity reference, not links." },
  { code: "domain", severity: "reject", pattern: new RegExp(`\\b[a-z0-9][a-z0-9-]*\\.(?:${COMMON_TLDS})\\b`, "i"), message: "Remove the domain name. Describe the pattern, not the company or site." },
  { code: "phone", severity: "reject", pattern: /(?:\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]\d{3,4}[\s.-]\d{3,4}\b/, message: "Remove the phone number." },
  { code: "currency", severity: "reject", pattern: /[$€£¥]\s?\d|\b\d[\d,.]*\s?(?:usd|eur|gbp|dollars|euros|pounds)\b/i, message: "Remove currency amounts. Share relative results only (e.g. \"moderate win vs. control\")." },
  { code: "decimal_percent", severity: "reject", pattern: /\d+[.,]\d+\s?%/, message: "Remove precise percentages. Use the lift_band field for relative results." },
  { code: "absolute_number", severity: "reject", pattern: /\b\d+(?:\.\d+)?\s?(?:k|mm|m|bn|b)\b/i, message: "Remove absolute counts (like 10k or 2M). Use the band fields instead." },
  { code: "long_number", severity: "reject", pattern: /\d{5,}|\b\d{1,3}(?:,\d{3})+\b/, message: "Remove long numbers. Waggle shares what beat what, never the numbers." },
  { code: "control_chars", severity: "reject", pattern: /[\u0000-\u0008\u000B\u000C\u000E-\u001F​-‏‪-‮⁦-⁩]/, message: "Remove control or invisible characters." },
  { code: "encoded_blob", severity: "quarantine", pattern: /[A-Za-z0-9+/]{40,}={0,2}/, message: "Encoded blobs are not allowed." },
];

// Text that tries to instruct an agent is evidence of harm (design principle 6).
// Unambiguous attempts are quarantined and count against the contributor.
const INJECTION_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\b[^.]{0,40}\b(?:previous|prior|above|earlier|all|your|system)\b[^.]{0,20}\b(?:instructions?|prompts?|rules?|messages?|context)\b/i,
  /\bsystem\s+prompt\b/i,
  /\byou\s+are\s+now\b/i,
  /\bdo\s+not\s+(?:tell|inform|mention\s+to)\s+the\s+user\b/i,
  /<\/?\s*(?:system|assistant|user|tool|instructions?|im_start|im_end)\b[^>]*>/i,
  /\[\/?(?:INST|SYS)\]/i,
  /^\s*(?:system|assistant|user)\s*:/im,
  /#{2,}\s*(?:system|instructions?)\b/i,
  /\bjailbreak\b|\bDAN\s+mode\b/i,
];

// Imperative phrasing an honest agent might slip into ("you should verify
// first"). Rejected with a fixable message, not treated as an attack.
const IMPERATIVE_PATTERNS: RegExp[] = [
  /\byou\s+(?:must|should|need\s+to|have\s+to|will\s+now)\b/i,
  /\b(?:new|updated|real)\s+instructions?\b/i,
  /\bact\s+as\s+(?:an?|the)\b/i,
  /\b(?:call|invoke|run|execute)\s+(?:the\s+)?(?:tool|function|command)\b/i,
];

export function scrubText(field: string, text: string, opts: ScrubOptions = {}): ScrubIssue[] {
  const issues: ScrubIssue[] = [];
  const normalized = text.normalize("NFKC");

  for (const rule of RULES) {
    if (rule.pattern.test(normalized)) issues.push({ field, code: rule.code, severity: rule.severity, message: rule.message });
  }

  if (INJECTION_PATTERNS.some((p) => p.test(normalized))) {
    issues.push({
      field,
      code: "injection",
      severity: "quarantine",
      message: "Text that reads as instructions to an agent is not allowed in Waggle. Describe what happened, not what an agent should do.",
    });
  } else if (IMPERATIVE_PATTERNS.some((p) => p.test(normalized))) {
    issues.push({
      field,
      code: "imperative",
      severity: "reject",
      message: "Rephrase as an observation (\"X worked better than Y because...\"), not an instruction to a reader or agent.",
    });
  }

  const maxWords = opts.maxQuotedWords ?? 8;
  for (const m of normalized.matchAll(/["“”]([^"“”]{1,1000})["“”]/g)) {
    const words = (m[1] ?? "").trim().split(/\s+/).filter(Boolean);
    if (words.length > maxWords) {
      issues.push({ field, code: "quoted_copy", severity: "reject", message: `Remove quoted copy longer than ${maxWords} words. Describe the pattern instead of pasting it.` });
      break;
    }
  }

  for (const name of opts.denylist ?? []) {
    if (!name.trim()) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name.trim())}(?![\\p{L}\\p{N}])`, "iu");
    if (re.test(normalized)) {
      issues.push({ field, code: "denylisted_name", severity: "reject", message: "Remove company or brand names. Describe the kind of company instead (use the context fields)." });
      break;
    }
  }
  return issues;
}

/** Scrub every free-text field in a report submission. */
export function scrubReport(r: ReportInput, opts: ScrubOptions = {}): ScrubIssue[] {
  const issues: ScrubIssue[] = [];
  issues.push(...scrubText("rationale", r.rationale, opts));
  if (r.propose_entity) {
    // Tool entities are named after the product itself, so the company
    // denylist doesn't apply to a tool's name. Everything else still does.
    const nameOpts = r.propose_entity.type === "tool" ? { ...opts, denylist: [] } : opts;
    issues.push(...scrubText("propose_entity.name", r.propose_entity.name, nameOpts));
    issues.push(...scrubText("propose_entity.description", r.propose_entity.description, opts));
  }
  if (r.proposed_subfunction) {
    issues.push(...scrubText("proposed_subfunction.name", r.proposed_subfunction.name, opts));
    issues.push(...scrubText("proposed_subfunction.description", r.proposed_subfunction.description, opts));
  }
  r.tags?.forEach((t, i) => issues.push(...scrubText(`tags.${i}`, t, opts)));
  return issues;
}

export function hasQuarantine(issues: readonly ScrubIssue[]): boolean {
  return issues.some((i) => i.severity === "quarantine");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
