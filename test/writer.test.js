import { describe, it, expect } from "vitest";
import {
  mkdtemp,
  readFile,
  mkdir,
  writeFile,
  symlink,
  stat,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createFsWriter, createFakeWriter } from "../lib/writer.js";

/** A fresh temp directory, resolved through any symlinks (/var -> /private/var
 * on macOS) so a test comparing paths is comparing the same thing the writer
 * is. */
async function tempRoot() {
  return await realpath(await mkdtemp(join(tmpdir(), "writer-")));
}

/** @param {string} p */
async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("createFakeWriter", () => {
  it("records what was written", async () => {
    const w = createFakeWriter();
    await w.write("a/b.txt", "hi");
    expect(w.files["a/b.txt"]).toBe("hi");
  });
});

describe("createFsWriter", () => {
  it("writes a file, creating parent directories", async () => {
    const dir = await tempRoot();
    const w = createFsWriter(dir);
    await w.write("deep/nested/file.txt", "hi");
    expect(await readFile(join(dir, "deep/nested/file.txt"), "utf8")).toBe(
      "hi",
    );
  });

  it("overwrites a file it wrote before", async () => {
    const dir = await tempRoot();
    const w = createFsWriter(dir);
    await w.write("a.txt", "one");
    await w.write("a.txt", "two");
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("two");
  });

  // The containment rule, stated as a test rather than a comment. A repo can
  // influence what gets written; it must never influence WHERE.
  it("refuses a path escaping the root", async () => {
    const dir = await tempRoot();
    const w = createFsWriter(dir);
    await expect(w.write("../escaped.txt", "x")).rejects.toThrow(/outside/i);
  });

  it("refuses an absolute path", async () => {
    const dir = await tempRoot();
    const w = createFsWriter(dir);
    await expect(w.write("/etc/passwd", "x")).rejects.toThrow(/outside/i);
  });

  it("refuses to write inside .git", async () => {
    const dir = await tempRoot();
    await mkdir(join(dir, ".git"), { recursive: true });
    const w = createFsWriter(dir);
    await expect(w.write(".git/config", "x")).rejects.toThrow(/\.git/i);
  });

  // Amendment B1, bypass 1 (reproduced against the plan's `assertInside`:
  // "symlinked file inside root -> ALLOWED; the file OUTSIDE the root was
  // overwritten"). resolve() is lexical; writeFile follows symlinks.
  it("refuses to write through a symlinked file, and leaves the target intact", async () => {
    const dir = await tempRoot();
    const outside = await tempRoot();
    const secret = join(outside, "secret.txt");
    await writeFile(secret, "PRECIOUS\n", "utf8");
    await symlink(secret, join(dir, "CLAUDE.md"));

    const w = createFsWriter(dir);
    await expect(w.write("CLAUDE.md", "clobbered")).rejects.toThrow(/symlink/i);
    expect(await readFile(secret, "utf8")).toBe("PRECIOUS\n");
  });

  // Amendment B1, bypass 2 ("symlinked dir inside root -> mkdir -p CREATED
  // directories outside the root"). Refusing the write is not enough: the
  // directories must never be created either, which is why containment is
  // re-asserted per component as the path is built rather than once after a
  // recursive mkdir.
  it("refuses to write through a symlinked directory, and creates nothing outside the root", async () => {
    const dir = await tempRoot();
    const outside = await tempRoot();
    await symlink(outside, join(dir, "link"));

    const w = createFsWriter(dir);
    await expect(w.write("link/deep/file.txt", "x")).rejects.toThrow(
      /outside/i,
    );
    expect(await exists(join(outside, "deep"))).toBe(false);
    expect(await exists(join(outside, "deep", "file.txt"))).toBe(false);
  });

  // Amendment B1, bypass 3 (".GIT/config on this macOS box, real .git present
  // -> ALLOWED; .git/config overwritten"). The comparison must be case-folded,
  // because the filesystem's is.
  it("refuses .git in any case", async () => {
    const dir = await tempRoot();
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, ".git", "config"), "REAL CONFIG\n", "utf8");

    const w = createFsWriter(dir);
    await expect(w.write(".GIT/config", "x")).rejects.toThrow(/\.git/i);
    await expect(w.write(".Git/hooks/pre-commit", "x")).rejects.toThrow(
      /\.git/i,
    );
    expect(await readFile(join(dir, ".git", "config"), "utf8")).toBe(
      "REAL CONFIG\n",
    );
  });

  // A submodule's or a vendored checkout's .git is a git directory too.
  it("refuses a .git component at any depth", async () => {
    const dir = await tempRoot();
    const w = createFsWriter(dir);
    await expect(w.write("vendor/sub/.git/config", "x")).rejects.toThrow(
      /\.git/i,
    );
    expect(await exists(join(dir, "vendor"))).toBe(false);
  });

  // A symlink can also aim back INSIDE the root at .git, which passes a
  // containment test but is still the repository's own metadata.
  it("refuses a symlinked directory that resolves into .git", async () => {
    const dir = await tempRoot();
    await mkdir(join(dir, ".git", "hooks"), { recursive: true });
    await symlink(join(dir, ".git"), join(dir, "gitdir"));
    const w = createFsWriter(dir);
    await expect(w.write("gitdir/hooks/pre-commit", "x")).rejects.toThrow(
      /\.git/i,
    );
  });

  it("refuses to overwrite a directory", async () => {
    const dir = await tempRoot();
    await mkdir(join(dir, "docs"), { recursive: true });
    const w = createFsWriter(dir);
    await expect(w.write("docs", "x")).rejects.toThrow(/director/i);
  });

  // Amendment B1 item 6: `rel = target.slice(base.length + 1)` eats the first
  // character of the relative path when the root already ends with a
  // separator, so `.gitignore` reads as `gitignore` and `.git/config` slips
  // through as `git/config`.
  it("handles a root that ends with a separator", async () => {
    const dir = await tempRoot();
    await mkdir(join(dir, ".git"), { recursive: true });
    const w = createFsWriter(dir + sep);
    await w.write(".gitignore", "node_modules/\n");
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe(
      "node_modules/\n",
    );
    await expect(w.write(".git/config", "x")).rejects.toThrow(/\.git/i);
  });
});
