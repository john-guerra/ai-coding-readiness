/**
 * Locating and measuring the agent guide.
 *
 * Three checks in this milestone read it and two need its imports resolved.
 * Two copies would not be a seam; three is — the same threshold that was
 * applied to the pull-request-gate predicate after two independent copies
 * drifted and produced contradictory verdicts on the same repository.
 *
 * @typedef {import('./repo.js').Repo} Repo
 * @typedef {{path: string, text: string}} Guide
 */

/** Searched in order; the first that exists wins. */
export const GUIDE_PATHS = ["CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md"];

/** Imports may nest this deep, per the documented limit. */
const MAX_IMPORT_DEPTH = 4;

/**
 * Count lines the way `wc -l` does — newlines, not segments. A trailing
 * newline must not add a phantom line, or every reported size is one high.
 * @param {string} text
 */
export function countLines(text) {
  if (text === "") return 0;
  const newlines = (text.match(/\n/g) ?? []).length;
  return text.endsWith("\n") ? newlines : newlines + 1;
}

/**
 * @param {Repo} repo
 * @returns {Promise<Guide|null>}
 */
export async function readGuide(repo) {
  for (const path of GUIDE_PATHS) {
    const text = await repo.readFile(path);
    if (text !== null) return { path, text };
  }
  return null;
}

/**
 * Strip fenced blocks and code spans before scanning for imports. An `@path`
 * inside either is documentation, not an import — import parsing skips both —
 * and counting them would inflate the very budget this exists to measure.
 * @param {string} text
 */
function withoutCode(text) {
  return text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

/**
 * The guide plus every file reachable through `@path` imports, each counted
 * once, depth-limited.
 *
 * @param {Repo} repo
 * @param {Guide} guide
 * @returns {Promise<{files: Array<{path: string, lines: number}>, cycles: string[]}>}
 */
export async function resolveImports(repo, guide) {
  /** @type {Array<{path: string, lines: number}>} */
  const files = [{ path: guide.path, lines: countLines(guide.text) }];
  /** @type {Set<string>} */
  const seen = new Set([guide.path]);
  /** @type {string[]} */
  const cycles = [];

  /**
   * @param {string} text
   * @param {number} depth
   */
  const walk = async (text, depth) => {
    if (depth > MAX_IMPORT_DEPTH) return;
    const matches = withoutCode(text).matchAll(/(?:^|\s)@([^\s`)\]]+)/g);
    for (const m of matches) {
      const path = m[1];
      if (seen.has(path)) {
        cycles.push(path);
        continue;
      }
      const imported = await repo.readFile(path);
      // A path that does not resolve imports nothing and costs nothing. It is
      // a finding for a different check, not a reason to fail this one.
      if (imported === null) continue;
      seen.add(path);
      files.push({ path, lines: countLines(imported) });
      await walk(imported, depth + 1);
    }
  };

  await walk(guide.text, 1);
  return { files, cycles };
}

/**
 * Rules that load in every session — i.e. those WITHOUT `paths:` frontmatter.
 * A path-scoped rule loads only when Claude reads a matching file, so it costs
 * nothing on an unrelated session and must not count against the always-loaded
 * budget; counting it would make the remedy for that budget look ineffective.
 *
 * @param {Repo} repo
 * @returns {Promise<Array<{path: string, lines: number}>>}
 */
export async function alwaysLoadedRules(repo) {
  const paths = (await repo.listFiles(".claude/rules")).filter((p) =>
    p.endsWith(".md"),
  );
  const out = [];
  for (const path of paths) {
    const text = await repo.readFile(path);
    if (text === null) continue;
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text);
    if (frontmatter && /^paths\s*:/m.test(frontmatter[1])) continue;
    out.push({ path, lines: countLines(text) });
  }
  return out;
}
