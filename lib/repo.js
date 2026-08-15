import { readFile as fsReadFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, posix } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Read access to a repository. Every check takes one of these and nothing else,
 * so a check is never coupled to a real checkout and tests need no fixture repos.
 *
 * @typedef {Object} Repo
 * @property {string} root
 * @property {(path: string) => Promise<string|null>} readFile - Returns file content or null if path does not exist. Throws if the path exists but cannot be read (permissions, I/O errors).
 * @property {(dir: string) => Promise<string[]>} listFiles - Returns repo-relative paths of files in dir, non-recursive. Returns [] if dir does not exist. Throws if dir exists but cannot be read.
 * @property {(n: number) => Promise<string[][]>} mergedPrFileLists - Returns one array of changed paths per merge commit, newest first. Returns [] when there is no git history.
 */

/**
 * In-memory repo for tests.
 * @param {{files?: Record<string,string>, mergedPrFileLists?: string[][]}} data
 * @returns {Repo}
 */
export function createFakeRepo({ files = {}, mergedPrFileLists = [] } = {}) {
  return {
    root: "/fake",
    async readFile(path) {
      return path in files ? files[path] : null;
    },
    async listFiles(dir) {
      const prefix = dir === "" || dir === "." ? "" : dir.endsWith("/") ? dir : `${dir}/`;
      return Object.keys(files).filter(
        (p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/")
      );
    },
    async mergedPrFileLists(n) {
      return mergedPrFileLists.slice(0, n);
    },
  };
}

/**
 * Filesystem- and git-backed repo. The only code here that touches the disk.
 * @param {string} root
 * @returns {Repo}
 */
export function createFsRepo(root) {
  return {
    root,
    async readFile(path) {
      try {
        return await fsReadFile(join(root, path), "utf8");
      } catch (err) {
        // Return null only if the path does not exist or is a directory.
        // Re-throw for permissions errors, I/O errors, etc. — those are findings
        // that must be reported as unknown, not silently swallowed.
        if (
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err.code === "ENOENT" || err.code === "EISDIR")
        ) {
          return null;
        }
        throw err;
      }
    },
    async listFiles(dir) {
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
      let shas;
      try {
        const { stdout } = await run(
          "git",
          ["log", "--merges", `-n${n}`, "--format=%H"],
          { cwd: root, maxBuffer: 10 * 1024 * 1024 }
        );
        shas = stdout.split("\n").filter(Boolean);
      } catch {
        return []; // no git, no history, or a shallow clone
      }

      const lists = [];
      for (const sha of shas) {
        try {
          const { stdout } = await run(
            "git",
            ["diff", "--name-only", `${sha}^1`, sha],
            { cwd: root, maxBuffer: 10 * 1024 * 1024 }
          );
          lists.push(stdout.split("\n").filter(Boolean));
        } catch {
          // A merge with no first parent (a root merge) or an unreachable
          // object. Skip it rather than failing the whole scan.
        }
      }
      return lists;
    },
  };
}
