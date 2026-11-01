# Deploying Waggle (Supabase)

Hosting decision (2026-11-01): **Supabase Edge Functions + Supabase Auth's OAuth 2.1 server.** Supabase Auth provides dynamic client registration, PKCE, discovery metadata, token rotation, and magic-link sign-in out of the box, which is what MCP connectors need. The connect site is static and can live on any static host (Cloudflare Pages suggested, since you have an account).

Status legend: ✅ done · ⬜ to do (you) · 🔁 repeat on every release.

## 1. Project and database

- ✅ Project `waggle` (ref `yoagtdkpsomjzauoxvxb`, us-east-1) in Matt's org.
- ✅ Migrations applied (5). Local files in `supabase/migrations` are named with the versions the project records.
- ⬜ Enable backups / point-in-time recovery (Database → Backups) when you move to a paid plan.
- ⬜ Install the Supabase CLI and run `npx supabase link --project-ref yoagtdkpsomjzauoxvxb` from the repo root.

## 2. The API database login

The functions connect as a login role that can only execute `waggle.api_*` functions. In the SQL editor (pick a strong password; store it only as a function secret):

```sql
create role waggle_api_login login password '<strong-password>' in role waggle_api;
```

Connection string: the project's **transaction-mode pooler** URL (Database → Connect → Transaction pooler), with user `waggle_api_login.yoagtdkpsomjzauoxvxb`.

## 3. Host the connect site

`apps/connect` is plain static files (no build step). Rebuild the skill zip first with `npm run build:skill`.

- ⬜ Cloudflare Pages: create a project from the GitHub repo, build command none, output directory `apps/connect`. Add the custom domain (suggested `waggle.superproductive.co`).
- Pages serves `/oauth/consent` from `oauth/consent.html` automatically.

## 4. Supabase Auth

- ⬜ Authentication → URL Configuration: **Site URL** = the connect site origin (e.g. `https://waggle.superproductive.co`). Add `https://waggle.superproductive.co/**` to redirect URLs.
- ⬜ Authentication → Sign In / Providers: Email enabled with magic links. Set custom SMTP (e.g. Resend) so sign-in emails come from Superproductive, and edit the magic-link template copy.
- ⬜ Authentication → OAuth Server: enable the OAuth 2.1 server, enable **dynamic client registration**, and set the **authorization path** to `/oauth/consent`.
- ⬜ Confirm Claude's callback (`https://claude.ai/api/mcp/auth_callback`) and ChatGPT's current connector callback are accepted for dynamically registered clients.

## 5. Function secrets

```bash
npx supabase secrets set \
  WAGGLE_API_DB_URL='postgresql://waggle_api_login.yoagtdkpsomjzauoxvxb:<password>@<pooler-host>:6543/postgres' \
  WAGGLE_APPROVAL_SECRET='<random 32+ bytes>' \
  WAGGLE_BEEHIIV_API_KEY='<beehiiv API key>' \
  WAGGLE_BEEHIIV_PUBLICATION_ID='pub_d9d7bf1e-85c1-4625-9740-f21f2b182b61' \
  WAGGLE_SITE_ORIGINS='https://waggle.superproductive.co' \
  WAGGLE_SUBSCRIBE_URL='https://superproductive.co'
# Once a custom domain fronts the MCP endpoint:
npx supabase secrets set WAGGLE_PUBLIC_URL='https://waggle.superproductive.co/mcp'
```

The beehiiv publication is "The Superproductive Newsletter". Never set the service-role key on either function.

## 6. Deploy functions 🔁

```bash
npm run deploy:functions
```

Builds `supabase/functions/_shared/waggle.bundle.js` from `packages/server`, then deploys `mcp` and `connect-api` with gateway JWT checks off (both verify tokens in code).

Endpoints:
- MCP: `https://yoagtdkpsomjzauoxvxb.supabase.co/functions/v1/mcp`
- Connect API: `https://yoagtdkpsomjzauoxvxb.supabase.co/functions/v1/connect-api`

If you later serve MCP from `waggle.superproductive.co/mcp`, update `mcpUrl` in `apps/connect/config.js` and set `WAGGLE_PUBLIC_URL`.

## 7. Smoke test

1. `npx -y @modelcontextprotocol/inspector`, point it at the MCP endpoint. It should discover OAuth, register, send you through the magic link and consent page, then list eight tools.
2. Add the connector in Claude (Settings → Connectors → Add custom connector), then ChatGPT.
3. Ask the agent to call `waggle_get_rules`, then rate a tool you've used.

## Not built yet

- The batched approval-email job (approvals are stored and the approval page works; nothing sends the emails yet).
- Nightly jobs: reputation, subscription re-check, playbook ingestion, digest.
- Privacy and terms pages (required before launch).
