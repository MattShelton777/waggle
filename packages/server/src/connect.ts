import { CONTRIBUTION_POLICIES, isPersonalDomain, emailDomain, type ContributionPolicy } from "@waggle/core";
import type { WaggleDb } from "./db";
import { approvalTokenHashFromToken } from "./write-tools";

// Server routes behind the connect/consent pages (§1, §6.4, §7.1).
// Waggle is standalone: anyone with a verified email can connect. The caller
// verifies the Supabase Auth session; email always comes from the verified
// token, never from the request body.

export interface ConnectDeps {
  db: WaggleDb;
}

export interface VerifiedUser {
  id: string;
  email: string;
}

export type ConnectResult = { status: number; body: Record<string, unknown> };

const ok = (body: Record<string, unknown>): ConnectResult => ({ status: 200, body });
const fail = (status: number, error: string, message: string): ConnectResult => ({ status, body: { error, message } });

/** After magic-link sign-in: create or link the Waggle account. Tenure starts now. */
export async function linkAccount(deps: ConnectDeps, user: VerifiedUser, policy: unknown): Promise<ConnectResult> {
  if (!user.email) return fail(400, "no_email", "This sign-in has no email address.");
  const subscriberId = await deps.db.ensureSubscriber(user.id, user.email, isPersonalDomain(emailDomain(user.email)), null);
  const sub = await deps.db.getSubscriber(subscriberId);
  if (sub?.banned) return fail(403, "banned", "This account can no longer use Waggle.");
  if (policy !== undefined) {
    const res = await setPolicy(deps, user, policy);
    if (res.status !== 200) return res;
  }
  return ok({ subscriber_id: subscriberId, policy: policy ?? sub?.policy ?? null });
}

export async function setPolicy(deps: ConnectDeps, user: VerifiedUser, policy: unknown): Promise<ConnectResult> {
  if (typeof policy !== "string" || !(CONTRIBUTION_POLICIES as readonly string[]).includes(policy))
    return fail(400, "invalid_policy", `policy must be one of: ${CONTRIBUTION_POLICIES.join(", ")}`);
  const subscriberId = await deps.db.subscriberForAuthUser(user.id);
  if (!subscriberId) return fail(404, "not_connected", "Connect your account first.");
  await deps.db.setPolicy(subscriberId, policy as ContributionPolicy);
  return ok({ policy });
}

export async function getAccount(deps: ConnectDeps, user: VerifiedUser): Promise<ConnectResult> {
  const subscriberId = await deps.db.subscriberForAuthUser(user.id);
  if (!subscriberId) return ok({ connected: false });
  const sub = await deps.db.getSubscriber(subscriberId);
  return ok({ connected: true, policy: sub?.policy, banned: sub?.banned ?? false });
}

/** One-click approve/discard from an approval email link. The token is the link's secret. */
export async function decideApproval(deps: ConnectDeps, token: unknown, decision: unknown): Promise<ConnectResult> {
  if (typeof token !== "string" || token.length < 20) return fail(400, "invalid_token", "This approval link is invalid.");
  if (decision !== "approve" && decision !== "discard") return fail(400, "invalid_decision", "decision must be approve or discard.");
  try {
    const result = await deps.db.decideApproval(await approvalTokenHashFromToken(token), decision);
    return ok(result);
  } catch (err) {
    if (err instanceof Error && /invalid or expired/.test(err.message)) return fail(410, "expired", "This approval link is invalid or has expired.");
    throw err;
  }
}
