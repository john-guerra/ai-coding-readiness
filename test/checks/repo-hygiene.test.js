import { describe, it, expect } from "vitest";
import { createFakeRepo } from "../../lib/repo.js";
import check from "../../lib/checks/repo-hygiene.js";

const IGNORE_ALL = "node_modules/\ndist/\n.env\n.DS_Store\n";

describe("repo.hygiene", () => {
  it("is unknown without a package.json to identify the ecosystem", async () => {
    expect((await check.run(createFakeRepo({ files: {} }))).status).toBe(
      "unknown",
    );
  });

  it("fails when the lockfile is missing", async () => {
    const f = await check.run(
      createFakeRepo({
        files: { "package.json": "{}", ".gitignore": IGNORE_ALL },
      }),
    );
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/lockfile/i);
    expect(f.fix).toMatch(/--package-lock-only/);
  });

  it("accepts any of the ecosystem's lockfiles", async () => {
    for (const lock of [
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "bun.lockb",
    ]) {
      const f = await check.run(
        createFakeRepo({
          files: {
            "package.json": "{}",
            [lock]: "x",
            ".gitignore": IGNORE_ALL,
          },
        }),
      );
      expect(f.status, lock).toBe("pass");
    }
  });

  it("names every .gitignore gap rather than only the first", async () => {
    const f = await check.run(
      createFakeRepo({
        files: {
          "package.json": "{}",
          "package-lock.json": "x",
          ".gitignore": "node_modules/\n",
        },
      }),
    );
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/\.env/);
    expect(f.evidence).toMatch(/\.DS_Store/);
  });

  it("fails when there is no .gitignore at all", async () => {
    const f = await check.run(
      createFakeRepo({
        files: { "package.json": "{}", "package-lock.json": "x" },
      }),
    );
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/not found at the repo root/i);
  });

  // A6: comments and negations must not count as coverage, and substrings
  // that merely CONTAIN the required name (distribution/, .envrc) must not
  // either. Every entry in this .gitignore is a decoy for one requirement.
  it("does not credit comments, negations, or look-alike entries as coverage", async () => {
    const decoy =
      "# node_modules is tracked on purpose\n" +
      "distribution/\n" +
      ".envrc\n" +
      "# never commit .DS_Store\n";
    const f = await check.run(
      createFakeRepo({
        files: {
          "package.json": "{}",
          "package-lock.json": "x",
          ".gitignore": decoy,
        },
      }),
    );
    expect(f.status).toBe("fail");
    // 4 of 4, still. This is the case the whole whole-entry rewrite exists
    // for: `.envrc` has no `*` and is not `.env`, so the trailing-`*` rule
    // below must not rescue it, and `distribution/` must not cover `dist`.
    expect(f.evidence).toMatch(/4 hygiene gap/);
    expect(f.evidence).toMatch(/node_modules/);
    expect(f.evidence).toMatch(/dist|build/);
    expect(f.evidence).toMatch(/\.env/);
    expect(f.evidence).toMatch(/\.DS_Store/);
  });

  // Anchoring to whole entries killed the `distribution/` decoy but also
  // rejected the commonest glob forms, so a perfectly-covered .gitignore
  // scored 4 of 4 gaps and the fix told the maintainer to add entries that
  // were already there — a fix that does not apply.
  it("credits common glob forms of the required entries", async () => {
    const f = await check.run(
      createFakeRepo({
        files: {
          "package.json": "{}",
          "package-lock.json": "x",
          ".gitignore": "**/node_modules\ndist/**\n.env\n**/.DS_Store  \n",
        },
      }),
    );
    expect(f.status).toBe("pass");
  });

  it("names only the genuinely-missing entry when the rest are globs", async () => {
    const f = await check.run(
      createFakeRepo({
        files: {
          "package.json": "{}",
          "package-lock.json": "x",
          ".gitignore": "**/node_modules\ndist/**\n**/.DS_Store\n",
        },
      }),
    );
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/1 hygiene gap/);
    expect(f.evidence).toMatch(/\.env/);
    expect(f.evidence).not.toMatch(/node_modules/);
    expect(f.evidence).not.toMatch(/\.DS_Store/);
  });

  // A trailing `*` is a prefix glob to git — `*` matches the empty string, so
  // `.env*` really does ignore `.env`:
  //   $ printf '.env*\n' > .gitignore && git check-ignore -v .env
  //   .gitignore:1:.env*	.env
  // Reporting a gap here told the maintainer to add an entry already covered,
  // which is the one thing a remediation is never allowed to be.
  it("credits a trailing-* entry, which is what git actually does", async () => {
    const f = await check.run(
      createFakeRepo({
        files: {
          "package.json": "{}",
          "package-lock.json": "x",
          ".gitignore": "node_modules*\ndist*\n.env*\n.DS_Store\n",
        },
      }),
    );
    expect(f.status).toBe("pass");
  });

  it("credits each trailing-* form on its own, leaving the others as gaps", async () => {
    for (const [entry, covered] of [
      ["node_modules*", "node_modules"],
      ["dist*", "build output"],
      [".env*", ".env"],
    ]) {
      const f = await check.run(
        createFakeRepo({
          files: {
            "package.json": "{}",
            "package-lock.json": "x",
            ".gitignore": `${entry}\n`,
          },
        }),
      );
      expect(f.status, entry).toBe("fail");
      expect(f.evidence, entry).toMatch(/3 hygiene gap/);
      expect(f.evidence, entry).not.toMatch(
        new RegExp(covered.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    }
  });

  // The trailing-* rule is a PREFIX rule, not "contains". `.env` must not be
  // covered by an entry for something else that happens to start similarly.
  it("does not let a trailing-* entry cover a name it is not a prefix of", async () => {
    const f = await check.run(
      createFakeRepo({
        files: {
          "package.json": "{}",
          "package-lock.json": "x",
          ".gitignore": "node_modules/\ndist/\n.envrc*\n.DS_Store\n",
        },
      }),
    );
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/1 hygiene gap/);
    expect(f.evidence).toMatch(/\.env/);
  });

  it("reports the lockfile as present, not committed", async () => {
    const f = await check.run(
      createFakeRepo({
        files: {
          "package.json": "{}",
          "package-lock.json": "x",
          ".gitignore": IGNORE_ALL,
        },
      }),
    );
    expect(f.status).toBe("pass");
    expect(f.evidence).not.toMatch(/committed/i);
    expect(f.evidence).toMatch(/present/i);
  });

  // A6 (inverted from the brief): the check must NOT imply it scanned for
  // secrets. It must instead say so explicitly, because that disclosure is
  // what keeps "repo.hygiene" from over-claiming.
  it("states what it did not examine, rather than implying it scanned for secrets", async () => {
    const f = await check.run(
      createFakeRepo({
        files: {
          "package.json": "{}",
          "package-lock.json": "x",
          ".gitignore": IGNORE_ALL,
        },
      }),
    );
    expect(f.status).toBe("pass");
    expect(f.evidence).toMatch(
      /does not look for tracked secrets or credentials/i,
    );
    expect(f.evidence).toMatch(/listing of tracked files/i);
  });
});
