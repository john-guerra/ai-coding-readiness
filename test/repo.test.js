import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createFakeRepo, createFsRepo } from "../lib/repo.js";

describe("createFakeRepo", () => {
  it("reads a file that exists", async () => {
    const repo = createFakeRepo({ files: { "a.txt": "hello" } });
    expect(await repo.readFile("a.txt")).toBe("hello");
  });

  // Absence is a finding, not an exception. Every check relies on this.
  it("returns null for a missing file rather than throwing", async () => {
    const repo = createFakeRepo({ files: {} });
    expect(await repo.readFile("nope.txt")).toBeNull();
  });

  it("lists files in a directory, non-recursively", async () => {
    const repo = createFakeRepo({
      files: {
        ".github/workflows/ci.yml": "",
        ".github/workflows/release.yml": "",
        ".github/dependabot.yml": "",
      },
    });
    const found = await repo.listFiles(".github/workflows");
    expect(found.sort()).toEqual([
      ".github/workflows/ci.yml",
      ".github/workflows/release.yml",
    ]);
  });

  it("returns an empty list for a missing directory", async () => {
    const repo = createFakeRepo({ files: {} });
    expect(await repo.listFiles(".github/workflows")).toEqual([]);
  });

  it("lists root-level files when dir is empty string", async () => {
    const repo = createFakeRepo({
      files: {
        "README.md": "",
        "package.json": "",
        "src/index.js": "",
      },
    });
    const found = await repo.listFiles("");
    expect(found.sort()).toEqual(["README.md", "package.json"]);
  });

  it("lists root-level files when dir is dot", async () => {
    const repo = createFakeRepo({
      files: {
        "README.md": "",
        "package.json": "",
        "src/index.js": "",
      },
    });
    const found = await repo.listFiles(".");
    expect(found.sort()).toEqual(["README.md", "package.json"]);
  });

  it("returns merge file lists newest first", async () => {
    const repo = createFakeRepo({
      mergedPrFileLists: [["a.js"], ["b.js", "CHANGELOG.md"]],
    });
    expect((await repo.mergedPrFileLists(10)).lists).toEqual([
      ["a.js"],
      ["b.js", "CHANGELOG.md"],
    ]);
  });

  it("truncates merge file lists to the requested count", async () => {
    const repo = createFakeRepo({
      mergedPrFileLists: [["a"], ["b"], ["c"]],
    });
    expect((await repo.mergedPrFileLists(2)).lists).toEqual([["a"], ["b"]]);
  });
});

describe("contract tests (both implementations)", () => {
  // Helper to create contract test suite
  /**
   * @param {string} name
   * @param {(files: Record<string,string>) => Promise<any>} makeRepo
   */
  const buildContractTests = (name, makeRepo) => {
    describe(name, () => {
      it("reads a file that exists", async () => {
        const repo = await makeRepo({ "file.txt": "content" });
        try {
          expect(await repo.readFile("file.txt")).toBe("content");
        } finally {
          await cleanupRepo(repo);
        }
      });

      it("returns null for a missing file", async () => {
        const repo = await makeRepo({});
        try {
          expect(await repo.readFile("nope.txt")).toBeNull();
        } finally {
          await cleanupRepo(repo);
        }
      });

      it("lists root-level files with empty string", async () => {
        const repo = await makeRepo({
          "README.md": "content",
          "package.json": "content",
          "src/index.js": "nested",
        });
        try {
          const found = await repo.listFiles("");
          expect(found.sort()).toEqual(["README.md", "package.json"]);
        } finally {
          await cleanupRepo(repo);
        }
      });

      // A path beneath a file genuinely is "not there". listFiles already
      // narrowed on ENOTDIR; readFile did not, so the same shape of absence
      // threw out of one accessor and returned null from the other.
      it("returns null for a path underneath a file", async () => {
        const repo = await makeRepo({ "file.txt": "content" });
        try {
          expect(await repo.readFile("file.txt/nested.txt")).toBeNull();
        } finally {
          await cleanupRepo(repo);
        }
      });

      it("returns empty list for missing directory", async () => {
        const repo = await makeRepo({});
        try {
          expect(await repo.listFiles("nonexistent")).toEqual([]);
        } finally {
          await cleanupRepo(repo);
        }
      });

      it("returns empty merge list for non-git directory", async () => {
        const repo = await makeRepo({});
        try {
          const result = await repo.mergedPrFileLists(10);
          expect(result.lists).toEqual([]);
          // Absence must arrive with a stated cause, not as a bare empty list —
          // "this repo squash-merges" and "the CLI is not authenticated" are
          // different findings and used to render as the same shrug.
          expect(result.source).toBe("none");
          expect(result.reason).toBeTruthy();
        } finally {
          await cleanupRepo(repo);
        }
      });
    });
  };

  // Create fake repo
  /**
   * @param {Record<string,string>} files
   * @returns {Promise<any>}
   */
  const makeFakeRepo = async (files) => {
    /** @type {Record<string,string>} */
    const fileMap = {};
    for (const [path, content] of Object.entries(files)) {
      fileMap[path] = content;
    }
    return createFakeRepo({ files: fileMap });
  };

  // Create fs repo in temp directory
  /**
   * @param {Record<string,string>} files
   * @returns {Promise<any>}
   */
  const makeFsRepo = async (files) => {
    const tmpDir = await mkdtemp(join(tmpdir(), "repo-test-"));
    for (const [path, content] of Object.entries(files)) {
      const fullPath = join(tmpDir, path);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, "utf8");
    }
    return createFsRepo(tmpDir);
  };

  // Cleanup function
  /**
   * @param {any} repo
   * @returns {Promise<void>}
   */
  const cleanupRepo = async (repo) => {
    if (repo.root.startsWith(tmpdir())) {
      await rm(repo.root, { recursive: true, force: true });
    }
  };

  buildContractTests("fake repo", makeFakeRepo);
  buildContractTests("fs repo", makeFsRepo);
});
