import { describe, it, expect } from "vitest";
import { createFakeRepo } from "../../lib/repo.js";
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
});
