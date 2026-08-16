import { describe, it, expect } from "vitest";
import { createFakeRepo } from "../../lib/repo.js";
import check from "../../lib/checks/guide-context-budget.js";

/** @param {number} n */
const lines = (n) => "x\n".repeat(n);

describe("guide.context-budget", () => {
  it("is unknown when there is no guide", async () => {
    expect((await check.run(createFakeRepo({ files: {} }))).status).toBe(
      "unknown",
    );
  });

  it("passes a guide comfortably under the budget", async () => {
    const f = await check.run(
      createFakeRepo({ files: { "CLAUDE.md": lines(120) } }),
    );
    expect(f.status).toBe("pass");
    expect(f.evidence).toMatch(/120/);
  });

  // Imports do not reduce context — they load at launch — so they count.
  // Missing an import silently under-counts the budget (a false `pass`), so
  // assert the actual combined total rather than a substring that an
  // itemised "docs/big.md — 400 lines" line would satisfy on its own.
  it("counts @-imported files against the budget", async () => {
    const f = await check.run(
      createFakeRepo({
        files: {
          "CLAUDE.md": `@docs/big.md\n${lines(50)}`,
          "docs/big.md": lines(400),
        },
      }),
    );
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/docs\/big\.md/);
    // CLAUDE.md is 51 lines ("@docs/big.md\n" + 50 more newlines) + 400 in
    // the import = 451.
    expect(f.evidence).toMatch(/451/);
  });

  it("counts an unscoped rule but not a paths-scoped one", async () => {
    const f = await check.run(
      createFakeRepo({
        files: {
          "CLAUDE.md": lines(150),
          ".claude/rules/always.md": lines(100),
          ".claude/rules/scoped.md": `---\npaths:\n  - "src/**"\n---\n${lines(500)}`,
        },
      }),
    );
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/always\.md/);
    expect(f.evidence).not.toMatch(/scoped\.md/);
  });

  it("carries the precondition that only path-scopable content can move", async () => {
    const f = await check.run(
      createFakeRepo({ files: { "CLAUDE.md": lines(400) } }),
    );
    expect(f.status).toBe("fail");
    expect(f.precondition).toMatch(/path scope/i);
    expect(f.fix).toMatch(/mechaniz/i);
  });

  // Math.round(total / 200) prints "1×" for 201, 250 AND 299 lines alike,
  // which reads as "barely failing" no matter how far over budget the guide
  // actually is. A one-decimal multiplier must distinguish them.
  it("reports a multiplier that is readable just over budget", async () => {
    const f = await check.run(
      createFakeRepo({ files: { "CLAUDE.md": lines(201) } }),
    );
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/1\.0×/);
  });

  it("reports a multiplier that is readable far over budget", async () => {
    const f = await check.run(
      createFakeRepo({ files: { "CLAUDE.md": lines(1595) } }),
    );
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/8\.0×/);
  });
});
