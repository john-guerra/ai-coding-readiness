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
  });

/**
 * @param {string} id
 * @param {'S'|'M'|'L'} cost
 * @returns {Check}
 */
const check = (id, cost) => ({
  id,
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
      spy
    );
    expect(order).toEqual(["fast", "mid", "slow"]);
  });

  it("emits each finding as it resolves rather than only at the end", async () => {
    const repo = createFakeRepo();
    /** @type {(f: Finding) => void} */
    const onFinding = vi.fn();
    const all = await runChecks([check("a", "S"), check("b", "S")], repo, onFinding);
    expect(onFinding).toHaveBeenCalledTimes(2);
    expect(all).toHaveLength(2);
  });

  // One broken check must not cost the user the other fifteen.
  it("converts a thrown check into an unknown finding and keeps going", async () => {
    const repo = createFakeRepo();
    /** @type {Check} */
    const exploding = {
      id: "ci.boom",
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
});
