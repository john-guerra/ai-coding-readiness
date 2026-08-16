import { writeFile, mkdir, realpath, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { join, relative, resolve } from "node:path";
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
 * `O_NOFOLLOW` makes the kernel refuse to open a symlink rather than following
 * it, which closes the window between the `lstat` below and the write. It does
 * not exist on Windows; there the `lstat` check is what we have, and Windows
 * does not create symlinks without a privilege in the first place.
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
 * @param {string} realRoot
 * @param {string} relDir
 * @returns {Promise<string>}
 */
async function ensureDirWithin(realRoot, relDir) {
  let current = realRoot;
  if (relDir === "") return current;

  for (const component of relDir.split(/[\\/]/)) {
    const next = join(current, component);
    try {
      await mkdir(next);
    } catch (err) {
      // Already there is fine; anything else (a file in the way, permissions)
      // is the caller's to see.
      if (codeOf(err) !== "EEXIST") throw err;
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
  return current;
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
      const dir = await ensureDirWithin(realRoot, parts.slice(0, -1).join("/"));
      const target = join(dir, name);

      // lstat, not stat: stat follows the link and would report the type of
      // whatever it points at, which is exactly the thing being checked for.
      let existing = null;
      try {
        existing = await lstat(target);
      } catch (err) {
        if (codeOf(err) !== "ENOENT") throw err;
      }
      if (existing?.isSymbolicLink()) {
        throw new Error(
          `refusing to write through a symlink: ${path} is a symbolic link, and following it would write somewhere this tool was not pointed at`,
        );
      }
      if (existing?.isDirectory()) {
        throw new Error(`refusing to overwrite a directory: ${path}`);
      }

      await writeFile(target, content, {
        encoding: "utf8",
        flag:
          constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW,
      });
    },
  };
}

/**
 * In-memory writer for tests, the twin of `createFakeRepo`.
 *
 * It applies the same lexical guard as the real writer so a test cannot encode
 * a path the real one would refuse. It cannot apply the symlink guards —
 * there is no filesystem here to have symlinks — which is why the containment
 * tests in `test/writer.test.js` run against a real temp directory.
 *
 * @param {Record<string, string>} [initial]
 * @returns {Writer & {files: Record<string, string>}}
 */
export function createFakeWriter(initial = {}) {
  const files = { ...initial };
  return {
    files,
    async write(path, content) {
      assertWritableRelative("/fake", path);
      files[path] = content;
    },
  };
}
