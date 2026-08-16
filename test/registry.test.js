import { describe, it, expect, vi } from "vitest";
import { runChecks } from "../lib/registry.js";
import { makeFinding } from "../lib/finding.js";
import { createFakeRepo } from "../lib/repo.js";

/**
 * @typedef {import('../lib/finding.js').Finding} Finding
 * @typedef {import('../lib/registry.js').Check} Check
 */

/**
 * @param {string} id
 * @param {'pass'|'fail'|'unknown'} [status]
 * @returns {Finding}
 */
const finding = (id, status = "pass") =>
  makeFinding({
    id,
    tier: 1,
    layer: "deterministic",
    status,
    effort: "S",
    evidence: "e",
    why: "w",
    precondition: null,
    fix: status === "fail" ? "f" : null,
    autoFixable: false,
    action: null,
  });

/**
 * @param {string} id
 * @param {'S'|'M'|'L'} cost
 * @param {0|1|2} [tier]
 * @returns {Check}
 */
const check = (id, cost, tier = 1) => ({
  id,
  tier,
  cost,
  run: async () => finding(id),
});

describe("runChecks", () => {
  it("runs cheapest checks first so findings appear early", async () => {
    const repo = createFakeRepo();
    /** @type {string[]} */
    const order = [];
    /** @type {(f: Finding) => void} */
    const spy = (f) => {
      order.push(f.id);
    };
    await runChecks(
      [check("slow", "L"), check("fast", "S"), check("mid", "M")],
      repo,
      spy,
    );
    expect(order).toEqual(["fast", "mid", "slow"]);
  });

  it("emits each finding as it resolves rather than only at the end", async () => {
    const repo = createFakeRepo();
    /** @type {(f: Finding) => void} */
    const onFinding = vi.fn();
    const all = await runChecks(
      [check("a", "S"), check("b", "S")],
      repo,
      onFinding,
    );
    expect(onFinding).toHaveBeenCalledTimes(2);
    expect(all).toHaveLength(2);
  });

  // An unrecognized cost indexed COST_ORDER to undefined, so the comparator
  // returned NaN and the run order became arbitrary — the one property this
  // ordering exists to provide.
  it("orders a check with an unrecognized cost rather than going NaN", async () => {
    const repo = createFakeRepo();
    /** @type {string[]} */
    const order = [];
    /** @type {(f: Finding) => void} */
    const spy = (f) => {
      order.push(f.id);
    };
    await runChecks(
      [check("odd", /** @type {any} */ ("XL")), check("fast", "S")],
      repo,
      spy,
    );
    expect(order).toEqual(["fast", "odd"]);
  });

  // One broken check must not cost the user the other fifteen.
  it("converts a thrown check into an unknown finding and keeps going", async () => {
    const repo = createFakeRepo();
    /** @type {Check} */
    const exploding = {
      id: "ci.boom",
      tier: 1,
      cost: "S",
      run: async () => {
        throw new Error("kaboom");
      },
    };
    const all = await runChecks([exploding, check("ok", "S")], repo);
    const boom = all.find((f) => f.id === "ci.boom");
    expect(boom).toBeDefined();
    if (!boom) return; // Type guard
    expect(boom.status).toBe("unknown");
    expect(boom.evidence).toMatch(/kaboom/);
    const ok = all.find((f) => f.id === "ok");
    expect(ok).toBeDefined();
    if (!ok) return; // Type guard
    expect(ok.status).toBe("pass");
  });

  // The synthesized finding hardcoded tier 1, so a broken tier-2 check was
  // reported to the user as "(T1)" — the report's tier vocabulary silently
  // misdescribing the check that failed.
  it("reports a thrown check at its own tier, not a hardcoded one", async () => {
    const repo = createFakeRepo();
    /** @type {Check} */
    const exploding = {
      id: "concurrency.boom",
      tier: 2,
      cost: "S",
      run: async () => {
        throw new Error("kaboom");
      },
    };
    const [f] = await runChecks([exploding], repo);
    expect(f.tier).toBe(2);
  });
});
