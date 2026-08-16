import { readFile as fsReadFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, posix } from "node:path";
import { promisify } from "node:util";
// Containment lives in one module, shared with lib/writer.js. It was copied
// once and the copy was already worse; see lib/paths.js for why the audit's
// read-only guarantee depends on it.
import { insideRoot } from "./paths.js";

const run = promisify(execFile);

/**
 * Read access to a repository. Every check takes one of these and nothing else,
 * so a check is never coupled to a real checkout and tests need no fixture repos.
 *
 * @typedef {Object} Repo
 * @property {string} root
 * @property {(path: string) => Promise<string|null>} readFile - Returns file content or null if path does not exist. Throws if the path exists but cannot be read (permissions, I/O errors).
 * @property {(dir: string) => Promise<string[]>} listFiles - Returns repo-relative paths of files in dir, non-recursive. Returns [] if dir does not exist. Throws if dir exists but cannot be read.
 * @property {(n: number) => Promise<PrFileLists>} mergedPrFileLists - One array of changed paths per merged pull request, newest first, plus where that answer came from.
 */

/**
 * The file lists, and their provenance.
 *
 * The source is not bookkeeping. A profile built from merge commits and one
 * built from the GitHub API mean the same thing but are available in different
 * circumstances, and a caller reporting "no history" must be able to say *why*
 * it has none — "this repo squash-merges" and "the CLI is not authenticated"
 * are different findings that used to render as the same shrug.
 *
 * @typedef {Object} PrFileLists
 * @property {"merge-commits"|"github-api"|"none"} source
 * @property {string|null} reason - Set when source is "none"; null otherwise.
 * @property {string[][]} lists
 * @property {number} truncated - How many of `lists` were cut short by the API's per-PR file cap. Always 0 on the merge-commit path, which has no cap.
 */

/**
 * `gh pr list --json files` returns at most this many paths per pull request,
 * silently. Verified against a real repository: kubernetes#141226 reports 100
 * files here while the API's own `changed_files` says 301.
 *
 * The truncation is systematic, not noise that averages out — paths arrive in
 * diff order, so the tail is always what goes missing. Any share computed from
 * a truncated list is therefore a LOWER BOUND, and a caller that would
 * otherwise report "nothing is contended" has to say it could not see enough
 * to know.
 */
const GH_FILES_PER_PR_CAP = 100;

/**
 * In-memory repo for tests.
 * @param {{files?: Record<string,string>, mergedPrFileLists?: string[][], prListSource?: "merge-commits"|"github-api"|"none", prListReason?: string|null, prListTruncated?: number}} data
 * @returns {Repo}
 */
export function createFakeRepo({
  files = {},
  mergedPrFileLists = [],
  // A fake with no lists must answer the way the real accessor does: "none",
  // with a reason. Defaulting to "merge-commits" with an empty array would let
  // the fake and the real one disagree about what an empty history is — the
  // exact divergence the contract tests exist to catch.
  prListSource = mergedPrFileLists.length > 0 ? "merge-commits" : "none",
  prListReason = null,
  prListTruncated = 0,
} = {}) {
  const resolvedReason =
    prListSource === "none"
      ? (prListReason ??
        "no merge commits were found and the repository has no merged pull requests")
      : prListReason;
  return {
    root: "/fake",
    async readFile(path) {
      return path in files ? files[path] : null;
    },
    async listFiles(dir) {
      const prefix =
        dir === "" || dir === "." ? "" : dir.endsWith("/") ? dir : `${dir}/`;
      return Object.keys(files).filter(
        (p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"),
      );
    },
    async mergedPrFileLists(n) {
      const lists =
        prListSource === "none" ? [] : mergedPrFileLists.slice(0, n);
      return {
        source: prListSource,
        reason: resolvedReason,
        lists,
        truncated: prListTruncated,
      };
    },
  };
}

/**
 * Classify why `gh` could not answer, so the caller can say something specific.
 * Each branch is a different thing for a maintainer to do about it.
 *
 * @param {unknown} err
 * @returns {string}
 */
function explainGhFailure(err) {
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String(err.code)
      : "";
  if (code === "ENOENT") {
    return "the GitHub CLI (`gh`) is not installed, so merged pull requests could not be listed";
  }

  const text = err instanceof Error ? err.message : String(err);
  if (/auth login|not logged in|authentication/i.test(text)) {
    return "the GitHub CLI is not authenticated (`gh auth login`), so merged pull requests could not be listed";
  }
  if (/known GitHub host|git remotes/i.test(text)) {
    return "no GitHub remote was found, so there are no pull requests to profile";
  }
  if (/not a git repository/i.test(text)) {
    return "this directory is not a git repository, so there are no pull requests to profile";
  }

  // An execFile rejection reads `Command failed: <cmd>\n<stderr>`, so the FIRST
  // line is the command we ran and the cause starts on the second. Reporting
  // line one throws the diagnosis away and echoes our own invocation back at
  // the reader. Prefer captured stderr; otherwise take the last real line.
  const stderr =
    typeof err === "object" && err !== null && "stderr" in err
      ? String(err.stderr)
      : "";
  const lines = (stderr || text)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("Command failed:"));
  const cause = lines[lines.length - 1] ?? text.trim();
  return `the GitHub API could not be reached: ${cause}`;
}

/**
 * Filesystem-, git-, and `gh`-backed repo. The only code here that touches the
 * disk or the network.
 *
 * Every path handed to `readFile` and `listFiles` is refused unless it
 * resolves inside `root` — see `insideRoot`. A refused path behaves exactly as
 * an absent one (`null` / `[]`) rather than throwing, so no check has to learn
 * a new failure mode and none of them can be talked into reporting on a file
 * the user did not point the tool at.
 *
 * `exec` is injectable so tests can drive every branch — including the failures
 * — without a network call or a real checkout. It is always invoked with an
 * argument array and never a shell string, so nothing here can be shell-injected.
 *
 * @param {string} root
 * @param {{exec?: (cmd: string, args: string[], opts?: object) => Promise<{stdout: string}>}} [deps]
 * @returns {Repo}
 */
export function createFsRepo(root, { exec = run } = {}) {
  return {
    root,
    async readFile(path) {
      // Outside the audited repository is the same as not there.
      if (!insideRoot(root, path)) return null;
      try {
        return await fsReadFile(join(root, path), "utf8");
      } catch (err) {
        // Return null only if the path does not exist, is a directory, or
        // lies underneath a file (ENOTDIR — which is as genuinely "not there"
        // as ENOENT, and is the same case listFiles already narrows on).
        // Re-throw for permissions errors, I/O errors, etc. — those are findings
        // that must be reported as unknown, not silently swallowed.
        if (
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err.code === "ENOENT" ||
            err.code === "EISDIR" ||
            err.code === "ENOTDIR")
        ) {
          return null;
        }
        throw err;
      }
    },
    async listFiles(dir) {
      // Outside the audited repository is the same as not there.
      if (!insideRoot(root, dir)) return [];
      try {
        const entries = await readdir(join(root, dir), { withFileTypes: true });
        return entries
          .filter((e) => e.isFile())
          .map((e) => posix.join(dir, e.name));
      } catch (err) {
        // Return empty list only if the directory does not exist or the path is a file.
        // Re-throw for permissions errors, I/O errors, etc.
        if (
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err.code === "ENOENT" || err.code === "ENOTDIR")
        ) {
          return [];
        }
        throw err;
      }
    },
    async mergedPrFileLists(n) {
      const opts = { cwd: root, maxBuffer: 10 * 1024 * 1024 };

      // Local first: merge commits are offline, fast, and need no credentials.
      const fromGit = [];
      try {
        const { stdout } = await exec(
          "git",
          ["log", "--merges", `-n${n}`, "--format=%H"],
          opts,
        );
        for (const sha of stdout.split("\n").filter(Boolean)) {
          try {
            const { stdout: diff } = await exec(
              "git",
              ["diff", "--name-only", `${sha}^1`, sha],
              opts,
            );
            fromGit.push(diff.split("\n").filter(Boolean));
          } catch {
            // A root merge has no first parent, and an object can be missing
            // from a partial clone. Skip the commit rather than the scan.
          }
        }
      } catch {
        // No git, no history, or a shallow clone. The API path may still work.
      }

      // A full sample from git is authoritative enough; don't spend a network
      // call. The trigger below is "fewer than asked for", NOT "none at all":
      // a repo that merged a few times years ago and squash-merges today would
      // otherwise profile those few commits and call that the repository.
      if (fromGit.length >= n) {
        return {
          source: "merge-commits",
          reason: null,
          lists: fromGit,
          truncated: 0,
        };
      }

      let fromApi = null;
      let apiFailure = null;
      try {
        const { stdout } = await exec(
          "gh",
          [
            "pr",
            "list",
            "--state",
            "merged",
            "--limit",
            String(n),
            "--json",
            "files",
          ],
          opts,
        );
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          apiFailure =
            "the GitHub CLI returned output that could not be read as JSON";
        }
        if (Array.isArray(parsed)) {
          fromApi = parsed.map((pr) =>
            (pr?.files ?? [])
              .map((/** @type {{path?: string}} */ f) => f?.path)
              .filter(
                (/** @type {unknown} */ p) => typeof p === "string" && p !== "",
              ),
          );
        } else if (!apiFailure) {
          apiFailure =
            "the GitHub CLI returned output that could not be read as JSON";
        }
      } catch (err) {
        apiFailure = explainGhFailure(err);
      }

      // Whichever saw more merged work wins. A repo with both histories gets
      // the same answer either way; a repo with only one gets the one it has.
      if (fromApi && fromApi.length > fromGit.length) {
        return {
          source: "github-api",
          reason: null,
          lists: fromApi,
          // A list that arrived exactly at the cap was almost certainly cut.
          truncated: fromApi.filter((l) => l.length >= GH_FILES_PER_PR_CAP)
            .length,
        };
      }
      if (fromGit.length > 0) {
        return {
          source: "merge-commits",
          reason: null,
          lists: fromGit,
          truncated: 0,
        };
      }

      return {
        source: "none",
        reason:
          apiFailure ??
          "no merge commits were found and the repository has no merged pull requests",
        lists: [],
        truncated: 0,
      };
    },
  };
}
