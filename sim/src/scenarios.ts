import { makeAgents, makeEntities, type PopulationSpec, type Scenario } from "./engine";

// Named scenarios used by both the test suite and the report script.
// Honest raters are existing subscribers (accounts created before day 0);
// attackers open their accounts when the simulation starts.

export const DAYS = 120;
export const ENTITY_COUNT = 20;
/** The attacked entity: a genuinely poor tool. */
export const TARGET = "target";
export const TARGET_QUALITY = 0.2;
/** A genuinely good tool, used for slander. */
export const GOOD_TARGET = "good-target";
export const GOOD_QUALITY = 0.85;
const EXISTING = -180;
/** Fresh-account attacks open their mailboxes here, so they are still in probation when scored at day 120. */
const ATTACK_START = 40;

function entities() {
  return [...makeEntities(ENTITY_COUNT, 7), { id: TARGET, quality: TARGET_QUALITY }, { id: GOOD_TARGET, quality: GOOD_QUALITY }];
}

export function scenario(name: string, specs: PopulationSpec[], seed = 42, days = DAYS): Scenario {
  return { name, seed, days, entities: entities(), agents: makeAgents(specs) };
}

const HONEST = 40;
const honestWork = (count = HONEST): PopulationSpec => ({ behavior: "honest", count, createdDay: EXISTING });
const honestPersonal = (count: number): PopulationSpec => ({ behavior: "honest", count, sharedDomain: "gmail.com", createdDay: EXISTING });
/** Realistic newsletter audience: most subscribers on personal mailboxes. */
const honestMixed = (): PopulationSpec[] => [honestPersonal(24), honestWork(16)];

export const scenarios = {
  honestOnly: () => scenario("honest only", [honestWork()]),

  honestMixed: () => scenario("honest, 60% personal mailboxes", honestMixed()),

  faulty: () => scenario("20% faulty raters", [honestWork(), { behavior: "faulty", count: 10 }]),

  persistentLiars: () => scenario("20% persistent liars", [honestWork(), { behavior: "liar", count: 10 }]),

  slander: () =>
    scenario("slanderers on a good tool", [honestWork(), { behavior: "slanderer", count: 5, target: GOOD_TARGET, targetFocus: 0.5 }]),

  camouflage: () =>
    scenario("camouflaged boosters", [honestWork(), { behavior: "camouflage", count: 8, target: TARGET, targetFocus: 0.3 }]),

  /** Colluders (distinct work domains) boosting the bad target. */
  clique: (colluders: number, honest = HONEST) =>
    scenario(`clique ${colluders} vs ${honest} honest`, [
      honestWork(honest),
      { behavior: "colluder", count: colluders, target: TARGET, activity: 0.3 },
    ]),

  /** Many accounts on one work domain boosting the bad target. */
  sameDomainSybil: (accounts: number) =>
    scenario(`${accounts} sybils on one work domain`, [
      honestWork(),
      { behavior: "sybil", count: accounts, sharedDomain: "sybil-farm.io", target: TARGET, activity: 0.5 },
    ]),

  /** Fresh personal mailboxes boosting the bad target, against a mostly-personal honest audience. */
  personalDomainSybil: (accounts: number) =>
    scenario(`${accounts} new personal-mailbox sybils (mixed audience)`, [
      ...honestMixed(),
      { behavior: "sybil", count: accounts, sharedDomain: "gmail.com", target: TARGET, activity: 0.5, createdDay: ATTACK_START },
    ]),

  /** Same attack where every honest subscriber is on a personal mailbox. */
  personalDomainSybilAllPersonal: (accounts: number) =>
    scenario(`${accounts} new personal-mailbox sybils (all-personal audience)`, [
      honestPersonal(HONEST),
      { behavior: "sybil", count: accounts, sharedDomain: "gmail.com", target: TARGET, activity: 0.5, createdDay: ATTACK_START },
    ]),

  /** A patient attacker: mailboxes opened 120 days before attacking, so they are already established. */
  agedPersonalSybil: (accounts: number) =>
    scenario(`${accounts} aged personal-mailbox sybils (mixed audience)`, [
      ...honestMixed(),
      { behavior: "sybil", count: accounts, sharedDomain: "gmail.com", target: TARGET, activity: 0.5, createdDay: -120 },
    ]),
};
