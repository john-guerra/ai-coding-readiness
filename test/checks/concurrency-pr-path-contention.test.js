import { describe, it, expect } from "vitest";
import check, { profile } from "../../lib/checks/concurrency-pr-path-contention.js";
import { createFakeRepo } from "../../lib/repo.js";

describe("profile", () => {
  it("ranks by share of PRs touched, descending", () => {
    const rows = profile(
      [["a.js", "CHANGELOG.md"], ["b.js", "CHANGELOG.md"], ["CHANGELOG.md"]],
      {}
    );
    expect(rows[0].path).toBe("CHANGELOG.md");
    expect(rows[0].count).toBe(3);
    expect(rows[0].share).toBe(1);
  });

  it("classifies changelog and manifest files as metadata", () => {
    const rows = profile([["CHANGELOG.md", "package.json", "src/app.js"]], {});
    const kinds = Object.fromEntries(rows.map((r) => [r.path, r.kind]));
    expect(kinds["CHANGELOG.md"]).toBe("metadata");
    expect(kinds["package.json"]).toBe("metadata");
    expect(kinds["src/app.js"]).toBe("source");
  });

  it("carries line counts through when known", () => {
    const rows = profile([["src/app.js"]], { "src/app.js": 7409 });
    expect(rows[0].lines).toBe(7409);
  });
});

describe("concurrency.pr-path-contention", () => {
  it("is unknown when there is no merge history to profile", async () => {
    const f = await check.run(createFakeRepo({ mergedPrFileLists: [] }));
    expect(f.status).toBe("unknown");
  });

  it("fails on a contended metadata file and prescribes changesets", async () => {
    const lists = Array.from({ length: 10 }, (_, i) => [
      `src/f${i}.js`,
      "CHANGELOG.md",
    ]);
    const f = await check.run(createFakeRepo({ mergedPrFileLists: lists }));
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/CHANGELOG\.md/);
    expect(f.fix).toMatch(/changesets|towncrier/i);
    expect(f.autoFixable).toBe(true);
  });

  // Rule 5: report what you cannot fix, and say so.
  it("reports a contended god-file without claiming it can fix it", async () => {
    const big = "a\n".repeat(6000);
    const lists = Array.from({ length: 10 }, (_, i) => [
      `src/f${i}.js`,
      "src/App.svelte",
    ]);
    const f = await check.run(
      createFakeRepo({ files: { "src/App.svelte": big }, mergedPrFileLists: lists })
    );
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/App\.svelte/);
    expect(f.fix).toMatch(/no automatic fix/i);
    expect(f.autoFixable).toBe(false);
  });

  it("passes when no file is contended", async () => {
    const lists = Array.from({ length: 10 }, (_, i) => [`src/f${i}.js`]);
    expect((await check.run(createFakeRepo({ mergedPrFileLists: lists }))).status).toBe(
      "pass"
    );
  });
});
