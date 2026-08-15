import { describe, it, expect } from "vitest";
import { renderMarkdown, renderJson } from "../lib/report.js";
import { makeFinding } from "../lib/finding.js";

/**
 * @param {string} id
 * @param {'pass'|'fail'|'unknown'} status
 * @param {Partial<import('../lib/finding.js').Finding>} [extra]
 */
const f = (id, status, extra = {}) =>
  makeFinding({
    id,
    tier: 1,
    layer: "deterministic",
    status,
    effort: "S",
    evidence: "ev",
    why: "why",
    precondition: null,
    fix: status === "fail" ? "do it" : null,
    autoFixable: false,
    ...extra,
  });

describe("renderMarkdown", () => {
  it("puts failures first, since they are the point", () => {
    const out = renderMarkdown([f("a.pass", "pass"), f("b.fail", "fail")]);
    expect(out.indexOf("b.fail")).toBeLessThan(out.indexOf("a.pass"));
  });

  it("renders the precondition when one exists", () => {
    const out = renderMarkdown([
      f("c.fail", "fail", { precondition: "measure first" }),
    ]);
    expect(out).toMatch(/measure first/);
  });

  it("distinguishes unknown from pass in the summary", () => {
    const out = renderMarkdown([f("a", "unknown"), f("b", "pass")]);
    expect(out).toMatch(/1 unknown/);
    expect(out).toMatch(/1 pass/);
  });

  it("says plainly when a finding has no automatic fix", () => {
    const out = renderMarkdown([f("d.fail", "fail", { autoFixable: false })]);
    expect(out).toMatch(/no automatic fix/i);
  });
});

describe("renderJson", () => {
  it("emits a parseable array of findings", () => {
    const parsed = JSON.parse(renderJson([f("a", "pass")]));
    expect(parsed.findings[0].id).toBe("a");
    expect(parsed.summary.pass).toBe(1);
  });
});
