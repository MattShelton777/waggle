import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG as cfg, computeWeight, effectiveWeight, MIN_WEIGHT, resolveConfig } from "../src";

describe("computeWeight (§4.2)", () => {
  it("full-strength tool evidence is weight 1", () => {
    const w = computeWeight(
      { entityType: "tool", evidenceSource: "platform_read", runCountBand: "gt_10", contributorReputation: 1, accountAgeDays: 30, plausibilityPenalties: 0 },
      cfg,
    );
    expect(w.weight).toBe(1);
  });

  it("multiplies tactic factors", () => {
    const w = computeWeight(
      { entityType: "tactic", evidenceSource: "self_reported", metricKind: "leading", sampleBand: "100_1k", contributorReputation: 1, accountAgeDays: 30, plausibilityPenalties: 0 },
      cfg,
    );
    expect(w.weight).toBeCloseTo(0.6 * 0.6 * 0.6, 10);
  });

  it("ignores metric/sample factors for tools and run counts for tactics", () => {
    const tool = computeWeight(
      { entityType: "tool", evidenceSource: "platform_read", metricKind: "leading", sampleBand: "lt_100", runCountBand: "2_10", contributorReputation: 1, accountAgeDays: 30, plausibilityPenalties: 0 },
      cfg,
    );
    expect(tool.weight).toBeCloseTo(0.8, 10);
  });

  it("applies new-account and plausibility penalties", () => {
    const w = computeWeight(
      { entityType: "tool", evidenceSource: "platform_read", runCountBand: "gt_10", contributorReputation: 1, accountAgeDays: 2, plausibilityPenalties: 2 },
      cfg,
    );
    expect(w.weight).toBeCloseTo(0.5 * 0.25, 10);
  });

  it("clamps high reputation to 1 and keeps weight above zero", () => {
    const hi = computeWeight(
      { entityType: "tool", evidenceSource: "platform_read", runCountBand: "gt_10", contributorReputation: 5, accountAgeDays: 30, plausibilityPenalties: 0 },
      cfg,
    );
    expect(hi.contributor_reputation).toBe(1.5);
    expect(hi.weight).toBe(1);
    const lo = computeWeight(
      { entityType: "tactic", evidenceSource: "inspection_only", contributorReputation: 0, accountAgeDays: 0, plausibilityPenalties: 20 },
      cfg,
    );
    expect(lo.weight).toBe(MIN_WEIGHT);
  });

  it("effectiveWeight applies current reputation to the stored base", () => {
    expect(effectiveWeight(0.6, 0.3, cfg)).toBeCloseTo(0.18, 10);
    expect(effectiveWeight(0.9, 1.5, cfg)).toBe(1);
  });
});

describe("resolveConfig", () => {
  it("deep-merges overrides onto defaults", () => {
    const c = resolveConfig({ halfLifeDays: { tool: 14 }, giveToGet: { enabled: false } });
    expect(c.halfLifeDays).toEqual({ tool: 14, workflow: 60, tactic: 180 });
    expect(c.giveToGet.enabled).toBe(false);
    expect(c.giveToGet.graceDays).toBe(30);
    expect(cfg.halfLifeDays.tool).toBe(30);
  });
});
