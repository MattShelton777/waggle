import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG as cfg, scoreEntity, type ScoringEvent } from "@waggle/core";
import { runScenario } from "../src/engine";
import { GOOD_QUALITY, GOOD_TARGET, TARGET, scenarios } from "../src/scenarios";

// Guarantees the reputation model must keep (plan §15 step 4). Where it is
// expected to break (colluders past parity, patient aged-mailbox sybils) is
// recorded by `npm run sim` in docs/simulation.md rather than asserted here.

const honest = runScenario(scenarios.honestOnly());
const target = (r: ReturnType<typeof runScenario>) => r.scores.get(TARGET)!;
const good = (r: ReturnType<typeof runScenario>) => r.scores.get(GOOD_TARGET)!;

describe("adversarial simulation", () => {
  it("honest raters converge on true quality", () => {
    expect(honest.maeConfident).toBeLessThan(0.05);
  });

  it("one maximally negative event barely moves an established entity", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const base: ScoringEvent[] = Array.from({ length: 20 }, (_, i) => ({
      id: `h${i}`,
      subscriberId: `s${i}`,
      voiceKey: `domain:d${i}.example`,
      score: 0.8,
      weight: 1,
      observedAt: now,
      context: {},
    }));
    const before = scoreEntity(base, { entityType: "tool", now, cfg });
    const attack: ScoringEvent = { id: "x", subscriberId: "evil", voiceKey: "domain:evil.example", score: 0, weight: 1, observedAt: now, context: {} };
    const after = scoreEntity([...base, attack], { entityType: "tool", now, cfg });
    expect(before.composite - after.composite).toBeLessThan(0.05);
  });

  it("caps a same-domain sybil flood at one voice and drives its reputation to the floor", () => {
    const r = runScenario(scenarios.sameDomainSybil(30));
    expect(target(r).composite).toBeLessThan(target(honest).composite + 0.03);
    expect(r.meanReputationByBehavior.sybil).toBe(cfg.reputation.min);
  });

  it("decays persistent liars' reputation and keeps error bounded", () => {
    const r = runScenario(scenarios.persistentLiars());
    expect(r.meanReputationByBehavior.liar!).toBeLessThan(0.9);
    expect(r.meanReputationByBehavior.honest! - r.meanReputationByBehavior.liar!).toBeGreaterThan(0.4);
    expect(r.maeConfident).toBeLessThan(0.1);
  });

  it("discounts random (faulty) raters", () => {
    const r = runScenario(scenarios.faulty());
    expect(r.meanReputationByBehavior.faulty!).toBeLessThan(0.7);
    expect(r.maeConfident).toBeLessThan(0.06);
  });

  it("limits slander of a good tool", () => {
    const r = runScenario(scenarios.slander());
    expect(good(r).composite).toBeGreaterThan(0.6);
    expect(Math.abs(good(r).mu - GOOD_QUALITY)).toBeLessThan(0.25);
    expect(r.meanReputationByBehavior.slanderer!).toBeLessThan(0.7);
  });

  it("degrades gracefully below parity", () => {
    const composites = [0, 2, 5, 10].map((n) => target(runScenario(scenarios.clique(n, 20))).composite);
    for (let i = 1; i < composites.length; i++) expect(composites[i]!).toBeGreaterThanOrEqual(composites[i - 1]! - 0.01);
    // 5 colluders vs 20 honest: the bad tool stays clearly below neutral.
    expect(composites[2]!).toBeLessThan(0.45);
  });

  it("scores accurately with a mostly personal-mailbox audience", () => {
    expect(runScenario(scenarios.honestMixed()).maeConfident).toBeLessThan(0.05);
  });

  it("bounds a farm of new personal mailboxes no matter how many accounts", () => {
    const ten = runScenario(scenarios.personalDomainSybil(10));
    const thirty = runScenario(scenarios.personalDomainSybil(30));
    expect(target(thirty).composite).toBeLessThan(0.45);
    expect(target(thirty).composite - target(ten).composite).toBeLessThan(0.02);
    expect(thirty.meanReputationByBehavior.sybil).toBe(cfg.reputation.min);
    expect(target(runScenario(scenarios.personalDomainSybilAllPersonal(30))).composite).toBeLessThan(0.45);
  });

  it("floors colluders' reputation below parity", () => {
    const r = runScenario(scenarios.clique(5, 20));
    expect(r.meanReputationByBehavior.colluder).toBe(cfg.reputation.min);
  });
});
