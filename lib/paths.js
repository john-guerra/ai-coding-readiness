import { relative, resolve, sep } from "node:path";

/**
 * Path containment, in one place because it is a security predicate.
 *
 * Both halves of this tool depend on it: the audit must not READ a file
 * outside the directory it was pointed at, and the adapter must not WRITE one.
 * The read side shipped a traversal bug once already (an `@../secret.md`
 * import in a CLAUDE.md made the audit quote a line of a file outside the
 * repo, verbatim, into a report the issue template asks people to paste in
 * public). The write side's version of that bug destroys the file instead of
 * disclosing it.
 *
 * A second copy of a predicate like this is a second thing to get wrong, and
 * when this module was two copies, the newer one had already lost the
 * trailing-separator guard. So there is one copy, `lib/repo.js` and
 * `lib/writer.js` both import it, and it is tested from both sides.
 *
 * **This module is lexical only.** `resolve()` does not follow symlinks and
 * `readFile`/`readdir`/`writeFile`/`mkdir` all do, so a lexical check alone
 * contains nothing on a filesystem where the repo may contain a symlink.
 * `insideRoot` is the first gate; the second — the one that actually holds —
 * is a `realpath()` and a re-assertion, done by `lib/writer.js` per component
 * as it builds a path and by `lib/repo.js` before every read. Both sides do it
 * now; the read side went a milestone without it, and a
 * `CLAUDE.md -> /outside/secret.md` symlink was enough to quote a file outside
 * the repository into a public report.
 */

/**
 * Is `p`, resolved against `root`, still inside `root`?
 *
 * `resolve(root, p)` also absorbs the absolute-path case, since resolve
 * returns `p` unchanged when it is already absolute. The separator is appended
 * to `base` before the prefix test so `/a/root-evil` is not read as living
 * inside `/a/root` — a bare `startsWith` says it does. The `endsWith(sep)`
 * guard is for a root of `/`, where the naive form builds `//` and refuses
 * everything.
 *
 * @param {string} root
 * @param {string} p
 */
export function insideRoot(root, p) {
  const base = resolve(root);
  const target = resolve(base, p);
  return (
    target === base || target.startsWith(base.endsWith(sep) ? base : base + sep)
  );
}

/**
 * Does any component of this relative path name a git directory?
 *
 * Case-folded because the comparison has to agree with the filesystem's, and
 * macOS and Windows are case-insensitive by default — `.GIT/config` opens the
 * real `.git/config` there. Checked at every depth, not just the first, because
 * a submodule or a vendored checkout has a `.git` of its own and it is no more
 * ours to write than the top-level one.
 *
 * Both separators are split on so a Windows-style path cannot smuggle a
 * component past a posix-only split.
 *
 * @param {string} relPath - a path already known to be relative to some root
 */
export function hasGitComponent(relPath) {
  return relPath
    .split(/[\\/]/)
    .some((component) => component.toLowerCase() === ".git");
}

/**
 * The lexical half of the write guard: refuse anything that escapes `root` or
 * names `.git`, and return the path relative to `root`.
 *
 * `relative()` rather than `target.slice(base.length + 1)`: the slice is off by
 * one when `root` already ends with a separator, which silently turns
 * `.gitignore` into `gitignore` and lets `.git/config` through as
 * `git/config` — the check reads a path one character to the left of the one
 * being written.
 *
 * @param {string} root
 * @param {string} p
 * @returns {string} `p` relative to `root`
 */
export function assertWritableRelative(root, p) {
  const base = resolve(root);
  if (!insideRoot(base, p)) {
    throw new Error(`refusing to write outside the target directory: ${p}`);
  }
  const rel = relative(base, resolve(base, p));
  if (rel === "") {
    throw new Error(`refusing to write over the target directory itself: ${p}`);
  }
  if (hasGitComponent(rel)) {
    throw new Error(`refusing to write inside .git: ${p}`);
  }
  return rel;
}
