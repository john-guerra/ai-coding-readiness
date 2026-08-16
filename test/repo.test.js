import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
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
    // Inject a runner that fails every subprocess. Without it this helper
    // shells out to the real `git` and then the real `gh`, so the result would
    // depend on whether `gh` is installed and authenticated on the machine
    // running the suite — and on a developer whose TMPDIR sits inside a
    // checkout, a unit test could make a live network call.
    return createFsRepo(tmpDir, {
      exec: async (cmd) => {
        throw new Error(`refusing to run ${cmd} in a hermetic test`);
      },
    });
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

// `readFile` was a bare `join(root, path)`, so repo-controlled content — an
// `@../secret.md` import in a CLAUDE.md — made the audit read a file outside
// the directory it was pointed at and print a line of it into a report the
// issue template tells people to paste. A refused path behaves as absent.
describe("createFsRepo containment", () => {
  /** @returns {Promise<{parent: string, root: string, repo: any}>} */
  const makeTree = async () => {
    const parent = await mkdtemp(join(tmpdir(), "repo-contain-"));
    const root = join(parent, "root");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "inside.md"), "inside\n", "utf8");
    await writeFile(join(parent, "secret.md"), "AWS_SECRET=xyz\n", "utf8");
    // A sibling whose name has the root's name as a string prefix. A naive
    // `startsWith(root)` test treats /a/root-evil as living inside /a/root.
    await mkdir(join(parent, "root-evil"), { recursive: true });
    await writeFile(join(parent, "root-evil", "x.md"), "outside\n", "utf8");
    const repo = createFsRepo(root, {
      exec: async (cmd) => {
        throw new Error(`refusing to run ${cmd} in a hermetic test`);
      },
    });
    return { parent, root, repo };
  };

  it("reads a file inside the root", async () => {
    const { parent, repo } = await makeTree();
    try {
      expect(await repo.readFile("inside.md")).toBe("inside\n");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("refuses a ../-escaping readFile, returning null as if absent", async () => {
    const { parent, repo } = await makeTree();
    try {
      expect(await repo.readFile("../secret.md")).toBeNull();
      expect(await repo.readFile("a/b/../../../secret.md")).toBeNull();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("refuses an absolute readFile outside the root", async () => {
    const { parent, repo } = await makeTree();
    try {
      expect(await repo.readFile(join(parent, "secret.md"))).toBeNull();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("does not treat a sibling sharing the root's name prefix as inside", async () => {
    const { parent, repo } = await makeTree();
    try {
      expect(await repo.readFile("../root-evil/x.md")).toBeNull();
      expect(await repo.listFiles("../root-evil")).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("refuses an escaping listFiles, returning [] as if absent", async () => {
    const { parent, repo } = await makeTree();
    try {
      expect(await repo.listFiles("..")).toEqual([]);
      expect(await repo.listFiles(parent)).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  // The `@../secret.md` traversal was closed; the SYMLINK route was not.
  // `insideRoot` is lexical, and `readFile` follows links — so a
  // `CLAUDE.md -> /outside/secret.md` symlink made the audit quote verbatim
  // content of a file outside the target directory into a report that
  // `.github/ISSUE_TEMPLATE/bug.md` asks people to paste in public. Same fix
  // the writer uses: realpath, then re-assert containment.
  it("refuses a symlink pointing outside the root, returning null as if absent", async () => {
    const { parent, root, repo } = await makeTree();
    try {
      await symlink(join(parent, "secret.md"), join(root, "CLAUDE.md"));
      expect(await repo.readFile("CLAUDE.md")).toBeNull();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  // ...and the same for a directory hop, where the escaping component is not
  // the file being read.
  it("refuses a read through a symlinked directory pointing outside", async () => {
    const { parent, root, repo } = await makeTree();
    try {
      await mkdir(join(parent, "elsewhere"), { recursive: true });
      await writeFile(join(parent, "elsewhere", "x.md"), "outside\n", "utf8");
      await symlink(join(parent, "elsewhere"), join(root, "link"));
      expect(await repo.readFile("link/x.md")).toBeNull();
      expect(await repo.listFiles("link")).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  // The refusal is about WHERE the path lands, not about symlinks. A link that
  // resolves back inside the root is a repository doing nothing wrong, and it
  // must still be readable — otherwise the read half and the write half
  // disagree about the same `CLAUDE.md -> AGENTS.md` layout.
  it("reads through a symlink that resolves inside the root", async () => {
    const { parent, root, repo } = await makeTree();
    try {
      await symlink("inside.md", join(root, "CLAUDE.md"));
      expect(await repo.readFile("CLAUDE.md")).toBe("inside\n");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  // A dangling symlink is absent, not an error: every check treats null as
  // "not there", and there is nothing to disclose.
  it("treats a dangling symlink as absent", async () => {
    const { parent, root, repo } = await makeTree();
    try {
      await symlink(join(parent, "gone.md"), join(root, "CLAUDE.md"));
      expect(await repo.readFile("CLAUDE.md")).toBeNull();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
