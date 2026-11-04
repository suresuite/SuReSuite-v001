import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import registry from "@/lib/policies/registry.generated.json";
import { STRESS_PRESETS } from "@/components/docs/generated/policy.generated";
import {
  DISRUPTION_RULE,
  PLANT_TARGET,
  addBlockedReason,
  describeEvent,
  effectLabel,
  effectMeaning,
  eventWindow,
  judgeTarget,
  newEvent,
  supplierTarget,
  targetChoices,
  targetLabel,
} from "../disruptionEvents";
import { disruptionWeeks } from "../runWindow";

const ROOT = join(__dirname, "..", "..", "..", "..");

describe("one disruption-event model (WP 9.4 slice 6 · §4 D226)", () => {
  it("reads the mapper's exported rule", () => {
    const d = (registry as unknown as { disruption: typeof DISRUPTION_RULE }).disruption;
    expect(DISRUPTION_RULE).toEqual(d);
    // Engine 0.9.0 (PLAN.md §29 WP 19.1): a supplied material is a target too.
    expect(DISRUPTION_RULE.supported_target_kinds).toEqual(["supplier", "plant", "material"]);
  });

  it("agrees with the derived stress-preset classification on every event", () => {
    // `chains.mjs` applies the mapper's rule to each preset; judgeTarget applies
    // the shared one. They must never disagree about what the engine skips.
    for (const p of STRESS_PRESETS) {
      for (const e of p.events) {
        // "Skipped" is the claim both sides make; the shared rule also says WHY
        // (a kind the engine cannot disrupt, or no such supplier in the project).
        const { target, reason } = judgeTarget(e.target, []);
        if (e.resolves === "unsupported") expect(reason, e.target).not.toBeNull();
        if (e.resolves === "plant") expect(target.kind, e.target).toBe("plant");
        if (target.kind === "unsupported") expect(e.resolves, e.target).toBe("unsupported");
      }
    }
  });

  it("offers only targets the engine can disrupt", () => {
    const ids = ["S2", "S1"];
    const choices = targetChoices(ids);
    expect(choices.map((c) => c.value)).toEqual([PLANT_TARGET, supplierTarget("S1"), supplierTarget("S2")]);
    for (const c of choices) expect(judgeTarget(c.value, ids).reason).toBeNull();
  });

  it("a new event is a whole-week lead-time delay after the warm-up", () => {
    const e = newEvent("node:plant", 105);
    expect(e.start_day % 7).toBe(0);
    expect(e.duration_days % 7).toBe(0);
    expect(effectLabel(e.magnitude_pct)).toBe("Lead-time delay");
    expect(effectLabel(30)).toBe("Capacity reduction 30%");
  });

  it("names an event in the engine's terms (DISRUPTION_TERMS)", () => {
    const e = { target: supplierTarget("S1"), start_day: 133, duration_days: 28, magnitude_pct: 30 };
    const { startWeek } = disruptionWeeks(e.start_day, e.duration_days);
    expect(targetLabel(PLANT_TARGET)).toBe("Plant");
    expect(targetLabel(supplierTarget("S1"))).toBe("Supplier S1");
    expect(eventWindow(e.start_day, e.duration_days)).toBe(`weeks ${startWeek}–${startWeek + 3}`);
    expect(eventWindow(e.start_day, 7)).toBe(`week ${startWeek}`);
    expect(describeEvent(e)).toBe(`Capacity reduction 30% · Supplier S1 · weeks ${startWeek}–${startWeek + 3}`);
    expect(effectMeaning(30)).toMatch(/^70% of the node's weekly capacity remains/);
  });

  it("stops at the engine's cap and says so", () => {
    const five = Array.from({ length: DISRUPTION_RULE.event_cap }, () => newEvent("node:plant"));
    expect(addBlockedReason(five.slice(1))).toBeNull();
    expect(addBlockedReason(five)).toMatch(/at most 5 events/);
  });

  it("the week bounds come from the rule, not a literal (§4 D226)", () => {
    expect(disruptionWeeks(0, 400 * 7).durationWeeks).toBe(DISRUPTION_RULE.duration_weeks_max);
    const src = readFileSync(join(ROOT, "src/lib/sim/runWindow.ts"), "utf8");
    expect(src).not.toMatch(/clamp\([^)]*,\s*1,\s*52\)/);
  });
});
