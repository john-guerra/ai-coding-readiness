import {
  writeFile,
  mkdir,
  realpath,
  lstat,
  rename,
  rmdir,
  unlink,
  chmod,
} from "node:fs/promises";
import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import {
  assertWritableRelative,
  insideRoot,
  hasGitComponent,
} from "./paths.js";

/**
 * The write-side twin of `Repo`, deliberately a separate object.
 *
 * A check is handed a `Repo` and nothing else, so a check *cannot* mutate the
 * repository even by mistake — the capability is not in scope. Keeping writes
 * in a different type is what makes that structural rather than a rule
 * somebody has to remember.
 *
 * @typedef {Object} Writer
 * @property {(path: string, content: string) => Promise<void>} write
 */

/**
 * Every write goes to a sibling temp file which is then `rename()`d over the
 * target. That is not a tidiness preference; it is the containment mechanism.
 *
 * `rename` replaces the **directory entry**. It therefore cannot write through
 * a HARDLINK — an `lstat` sees a plain regular file and `O_NOFOLLOW` sees no
 * link to follow, because the directory entry *is* the file, and `O_TRUNC` on
 * it destroys whatever else shares the inode, including a file outside the
 * root. It also cannot follow a symlink, which demotes `lstat`/`O_NOFOLLOW`
 * from "the only gate" to belt-and-braces.
 *
 * It is also what makes a write crash-safe. An in-place `O_TRUNC` that is
 * interrupted between truncate and write (SIGINT, ENOSPC, a panic) leaves a
 * half-written guide — and since the manifest is persisted only on success,
 * the mangled region has no record, so the next run classifies it as `absent`
 * and refuses it forever. With a rename the target is only ever the old bytes
 * or the new ones.
 *
 * The prefix is deliberately recognisable: a temp file surviving a hard kill
 * shows up in `git status`, and it should be obvious whose it is.
 */
const TMP_PREFIX = ".ai-readiness-tmp-";

/**
 * `O_NOFOLLOW` makes the kernel refuse to open a symlink rather than following
 * it. With the rename above it is no longer load-bearing, but it costs nothing
 * and it means the temp-file creation cannot be diverted either. It does not
 * exist on Windows; there the `lstat` check is what we have, and Windows does
 * not create symlinks without a privilege in the first place.
 */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** @param {unknown} err */
function codeOf(err) {
  return typeof err === "object" && err !== null && "code" in err
    ? String(err.code)
    : "";
}

/**
 * Build `relDir` under `realRoot` one component at a time, re-asserting
 * containment against the REAL path after each step, and return the real
 * directory to write into.
 *
 * Why per component rather than one `mkdir(..., {recursive: true})` followed
 * by a check: `resolve()` is lexical and `mkdir` is not, so a symlinked
 * directory inside the repo (`root/link -> /somewhere/else`) makes a recursive
 * mkdir create `/somewhere/else/deep/` **before** any refusal can run.
 * Refusing the write afterwards still leaves those directories behind, outside
 * the directory the user pointed the tool at. Creating one level at a time
 * means the symlink is caught at the level it appears: `mkdir` on it fails
 * with EEXIST (creating nothing), `realpath` then shows where it really goes,
 * and we stop there.
 *
 * The same re-check catches a symlink that aims back INSIDE the root at
 * `.git` — contained, but still the repository's own metadata.
 *
 * Returns the directories this call actually created alongside the real
 * directory to write into, so the caller can undo them if what follows fails.
 * Note that a *containment* refusal can never orphan one: refusing requires the
 * offending component to already exist, which means every component before it
 * existed too, which means nothing was created. What can orphan a directory is
 * an I/O failure at the leaf — ENAMETOOLONG, ENOSPC, EACCES — after the parents
 * are on disk.
 *
 * @param {string} realRoot
 * @param {string} relDir
 * @returns {Promise<{dir: string, created: string[]}>}
 */
async function ensureDirWithin(realRoot, relDir) {
  let current = realRoot;
  /** @type {string[]} */
  const created = [];
  if (relDir === "") return { dir: current, created };

  for (const component of relDir.split(/[\\/]/)) {
    const next = join(current, component);
    try {
      await mkdir(next);
      created.push(next);
    } catch (err) {
      // Already there is fine; anything else (a file in the way, permissions)
      // is the caller's to see.
      if (codeOf(err) !== "EEXIST") {
        await removeCreated(created);
        throw err;
      }
    }
    const real = await realpath(next);
    if (!insideRoot(realRoot, real)) {
      throw new Error(
        `refusing to write outside the target directory: ${relDir} leads through ${component}, which really is ${real}`,
      );
    }
    if (hasGitComponent(relative(realRoot, real))) {
      throw new Error(
        `refusing to write inside .git: ${relDir} leads through ${component}, which really is ${real}`,
      );
    }
    current = real;
  }
  return { dir: current, created };
}

/**
 * Undo the directories a failed write created, deepest first.
 *
 * `rmdir`, never a recursive remove: if anything else has appeared inside one
 * of them in the meantime it is not ours to delete, and ENOTEMPTY leaving the
 * directory behind is the correct outcome. Failures are swallowed because this
 * runs on the way out of an error that is about to be rethrown — the original
 * failure is the one worth reporting.
 *
 * @param {string[]} created
 */
async function removeCreated(created) {
  for (const dir of [...created].reverse()) {
    try {
      await rmdir(dir);
    } catch {
      // Not empty, already gone, or not ours. Leave it.
    }
  }
}

/**
 * Where this write really lands, after the final path component is examined.
 *
 * A symlink here gets the same treatment `ensureDirWithin` already gives a
 * symlinked *directory*: resolve it, and accept it if the real path is still
 * inside the root and names no `.git`. The two now agree, which they did not
 * before — a `CLAUDE.md -> AGENTS.md` symlink (the common one-guide-two-names
 * layout) was refused with a message that was factually wrong, and refused on
 * every subsequent run, so the check could never be satisfied. A symlink
 * leading OUT of the root is still refused, with the same message as before,
 * because there the message is true.
 *
 * @param {string} realRoot
 * @param {string} target - absolute, already contained
 * @param {string} path - the caller's path, for messages
 * @returns {Promise<string>} the absolute path to rename over
 */
async function resolveTarget(realRoot, target, path) {
  // lstat, not stat: stat follows the link and would report the type of
  // whatever it points at, which is exactly the thing being checked for.
  let existing = null;
  try {
    existing = await lstat(target);
  } catch (err) {
    if (codeOf(err) !== "ENOENT") throw err;
  }
  if (existing === null) return target;

  if (existing.isDirectory()) {
    throw new Error(`refusing to overwrite a directory: ${path}`);
  }
  if (!existing.isSymbolicLink()) return target;

  let real;
  try {
    real = await realpath(target);
  } catch {
    // A dangling symlink resolves nowhere, so there is no way to tell whether
    // it leads outside the root. Unknown is not "inside".
    throw new Error(
      `refusing to write through a symlink: ${path} is a symbolic link whose ` +
        `target does not resolve, so there is no way to tell where following ` +
        `it would write`,
    );
  }
  if (!insideRoot(realRoot, real)) {
    throw new Error(
      `refusing to write through a symlink: ${path} is a symbolic link, and following it would write somewhere this tool was not pointed at`,
    );
  }
  if (hasGitComponent(relative(realRoot, real))) {
    throw new Error(
      `refusing to write inside .git: ${path} is a symbolic link that really is ${real}`,
    );
  }
  const realStat = await lstat(real);
  if (realStat.isDirectory()) {
    throw new Error(
      `refusing to overwrite a directory: ${path} is a symbolic link to ${real}`,
    );
  }
  return real;
}

/**
 * Write `content` to `target` by way of a sibling temp file and a `rename`.
 *
 * The temp file goes in the SAME directory as the target, because `rename` is
 * only atomic — and only works at all — within one filesystem, and a repo can
 * easily span mounts. `O_EXCL` so a temp name collision fails rather than
 * clobbering something; the mode of an existing target is carried across so a
 * rename does not silently drop an executable bit the in-place write preserved.
 *
 * @param {string} target - absolute
 * @param {string} content
 */
async function writeAtomically(target, content) {
  let mode;
  try {
    const existing = await lstat(target);
    if (existing.isFile()) mode = existing.mode & 0o777;
  } catch {
    // Not there: the temp file's default mode is the right one.
  }

  const tmp = join(
    dirname(target),
    `${TMP_PREFIX}${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  try {
    await writeFile(tmp, content, {
      encoding: "utf8",
      flag:
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
    });
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, target);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      // Never created, or already gone. The original error is the one to raise.
    }
    throw err;
  }
}

/**
 * Writes, contained to `root`.
 *
 * Every path is refused unless it stays inside `root` **after symlinks are
 * resolved**, and unless no component of it names `.git`. A refusal throws
 * rather than returning quietly: unlike a read, where "outside the repo" can
 * safely read as "not there", a write that silently does nothing would let a
 * caller report a fix it never applied.
 *
 * @param {string} root
 * @returns {Writer}
 */
export function createFsWriter(root) {
  const base = resolve(root);
  return {
    async write(path, content) {
      // Lexical gate first: it is cheap, it rejects the obvious `../` and
      // absolute cases before touching the disk, and it is the only gate that
      // can see the path the caller actually asked for.
      const rel = assertWritableRelative(base, path);

      // Everything after this is measured against the REAL root, because the
      // root itself is frequently a symlink (macOS `/tmp` and `/var` both are)
      // and a lexical comparison against it would reject legitimate writes.
      let realRoot;
      try {
        realRoot = await realpath(base);
      } catch (err) {
        throw new Error(
          `cannot write to ${base}: the target directory could not be resolved (${err instanceof Error ? err.message : String(err)})`,
        );
      }

      const parts = rel.split(/[\\/]/);
      const name = parts[parts.length - 1];
      const { dir, created } = await ensureDirWithin(
        realRoot,
        parts.slice(0, -1).join("/"),
      );

      // Anything that fails from here undoes the directories this call made,
      // rather than leaving empty ones behind in a repository it then declined
      // to write to.
      try {
        const target = await resolveTarget(realRoot, join(dir, name), path);
        await writeAtomically(target, content);
      } catch (err) {
        await removeCreated(created);
        throw err;
      }
    },
  };
}

/**
 * In-memory writer for tests, the twin of `createFakeRepo`.
 *
 * It applies the same lexical guard as the real writer so a test cannot encode
 * a path the real one would refuse, and it keys on the guard's RETURN value
 * rather than on the raw path — otherwise `docs/../top.md` is a distinct key
 * here and the same file as `top.md` on disk, and a test can pass against a
 * key the real writer would never produce. `test/writer.test.js` pins the two
 * to the same normalisation. It cannot apply the symlink guards — there is no
 * filesystem here to have symlinks — which is why the containment tests run
 * against a real temp directory.
 *
 * @param {Record<string, string>} [initial]
 * @returns {Writer & {files: Record<string, string>}}
 */
export function createFakeWriter(initial = {}) {
  const files = { ...initial };
  return {
    files,
    async write(path, content) {
      files[assertWritableRelative("/fake", path)] = content;
    },
  };
}
