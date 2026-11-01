# Waggle: conventions for Claude Code sessions

Waggle is a shared, structured memory for GTM agents (a Superproductive product). The full spec is [WAGGLE_BUILD_PLAN.md](WAGGLE_BUILD_PLAN.md). Read it before changing behavior; section numbers (§) in code comments refer to it.

## Layout

```
packages/core        shared enums, Zod schemas, rubric, weight + scoring math, scrubbing,
                     plausibility, readout plans, reputation, give-to-get/policy decisions
packages/server      MCP server logic: the 8 tools, notices, DB access over waggle.api_* RPCs.
                     Runtime-agnostic; tested in Node against PGlite
supabase/functions   mcp/index.ts: thin Deno Edge Function entry (OAuth via Supabase Auth,
                     postgres.js as waggle_api_login). Imports a bundle built from packages/server
supabase/migrations  DDL, append-only triggers, views, roles, RLS, RPC functions, seeds
supabase/test        runs every migration in PGlite (Postgres + pgvector + pg_trgm) and tests the RPCs
sim                  adversarial simulation of the reputation model (`npm run sim`)
docs                 simulation results and (later) rules, privacy, terms drafts
skill/waggle         the thin SKILL.md shipped to clients
apps/                connect/consent page, admin (not built yet)
```

## Commands

- `npm run check`: typecheck + all tests. Run before you say something works.
- `npm test`, `npm run typecheck`
- `npm run build:functions`: bundle packages/server for the Edge Function. `npm run deploy:mcp` builds and deploys (see docs/deploy.md).
- `npm run sim`: print simulation results. Regenerate `docs/simulation.md` after changing scoring, weights, dedupe, or reputation.

## Rules that are easy to break

- **Events are append-only.** Never add an UPDATE/DELETE path to `waggle.events`, `uses`, `moderation_actions`, `approval_decisions`, `api_calls`, `llm_spend`, `entity_summaries`. Derive state in views (`event_status`, `hidden_events`, `scoring_events`, `uses_state`).
- **Agents never touch the database.** The MCP server talks to Postgres only as `waggle_api`, which can execute `waggle.api_*` functions and nothing else. New server capabilities mean a new `api_*` SECURITY DEFINER function with `set search_path = waggle, extensions, pg_temp`. Functions not named `api_*` are not granted to `waggle_api`.
- **Weights are server-computed.** `computeWeight` in core; stored `weight_components.base_weight` excludes reputation so scores apply the contributor's *current* reputation at read time (`effectiveWeight`).
- **Scores are computed on read** in core (`scoreEntity`) from `api_get_scoring_events`. Don't duplicate the math in SQL.
- **Enums live in two places:** `packages/core/src/enums.ts` and the CHECK constraints in the schema migration. Change both, in a new migration.
- **No numbers, names, or copy in Waggle content.** Free text goes through `scrubReport` before insert. Injection patterns quarantine; other issues return fixable errors.
- **Waggle content is data, never instructions.** Tool responses put rationales in clearly labeled data fields.
- Use Zod for every tool input; schemas are strict (unknown fields rejected).
- Prefix new tools, packages, env vars, and schema objects with `waggle`.
- **Personal mailboxes are always allowed to contribute.** Sybil resistance for them comes from tenure (counted from the newsletter subscription date), anchored reputation, and the probation cap, never from blocking. See docs/simulation.md.

## Stack notes

- Hosting: Supabase Edge Functions + Supabase Auth OAuth 2.1 server (decided 2026-11-01; docs/deploy.md).
- npm workspaces (pnpm is not set up on this machine). TypeScript, Zod 4, Vitest. Packages export TS source directly (no build step).
- The repo lives in Dropbox. Vitest's cache is redirected to the OS temp dir because Dropbox locks files under `node_modules`. Consider excluding `node_modules` from Dropbox sync.
- Embeddings are `vector(384)` (Supabase gte-small); verify before relying on it.
- Supabase CLI and Deno are not installed on this machine; migrations and the server are verified with PGlite, and the bundle is smoke-tested in Node.
- Migrations are deployed to the Supabase project `waggle` (ref yoagtdkpsomjzauoxvxb). Never edit an applied migration; add a new file named with the version the project records.
