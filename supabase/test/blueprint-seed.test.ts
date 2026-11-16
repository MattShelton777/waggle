import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without types
import { blueprintSeedSql } from "../../scripts/blueprint-seed.mjs";

// The seed migration is generated from seed/blueprints/*.json. This keeps the
// committed file in step with the JSON and checks every blueprint lands.

const root = join(import.meta.dirname, "..", "..");
const dir = join(root, "supabase", "migrations");
const seedFile = readdirSync(dir).find((f) => f.endsWith("_waggle_seed_blueprints.sql"))!;
const seedSlugs = readdirSync(join(root, "seed", "blueprints"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""));
let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create({ extensions: { vector, pg_trgm } });
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(dir, f), "utf8"));
  }
});

describe("blueprint seed", () => {
  it("matches the generator output", () => {
    expect(readFileSync(join(dir, seedFile), "utf8")).toBe(blueprintSeedSql(join(root, "seed", "blueprints")));
  });

  it("lands one accepted blueprint per seed file", async () => {
    const r = await db.query<{ slug: string }>(
      "select e.slug from waggle.current_blueprints b join waggle.entities e on e.id = b.entity_id order by 1",
    );
    expect(r.rows.map((x) => x.slug)).toEqual([...seedSlugs].sort());
  });

  it("sets vendor domains and serves the body through the API", async () => {
    const e = await db.query<{ id: string; domains: string[] }>(
      "select id, attributes->'vendor_domains' as domains from waggle.entities where slug = 'ahrefs'",
    );
    expect(e.rows[0]!.domains).toEqual(["ahrefs.com"]);
    const bp = await db.query<{ r: { version: number; body: { entity: string } } }>("select waggle.api_get_blueprint($1) as r", [e.rows[0]!.id]);
    expect(bp.rows[0]!.r.version).toBe(1);
    expect(bp.rows[0]!.r.body.entity).toBe("ahrefs");
  });
});

describe("playbooks removal", () => {
  it("drops the playbook tables and search function", async () => {
    const r = await db.query<{ n: number }>(
      "select (select count(*) from pg_tables where schemaname = 'waggle' and tablename like 'playbook%') + (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'waggle' and p.proname = 'api_search_playbooks') as n",
    );
    expect(Number(r.rows[0]!.n)).toBe(0);
  });
});
