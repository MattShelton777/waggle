import { accessStatus, dueReadouts, resolveConfig, type AccessStatus, type ReadoutStage, type WaggleConfig } from "@waggle/core";
import type { SubscriberInfo, WaggleDb } from "./db";

// Per-request context and the notices block every tool response carries (§6.2).

export interface Embedder {
  /** Returns a 384-dim embedding, or null when embeddings are unavailable (text search is the fallback). */
  embed(text: string): Promise<number[] | null>;
}

export const noEmbeddings: Embedder = { embed: async () => null };

export interface Deps {
  db: WaggleDb;
  embedder: Embedder;
  /** Secret for approval-link tokens (HMAC). */
  approvalSecret: string;
  now?: () => Date;
}

export interface RequestContext {
  deps: Deps;
  db: WaggleDb;
  embedder: Embedder;
  subscriber: SubscriberInfo;
  cfg: WaggleConfig;
  denylist: string[];
  rulesVersion: number;
  now: Date;
  access: AccessStatus;
}

export async function loadContext(deps: Deps, subscriberId: string): Promise<RequestContext> {
  const [subscriber, serverConfig] = await Promise.all([deps.db.getSubscriber(subscriberId), deps.db.getServerConfig()]);
  if (!subscriber) throw new WaggleError("not_connected", "This account isn't connected to Waggle. Reconnect the Waggle connector.");
  if (subscriber.banned) throw new WaggleError("banned", "This account can no longer use Waggle.");
  if (subscriber.newsletter_status !== "active")
    throw new WaggleError("not_subscribed", "Waggle is for active Superproductive subscribers. Resubscribe, then reconnect the connector.");
  const cfg = resolveConfig(serverConfig.settings as Parameters<typeof resolveConfig>[0]);
  const now = deps.now?.() ?? new Date();
  const lastContribution = subscriber.last_accepted_contribution_at ? new Date(subscriber.last_accepted_contribution_at) : null;
  const connectedAt = subscriber.connected_at ? new Date(subscriber.connected_at) : null;
  return {
    deps,
    db: deps.db,
    embedder: deps.embedder,
    subscriber,
    cfg,
    denylist: serverConfig.denylist ?? [],
    rulesVersion: serverConfig.rules_version,
    now,
    access: accessStatus(connectedAt, lastContribution, now, cfg),
  };
}

export class WaggleError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Notices {
  due_readouts: Array<{ use_id: string; entity: string; stage: ReadoutStage; due_since: string }>;
  access: { level: AccessStatus["level"]; message?: string };
  rules_version: { current: number; stale: boolean; message?: string };
}

export async function buildNotices(ctx: RequestContext, rulesVersionSeen: number | undefined): Promise<Notices> {
  const uses = await ctx.db.openUses(ctx.subscriber.id);
  const due = uses.flatMap((u) =>
    dueReadouts(u.readout_plan, u.completed_stages as ReadoutStage[], ctx.now).map((w) => ({
      use_id: u.id,
      entity: u.entity_slug,
      stage: w.stage,
      due_since: w.due_from.slice(0, 10),
    })),
  );
  const seen = rulesVersionSeen ?? ctx.subscriber.rules_version_seen ?? 0;
  const stale = seen < ctx.rulesVersion;
  return {
    due_readouts: due,
    access: { level: ctx.access.level, ...(ctx.access.message ? { message: ctx.access.message } : {}) },
    rules_version: {
      current: ctx.rulesVersion,
      stale,
      ...(stale ? { message: `Waggle rules are at version ${ctx.rulesVersion}. Call waggle_get_rules before submitting.` } : {}),
    },
  };
}
