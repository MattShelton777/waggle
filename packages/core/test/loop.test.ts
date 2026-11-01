import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG as cfg,
  accessStatus,
  computeReputation,
  computeWeight,
  isAnchor,
  dueReadouts,
  readoutPlan,
  requiresApproval,
  resolveConfig,
  schedulePrompts,
  voiceKey,
} from "../src";

const now = new Date("2026-11-01T00:00:00Z");
const days = (d: number) => new Date(now.getTime() + d * 86_400_000);

describe("readout plans (§6.1)", () => {
  it("schedules leading and lagging readouts for tactics", () => {
    const plan = readoutPlan("tactic", now, cfg);
    expect(plan.readouts.map((r) => r.stage)).toEqual(["leading", "lagging"]);
    expect(plan.readouts[0]?.due_from).toBe(days(7).toISOString());
    expect(plan.readouts[1]?.due_by).toBe(days(90).toISOString());
    expect(plan.expires_at).toBe(days(120).toISOString());
  });

  it("reports due readouts once their window opens", () => {
    const plan = readoutPlan("tactic", now, cfg);
    expect(dueReadouts(plan, [], days(3))).toHaveLength(0);
    expect(dueReadouts(plan, [], days(8)).map((r) => r.stage)).toEqual(["leading"]);
    expect(dueReadouts(plan, ["leading"], days(45)).map((r) => r.stage)).toEqual(["lagging"]);
  });

  it("builds schedule prompts with identifiers only", () => {
    const plan = readoutPlan("workflow", now, cfg);
    const [p] = schedulePrompts("maps-scrape-enrich", "use-123", plan);
    expect(p).toContain("2026-11-02");
    expect(p).toContain('use_id "use-123"');
    expect(p).toContain("never the numbers");
  });
});

describe("reputation (§4.5)", () => {
  const cmp = (score: number, mu: number, c = 0.8) => ({ observedAt: now, score, consensusMu: mu, consensusConfidence: c });

  it("rises with agreement and falls faster with disagreement, within bounds", () => {
    expect(computeReputation(1, [cmp(0.8, 0.75), cmp(0.6, 0.7)], 0, cfg)).toBeCloseTo(1.04, 10);
    expect(computeReputation(1, [cmp(0, 0.8)], 0, cfg)).toBeCloseTo(0.96, 10);
    expect(computeReputation(1, Array.from({ length: 200 }, () => cmp(0.8, 0.8)), 0, cfg)).toBe(1.5);
    expect(computeReputation(1, Array.from({ length: 200 }, () => cmp(0, 0.9)), 0, cfg)).toBe(0.3);
  });

  it("ignores comparisons against an unconfident consensus", () => {
    expect(computeReputation(1, [cmp(0, 0.9, 0.1)], 0, cfg)).toBe(1);
  });

  it("halves reputation per injection flag", () => {
    expect(computeReputation(1, [], 1, cfg)).toBe(0.5);
    expect(computeReputation(1, [], 3, cfg)).toBe(0.3);
  });
});

describe("give-to-get (§7.3)", () => {
  it("grants full access during the grace period", () => {
    expect(accessStatus(days(-10), null, now, cfg).level).toBe("full");
  });
  it("requires a recent contribution after grace", () => {
    expect(accessStatus(days(-40), null, now, cfg).level).toBe("reduced");
    expect(accessStatus(days(-40), days(-5), now, cfg).level).toBe("full");
    expect(accessStatus(days(-90), days(-45), now, cfg).level).toBe("reduced");
  });
  it("can be disabled", () => {
    expect(accessStatus(days(-90), null, now, resolveConfig({ giveToGet: { enabled: false } })).level).toBe("full");
  });
});

describe("contribution policy (§6.4)", () => {
  const base = { kind: "observation", entityType: "tool", isNewEntity: false, isFirstTacticObservation: false } as const;
  it("auto_low_risk accepts ratings on existing entities", () => {
    expect(requiresApproval({ ...base, policy: "auto_low_risk" })).toBe(false);
    expect(requiresApproval({ ...base, policy: "auto_low_risk", kind: "readout", entityType: "tactic" })).toBe(false);
  });
  it("auto_low_risk holds new entities and first tactic observations", () => {
    expect(requiresApproval({ ...base, policy: "auto_low_risk", isNewEntity: true })).toBe(true);
    expect(requiresApproval({ ...base, policy: "auto_low_risk", entityType: "tactic", isFirstTacticObservation: true })).toBe(true);
  });
  it("ask_always and auto_all are absolute", () => {
    expect(requiresApproval({ ...base, policy: "ask_always" })).toBe(true);
    expect(requiresApproval({ ...base, policy: "auto_all", isNewEntity: true })).toBe(false);
  });
});

describe("voiceKey (§4.4)", () => {
  it("pools work domains and separates personal accounts", () => {
    expect(voiceKey("a", "Acme.io")).toBe("domain:acme.io");
    expect(voiceKey("a", "gmail.com")).toBe("acct:a");
    expect(voiceKey("b", "gmail.com")).not.toBe(voiceKey("a", "gmail.com"));
  });
});

describe("personal-mailbox defenses", () => {
  it("personal mailboxes become anchors after the tenure window; work domains always are", () => {
    const base = { subscriberId: "p", injectionFlags: 0 };
    expect(isAnchor({ ...base, isPersonalDomain: false, createdAt: now }, now, cfg)).toBe(true);
    expect(isAnchor({ ...base, isPersonalDomain: true, createdAt: days(-30) }, now, cfg)).toBe(false);
    expect(isAnchor({ ...base, isPersonalDomain: true, createdAt: days(-90) }, now, cfg)).toBe(true);
  });

  it("personal mailboxes keep the new-account factor for 30 days, work domains for 7", () => {
    const w = (isPersonalDomain: boolean, accountAgeDays: number) =>
      computeWeight(
        { entityType: "tool", evidenceSource: "platform_read", runCountBand: "gt_10", contributorReputation: 1, accountAgeDays, isPersonalDomain, plausibilityPenalties: 0 },
        cfg,
      ).weight;
    expect(w(false, 10)).toBe(1);
    expect(w(true, 10)).toBe(0.5);
    expect(w(true, 31)).toBe(1);
  });
});
