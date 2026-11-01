import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { beforeAll, describe, expect, it } from "vitest";
import {
  approvalToken,
  beehiivProvider,
  checkSubscriber,
  decideApproval,
  getAccount,
  linkAccount,
  setPolicy,
  WaggleDb,
  type ConnectDeps,
  type NewsletterProvider,
} from "../src";

const migrations = join(import.meta.dirname, "..", "..", "..", "supabase", "migrations");
let pg: PGlite;
let deps: ConnectDeps;

const subscribers: Record<string, Date> = {
  "reader@gmail.com": new Date("2024-03-01T00:00:00Z"),
  "ops@acme-co.com": new Date("2025-06-01T00:00:00Z"),
};
const fakeNewsletter: NewsletterProvider = {
  async lookup(email) {
    const at = subscribers[email.toLowerCase()];
    return { active: !!at, subscribedAt: at ?? null };
  },
};

beforeAll(async () => {
  pg = await PGlite.create({ extensions: { vector, pg_trgm } });
  for (const f of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) await pg.exec(readFileSync(join(migrations, f), "utf8"));
  const db = new WaggleDb(async (text, params) => (await pg.query<Record<string, unknown>>(text, params)).rows);
  deps = { db, newsletter: fakeNewsletter, subscribeUrl: "https://superproductive.co" };
});

describe("connect routes", () => {
  it("tells non-subscribers to subscribe before sending a magic link", async () => {
    expect((await checkSubscriber(deps, "reader@gmail.com")).body).toEqual({ subscribed: true });
    expect((await checkSubscriber(deps, "stranger@example.com")).body).toMatchObject({ subscribed: false, subscribe_url: "https://superproductive.co" });
    expect((await checkSubscriber(deps, "not-an-email")).status).toBe(400);
  });

  it("links a verified subscriber with newsletter tenure and personal-domain flag", async () => {
    const user = { id: crypto.randomUUID(), email: "Reader@Gmail.com" };
    const r = await linkAccount(deps, user, "ask_always");
    expect(r.status).toBe(200);
    expect(r.body.policy).toBe("ask_always");
    const row = (await pg.query<{ is_personal_domain: boolean; newsletter_subscribed_at: Date; reputation: string; auth_user_id: string }>(
      "select is_personal_domain, newsletter_subscribed_at, reputation, auth_user_id from waggle.subscribers where email = 'reader@gmail.com'",
    )).rows[0]!;
    expect(row.is_personal_domain).toBe(true);
    expect(row.newsletter_subscribed_at.toISOString()).toBe("2024-03-01T00:00:00.000Z");
    expect(Number(row.reputation)).toBe(0.7);
    expect(row.auth_user_id).toBe(user.id);

    // Linking again is idempotent and keeps the policy unless a new one is given.
    const again = await linkAccount(deps, user, undefined);
    expect(again.body.subscriber_id).toBe(r.body.subscriber_id);
    expect(again.body.policy).toBe("ask_always");
  });

  it("refuses to link non-subscribers", async () => {
    const r = await linkAccount(deps, { id: crypto.randomUUID(), email: "stranger@example.com" }, undefined);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("not_subscribed");
  });

  it("validates and saves the contribution policy", async () => {
    const user = { id: crypto.randomUUID(), email: "ops@acme-co.com" };
    expect((await setPolicy(deps, user, "auto_all")).status).toBe(404);
    await linkAccount(deps, user, undefined);
    expect((await getAccount(deps, user)).body).toMatchObject({ connected: true, policy: "auto_low_risk" });
    expect((await setPolicy(deps, user, "yolo")).status).toBe(400);
    expect((await setPolicy(deps, user, "auto_all")).body).toEqual({ policy: "auto_all" });
    expect((await getAccount(deps, user)).body.policy).toBe("auto_all");
  });

  it("decides approvals from the emailed token, once", async () => {
    // Create a pending event the way the MCP server does, with the HMAC-derived token hash.
    const sub = (await pg.query<{ id: string }>("select id from waggle.subscribers where email = 'reader@gmail.com'")).rows[0]!.id;
    const eventId = crypto.randomUUID();
    const token = await approvalToken("secret", eventId);
    const { approvalTokenHashFromToken } = await import("../src");
    await pg.query("select waggle.api_submit_event($1, $2::jsonb, $3::jsonb, null, null, $4)", [
      sub,
      JSON.stringify({
        id: eventId, kind: "observation", score: 0.8, weight: 0.5, weight_components: { base_weight: 0.5 },
        evidence_source: "platform_read", rating: "good", rationale: "Pattern worked well for local trades lists in testing.",
        observed_at: new Date().toISOString(), status: "awaiting_approval", screen_results: {},
      }),
      JSON.stringify({ type: "tool", slug: "test-tool", name: "Test tool", description: "A tool used to test approvals.", primary_function: "gtm_engineering" }),
      await approvalTokenHashFromToken(token),
    ]);

    expect((await decideApproval(deps, "short", "approve")).status).toBe(400);
    expect((await decideApproval(deps, token, "maybe")).status).toBe(400);
    expect((await decideApproval(deps, "x".repeat(43), "approve")).status).toBe(410);
    expect((await decideApproval(deps, token, "approve")).body).toMatchObject({ event_id: eventId, status: "accepted" });
    expect((await decideApproval(deps, token, "discard")).body.status).toBe("already_decided");
    const entity = (await pg.query<{ status: string }>("select status from waggle.entities where slug = 'test-tool'")).rows[0]!;
    expect(entity.status).toBe("active");
  });
});

describe("beehiiv provider", () => {
  const fakeFetch = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("maps active subscriptions and their start date", async () => {
    const p = beehiivProvider("key", "pub_1", fakeFetch(200, { data: { status: "active", created: 1709251200 } }));
    expect(await p.lookup("A@B.com")).toEqual({ active: true, subscribedAt: new Date(1709251200 * 1000) });
  });

  it("treats inactive or missing subscribers as not active", async () => {
    expect((await beehiivProvider("k", "p", fakeFetch(200, { data: { status: "inactive" } })).lookup("a@b.com")).active).toBe(false);
    expect((await beehiivProvider("k", "p", fakeFetch(404, {})).lookup("a@b.com")).active).toBe(false);
  });

  it("throws on API errors rather than locking people out silently", async () => {
    await expect(beehiivProvider("k", "p", fakeFetch(500, {})).lookup("a@b.com")).rejects.toThrow(/500/);
  });
});
