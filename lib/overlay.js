import { posix } from "node:path";
import { assertWritableRelative } from "./paths.js";

/**
 * An in-memory layer over a real `Repo`: a `Writer` that records writes instead
 * of performing them, and a `Repo` that reads through them.
 *
 * This exists so the dry run can execute the SAME convergence loop `--write`
 * executes, against a repository that changes as the loop goes. Running the
 * checks once — which is what the dry run used to do — under-reports, because
 * a finding carries one action and `github.contribution-scaffold` deliberately
 * emits a sequence: pass 1 writes the issue template, pass 2 the pull request
 * template. The single-pass dry run never mentioned
 * `.github/PULL_REQUEST_TEMPLATE.md`, and then `--write` created it. The skill
 * tells an agent to show the user the dry run and let them decide; deciding on
 * an incomplete list is exactly the failure this tool exists to prevent.
 *
 * It is deliberately NOT a general-purpose filesystem. It models the three
 * things `applyAction` does — create a file, append to one, rewrite a region —
 * all of which reduce to "this path now has this content".
 *
 * @typedef {{repo: import('./repo.js').Repo, writer: import('./writer.js').Writer, writes: Map<string, string>}} Overlay
 */

/**
 * @param {import('./repo.js').Repo} base
 * @returns {Overlay}
 */
export function createOverlay(base) {
  /** @type {Map<string, string>} */
  const writes = new Map();

  /**
   * Normalise a path the way `createFsWriter` does, so a read of `docs/x.md`
   * finds a write of `./docs/x.md`. A path the writer would refuse (outside
   * the root, or naming `.git`) has no overlay entry by definition — fall
   * through to the real repo, which answers `null`/`[]` for those itself.
   *
   * @param {string} p
   * @returns {string|null}
   */
  const key = (p) => {
    try {
      return assertWritableRelative(base.root, p).split(/[\\/]/).join("/");
    } catch {
      return null;
    }
  };

  return {
    writes,
    writer: {
      async write(path, content) {
        // The real writer's lexical guard, so a path this records is a path
        // `--write` would accept. Left to throw for the same reason it throws
        // there: a silently dropped write would make the dry run under-report
        // again, in a different way.
        writes.set(assertWritableRelative(base.root, path), content);
      },
    },
    repo: {
      root: base.root,
      async readFile(path) {
        const k = key(path);
        if (k !== null && writes.has(k)) {
          return /** @type {string} */ (writes.get(k));
        }
        return await base.readFile(path);
      },
      async listFiles(dir) {
        const real = await base.listFiles(dir);
        const prefix =
          dir === "" || dir === "." ? "" : dir.endsWith("/") ? dir : `${dir}/`;
        const seen = new Set(real);
        for (const written of writes.keys()) {
          if (!written.startsWith(prefix)) continue;
          // Non-recursive, like the real `listFiles`.
          if (written.slice(prefix.length).includes("/")) continue;
          seen.add(posix.join(dir, written.slice(prefix.length)));
        }
        return [...seen];
      },
      // Nothing this overlay writes can change a repository's merged pull
      // request history, so this is a straight delegation.
      mergedPrFileLists: (n) => base.mergedPrFileLists(n),
    },
  };
}
