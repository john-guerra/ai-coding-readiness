import { describe, it, expect } from "vitest";
import {
  mkdtemp,
  readFile,
  readdir,
  mkdir,
  writeFile,
  link,
  symlink,
  stat,
  lstat,
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

  // Bypass 4 of the same family, and the one neither `lstat` nor `O_NOFOLLOW`
  // can see: a HARDLINK has no link to follow — the directory entry *is* the
  // file, sharing an inode with a file outside the root. `O_TRUNC` then writes
  // straight through it. `rename()` replaces the directory entry instead, so
  // the outside file keeps its content and its inode.
  it("refuses to write through a hardlink, and leaves the outside file intact", async () => {
    const dir = await tempRoot();
    const outside = await tempRoot();
    const secret = join(outside, "secret.txt");
    await writeFile(secret, "PRECIOUS\n", "utf8");
    await link(secret, join(dir, ".gitignore"));
    expect((await lstat(secret)).nlink).toBe(2);

    const w = createFsWriter(dir);
    await w.write(".gitignore", "node_modules/\ndist/\n");

    // The write landed where it was pointed...
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe(
      "node_modules/\ndist/\n",
    );
    // ...and the file outside the root is untouched, still on its own inode.
    expect(await readFile(secret, "utf8")).toBe("PRECIOUS\n");
    expect((await lstat(secret)).nlink).toBe(1);
  });

  // The other half of the same change: an in-place `O_TRUNC` leaves a
  // half-written file if the process dies between truncate and write, and the
  // manifest is only persisted on success — so the next run sees a mangled
  // region it has no record of and refuses it forever. Writing a sibling temp
  // file and renaming it over the target means the target is only ever the old
  // bytes or the new ones. A crash cannot be staged in a unit test; the
  // observable proof that no in-place truncate happened is that the directory
  // entry now points at a DIFFERENT inode.
  it("replaces the target rather than truncating it in place", async () => {
    const dir = await tempRoot();
    const target = join(dir, "CLAUDE.md");
    await writeFile(target, "original\n", "utf8");
    const before = (await lstat(target)).ino;

    const w = createFsWriter(dir);
    await w.write("CLAUDE.md", "replaced\n");

    expect(await readFile(target, "utf8")).toBe("replaced\n");
    expect((await lstat(target)).ino).not.toBe(before);
    // And no temp file was left lying around — a stray one would make the
    // next run's dirty-tree check refuse.
    expect(await readdir(dir)).toEqual(["CLAUDE.md"]);
  });

  // A symlink that resolves back INSIDE the root is a repository doing nothing
  // wrong — `CLAUDE.md -> AGENTS.md` is the common one-guide-two-names layout.
  // Refusing it is factually wrong ("following it would write somewhere this
  // tool was not pointed at" — it would not) and permanent: the check fails
  // every run, forever. `ensureDirWithin` already accepts a symlinked
  // DIRECTORY that realpaths back inside the root; this makes the final
  // component agree with it.
  it("accepts a symlink that resolves inside the root, and updates the resolved file", async () => {
    const dir = await tempRoot();
    await writeFile(join(dir, "AGENTS.md"), "# real guide\n", "utf8");
    await symlink("AGENTS.md", join(dir, "CLAUDE.md"));

    const w = createFsWriter(dir);
    await w.write("CLAUDE.md", "# rewritten\n");

    // The resolved file got the content...
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe(
      "# rewritten\n",
    );
    // ...and the symlink is still a symlink, not replaced by a regular file.
    expect((await lstat(join(dir, "CLAUDE.md"))).isSymbolicLink()).toBe(true);
  });

  // The same acceptance must not extend to a symlink aiming at the
  // repository's own metadata.
  it("refuses a symlinked file that resolves into .git", async () => {
    const dir = await tempRoot();
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, ".git", "config"), "REAL CONFIG\n", "utf8");
    await symlink(join(dir, ".git", "config"), join(dir, "CLAUDE.md"));

    const w = createFsWriter(dir);
    await expect(w.write("CLAUDE.md", "x")).rejects.toThrow(/\.git/i);
    expect(await readFile(join(dir, ".git", "config"), "utf8")).toBe(
      "REAL CONFIG\n",
    );
  });

  // A dangling symlink resolves nowhere, so there is no way to tell whether it
  // leads outside. Unknown is not "inside".
  it("refuses a symlink whose target does not exist", async () => {
    const dir = await tempRoot();
    await symlink("nowhere.md", join(dir, "CLAUDE.md"));
    const w = createFsWriter(dir);
    await expect(w.write("CLAUDE.md", "x")).rejects.toThrow(/symlink/i);
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

  // `ensureDirWithin` creates the parents before the final component is
  // examined, so a refusal there used to leave empty directories behind in a
  // repository the tool then declined to write to — visible in `git status`,
  // and nothing ever removes them.
  it("removes the directories it created when the write is then refused", async () => {
    const dir = await tempRoot();
    const outside = await tempRoot();
    await writeFile(join(outside, "secret.txt"), "PRECIOUS\n", "utf8");
    await mkdir(join(dir, "a", "b"), { recursive: true });
    await symlink(join(outside, "secret.txt"), join(dir, "a", "b", "leaf.md"));

    const w = createFsWriter(dir);
    // A refusal underneath directories that already existed leaves them alone.
    await expect(w.write("a/b/leaf.md", "x")).rejects.toThrow(/symlink/i);
    expect(await exists(join(dir, "a", "b"))).toBe(true);

    // A failure underneath directories THIS call created removes them again.
    // ENAMETOOLONG is the failure staged here because it is the shape that can
    // actually orphan a directory: every *containment* refusal happens at a
    // component that already existed (which means its parents did too, so
    // nothing was created), while an I/O error at the leaf lands after the
    // parents are on disk. See the note in lib/writer.js.
    const tooLong = `${"x".repeat(300)}.md`;
    await expect(w.write(`fresh/nested/${tooLong}`, "x")).rejects.toThrow();
    expect(await exists(join(dir, "fresh"))).toBe(false);
  });
});

// The fake and the real writer are used interchangeably by the check tests and
// by `applyAction`; when they disagree about what a path MEANS, a test can pass
// against a key the real writer would never produce. That divergence class has
// already cost this project a fix round, so it is pinned rather than assumed.
describe("createFakeWriter and createFsWriter agree on the path", () => {
  it("normalizes the same path to the same key", async () => {
    const dir = await tempRoot();
    const real = createFsWriter(dir);
    const fake = createFakeWriter();

    for (const path of ["a/./b.txt", "docs/../top.md", "./plain.md"]) {
      await real.write(path, "hi");
      await fake.write(path, "hi");
    }

    /** Every file under `dir`, as a repo-relative posix path. */
    const onDisk = async (/** @type {string} */ rel) => {
      /** @type {string[]} */
      const out = [];
      for (const entry of await readdir(join(dir, rel), {
        withFileTypes: true,
      })) {
        const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) out.push(...(await onDisk(child)));
        else out.push(child);
      }
      return out;
    };

    expect(Object.keys(fake.files).sort()).toEqual((await onDisk("")).sort());
  });
});
