import { describe, it, expect } from "vitest";
import { makeFinding } from "../lib/finding.js";

const base = {
  id: "ci.example",
  tier: 1,
  layer: "deterministic",
  status: "pass",
  effort: "S",
  evidence: "nothing to report",
  why: "because",
  precondition: null,
  fix: null,
  autoFixable: false,
};

describe("makeFinding", () => {
  it("returns a frozen finding when the shape is valid", () => {
    const f = makeFinding(base);
    expect(f.id).toBe("ci.example");
    expect(Object.isFrozen(f)).toBe(true);
  });

  // The spec's binding rule, enforced at runtime rather than by review.
  it("rejects a failing finding that carries no fix", () => {
    expect(() => makeFinding({ ...base, status: "fail", fix: null })).toThrow(
      /every check ships with its remediation/i
    );
  });

  it("allows a failing finding with a fix", () => {
    const f = makeFinding({ ...base, status: "fail", fix: "do the thing" });
    expect(f.status).toBe("fail");
  });

  // `precondition` must be explicitly null, never absent, so a missing
  // precondition is a deliberate statement rather than an oversight.
  it("rejects a finding that omits precondition entirely", () => {
    const { precondition, ...withoutPrecondition } = base;
    expect(() => makeFinding(withoutPrecondition)).toThrow(/precondition/i);
  });

  it("rejects an unknown status value", () => {
    expect(() => makeFinding({ ...base, status: "maybe" })).toThrow(/status/i);
  });

  it("rejects a judgment-layer finding, which the binary must never emit", () => {
    expect(() => makeFinding({ ...base, layer: "judgment" })).toThrow(
      /judgment/i
    );
  });
});
