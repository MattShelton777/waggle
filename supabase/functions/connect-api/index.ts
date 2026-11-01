// JSON API behind the connect and consent pages (apps/connect).
//
//   POST /connect-api/check     { email }              public: is this email an active subscriber?
//   POST /connect-api/link      { policy? }            signed in: verify subscription, create/link subscriber
//   GET  /connect-api/account                          signed in: connection status and policy
//   POST /connect-api/policy    { policy }             signed in: change contribution policy
//   POST /connect-api/approval  { token, decision }    public: one-click approval link (token is the secret)
//
// Signed-in routes take the user's Supabase Auth access token (magic-link session).
// Uses the same waggle_api_login DB role as the MCP function.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { pipeline } from "npm:@supabase/middleware@1";
import { withSupabase } from "npm:@supabase/server@1";
import postgres from "npm:postgres@3.4.9";
import {
  beehiivProvider,
  checkSubscriber,
  decideApproval,
  getAccount,
  linkAccount,
  setPolicy,
  WaggleDb,
} from "../_shared/waggle.bundle.js";

const env = (name: string) => {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing secret ${name}`);
  return v;
};

const sql = postgres(env("WAGGLE_API_DB_URL"), { prepare: false, max: 3, idle_timeout: 20 });
const deps = {
  db: new WaggleDb((text: string, params?: unknown[]) => sql.unsafe(text, (params ?? []) as never[]) as never),
  newsletter: beehiivProvider(env("WAGGLE_BEEHIIV_API_KEY"), env("WAGGLE_BEEHIIV_PUBLICATION_ID")),
  subscribeUrl: Deno.env.get("WAGGLE_SUBSCRIBE_URL") ?? "https://superproductive.co",
};

// The connect site's origin(s), e.g. https://waggle.superproductive.co
const siteOrigins = new Set((Deno.env.get("WAGGLE_SITE_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean));

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  if (!siteOrigins.has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    vary: "origin",
  };
}

const json = (req: Request, status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors(req) } });

const handler = pipeline([withSupabase({ auth: ["user", "none"] })], async (req, ctx) => {
  const route = new URL(req.url).pathname.replace(/^.*\/connect-api/, "") || "/";
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const claims = ctx.userClaims;
  const user = claims?.id && claims.email ? { id: claims.id, email: claims.email } : null;
  const needUser = () => json(req, 401, { error: "unauthorized", message: "Sign in first." });

  try {
    let r;
    if (req.method === "POST" && route === "/check") r = await checkSubscriber(deps, body.email);
    else if (req.method === "POST" && route === "/approval") r = await decideApproval(deps, body.token, body.decision);
    else if (req.method === "POST" && route === "/link") r = user ? await linkAccount(deps, user, body.policy) : null;
    else if (req.method === "POST" && route === "/policy") r = user ? await setPolicy(deps, user, body.policy) : null;
    else if (req.method === "GET" && route === "/account") r = user ? await getAccount(deps, user) : null;
    else return json(req, 404, { error: "not_found" });
    if (!r) return needUser();
    return json(req, r.status, r.body);
  } catch (err) {
    console.error("connect-api error", err);
    return json(req, 500, { error: "internal", message: "Something went wrong. Try again shortly." });
  }
});

Deno.serve((req) => (req.method === "OPTIONS" ? new Response(null, { status: 204, headers: cors(req) }) : handler(req)));
