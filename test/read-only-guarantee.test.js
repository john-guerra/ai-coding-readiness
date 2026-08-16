import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ACTION_KINDS } from "../lib/finding.js";
import { applyAction } from "../lib/actions.js";
import { createFakeRepo } from "../lib/repo.js";
import { createFakeWriter } from "../lib/writer.js";
import repoHygiene from "../lib/checks/repo-hygiene.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Comments have to go before anything is matched.
 *
 * `lib/finding.js` mentions `import('./actions.js').Action` as an **erased**
 * JSDoc type — TypeScript resolves it, the runtime never sees it, and it costs
 * nothing. A scanner that does not strip comments flags that line and reports
 * a violation that does not exist, which is exactly how a real guarantee gets
 * downgraded to a nuisance and then deleted. Block comments go first; only
 * whole-line `//` comments are stripped after that, so a `//` inside a string
 * (a URL, say) is left alone.
 *
 * @param {string} src
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Every module specifier in `code`: `from "x"` (static import and re-export),
 * a bare side-effect `import "x"`, and `import("x")`.
 * @param {string} code
 */
function collect(code) {
  /** @type {string[]} */
  const out = [];
  for (const re of [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s+["']([^"']+)["']/g,
  ]) {
    for (const m of code.matchAll(re)) out.push(m[1]);
  }
  return out;
}

/** @param {string} src */
const specifiers = (src) => collect(stripComments(src));

/** The same scan with the comment strip left out — the naive version. */
const naiveSpecifiers = (/** @type {string} */ src) => collect(src);

/**
 * Walk the static import graph from `entry`, following relative specifiers
 * only (bare ones are packages, which cannot reach back into `lib/`).
 *
 * Recursive on purpose. Grepping one file proves nothing about what that
 * file's imports import — the guarantee is about reachability, not about a
 * single line.
 *
 * @param {string} entry - absolute path
 * @param {(src: string) => string[]} [read] - how to extract specifiers
 * @returns {Set<string>} repo-relative paths, including the entry
 */
function importGraph(entry, read = specifiers) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const queue = [entry];
  while (queue.length > 0) {
    const file = /** @type {string} */ (queue.shift());
    const rel = relative(ROOT, file);
    if (seen.has(rel)) continue;
    seen.add(rel);
    let src;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const spec of read(src)) {
      if (!spec.startsWith(".")) continue;
      queue.push(resolve(dirname(file), spec));
    }
  }
  return seen;
}

describe("the audit's read-only guarantee", () => {
  const graph = importGraph(join(ROOT, "bin", "audit.mjs"));

  // A walker that silently found nothing would pass every assertion below.
  it("actually walks the graph", () => {
    expect(graph.has("bin/audit.mjs")).toBe(true);
    expect(graph.has("lib/repo.js")).toBe(true);
    expect(graph.has("lib/registry.js")).toBe(true);
    expect(graph.has("lib/report.js")).toBe(true);
    expect(graph.has("lib/finding.js")).toBe(true);
    expect(graph.has("lib/checks/repo-hygiene.js")).toBe(true);
    expect(graph.has("lib/paths.js")).toBe(true);
    expect(graph.size).toBeGreaterThan(12);
  });

  it("has no runtime path from bin/audit.mjs to the write layer", () => {
    expect([...graph].filter((p) => /writer\.js|actions\.js/.test(p))).toEqual(
      [],
    );
  });

  // The strip is load-bearing, not defensive: without it this same walk
  // reports a violation, because `lib/finding.js` names `actions.js` in a
  // JSDoc type. Asserting that keeps somebody from "simplifying" the scanner
  // and then deleting the guarantee when it goes red for no reason.
  it("would report a false violation if comments were not stripped", () => {
    const naive = importGraph(join(ROOT, "bin", "audit.mjs"), naiveSpecifiers);
    expect(naive.has("lib/actions.js")).toBe(true);
  });

  // The other direction: the write layer IS reachable from the adapter, which
  // proves the walker can find these files when they are genuinely imported.
  it("does reach the write layer from bin/adapt.mjs", () => {
    const adapt = importGraph(join(ROOT, "bin", "adapt.mjs"));
    expect(adapt.has("lib/actions.js")).toBe(true);
    expect(adapt.has("lib/writer.js")).toBe(true);
  });
});

describe("ACTION_KINDS does not drift from lib/actions.js", () => {
  // `lib/finding.js` keeps a second copy of the kind list deliberately: it is
  // in the audit's import graph and `lib/actions.js` is not, so importing the
  // real one would cost the guarantee asserted above. A second copy is a
  // second thing to get wrong, and the way it goes wrong here is silent —
  // `makeFinding` throws on an unrecognised kind, `runChecks` catches it, and
  // a real `fail` renders as `unknown`.
  const source = readFileSync(join(ROOT, "lib", "actions.js"), "utf8");

  it("lists exactly the kinds the Action union declares", () => {
    // `\s*` after the brace, because Prettier formats an object TYPE as
    // `{ kind: "copy-file", … }` with the space — and the space-less form of
    // this pattern simply does not see such a member. The test then passes
    // green while `ACTION_KINDS` and `lib/actions.js` have diverged, which is
    // the exact silent downgrade the comment above describes: `makeFinding`
    // throws on the new kind, `runChecks` catches, and a real `fail` renders
    // as `unknown`.
    const matches = [...source.matchAll(/\{\s*kind:\s*"([a-z-]+)"/g)];
    // Three members, counted rather than assumed. Without this a pattern that
    // matched NOTHING, or matched two of three, would agree with an empty or
    // half-empty `declared` by coincidence rather than by observation.
    expect(matches).toHaveLength(3);
    const declared = new Set(matches.map((m) => m[1]));
    expect([...declared].sort()).toEqual([...ACTION_KINDS].sort());
  });

  it("lists exactly the kinds applyAction can perform", async () => {
    /** @type {Record<string, import('../lib/actions.js').Action>} */
    const sample = {
      "write-file": { kind: "write-file", path: "new.md", content: "hi\n" },
      "append-lines": { kind: "append-lines", path: "list.txt", lines: ["a"] },
      "write-region": {
        kind: "write-region",
        path: "GUIDE.md",
        id: "guardrails",
        inner: "text",
        version: 1,
      },
    };
    expect(Object.keys(sample).sort()).toEqual([...ACTION_KINDS].sort());
    for (const kind of ACTION_KINDS) {
      const action = sample[kind];
      const result = await applyAction(
        createFakeRepo({ files: {} }),
        createFakeWriter(),
        action,
        { schemaVersion: 1, entries: {} },
      );
      expect(result.changed, `${kind} should be applicable`).toBe(true);
    }
  });
});

describe("no action may ever ignore the manifest", () => {
  // Amendment B10: classification only survives if `.ai-readiness/` is
  // committed. A `.gitignore` line that hid it would disarm the safety
  // mechanism the entire write path rests on.
  it("repo.hygiene never proposes ignoring .ai-readiness/", async () => {
    /** @type {Record<string, string>[]} */
    const fixtures = [
      { "package.json": "{}", "package-lock.json": "{}" },
      {
        "package.json": "{}",
        "package-lock.json": "{}",
        ".gitignore": "node_modules/\n",
      },
    ];
    for (const files of fixtures) {
      const finding = await repoHygiene.run(createFakeRepo({ files }));
      const action = finding.action;
      expect(action).not.toBeNull();
      const lines =
        action && action.kind === "append-lines" ? action.lines : [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line).not.toMatch(/ai-readiness/);
    }
  });
});
