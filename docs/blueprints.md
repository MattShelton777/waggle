# Blueprints

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
- `waggle.blueprints` (entity_id, version, body jsonb, origin curated|contributed, status accepted|pending|rejected, contributed_by, created_at) is append-only: a change is a new version. Migration `20261116190000_waggle_blueprints.sql`.
- `waggle.current_blueprints` picks the latest accepted version, for tools and workflows only.
- `api_get_blueprint(entity_id)` returns `{version, updated_at, body}`; `api_blueprint_entity_ids()` lets check and discover set `has_blueprint`.
- `waggle_inspect` returns `blueprint_data` and a short `docs_step` that names the pages and facts to re-check.
- Docs links are allowed only on the entity's `attributes.vendor_domains` (subdomains included); `packages/core/src/blueprint.ts` holds the schema and the blueprint scrub mode.

## Seeding
- Seed files live in `seed/blueprints/<slug>.json` as `{ "vendor_domains": [...], "blueprint": {...} }`. The core tests validate every file.
- `node scripts/blueprint-seed.mjs supabase/migrations/<version>_waggle_seed_blueprints.sql` writes the migration; `supabase/test/blueprint-seed.test.ts` fails if the committed file and the JSON drift. To change a seeded blueprint, edit the JSON and write a new migration with a new version (each run appends a version).
- The first seed (2026-11-16) covers 12 entries. `first_hand` lines come only from the operator's own ratings; `docs` lines come from official pages checked that day; the rest are `inferred`. perplexity, exa, smartlead and signal-to-sequence have no first-hand use yet (`first_hand_runs: "0"`).

## Not built yet
- Embedding the blueprint summary and steps for check and discover.
- Contributed blueprints: `waggle_report` taking an optional blueprint suggestion that lands as `pending` for moderation.
