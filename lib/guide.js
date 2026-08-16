import { posix } from "node:path";
import { parse } from "yaml";
import { countLines } from "./text.js";
import { withoutCode } from "./markdown.js";

/**
 * Locating and measuring the agent guide.
 *
 * Three checks in this milestone read it and two need its imports resolved.
 * Two copies would not be a seam; three is — the same threshold that was
 * applied to the pull-request-gate predicate after two independent copies
 * drifted and produced contradictory verdicts on the same repository.
 *
 * `countLines` used to be defined here too, until it and the copy in
 * `lib/checks/concurrency-pr-path-contention.js` were found to disagree on
 * text with no trailing newline. It now lives in `lib/text.js`; re-exported
 * here so this module's documented export surface (which Task 3 consumes)
 * does not change.
 *
 * The code-stripper that used to live here went the same way, for the same
 * reason: three near-copies existed across this file and two checks, and they
 * had already begun to differ. It is now `withoutCode` in `lib/markdown.js`.
 * The version here deleted fenced blocks outright, which could join the text
 * on either side of a fence into one line and hide an import boundary; the
 * shared one blanks them in place instead.
 *
 * @typedef {import('./repo.js').Repo} Repo
 * @typedef {{path: string, text: string}} Guide
 */
export { countLines };

/** Searched in order; the first that exists wins. */
export const GUIDE_PATHS = ["CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md"];

/** Imports may nest this deep, per the documented limit. */
const MAX_IMPORT_DEPTH = 4;

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
 * Import paths appear as `@path`, sometimes wrapped in markdown emphasis
 * (`**@path**`, `_@path_`) and almost always followed by ordinary prose
 * punctuation (`@path.`, `@path,`, `@path;`). The boundary before `@` accepts
 * start-of-string, whitespace, `*`, `_`, `(`, `[`, or `{` — widened from
 * whitespace-only — so an emphasis-wrapped import (`**@path**`) and a
 * parenthesized or bracketed one (`(@path)`, `[@path]`) are still found; the
 * body excludes the matching closers `)`, `]`, and `}` so they are never
 * captured as part of the path, and trailing `.,;:!?*_` are trimmed from
 * whatever remains so ordinary prose punctuation and a closing emphasis
 * marker are not read as part of the path either.
 *
 * The previous, narrower boundary silently dropped these forms — the
 * dangerous direction, since a missed import under-counts whatever budget is
 * built on top of `resolveImports` (a false `pass`). The false-positive
 * direction (`@types/node`, `@media` mentioned outside code) sits on the
 * over-counting side instead, which this project treats as the safer
 * direction — but it is not universally harmless: guide.test.js has a fixture
 * where a file genuinely exists at one of these coincidentally-matching
 * paths, and that file DOES get pulled into the resolved-imports count. The
 * false positive is narrow (it needs a real file at that literal path) but
 * real when it occurs. Widening the boundary to include `_` also reopens one
 * theoretical false positive the previous whitespace-only boundary did not
 * have: an email address whose local part happens to end in `_` immediately
 * before the `@` (`user_@example.com`) now satisfies the boundary the same
 * way a real import would. Ordinary emails stay safe only because their
 * local part is some other character immediately before `@`.
 */
const IMPORT_RE = /(?:^|[\s*_([{])@([^\s`)\]}]+)/g;
const TRAILING_NOISE_RE = /[.,;:!?*_]+$/;

/**
 * The guide plus every file reachable through `@path` imports, each counted
 * once, depth-limited. Every import path resolves against the **repo root**,
 * not the file doing the importing — so a `.claude/CLAUDE.md` written with
 * paths relative to its own directory (rather than the repo root) will
 * under-count: its imports will not resolve and the check has no way to tell
 * the difference from an import that is simply missing.
 *
 * An import that does not name a path *within* the repo is skipped rather
 * than resolved, in three forms: `~` is a home-directory reference this tool
 * has no business reading; a `/`-rooted path is absolute; and one whose
 * normalized form starts with `..` climbs out of the root. The third was
 * missing, and it was the one that got out — `@../secret.md` in a CLAUDE.md
 * made the audit count a file outside the audited repository and quote a line
 * of it into the report. `createFsRepo` refuses the same paths independently;
 * this layer exists so the skip is visible where imports are parsed, and so
 * the behaviour holds for any `Repo` implementation.
 *
 * @param {Repo} repo
 * @param {Guide} guide
 * @returns {Promise<{files: Array<{path: string, lines: number, text: string}>, alreadyCounted: string[]}>}
 */
export async function resolveImports(repo, guide) {
  /** @type {Array<{path: string, lines: number, text: string}>} */
  const files = [
    { path: guide.path, lines: countLines(guide.text), text: guide.text },
  ];
  /** @type {Set<string>} */
  const seen = new Set([guide.path]);
  // Any path seen more than once lands here — a true cycle (an ancestor
  // importing itself back) and a diamond (two different files importing the
  // same third file) are indistinguishable from here, and neither is wrong
  // to skip. Calling this "cycles" implied every entry was a back-edge, which
  // is not true and would mislead a future reader into building cycle-only
  // logic on top of it.
  /** @type {string[]} */
  const alreadyCounted = [];

  /**
   * @param {string} text
   * @param {number} depth
   */
  const walk = async (text, depth) => {
    if (depth > MAX_IMPORT_DEPTH) return;
    const matches = withoutCode(text).matchAll(IMPORT_RE);
    for (const m of matches) {
      const path = m[1].replace(TRAILING_NOISE_RE, "");
      if (path === "") continue;
      // Not resolvable against the repo root — see the JSDoc above. The `..`
      // test is written as `=== ".."` or a `"../"` prefix rather than a bare
      // `startsWith("..")` so a legitimately-named file such as `..config.md`
      // is not skipped; it does not escape the root and skipping it would
      // under-count the budget, which is the false-pass direction.
      const normalized = posix.normalize(path);
      if (
        path.startsWith("~") ||
        path.startsWith("/") ||
        normalized === ".." ||
        normalized.startsWith("../")
      ) {
        continue;
      }
      if (seen.has(path)) {
        alreadyCounted.push(path);
        continue;
      }
      const imported = await repo.readFile(path);
      // A path that does not resolve imports nothing and costs nothing. It is
      // a finding for a different check, not a reason to fail this one.
      if (imported === null) continue;
      seen.add(path);
      files.push({ path, lines: countLines(imported), text: imported });
      await walk(imported, depth + 1);
    }
  };

  await walk(guide.text, 1);
  return { files, alreadyCounted };
}

/**
 * Normalize a file's leading bytes before frontmatter matching. Any of a BOM,
 * CRLF line endings, or a blank line before the opening `---` would otherwise
 * hide the fence from a `^---\n` anchor and cause a path-scoped rule to be
 * miscounted as always-loaded.
 * @param {string} text
 */
function normalizeLeading(text) {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/^\n+/, "");
}

/**
 * True when frontmatter declares a non-empty `paths:` scope. `paths:` with no
 * value, or `paths: []`, restricts the rule to nothing — which does not
 * restrict its loading at all, so treating either as "scoped" would exclude
 * an always-loaded rule from the budget (a false `pass`, the same
 * under-counting direction as a missed import). Require an actual non-empty
 * value: a non-empty array, or any other truthy scalar.
 * @param {string} text
 */
function hasNonEmptyPathsScope(text) {
  const match = /^---\n([\s\S]*?)\n---/.exec(normalizeLeading(text));
  if (!match) return false;
  let doc;
  try {
    doc = parse(match[1]);
  } catch {
    // Unparseable frontmatter declares no scope this function can verify;
    // treat it as unscoped rather than guessing, which keeps the rule in the
    // always-loaded count instead of silently excluding it.
    return false;
  }
  if (!doc || typeof doc !== "object") return false;
  const paths = /** @type {{paths?: unknown}} */ (doc).paths;
  return Array.isArray(paths) ? paths.length > 0 : Boolean(paths);
}

/**
 * Rules that load in every session — i.e. those WITHOUT a non-empty `paths:`
 * scope. Per the official memory documentation: "Rules without `paths`
 * frontmatter are loaded at launch with the same priority as
 * `.claude/CLAUDE.md`." A path-scoped rule loads only when Claude touches a
 * matching file, so it costs nothing on an unrelated session and must not
 * count against the always-loaded budget; counting it would make the remedy
 * for that budget look ineffective.
 *
 * Non-recursive, by `listFiles`' own contract: only the immediate entries of
 * `.claude/rules/` are visible, so a nested rule such as
 * `.claude/rules/api/x.md` is invisible to this function.
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
    if (hasNonEmptyPathsScope(text)) continue;
    out.push({ path, lines: countLines(text) });
  }
  return out;
}
