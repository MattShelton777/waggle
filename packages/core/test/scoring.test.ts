import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG as cfg,
  aggregate,
  decayFactor,
  dedupeByVoice,
  scoreEntity,
  type ScoringEvent,
} from "../src";

const now = new Date("2026-11-01T00:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

let seq = 0;
function ev(p: Partial<ScoringEvent> & Pick<ScoringEvent, "score">): ScoringEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    subscriberId: p.subscriberId ?? `s${seq}`,
    voiceKey: p.voiceKey ?? `domain:d${seq}.com`,
    weight: 1,
    observedAt: now,
    context: {},
    ...p,
  };
}

describe("aggregate (§4.3)", () => {
  it("sanity case: one maximally negative full-weight event cannot tank a fresh entity", () => {
    const a = aggregate([{ score: 0, weight: 1, observedAt: now }], now, 30, cfg);
    expect(a.mu).toBeCloseTo(1 / 3, 10);
    expect(a.confidence).toBeCloseTo(0.25, 10);
    expect(a.composite).toBeCloseTo(0.4583, 4);
  });

  it("an entity with no evidence is exactly neutral with zero confidence", () => {
    const a = aggregate([], now, 30, cfg);
    expect(a.composite).toBe(0.5);
    expect(a.confidence).toBe(0);
  });

  it("confidence grows with independent evidence and composite approaches mu", () => {
    const pts = Array.from({ length: 30 }, () => ({ score: 0.8, weight: 1, observedAt: now }));
    const a = aggregate(pts, now, 30, cfg);
    expect(a.confidence).toBeGreaterThan(0.9);
    expect(a.composite).toBeGreaterThan(0.75);
  });

  it("decays evidence by half-life", () => {
    expect(decayFactor(30, 30)).toBeCloseTo(0.5, 10);
    expect(decayFactor(0, 30)).toBe(1);
    expect(decayFactor(-5, 30)).toBe(1);
    const fresh = aggregate([{ score: 1, weight: 1, observedAt: now }], now, 30, cfg);
    const old = aggregate([{ score: 1, weight: 1, observedAt: daysAgo(30) }], now, 30, cfg);
    expect(old.nEff).toBeCloseTo(fresh.nEff / 2, 10);
  });

  it("is order-independent", () => {
    const pts = [0.2, 0.9, 0.5, 1, 0].map((s, i) => ({ score: s, weight: 0.3 + i * 0.1, observedAt: daysAgo(i * 3) }));
    const a = aggregate(pts, now, 60, cfg);
    const b = aggregate([...pts].reverse(), now, 60, cfg);
    expect(a.composite).toBeCloseTo(b.composite, 12);
  });
});

describe("dedupeByVoice (§4.4 one domain, one voice)", () => {
  it("keeps only the newest event per voice inside the window", () => {
    const events = [
      ev({ score: 1, voiceKey: "domain:acme.io", observedAt: daysAgo(1) }),
      ev({ score: 1, voiceKey: "domain:acme.io", observedAt: daysAgo(5) }),
      ev({ score: 1, voiceKey: "domain:acme.io", observedAt: daysAgo(29) }),
      ev({ score: 1, voiceKey: "domain:acme.io", observedAt: daysAgo(31) }),
      ev({ score: 1, voiceKey: "domain:other.io", observedAt: daysAgo(2) }),
    ];
    const kept = dedupeByVoice(events, 30);
    expect(kept.map((e) => e.observedAt.getTime()).sort()).toEqual([daysAgo(31), daysAgo(2), daysAgo(1)].map((d) => d.getTime()).sort());
  });

  it("caps a same-domain flood at one event's influence", () => {
    const flood = Array.from({ length: 50 }, (_, i) => ev({ score: 1, voiceKey: "domain:sybil.io", subscriberId: `sy${i}`, observedAt: daysAgo(i % 10) }));
    const s = scoreEntity(flood, { entityType: "tool", now, cfg });
    const single = scoreEntity([flood[0]!], { entityType: "tool", now, cfg });
    expect(s.composite).toBeCloseTo(single.composite, 10);
  });
});

describe("scoreEntity", () => {
  it("labels below the floor as unconfirmed and above as recommended", () => {
    const one = scoreEntity([ev({ score: 1 })], { entityType: "tool", now, cfg });
    expect(one.confidence).toBeCloseTo(0.25, 10);
    expect(one.label).toBe("unconfirmed");
    const two = scoreEntity([ev({ score: 1 }), ev({ score: 1 })], { entityType: "tool", now, cfg });
    expect(two.label).toBe("recommended");
  });

  it("filters by context and falls back to global when the context is thin", () => {
    const events = [
      ev({ score: 0.9, context: { industry_group: "b2b_saas", buyer: "smb" } }),
      ev({ score: 0.9, context: { industry_group: "b2b_saas", buyer: "mid_market" } }),
      ev({ score: 0.2, context: { industry_group: "ecommerce", buyer: "smb" }, weight: 0.5 }),
    ];
    const saas = scoreEntity(events, { entityType: "tool", now, cfg, context: { industry_group: "b2b_saas" } });
    expect(saas.eventCount).toBe(2);
    expect(saas.contextThin).toBe(false);

    const ecom = scoreEntity(events, { entityType: "tool", now, cfg, context: { industry_group: "ecommerce" } });
    expect(ecom.nEff).toBeLessThan(1);
    expect(ecom.contextThin).toBe(true);
    expect(ecom.global?.eventCount).toBe(3);
  });

  it("computes per-dimension scores over events that supplied them", () => {
    const events = [
      ev({ score: 0.8, dimensions: { accuracy: 1, cost: 0.2 } }),
      ev({ score: 0.6, dimensions: { accuracy: 0.8 } }),
      ev({ score: 0.6 }),
    ];
    const s = scoreEntity(events, { entityType: "tool", now, cfg });
    expect(s.dimensions.accuracy?.eventCount).toBe(2);
    expect(s.dimensions.cost?.eventCount).toBe(1);
    expect(s.dimensions.accuracy!.mu).toBeGreaterThan(s.dimensions.cost!.mu);
  });

  it("uses the type's half-life", () => {
    const old = [ev({ score: 1, observedAt: daysAgo(180) })];
    const tool = scoreEntity(old, { entityType: "tool", now, cfg });
    const tactic = scoreEntity(old, { entityType: "tactic", now, cfg });
    expect(tactic.nEff).toBeCloseTo(0.5, 10);
    expect(tool.nEff).toBeCloseTo(1 / 64, 10);
  });
});

describe("probation for new personal mailboxes", () => {
  it("caps probationary voices at a share of established weight", () => {
    const established = Array.from({ length: 8 }, () => ev({ score: 0.2 }));
    const farm = Array.from({ length: 30 }, () => ev({ score: 1, probationary: true }));
    const s = scoreEntity([...established, ...farm], { entityType: "tool", now, cfg });
    // Probationary weight is capped at 0.25 x 8 = 2, so the mean moves only modestly.
    expect(s.nEff).toBeCloseTo(10, 6);
    expect(s.mu).toBeLessThan(0.45);
  });

  it("lets probationary voices count fully on a quiet entity, up to the floor", () => {
    const two = [ev({ score: 1, probationary: true }), ev({ score: 1, probationary: true })];
    expect(scoreEntity(two, { entityType: "tool", now, cfg }).nEff).toBeCloseTo(2, 6);
    const ten = Array.from({ length: 10 }, () => ev({ score: 1, probationary: true }));
    expect(scoreEntity(ten, { entityType: "tool", now, cfg }).nEff).toBeCloseTo(cfg.probation.floorNEff, 6);
  });
});
