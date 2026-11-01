// Waggle MCP endpoint (Supabase Edge Function, Deno).
//
// Auth: Supabase Auth's OAuth 2.1 server (dynamic client registration + PKCE)
// issues the access tokens. withOAuthProtectedResource answers MCP discovery
// (RFC 9728) and withSupabase verifies the bearer token. The verified user is
// mapped to a Waggle subscriber, then the request is served by @waggle/server.
//
// DB: the function connects as waggle_api_login (member of waggle_api), which
// can execute waggle.api_* functions and nothing else. Never give this
// function the service-role key.
//
// The server logic is bundled into ./waggle.bundle.js by
// `npm run build:functions`; run that before `supabase functions deploy mcp`.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { pipeline } from "npm:@supabase/middleware@1";
import { withOAuthProtectedResource, withSupabase } from "npm:@supabase/server@1";
import postgres from "npm:postgres@3.4.9";
import { handleMcpRequest, WaggleDb } from "./waggle.bundle.js";

type Embedder = { embed(text: string): Promise<number[] | null> };

const env = (name: string) => {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing secret ${name}`);
  return v;
};

// Transaction-mode pooler URL for waggle_api_login. prepare:false is required by the pooler.
const sql = postgres(env("WAGGLE_API_DB_URL"), { prepare: false, max: 3, idle_timeout: 20 });
const db = new WaggleDb((text, params) => sql.unsafe(text, (params ?? []) as never[]) as never);

// Supabase's built-in gte-small model (384 dims) runs inside the Edge Runtime at no token cost.
// deno-lint-ignore no-explicit-any
const session = new (globalThis as any).Supabase.ai.Session("gte-small");
const embedder: Embedder = {
  async embed(text: string) {
    try {
      return Array.from((await session.run(text, { mean_pool: true, normalize: true })) as number[]);
    } catch (err) {
      console.error("embedding failed; falling back to text search", err);
      return null;
    }
  },
};

const deps = { db, embedder, approvalSecret: env("WAGGLE_APPROVAL_SECRET") };

// Custom domain (e.g. https://waggle.superproductive.co/mcp). Unset = the default functions URL.
const publicUrl = Deno.env.get("WAGGLE_PUBLIC_URL");

// Browsers send Origin; agents generally don't. Reject unexpected browser origins (DNS rebinding).
const allowedOrigins = new Set(
  (Deno.env.get("WAGGLE_ALLOWED_ORIGINS") ?? "https://claude.ai,https://chatgpt.com").split(",").map((s) => s.trim()),
);

Deno.serve(
  pipeline(
    [withOAuthProtectedResource(publicUrl ? { resourceServer: publicUrl } : undefined), withSupabase({ auth: "user" })],
    async (req, ctx) => {
      const origin = req.headers.get("origin");
      if (origin && !allowedOrigins.has(origin)) return new Response("Forbidden origin", { status: 403 });

      const authUserId = ctx.userClaims?.id;
      if (!authUserId) return new Response("Unauthorized", { status: 401 });
      // Subscribers are created on the connect/consent page after the newsletter check.
      // An unknown user gets a clear tool error from the server ("not_connected").
      const subscriberId = (await db.subscriberForAuthUser(authUserId)) ?? "00000000-0000-0000-0000-000000000000";
      return handleMcpRequest(deps, subscriberId, req);
    },
  ),
);
