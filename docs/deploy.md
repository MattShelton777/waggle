# Deploying Waggle (Supabase)

Hosting decision (2026-11-01): **Supabase Edge Functions + Supabase Auth's OAuth 2.1 server.** Supabase Auth provides dynamic client registration, PKCE, discovery metadata, token rotation, and magic-link sign-in out of the box, which is exactly what MCP connectors need. On Cloudflare Workers we would have had to run and maintain that OAuth layer ourselves.

Nothing below has been run yet. Verify each dashboard path against current Supabase docs when you do it.

## 1. Project

1. Create a new, dedicated Supabase project (e.g. `waggle`). Enable backups / point-in-time recovery.
2. Install the Supabase CLI and Deno locally, then `supabase link --project-ref <ref>` from the repo root.
3. Apply migrations: `supabase db push`.

## 2. The API database login

The MCP function connects as a login role that can only execute `waggle.api_*` functions. Run once in the SQL editor (choose a strong password, store it only as a function secret):

```sql
create role waggle_api_login login password '<strong-password>' in role waggle_api;
```

Build the connection string from the project's **transaction-mode pooler** URL with user `waggle_api_login.<project-ref>`.

## 3. Auth: OAuth 2.1 server + magic link

1. Authentication → Sign In / Providers: enable **Email** with magic link. Configure a custom SMTP sender (e.g. Resend) so links come from Superproductive.
2. Authentication → OAuth Server: **enable** the OAuth 2.1 server and **dynamic client registration**.
3. Set the **authorization path** to the connect app's consent page (built in step 6 of the build plan: `superproductive.co/waggle/authorize` or similar). That page:
   - signs the user in with a magic link,
   - checks the email is an active newsletter subscriber (newsletter API),
   - calls `waggle.api_ensure_subscriber(auth_user_id, email, is_personal_domain, newsletter_subscribed_at)` through a server route,
   - shows the client name and asks the user to approve.
4. Allowed redirect URLs must include Claude's callback `https://claude.ai/api/mcp/auth_callback` and ChatGPT's current connector callback (check ChatGPT's docs at build time).

## 4. Function secrets

```bash
supabase secrets set WAGGLE_API_DB_URL='postgresql://waggle_api_login.<ref>:<password>@<pooler-host>:6543/postgres'
supabase secrets set WAGGLE_APPROVAL_SECRET='<random 32+ bytes>'
# Optional, once the custom domain is live:
supabase secrets set WAGGLE_PUBLIC_URL='https://waggle.superproductive.co/mcp'
supabase secrets set WAGGLE_ALLOWED_ORIGINS='https://claude.ai,https://chatgpt.com'
```

Never set the service-role key on the `mcp` function.

## 5. Deploy

```bash
npm run deploy:mcp
```

This bundles `packages/server` into `supabase/functions/mcp/waggle.bundle.js` and deploys with JWT verification off at the gateway (the function verifies tokens itself).

Endpoint: `https://<ref>.supabase.co/functions/v1/mcp` until the custom domain is set up.

## 6. Smoke test

```bash
npx -y @modelcontextprotocol/inspector
```

Point it at the endpoint. It should discover OAuth, register, send you through the magic link and consent page, then list eight tools. Then add the connector in Claude (Settings → Connectors → Add custom connector) and ChatGPT.
