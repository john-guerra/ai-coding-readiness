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

  it("counts a path once per PR even if it appears twice in that PR's file list", () => {
    const rows = profile([["a.js", "a.js", "b.js"]], {});
    expect(rows.find((r) => r.path === "a.js")?.count).toBe(1);
  });

  it("classifies lockfiles as generated, not source", () => {
    const rows = profile([["package-lock.json", "yarn.lock", "src/app.js"]], {});
    const kinds = Object.fromEntries(rows.map((r) => [r.path, r.kind]));
    expect(kinds["package-lock.json"]).toBe("generated");
    expect(kinds["yarn.lock"]).toBe("generated");
    expect(kinds["src/app.js"]).toBe("source");
  });
});

describe("concurrency.pr-path-contention", () => {
  it("is unknown when there is no merge history to profile", async () => {
    const f = await check.run(createFakeRepo({ mergedPrFileLists: [] }));
    expect(f.status).toBe("unknown");
  });

  // The instrument must be able to produce a non-trivial result before its
  // output means anything. At N=1 every file in that one merge commit sits at
  // 100% and clears a 50% threshold by construction, so a "profile" from it
  // measures the sample size and nothing else.
  it("is unknown, not fail, when one merge commit would put every file it touched at 100%", async () => {
    const f = await check.run(
      createFakeRepo({ mergedPrFileLists: [["a.js", "b.js", "c.js"]] })
    );
    expect(f.status).toBe("unknown");
    expect(f.evidence).toMatch(/\b1\b/);
    expect(f.evidence).toMatch(/merge commit/i);
  });

  it("is unknown at 9 merge commits and reports a verdict at 10", async () => {
    /** @param {number} n */
    const lists = (n) =>
      Array.from({ length: n }, (_, i) => [`src/f${i}.js`, "CHANGELOG.md"]);

    const nine = await check.run(createFakeRepo({ mergedPrFileLists: lists(9) }));
    expect(nine.status).toBe("unknown");
    expect(nine.evidence).toMatch(/\b9\b/);

    const ten = await check.run(createFakeRepo({ mergedPrFileLists: lists(10) }));
    expect(ten.status).toBe("fail");
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

  it("is not auto-fixable when a contended god-file sits alongside a metadata file", async () => {
    const big = "a\n".repeat(6000);
    const lists = Array.from({ length: 10 }, (_, i) => [
      `src/f${i}.js`,
      "CHANGELOG.md",
      "src/App.svelte",
    ]);
    const f = await check.run(
      createFakeRepo({ files: { "src/App.svelte": big }, mergedPrFileLists: lists })
    );
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/CHANGELOG\.md/);
    expect(f.evidence).toMatch(/App\.svelte/);
    expect(f.fix).toMatch(/changesets|towncrier/i);
    expect(f.fix).toMatch(/no automatic fix/i);
    expect(f.autoFixable).toBe(false);
  });

  it("is not auto-fixable when a contended source file sits alongside a metadata file, even below the size floor", async () => {
    const lists = Array.from({ length: 10 }, (_, i) => [
      `src/f${i}.js`,
      "CHANGELOG.md",
      "src/small.js",
    ]);
    const f = await check.run(
      createFakeRepo({
        files: { "src/small.js": "a\n".repeat(10) },
        mergedPrFileLists: lists,
      })
    );
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/src\/small\.js/);
    expect(f.autoFixable).toBe(false);
  });

  it("gives a lockfile the regeneration fix, not the god-file fix", async () => {
    const bigLock = "a\n".repeat(6000);
    const lists = Array.from({ length: 10 }, (_, i) => [
      `src/f${i}.js`,
      "CHANGELOG.md",
      "package-lock.json",
    ]);
    const f = await check.run(
      createFakeRepo({
        files: { "package-lock.json": bigLock },
        mergedPrFileLists: lists,
      })
    );
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/package-lock\.json/);
    expect(f.fix).toMatch(/machine-generated|regenerat/i);
    expect(f.fix).not.toMatch(/no automatic fix/i);
  });

  // A lockfile is SUPPOSED to change on every PR that touches a dependency.
  // Failing on it produced a `fail` whose own fix said the contention was
  // expected and not a design problem — a finding arguing against itself.
  it("passes when the only contended file is machine-generated", async () => {
    const lists = Array.from({ length: 20 }, (_, i) => [
      `src/f${i}.js`,
      "package-lock.json",
    ]);
    const f = await check.run(createFakeRepo({ mergedPrFileLists: lists }));
    expect(f.status).toBe("pass");
    // Still reported, because it is context for whoever reads the profile.
    expect(f.evidence).toMatch(/package-lock\.json/);
  });

  // The flagship demo contradicted itself: it printed the changesets
  // remediation and then, three lines later, "This finding has no automatic
  // fix; it needs a person." A co-contended lockfile — package.json plus
  // package-lock.json, the most common Node shape there is — is not an
  // obstacle to auto-fixing the metadata half.
  it("stays auto-fixable when a lockfile is contended alongside package.json", async () => {
    const lists = Array.from({ length: 20 }, (_, i) => [
      `src/f${i}.js`,
      "package.json",
      "package-lock.json",
    ]);
    const f = await check.run(createFakeRepo({ mergedPrFileLists: lists }));
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/package\.json/);
    expect(f.evidence).toMatch(/package-lock\.json/);
    expect(f.fix).toMatch(/changesets|towncrier/i);
    expect(f.autoFixable).toBe(true);
  });

  // A tool that tells people their line counts are stale has to agree with
  // `wc -l`, which counts newline characters — not split("\n").length, which
  // reads the trailing newline as one more line.
  it("counts lines the way wc -l does, not one higher", async () => {
    const lists = Array.from({ length: 10 }, (_, i) => [
      `src/f${i}.js`,
      "CHANGELOG.md",
    ]);
    const f = await check.run(
      createFakeRepo({
        files: { "CHANGELOG.md": "one\ntwo\nthree\n" },
        mergedPrFileLists: lists,
      })
    );
    expect(f.evidence).toMatch(/3 lines/);
    expect(f.evidence).not.toMatch(/4 lines/);
  });

  // The god-file remediation used to ignore the measurement it had just
  // made, which is the one thing it has that generic advice does not.
  it("cites the measured size and share in the god-file remediation", async () => {
    const lists = Array.from({ length: 20 }, (_, i) => [
      `src/f${i}.js`,
      "ui/src/App.svelte",
    ]);
    const f = await check.run(
      createFakeRepo({
        files: { "ui/src/App.svelte": "x\n".repeat(7409) },
        mergedPrFileLists: lists,
      })
    );
    expect(f.status).toBe("fail");
    expect(f.fix).toMatch(/7,409 lines/);
    expect(f.fix).toMatch(/100% of/);
    expect(f.autoFixable).toBe(false);
  });

  it("surfaces a large sub-threshold file as 'also worth attention' without failing the status", async () => {
    const big = "a\n".repeat(2000);
    const lists = Array.from({ length: 20 }, (_, i) =>
      i < 3 ? ["src/big.js"] : [`src/f${i}.js`]
    );
    const f = await check.run(
      createFakeRepo({ files: { "src/big.js": big }, mergedPrFileLists: lists })
    );
    expect(f.status).toBe("pass");
    expect(f.evidence).toMatch(/also worth attention/i);
    expect(f.evidence).toMatch(/src\/big\.js/);
  });
});
