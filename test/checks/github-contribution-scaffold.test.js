import { describe, it, expect } from "vitest";
import { createFakeRepo } from "../../lib/repo.js";
import { applyFinding } from "../helpers/apply-finding.js";
import check from "../../lib/checks/github-contribution-scaffold.js";

const ALL = {
  ".github/ISSUE_TEMPLATE/bug.md": "x",
  ".github/PULL_REQUEST_TEMPLATE.md": "x",
  ".github/CODEOWNERS": "* @me",
};

describe("github.contribution-scaffold", () => {
  it("passes when all three are present", async () => {
    expect((await check.run(createFakeRepo({ files: ALL }))).status).toBe(
      "pass",
    );
  });

  it("names every missing artefact, not just the first", async () => {
    const f = await check.run(createFakeRepo({ files: {} }));
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/issue template/i);
    expect(f.evidence).toMatch(/pull request template/i);
    expect(f.evidence).toMatch(/CODEOWNERS/);
  });

  it("accepts the alternative locations", async () => {
    const f = await check.run(
      createFakeRepo({
        files: {
          ".github/ISSUE_TEMPLATE.md": "x",
          "PULL_REQUEST_TEMPLATE.md": "x",
          CODEOWNERS: "* @me",
        },
      }),
    );
    expect(f.status).toBe("pass");
  });

  // A7: the brief's version of this test used a MISSING directory, which
  // createFakeRepo cannot distinguish from an empty one. Renamed to say what
  // it actually tests, with the missing-directory case kept separately below.
  it("fails when there is no issue template at all", async () => {
    const f = await check.run(
      createFakeRepo({
        files: {
          ".github/PULL_REQUEST_TEMPLATE.md": "x",
          ".github/CODEOWNERS": "* @me",
        },
      }),
    );
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/issue template/i);
  });

  // A7: config.yml-only is the single most common way ISSUE_TEMPLATE/ exists
  // with no actual template in it, and must not be credited as one.
  it("does not accept an ISSUE_TEMPLATE directory containing only config.yml", async () => {
    const f = await check.run(
      createFakeRepo({
        files: {
          ".github/ISSUE_TEMPLATE/config.yml": "blank_issues_enabled: false",
          ".github/PULL_REQUEST_TEMPLATE.md": "x",
          ".github/CODEOWNERS": "* @me",
        },
      }),
    );
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/issue template/i);
  });

  it("accepts an ISSUE_TEMPLATE directory with a real template alongside config.yml", async () => {
    const f = await check.run(
      createFakeRepo({
        files: {
          ".github/ISSUE_TEMPLATE/config.yml": "blank_issues_enabled: false",
          ".github/ISSUE_TEMPLATE/bug.md": "x",
          ".github/PULL_REQUEST_TEMPLATE.md": "x",
          ".github/CODEOWNERS": "* @me",
        },
      }),
    );
    expect(f.status).toBe("pass");
  });

  it("explains why a bug template matters, not just that one is missing", async () => {
    const f = await check.run(createFakeRepo({ files: {} }));
    expect(f.fix).toMatch(/repro/i);
  });

  it("carries no action when it passes", async () => {
    const f = await check.run(createFakeRepo({ files: ALL }));
    expect(f.autoFixable).toBe(false);
    expect(f.action).toBeNull();
  });

  describe("action", () => {
    it("offers the first missing template, at the directory location", async () => {
      const f = await check.run(createFakeRepo({ files: {} }));
      expect(f.autoFixable).toBe(true);
      expect(f.action).toMatchObject({
        kind: "write-file",
        path: ".github/ISSUE_TEMPLATE/bug.md",
      });
    });

    // The whole point of the artefact: a report that does not say what was
    // expected and what happened instead cannot be verified against.
    it("generates a bug template that asks for repro, expected and actual", async () => {
      const f = await check.run(createFakeRepo({ files: {} }));
      const content = /** @type {{content: string}} */ (f.action).content;
      expect(content).toMatch(/reproduce/i);
      expect(content).toMatch(/expected/i);
      expect(content).toMatch(/actually happened|what happened/i);
    });

    it("moves on to the pull request template once an issue template exists", async () => {
      const f = await check.run(
        createFakeRepo({ files: { ".github/ISSUE_TEMPLATE/bug.md": "x" } }),
      );
      expect(f.action).toMatchObject({
        kind: "write-file",
        path: ".github/PULL_REQUEST_TEMPLATE.md",
      });
      const content = /** @type {{content: string}} */ (f.action).content;
      expect(content).toMatch(/what changed/i);
      expect(content).toMatch(/why/i);
      expect(content).toMatch(/verif/i);
    });

    // Amendment B7. `gh repo view` is a second network path; `git remote` is
    // not on `Repo`; and the derived owner is usually an ORGANISATION, which
    // is not valid CODEOWNERS syntax — GitHub renders `* @some-org` as
    // "Unknown owner" and required-review-by-owner silently never fires. A
    // generated file that looks right and quietly does nothing is worse than
    // no file, so CODEOWNERS stays a human step named in the fix prose.
    it("offers nothing when CODEOWNERS is the only gap, and says why in the fix", async () => {
      const f = await check.run(
        createFakeRepo({
          files: {
            ".github/ISSUE_TEMPLATE/bug.md": "x",
            ".github/PULL_REQUEST_TEMPLATE.md": "x",
          },
        }),
      );
      expect(f.status).toBe("fail");
      expect(f.autoFixable).toBe(false);
      expect(f.action).toBeNull();
      expect(f.evidence).toMatch(/CODEOWNERS/);
      expect(f.fix).toMatch(/CODEOWNERS/);
      expect(f.fix).toMatch(/not generated|by hand|yourself/i);
    });

    // Amendment B8, as far as B7 allows it to go: each applied action must
    // measurably improve the finding that produced it, and the loop must
    // terminate at a stated fixed point rather than churning. This check
    // cannot reach `pass` by writing — CODEOWNERS is deliberately not
    // generated — so the assertion is that the gap count strictly decreases
    // to exactly one, and that the remaining gap is the human one.
    it("converges in two passes, leaving only the CODEOWNERS gap", async () => {
      /** @type {Record<string, string>} */
      let files = {};

      const first = await check.run(createFakeRepo({ files }));
      expect(first.evidence).toMatch(/3 of 3 missing/);
      ({ files } = await applyFinding(files, first));

      const second = await check.run(createFakeRepo({ files }));
      expect(second.evidence).toMatch(/2 of 3 missing/);
      expect(second.evidence).not.toMatch(/issue template/i);
      ({ files } = await applyFinding(files, second));

      const third = await check.run(createFakeRepo({ files }));
      expect(third.evidence).toMatch(/1 of 3 missing/);
      expect(third.evidence).toMatch(/CODEOWNERS/);
      expect(third.evidence).not.toMatch(/pull request template/i);
      // Terminated: nothing left that a machine may apply.
      expect(third.action).toBeNull();
    });

    // A generated issue template that the check itself would not credit would
    // loop forever. `config.yml` is the name that does not count, and the
    // generated file must not be mistaken for it.
    it("generates an issue template this check credits on the next pass", async () => {
      const f = await check.run(createFakeRepo({ files: {} }));
      const { files } = await applyFinding({}, f);
      const after = await check.run(createFakeRepo({ files }));
      expect(after.evidence).not.toMatch(/issue template/i);
    });
  });
});
