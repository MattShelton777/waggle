import {
  DEFAULT_CONFIG,
  RATING_SCORES,
  computeAllReputations,
  computeWeight,
  effectiveWeight,
  isAnchor,
  scoreEntity,
  startingReputation,
  voiceKey,
  type ContributorInfo,
  type EntityScore,
  type ReputationEvent,
  type ScoringEvent,
  type WaggleConfig,
} from "@waggle/core";

// Adversarial simulation of the reputation model (plan §15 step 4).
// Agents report on tool entities with known true quality; the engine runs the
// same core math the server uses (weights, one-domain-one-voice, decay,
// shrinkage, nightly reputation) and measures how far scores drift from truth.

const DAY_MS = 86_400_000;
const RUBRIC = Object.values(RATING_SCORES).sort((a, b) => a - b);

export type Behavior =
  | "honest"
  | "faulty" // random ratings
  | "liar" // inverts true quality on everything
  | "slanderer" // floors the target, honest elsewhere
  | "colluder" // boosts the target to 1.0, nothing else
  | "camouflage" // honest everywhere except boosting the target
  | "sybil"; // like colluder, but many accounts share one domain

export interface SimEntity {
  id: string;
  quality: number;
}

export interface SimAgent {
  id: string;
  domain: string;
  behavior: Behavior;
  /** Day the account was created (affects the new-account weight factor). */
  createdDay: number;
  /** Probability of reporting on a given day. */
  activity: number;
  /** For targeted behaviors: the entity they attack. */
  target?: string;
  /** Probability a targeted agent reports on its target rather than a random entity. */
  targetFocus?: number;
}

export interface Scenario {
  name: string;
  seed: number;
  days: number;
  entities: SimEntity[];
  agents: SimAgent[];
  /** Std-dev of honest raters' noise around true quality. */
  honestNoise?: number;
  /** Recompute reputation every N days (1 = nightly, as in production). */
  reputationEveryDays?: number;
  cfg?: WaggleConfig;
}

export interface SimResult {
  scenario: string;
  scores: Map<string, EntityScore>;
  reputations: Map<string, number>;
  events: number;
  /** Mean |mu - quality| over entities that reached the recommendation floor. */
  maeConfident: number;
  /** Mean |composite - quality| over all entities. */
  maeComposite: number;
  meanReputationByBehavior: Partial<Record<Behavior, number>>;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function nearestRubric(x: number): number {
  let best = RUBRIC[0]!;
  for (const r of RUBRIC) if (Math.abs(r - x) < Math.abs(best - x)) best = r;
  return best;
}

function reportScore(agent: SimAgent, entity: SimEntity, rand: () => number, noise: number): number {
  const honest = () => nearestRubric(entity.quality + gaussian(rand) * noise);
  const onTarget = entity.id === agent.target;
  switch (agent.behavior) {
    case "honest":
      return honest();
    case "faulty":
      return RUBRIC[Math.floor(rand() * RUBRIC.length)]!;
    case "liar":
      return nearestRubric(1 - entity.quality);
    case "slanderer":
      return onTarget ? 0 : honest();
    case "colluder":
    case "sybil":
    case "camouflage":
      return onTarget ? 1 : honest();
  }
}

function pickEntity(agent: SimAgent, entities: SimEntity[], rand: () => number): SimEntity {
  const targetOnly = agent.behavior === "colluder" || agent.behavior === "sybil";
  if (agent.target && (targetOnly || rand() < (agent.targetFocus ?? 0.3))) {
    const t = entities.find((e) => e.id === agent.target);
    if (t) return t;
  }
  return entities[Math.floor(rand() * entities.length)]!;
}

export function runScenario(s: Scenario): SimResult {
  const cfg = s.cfg ?? DEFAULT_CONFIG;
  const rand = mulberry32(s.seed);
  const noise = s.honestNoise ?? 0.1;
  const repEvery = s.reputationEveryDays ?? 1;
  const start = new Date("2026-01-01T00:00:00Z").getTime();
  const dayDate = (d: number) => new Date(start + d * DAY_MS);

  const contributors: ContributorInfo[] = s.agents.map((a) => ({
    subscriberId: a.id,
    isPersonalDomain: voiceKey(a.id, a.domain).startsWith("acct:"),
    injectionFlags: 0,
    createdAt: dayDate(a.createdDay),
  }));
  const personal = new Set(contributors.filter((c) => c.isPersonalDomain).map((c) => c.subscriberId));
  let reputation = new Map(contributors.map((c) => [c.subscriberId, startingReputation(c.isPersonalDomain, cfg)]));

  const log: ReputationEvent[] = [];
  const entityType = "tool" as const;
  let seq = 0;

  for (let day = 0; day < s.days; day++) {
    const now = dayDate(day);
    for (const agent of s.agents) {
      if (day < agent.createdDay || rand() >= agent.activity) continue;
      const entity = pickEntity(agent, s.entities, rand);
      const w = computeWeight(
        {
          entityType,
          evidenceSource: "platform_read",
          runCountBand: "gt_10",
          contributorReputation: reputation.get(agent.id) ?? 1,
          accountAgeDays: day - agent.createdDay,
          isPersonalDomain: personal.has(agent.id),
          plausibilityPenalties: 0,
        },
        cfg,
      );
      log.push({
        id: `ev${++seq}`,
        entityId: entity.id,
        entityType,
        subscriberId: agent.id,
        voiceKey: voiceKey(agent.id, agent.domain),
        score: reportScore(agent, entity, rand, noise),
        baseWeight: w.base_weight,
        observedAt: new Date(now.getTime() + rand() * DAY_MS * 0.9),
        context: {},
      });
    }
    if ((day + 1) % repEvery === 0) {
      reputation = computeAllReputations(log, contributors, reputation, dayDate(day + 1), cfg);
    }
  }

  const end = dayDate(s.days);
  const scores = new Map<string, EntityScore>();
  const probationary = new Set(contributors.filter((c) => !isAnchor(c, end, cfg)).map((c) => c.subscriberId));
  for (const e of s.entities) scores.set(e.id, scoreFinal(log, e.id, reputation, probationary, end, cfg));

  let confSum = 0;
  let confN = 0;
  let compSum = 0;
  for (const e of s.entities) {
    const sc = scores.get(e.id)!;
    compSum += Math.abs(sc.composite - e.quality);
    if (sc.confidence >= cfg.recommendationFloor) {
      confSum += Math.abs(sc.mu - e.quality);
      confN++;
    }
  }

  const byBehavior = new Map<Behavior, number[]>();
  for (const a of s.agents) {
    const list = byBehavior.get(a.behavior) ?? [];
    list.push(reputation.get(a.id) ?? 0);
    byBehavior.set(a.behavior, list);
  }
  const meanReputationByBehavior: Partial<Record<Behavior, number>> = {};
  for (const [b, list] of byBehavior) meanReputationByBehavior[b] = list.reduce((x, y) => x + y, 0) / list.length;

  return {
    scenario: s.name,
    scores,
    reputations: reputation,
    events: log.length,
    maeConfident: confN ? confSum / confN : NaN,
    maeComposite: compSum / s.entities.length,
    meanReputationByBehavior,
  };
}

function scoreFinal(
  log: ReputationEvent[],
  entityId: string,
  reputation: Map<string, number>,
  probationary: Set<string>,
  now: Date,
  cfg: WaggleConfig,
): EntityScore {
  const events: ScoringEvent[] = log
    .filter((e) => e.entityId === entityId)
    .map((e) => ({
      ...e,
      weight: effectiveWeight(e.baseWeight, reputation.get(e.subscriberId) ?? 1, cfg),
      probationary: probationary.has(e.subscriberId),
    }));
  return scoreEntity(events, { entityType: "tool", now, cfg });
}

// ---------------------------------------------------------------- builders

export function makeEntities(n: number, seed: number): SimEntity[] {
  const rand = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => ({ id: `ent${i}`, quality: Math.round((0.15 + rand() * 0.8) * 100) / 100 }));
}

export interface PopulationSpec {
  behavior: Behavior;
  count: number;
  /** Shared domain for all of them (sybils). Default: a distinct work domain each. */
  sharedDomain?: string;
  activity?: number;
  target?: string;
  targetFocus?: number;
  createdDay?: number;
}

export function makeAgents(specs: PopulationSpec[]): SimAgent[] {
  const agents: SimAgent[] = [];
  for (const spec of specs) {
    for (let i = 0; i < spec.count; i++) {
      const id = `${spec.behavior}${agents.length}`;
      agents.push({
        id,
        domain: spec.sharedDomain ?? `${id}.example`,
        behavior: spec.behavior,
        createdDay: spec.createdDay ?? 0,
        activity: spec.activity ?? 0.3,
        ...(spec.target ? { target: spec.target } : {}),
        ...(spec.targetFocus !== undefined ? { targetFocus: spec.targetFocus } : {}),
      });
    }
  }
  return agents;
}
