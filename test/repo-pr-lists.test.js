import { describe, it, expect } from "vitest";
import { createFakeRepo, createFsRepo } from "../lib/repo.js";

/**
 * A stand-in for `execFile` that answers from a table keyed on the command.
 * Anything not in the table throws the way a missing binary would.
 *
 * @param {Record<string, string | Error>} table
 * @returns {(cmd: string, args: string[], opts?: object) => Promise<{stdout: string}>}
 */
function fakeExec(table) {
  return async (cmd, args) => {
    const key = `${cmd} ${args[0]}`;
    const answer = table[key];
    if (answer === undefined) {
      const err = /** @type {NodeJS.ErrnoException} */ (
        new Error(`spawn ${cmd} ENOENT`)
      );
      err.code = "ENOENT";
      throw err;
    }
    if (answer instanceof Error) throw answer;
    return { stdout: answer };
  };
}

/** @param {string[][]} lists */
function ghJson(lists) {
  return JSON.stringify(
    lists.map((paths) => ({ files: paths.map((path) => ({ path })) })),
  );
}

/**
 * Enough merge SHAs that the git path is considered complete.
 * @param {number} n
 */
function gitLog(n) {
  return Array.from({ length: n }, (_, i) => `sha${i}`).join("\n");
}

describe("createFakeRepo.mergedPrFileLists", () => {
  it("reports merge commits as the source by default", async () => {
    const repo = createFakeRepo({ mergedPrFileLists: [["a.js"], ["b.js"]] });
    const result = await repo.mergedPrFileLists(10);
    expect(result.source).toBe("merge-commits");
    expect(result.lists).toEqual([["a.js"], ["b.js"]]);
    expect(result.reason).toBeNull();
  });

  it("can stand in for the GitHub API path", async () => {
    const repo = createFakeRepo({
      mergedPrFileLists: [["a.js"]],
      prListSource: "github-api",
    });
    expect((await repo.mergedPrFileLists(10)).source).toBe("github-api");
  });

  it("can stand in for a repository that could not be profiled at all", async () => {
    const repo = createFakeRepo({
      prListSource: "none",
      prListReason: "the GitHub CLI is not installed",
    });
    const result = await repo.mergedPrFileLists(10);
    expect(result.source).toBe("none");
    expect(result.lists).toEqual([]);
    expect(result.reason).toMatch(/not installed/);
  });

  it("still truncates to the requested count", async () => {
    const repo = createFakeRepo({ mergedPrFileLists: [["a"], ["b"], ["c"]] });
    expect((await repo.mergedPrFileLists(2)).lists).toEqual([["a"], ["b"]]);
  });
});

describe("createFsRepo.mergedPrFileLists", () => {
  it("uses merge commits and never calls gh when git supplies a full sample", async () => {
    /** @type {string[]} */
    const calls = [];
    const exec = fakeExec({
      "git log": gitLog(3),
      "git diff": "a.js\nCHANGELOG.md\n",
    });
    const repo = createFsRepo("/r", {
      exec: async (cmd, args, opts) => {
        calls.push(cmd);
        return exec(cmd, args, opts);
      },
    });

    const result = await repo.mergedPrFileLists(3);
    expect(result.source).toBe("merge-commits");
    expect(result.lists).toHaveLength(3);
    expect(calls).not.toContain("gh");
  });

  // The trigger is "fewer than asked for", not "none at all" — a repo that
  // merged a few times years ago and squash-merges today must still reach the
  // API path, or it profiles three commits and calls that the repository.
  it("falls back to the GitHub API when git yields fewer merges than asked for", async () => {
    const repo = createFsRepo("/r", {
      exec: fakeExec({
        "git log": gitLog(2),
        "git diff": "a.js\n",
        "gh pr": ghJson([["x.js"], ["y.js"], ["z.js"]]),
      }),
    });

    const result = await repo.mergedPrFileLists(50);
    expect(result.source).toBe("github-api");
    expect(result.lists).toEqual([["x.js"], ["y.js"], ["z.js"]]);
  });

  it("keeps the git result when the API returns fewer lists than git did", async () => {
    const repo = createFsRepo("/r", {
      exec: fakeExec({
        "git log": gitLog(5),
        "git diff": "a.js\n",
        "gh pr": ghJson([["x.js"]]),
      }),
    });

    const result = await repo.mergedPrFileLists(50);
    expect(result.source).toBe("merge-commits");
    expect(result.lists).toHaveLength(5);
  });

  // Each way of failing gets its own sentence. A wall of identical
  // "could not determine" is how a tool reads as broken rather than as honest.
  it("names the GitHub CLI when it is not installed", async () => {
    const repo = createFsRepo("/r", {
      exec: fakeExec({ "git log": "" }),
    });
    const result = await repo.mergedPrFileLists(50);
    expect(result.source).toBe("none");
    expect(result.reason).toMatch(/gh.*not installed|not installed.*gh/i);
  });

  it("distinguishes an unauthenticated CLI from a missing one", async () => {
    const repo = createFsRepo("/r", {
      exec: fakeExec({
        "git log": "",
        "gh pr": new Error(
          "gh: To get started with GitHub CLI, please run: gh auth login",
        ),
      }),
    });
    const result = await repo.mergedPrFileLists(50);
    expect(result.source).toBe("none");
    expect(result.reason).toMatch(/authenticat/i);
  });

  it("distinguishes a repository with no GitHub remote", async () => {
    const repo = createFsRepo("/r", {
      exec: fakeExec({
        "git log": "",
        "gh pr": new Error(
          "none of the git remotes configured for this repository point to a known GitHub host",
        ),
      }),
    });
    const result = await repo.mergedPrFileLists(50);
    expect(result.source).toBe("none");
    expect(result.reason).toMatch(/GitHub remote/i);
  });

  it("reports an API failure as itself rather than as an absent history", async () => {
    const repo = createFsRepo("/r", {
      exec: fakeExec({
        "git log": "",
        "gh pr": new Error("API rate limit exceeded"),
      }),
    });
    const result = await repo.mergedPrFileLists(50);
    expect(result.source).toBe("none");
    expect(result.reason).toMatch(/rate limit/i);
  });

  it("reports unparseable API output as a failure, not as an empty history", async () => {
    const repo = createFsRepo("/r", {
      exec: fakeExec({ "git log": "", "gh pr": "not json at all" }),
    });
    const result = await repo.mergedPrFileLists(50);
    expect(result.source).toBe("none");
    expect(result.reason).toMatch(/could not be read|parse/i);
  });

  it("treats a genuinely empty PR history as none, with a reason saying so", async () => {
    const repo = createFsRepo("/r", {
      exec: fakeExec({ "git log": "", "gh pr": "[]" }),
    });
    const result = await repo.mergedPrFileLists(50);
    expect(result.source).toBe("none");
    expect(result.reason).toMatch(/no merged pull requests/i);
  });
});
