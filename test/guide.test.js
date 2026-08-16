import { describe, it, expect } from "vitest";
import { createFakeRepo } from "../lib/repo.js";
import {
  readGuide,
  resolveImports,
  guideCorpus,
  alwaysLoadedRules,
  countLines,
} from "../lib/guide.js";
import { countLines as canonicalCountLines } from "../lib/text.js";

describe("readGuide", () => {
  it("returns null when no agent guide exists", async () => {
    expect(await readGuide(createFakeRepo({ files: {} }))).toBeNull();
  });

  it("prefers CLAUDE.md at the root", async () => {
    const repo = createFakeRepo({
      files: { "CLAUDE.md": "root", "AGENTS.md": "agents" },
    });
    expect((await readGuide(repo))?.path).toBe("CLAUDE.md");
  });

  it("falls back to .claude/CLAUDE.md, then AGENTS.md", async () => {
    const nested = createFakeRepo({
      files: { ".claude/CLAUDE.md": "x", "AGENTS.md": "y" },
    });
    expect((await readGuide(nested))?.path).toBe(".claude/CLAUDE.md");

    const only = createFakeRepo({ files: { "AGENTS.md": "y" } });
    expect((await readGuide(only))?.path).toBe("AGENTS.md");
  });
});

describe("resolveImports", () => {
  it("counts the guide alone when it imports nothing", async () => {
    const repo = createFakeRepo({ files: { "CLAUDE.md": "a\nb\nc\n" } });
    const guide = await readGuide(repo);
    const { files } = await resolveImports(repo, /** @type {any} */ (guide));
    expect(files).toEqual([{ path: "CLAUDE.md", lines: 3, text: "a\nb\nc\n" }]);
  });

  it("follows @-imports and counts each file once", async () => {
    const repo = createFakeRepo({
      files: {
        "CLAUDE.md": "@docs/a.md\n@docs/b.md\n@docs/a.md\n",
        "docs/a.md": "1\n2\n",
        "docs/b.md": "1\n",
      },
    });
    const guide = await readGuide(repo);
    const { files } = await resolveImports(repo, /** @type {any} */ (guide));
    expect(files.map((f) => f.path).sort()).toEqual([
      "CLAUDE.md",
      "docs/a.md",
      "docs/b.md",
    ]);
  });

  // An @path inside a code span or fence is documentation, not an import —
  // the official memory docs say parsing skips both, and a check that counted
  // them would inflate the budget it is meant to measure.
  it("ignores an @path inside backticks or a fenced block", async () => {
    const repo = createFakeRepo({
      files: {
        "CLAUDE.md": "see `@docs/a.md`\n```\n@docs/b.md\n```\n",
        "docs/a.md": "x\n",
        "docs/b.md": "x\n",
      },
    });
    const guide = await readGuide(repo);
    const { files } = await resolveImports(repo, /** @type {any} */ (guide));
    expect(files.map((f) => f.path)).toEqual(["CLAUDE.md"]);
  });

  it("stops at a cycle and names it rather than recursing forever", async () => {
    const repo = createFakeRepo({
      files: { "CLAUDE.md": "@a.md\n", "a.md": "@CLAUDE.md\n" },
    });
    const guide = await readGuide(repo);
    const { files, alreadyCounted } = await resolveImports(
      repo,
      /** @type {any} */ (guide),
    );
    expect(files.map((f) => f.path).sort()).toEqual(["CLAUDE.md", "a.md"]);
    expect(alreadyCounted).toContain("CLAUDE.md");
  });

  it("skips an import that does not resolve to a file", async () => {
    const repo = createFakeRepo({ files: { "CLAUDE.md": "@missing.md\n" } });
    const guide = await readGuide(repo);
    const { files } = await resolveImports(repo, /** @type {any} */ (guide));
    expect(files.map((f) => f.path)).toEqual(["CLAUDE.md"]);
  });

  // KNOWN LIMITATION, not a spec requirement: the brief's import regex
  // (`/(?:^|\s)@([^\s`)\]]+)/g`) only excludes backticks/fences, not other
  // prose uses of `@`. An `@scope/package` mentioned outside a code span
  // reads as an import if a file happens to exist at that path. This test
  // documents the behavior rather than asserting it is desired — see the
  // task report for the concern raised about it.
  it("documents a false match: a scoped npm package named in prose", async () => {
    const repo = createFakeRepo({
      files: {
        "CLAUDE.md": "Install @types/node as a dev dependency.\n",
        "types/node": "unrelated file that happens to sit at that path\n",
      },
    });
    const guide = await readGuide(repo);
    const { files } = await resolveImports(repo, /** @type {any} */ (guide));
    expect(files.map((f) => f.path)).toContain("types/node");
  });

  // Same limitation, different trigger: an `@media` rule in an unfenced CSS
  // snippet is not inside backticks, so it is not stripped by `withoutCode`
  // and reads as `@media`.
  it("documents a false match: an @media rule in an unfenced snippet", async () => {
    const repo = createFakeRepo({
      files: {
        "CLAUDE.md": "@media (max-width: 600px) { .x { color: red; } }\n",
        media: "unrelated file that happens to sit at that path\n",
      },
    });
    const guide = await readGuide(repo);
    const { files } = await resolveImports(repo, /** @type {any} */ (guide));
    expect(files.map((f) => f.path)).toContain("media");
  });

  // A missed import silently under-counts whatever budget is built on top of
  // resolveImports — the false-`pass` direction, and the more dangerous one.
  // These four cases are the ones an independent plan review found the
  // original whitespace-only-boundary regex dropped.
  it("trims a trailing period from an import path", async () => {
    const repo = createFakeRepo({
      files: { "CLAUDE.md": "See @docs/a.md.\n", "docs/a.md": "x\n" },
    });
    const guide = await readGuide(repo);
    const { files } = await resolveImports(repo, /** @type {any} */ (guide));
    expect(files.map((f) => f.path)).toEqual(["CLAUDE.md", "docs/a.md"]);
  });

  it("trims a trailing comma from an import path", async () => {
    const repo = createFakeRepo({
      files: {
        "CLAUDE.md": "See @docs/a.md, then read on.\n",
        "docs/a.md": "x\n",
      },
    });
    const guide = await readGuide(repo);
    const { files } = await resolveImports(repo, /** @type {any} */ (guide));
    expect(files.map((f) => f.path)).toEqual(["CLAUDE.md", "docs/a.md"]);
  });

  it("trims a trailing semicolon from an import path", async () => {
    const repo = createFakeRepo({
      files: { "CLAUDE.md": "@docs/a.md;\n", "docs/a.md": "x\n" },
    });
    const guide = await readGuide(repo);
    const { files } = await resolveImports(repo, /** @type {any} */ (guide));
    expect(files.map((f) => f.path)).toEqual(["CLAUDE.md", "docs/a.md"]);
  });

  it("resolves an import wrapped in markdown emphasis", async () => {
    const repo = createFakeRepo({
      files: { "CLAUDE.md": "**@docs/a.md**\n", "docs/a.md": "x\n" },
    });
    const guide = await readGuide(repo);
    const { files } = await resolveImports(repo, /** @type {any} */ (guide));
    expect(files.map((f) => f.path)).toEqual(["CLAUDE.md", "docs/a.md"]);
  });

  // ~-rooted and /-rooted paths cannot be resolved against the repo root, so
  // treating them as imports would either read the wrong file or silently
  // fail — neither is what "skip" should mean.
  it("skips a ~-rooted import path", async () => {
    const repo = createFakeRepo({
      files: { "CLAUDE.md": "@~/.claude/x.md\n" },
    });
    const guide = await readGuide(repo);
    const { files } = await resolveImports(repo, /** @type {any} */ (guide));
    expect(files.map((f) => f.path)).toEqual(["CLAUDE.md"]);
  });

  it("skips a /-rooted (absolute) import path", async () => {
    const repo = createFakeRepo({ files: { "CLAUDE.md": "@/etc/passwd\n" } });
    const guide = await readGuide(repo);
    const { files } = await resolveImports(repo, /** @type {any} */ (guide));
    expect(files.map((f) => f.path)).toEqual(["CLAUDE.md"]);
  });
});

describe("guideCorpus", () => {
  it("returns null when no guide exists", async () => {
    expect(await guideCorpus(createFakeRepo({ files: {} }))).toBeNull();
  });

  // The documented delegation pattern: an entry file that imports the real
  // substance. A check reading only readGuide's single file would miss
  // content that guideCorpus makes searchable.
  it("concatenates the guide and its imports into one searchable body", async () => {
    const repo = createFakeRepo({
      files: {
        "CLAUDE.md": "@AGENTS.md\n",
        "AGENTS.md": "run `npm test`\n",
      },
    });
    const corpus = await guideCorpus(repo);
    expect(corpus?.paths.sort()).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(corpus?.text).toContain("npm test");
  });
});

describe("alwaysLoadedRules", () => {
  it("counts a rule with no paths frontmatter", async () => {
    const repo = createFakeRepo({
      files: { ".claude/rules/style.md": "# Style\nrule\n" },
    });
    const rules = await alwaysLoadedRules(repo);
    expect(rules).toEqual([{ path: ".claude/rules/style.md", lines: 2 }]);
  });

  // A path-scoped rule loads only when Claude touches a matching file, so it
  // costs nothing on an unrelated session. Counting it against the
  // always-loaded budget would make the fix for that budget look ineffective.
  it("excludes a rule scoped with paths frontmatter", async () => {
    const repo = createFakeRepo({
      files: {
        ".claude/rules/api.md": '---\npaths:\n  - "src/**/*.ts"\n---\nrule\n',
      },
    });
    expect(await alwaysLoadedRules(repo)).toEqual([]);
  });

  it("returns nothing when there is no rules directory", async () => {
    expect(await alwaysLoadedRules(createFakeRepo({ files: {} }))).toEqual([]);
  });

  // An empty `paths:` scope restricts the rule to nothing, which means the
  // rule IS always loaded. Excluding it would under-count the always-loaded
  // budget — the false-`pass` direction.
  it("treats paths: with no value as always-loaded", async () => {
    const repo = createFakeRepo({
      files: { ".claude/rules/x.md": "---\npaths:\n---\nrule\n" },
    });
    expect(await alwaysLoadedRules(repo)).toEqual([
      { path: ".claude/rules/x.md", lines: 4 },
    ]);
  });

  it("treats paths: [] as always-loaded", async () => {
    const repo = createFakeRepo({
      files: { ".claude/rules/x.md": "---\npaths: []\n---\nrule\n" },
    });
    expect(await alwaysLoadedRules(repo)).toEqual([
      { path: ".claude/rules/x.md", lines: 4 },
    ]);
  });

  // CRLF, a BOM, and a leading blank line all hide the opening `---` from a
  // `^---\n` anchor, which would wrongly count a scoped rule as always-loaded.
  it("recognizes a paths scope through CRLF line endings", async () => {
    const repo = createFakeRepo({
      files: {
        ".claude/rules/api.md":
          '---\r\npaths:\r\n  - "src/**/*.ts"\r\n---\r\nrule\r\n',
      },
    });
    expect(await alwaysLoadedRules(repo)).toEqual([]);
  });

  it("recognizes a paths scope past a leading BOM", async () => {
    const repo = createFakeRepo({
      files: {
        ".claude/rules/api.md":
          '\uFEFF---\npaths:\n  - "src/**/*.ts"\n---\nrule\n',
      },
    });
    expect(await alwaysLoadedRules(repo)).toEqual([]);
  });

  it("recognizes a paths scope past a leading blank line", async () => {
    const repo = createFakeRepo({
      files: {
        ".claude/rules/api.md": '\n---\npaths:\n  - "src/**/*.ts"\n---\nrule\n',
      },
    });
    expect(await alwaysLoadedRules(repo)).toEqual([]);
  });
});

describe("countLines", () => {
  it("counts the way wc -l does", () => {
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("a\nb")).toBe(1);
    expect(countLines("")).toBe(0);
  });

  // countLines used to be defined separately in lib/guide.js and
  // lib/checks/concurrency-pr-path-contention.js, and the two copies
  // silently disagreed on text with no trailing newline ("a\nb": 2 vs 1).
  // Asserting reference equality with the canonical lib/text.js export means
  // a future reintroduction of a local copy in either file fails this test
  // immediately, instead of waiting for another observed disagreement.
  it("is the exact function every consumer imports from lib/text.js", () => {
    expect(countLines).toBe(canonicalCountLines);
  });
});
