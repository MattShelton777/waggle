# Blueprints (proposal, not built)

Run 1 of the user test showed that Waggle's entries name a tool or a list of steps but don't say how to use them, so agents read the entry and then searched the web anyway. A blueprint is the structured how-to that sits on a tool or workflow entry. It is meant to make an agent's documentation lookup short and targeted, not to replace it.

## How an agent uses it (the docs-lookup step)
1. `waggle_check` or `waggle_discover` finds the entry.
2. `waggle_inspect` returns its score, its evidence and `blueprint_data`.
3. The agent fetches only the pages in `docs`, and only for the facts listed in `verify_live` (pricing, limits, endpoints: things that go stale).
4. It builds with the blueprint's steps, settings, thresholds and pitfalls.
5. It reports back with `waggle_report`, and later can suggest blueprint changes.

Waggle holds what docs never say: what works in practice, the order of steps, thresholds that matter, pitfalls and real cost. Docs hold what changes: endpoints, prices and limits. The token savings should come from exploring fewer options and hitting fewer dead ends, not from skipping docs.

## Format (v1)
Every item that states a fact carries `source`: `first_hand` (an operator did it), `docs` (taken from official docs, with a check date) or `inferred` (reasoned, not tested). Agents can then weigh each line.

```json
{
  "blueprint_version": 1,
  "entity": "slug",
  "summary": "What it does and when to reach for it, 1-3 sentences.",
  "use_when": ["..."],
  "avoid_when": ["..."],
  "inputs":  [{ "name": "", "kind": "text|list|csv|url|number", "required": true, "note": "" }],
  "outputs": [{ "name": "", "format": "csv|json|table|text", "fields": [""], "note": "" }],
  "setup":   [{ "do": "", "source": "first_hand|docs|inferred" }],
  "steps":   [{ "n": 1, "do": "", "tool": "slug or null", "settings": {}, "check": "how you know it worked", "gotchas": [""], "source": "" }],
  "thresholds": [{ "name": "", "value": "", "why": "", "source": "" }],
  "pitfalls":   [{ "issue": "", "fix": "", "source": "" }],
  "quality_bar": ["what good output looks like"],
  "cost": { "band": "free|lt_50|50_250|250_1k|gt_1k", "per": "run|month|1k_records", "drivers": [""], "free_alternatives": [""], "source": "" },
  "time": { "setup": "lt_1h|1_4h|1_day|gt_1_day", "per_run": "lt_15m|15m_1h|1_4h|gt_4h" },
  "limits":  [{ "what": "", "note": "", "source": "" }],
  "docs":    [{ "title": "", "url": "https://<vendor domain>/...", "covers": ["api|pricing|limits|setup|changelog"], "checked": "YYYY-MM-DD" }],
  "verify_live": ["facts the agent must re-check in docs before relying on them"],
  "related": ["slug"],
  "evidence": { "first_hand_runs": "1|2_10|11_50|gt_50", "last_first_hand": "YYYY-MM" }
}
```

Tools use `setup`, `settings` (inside steps), `limits` and `docs`. Workflows use `steps` with a `tool` per step. Tactics keep their lift bands and get only `summary`, `use_when`, `avoid_when`, `pitfalls` and `quality_bar`.

## Privacy rule changes this needs
Today Waggle content may hold no numbers, names or URLs. Blueprints need three narrow exceptions:
- **Configuration numbers** are allowed: thresholds, settings, rate limits and cost bands. Outcome numbers are still banned; results stay as bands.
- **Doc URLs** are allowed only in `docs`, only over https, and only on the tool's own vendor domain (a new `vendor_domain` attribute per tool).
- **Names** are allowed only for the tool's vendor. Customer, client and company names stay banned.
`scrubReport` gets a blueprint mode that enforces this. Injection patterns still quarantine.

## Storage
- A new append-only table, `waggle.blueprints` (entity_id, version, body jsonb, contributed_by, status, created_at), with a view that picks the current accepted version. No updates or deletes, in line with the events rule.
- `api_get_blueprint(entity_id)`. `waggle_inspect` returns `blueprint_data`, plus a short `docs_step_data` that names the pages and facts to re-check.
- The blueprint summary and steps are embedded, so `check` and `discover` match on how-to text, not just ratings.
- v1: blueprints are seeded by migration, curated with the operator. v2: `waggle_report` takes an optional blueprint suggestion, which goes to moderation as pending.

## What gets built after a yes
1. Migration: table, view, `api_get_blueprint`, `vendor_domain`.
2. Core: a Zod schema for the format, and the blueprint scrub mode.
3. Server: `inspect` returns the blueprint; check and discover use its embedding.
4. Skill: SKILL.md gets the five-step flow above.
5. Seed blueprints for the 9 entries with first-hand ratings, from the operator's own notes plus official docs.
