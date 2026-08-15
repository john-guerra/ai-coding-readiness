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
 * @property {(path: string) => Promise<string|null>} readFile
 * @property {(dir: string) => Promise<string[]>} listFiles
 * @property {(n: number) => Promise<string[][]>} mergedPrFileLists
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
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
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
      } catch {
        // Missing, unreadable, or a directory. All three mean "no content",
        // which every caller treats as a finding rather than an error.
        return null;
      }
    },
    async listFiles(dir) {
      try {
        const entries = await readdir(join(root, dir), { withFileTypes: true });
        return entries
          .filter((e) => e.isFile())
          .map((e) => posix.join(dir, e.name));
      } catch {
        return [];
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
