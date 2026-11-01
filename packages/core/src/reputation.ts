import type { WaggleConfig } from "./config";
import type { EntityType } from "./enums";
import { scoreEntity, type ScoringEvent } from "./scoring";
import { clamp } from "./weight";

// §4.5 contributor reputation. Recomputed from scratch each night from the
// full log, so it is idempotent and replayable: running the job twice gives
// the same answer, and nothing is ever compounded across runs.

const DAY_MS = 86_400_000;

export interface ReputationComparison {
  observedAt: Date;
  score: number;
  /** Entity consensus computed without this contributor's events. */
  consensusMu: number;
  consensusConfidence: number;
}

export function startingReputation(isPersonalDomain: boolean, cfg: WaggleConfig): number {
  return isPersonalDomain ? cfg.reputation.startPersonal : cfg.reputation.startWork;
}

export function computeReputation(
  start: number,
  comparisons: readonly ReputationComparison[],
  injectionFlags: number,
  cfg: WaggleConfig,
): number {
  const r = cfg.reputation;
  let rep = start;
  const ordered = [...comparisons].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  for (const c of ordered) {
    // Only judge against a consensus that is itself confident.
    if (c.consensusConfidence < cfg.recommendationFloor) continue;
    rep += Math.abs(c.score - c.consensusMu) < r.agreeThreshold ? r.stepUp : -r.stepDown;
    rep = clamp(rep, r.min, r.max);
  }
  rep *= Math.pow(r.injectionMultiplier, injectionFlags);
  return clamp(rep, r.min, r.max);
}

export interface ReputationEvent extends Omit<ScoringEvent, "weight"> {
  entityId: string;
  entityType: EntityType;
  /** Weight without reputation (WeightComponents.base_weight). */
  baseWeight: number;
}

export interface ContributorInfo {
  subscriberId: string;
  isPersonalDomain: boolean;
  injectionFlags: number;
  /** Account creation; decides when a personal-mailbox account becomes an anchor. */
  createdAt: Date;
}

/**
 * Anchor voices define the consensus everyone's reputation is judged against:
 * every work-domain voice (one per domain, so expensive to multiply) and
 * personal-mailbox accounts older than `anchorTenureDays`. Personal accounts
 * still contribute to scores from day one; they just can't vouch for each
 * other until they are established, which stops a fresh farm of mailboxes
 * from agreeing its way to maximum reputation.
 */
export function isAnchor(c: ContributorInfo, now: Date, cfg: WaggleConfig): boolean {
  if (!c.isPersonalDomain) return true;
  return now.getTime() - c.createdAt.getTime() >= cfg.reputation.anchorTenureDays * DAY_MS;
}

/**
 * The nightly job's core: for every contributor, compare each of their mature
 * events with the anchored entity consensus excluding them, weighted by
 * everyone's *previous* reputation. Returns the new reputation per subscriber.
 */
export function computeAllReputations(
  events: readonly ReputationEvent[],
  contributors: readonly ContributorInfo[],
  previousReputation: ReadonlyMap<string, number>,
  now: Date,
  cfg: WaggleConfig,
): Map<string, number> {
  const byEntity = new Map<string, ReputationEvent[]>();
  for (const e of events) {
    const list = byEntity.get(e.entityId);
    if (list) list.push(e);
    else byEntity.set(e.entityId, [e]);
  }

  const toScoring = (e: ReputationEvent): ScoringEvent => {
    const rep = previousReputation.get(e.subscriberId) ?? cfg.reputation.startWork;
    return { ...e, weight: clamp(e.baseWeight * clamp(rep, cfg.reputation.min, cfg.reputation.max), 0.001, 1) };
  };

  const anchors = new Set(contributors.filter((c) => isAnchor(c, now, cfg)).map((c) => c.subscriberId));

  // Cache consensus per (entity, excluded subscriber).
  const consensusCache = new Map<string, { mu: number; confidence: number }>();
  const consensus = (entityId: string, excluded: string) => {
    const key = `${entityId}|${excluded}`;
    let hit = consensusCache.get(key);
    if (!hit) {
      const list = byEntity.get(entityId) ?? [];
      const others = list.filter((e) => e.subscriberId !== excluded && anchors.has(e.subscriberId)).map(toScoring);
      const type = list[0]?.entityType ?? "tool";
      const s = scoreEntity(others, { entityType: type, now, cfg });
      hit = { mu: s.mu, confidence: s.confidence };
      consensusCache.set(key, hit);
    }
    return hit;
  };

  const matureCutoff = now.getTime() - cfg.reputation.matureAfterDays * DAY_MS;
  const bySubscriber = new Map<string, ReputationEvent[]>();
  for (const e of events) {
    if (e.observedAt.getTime() > matureCutoff) continue;
    const list = bySubscriber.get(e.subscriberId);
    if (list) list.push(e);
    else bySubscriber.set(e.subscriberId, [e]);
  }

  const out = new Map<string, number>();
  for (const c of contributors) {
    const comparisons = (bySubscriber.get(c.subscriberId) ?? []).map((e) => {
      const cons = consensus(e.entityId, c.subscriberId);
      return { observedAt: e.observedAt, score: e.score, consensusMu: cons.mu, consensusConfidence: cons.confidence };
    });
    out.set(c.subscriberId, computeReputation(startingReputation(c.isPersonalDomain, cfg), comparisons, c.injectionFlags, cfg));
  }
  return out;
}
