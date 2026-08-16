# Milestone 1: Universal Checks and Installability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the audit say something true and useful about *any* repository — including a two-day-old local one — and turn it from a script you clone into a plugin you install.

**Architecture:** Five new deterministic checks join the existing four in the same registry. Three of them read the agent guide, so guide location and `@`-import resolution move into one shared module rather than being reimplemented three times. A `.claude-plugin` manifest and one thin skill wrap the existing CLI; the CLI itself gains no new behaviour beyond registering the checks.

**Tech Stack:** Node 20+ ESM, plain JavaScript with JSDoc types, `tsc -p tsconfig.json` under `strict`, vitest. No new runtime dependencies.

**Spec:** `docs/specs/2026-08-15-ai-coding-readiness-design.md` (revision 4)

## Why this milestone

The tool currently reports **four `unknown`s and nothing else** on a fresh project — verified. Every check built so far measures how a repo behaves under concurrent contributors, which a young repo has not started doing. The four Tier-0 checks below work on any repository that exists, and the plugin manifest turns the result into something a person can install.

## Global Constraints

Copied from the spec. Every task's requirements implicitly include these.

- **Every check ships with its remediation, or it doesn't ship.** `makeFinding` throws on a `fail` with no `fix`.
- **`status` is `pass | fail | unknown`. `unknown` means "could not determine", never "passed."** A false `pass` is the most serious defect class in this project.
- **Every `fix` carries a `precondition` where one exists**, and `null` when none does — explicitly, never omitted.
- **A check may report a finding it cannot auto-fix, provided it says so** (`autoFixable: false`). It may never prescribe a fix that does not apply.
- **`layer: "deterministic"` only.** The binary must never emit a judgment finding; `makeFinding` refuses it.
- **The audit never writes to the repository it audits.** Read-only, in every task here.
- **No telemetry.** The only network path is the existing `gh` fallback in `mergedPrFileLists`; no task here adds another.
- **No new runtime dependencies.** The production tree is `yaml` and nothing else.
- **`tsconfig.json` typechecks `lib/**/*.js`, `bin/**/*.mjs`, `test/**/*.js` under `strict`.** `test/finding.test.js` is the single documented exclusion; do not add another.
- **Report accurately.** List every deviation including type annotations. Reports in the previous plan repeatedly under-disclosed changes and the reviews caught them.

## Controller decisions recorded up front

**1. `guide.exists` ships deterministic, narrowed.** The spec marks it ⚖ (judgment). The *mechanical* half — does a guide exist, and does it name the project's own test command — is checkable without a model, and it is the half that matters on a repo with no guide at all. The quality judgment ("is this guide any good") stays in the skill layer and is out of scope here.

**2. `repo.hygiene` covers lockfile and `.gitignore` only.** Secret scanning needs a recursive listing of *tracked* files, and `Repo` has neither `trackedFiles()` nor recursion. Adding those is a `Repo` change that deserves its own task; scoping this check now is honest, and the check's evidence must not imply it looked for secrets.

**3. Names.** The plugin is **`ai-ready`**, so its skill invokes as `/ai-ready:audit` exactly as the spec §9 specifies. The repository and npm package stay `ai-coding-readiness` (descriptive and searchable), with `ai-ready` added as a second `bin` alias. **This is reversible until the first publish** — flag it if you disagree.

**4. `lib/guide.js` is a seam.** Three checks in this plan read the agent guide and two need its `@`-imports resolved. Two copies is not yet a seam; three is — the same threshold the project applied to `gatesPullRequests`, which drifted and produced contradictory verdicts before being extracted.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `lib/guide.js` | Locate the agent guide, read it, resolve `@`-imports recursively, and classify `.claude/rules/` files as path-scoped or always-loaded |
| `lib/checks/guide-exists.js` | One check |
| `lib/checks/guide-guardrails.js` | One check |
| `lib/checks/guide-context-budget.js` | One check |
| `lib/checks/repo-hygiene.js` | One check |
| `lib/checks/github-contribution-scaffold.js` | One check (composite) |
| `.claude-plugin/plugin.json` | Plugin manifest |
| `.claude-plugin/marketplace.json` | Makes `/plugin marketplace add` work against this repo |
| `skills/audit/SKILL.md` | Thin wrapper: run the CLI, read the report back |
| `bin/audit.mjs` | Register the five new checks (modify) |
| `test/guide.test.js`, `test/checks/*.test.js` | vitest, mirroring `lib/` |

---

## Task 1: The agent-guide accessor

**Files:**
- Create: `lib/guide.js`
- Test: `test/guide.test.js`

**Interfaces:**
- Consumes: `Repo` from `lib/repo.js` (`readFile`, `listFiles`)
- Produces:
  - `GUIDE_PATHS` — `["CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md"]`, searched in that order
  - `readGuide(repo) -> Promise<Guide|null>` where `Guide` is `{path: string, text: string}`; `null` when no guide exists
  - `resolveImports(repo, guide) -> Promise<{files: Array<{path: string, lines: number}>, cycles: string[]}>` — the guide itself plus every file reachable through `@path` imports, depth-limited to 4 hops, each counted once; `cycles` names any import that was skipped because it had already been seen
  - `alwaysLoadedRules(repo) -> Promise<Array<{path: string, lines: number}>>` — `.claude/rules/*.md` **without** a `paths:` frontmatter key, since those load every session; path-scoped rules are excluded because they only load when Claude touches a matching file
  - `countLines(text) -> number` — newline count, matching `wc -l`

- [ ] **Step 1: Write the failing test**

Create `test/guide.test.js`:

```js
import { describe, it, expect } from "vitest";
import { createFakeRepo } from "../lib/repo.js";
import {
  readGuide,
  resolveImports,
  alwaysLoadedRules,
  countLines,
} from "../lib/guide.js";

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
    expect(files).toEqual([{ path: "CLAUDE.md", lines: 3 }]);
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
    const { files, cycles } = await resolveImports(
      repo,
      /** @type {any} */ (guide),
    );
    expect(files.map((f) => f.path).sort()).toEqual(["CLAUDE.md", "a.md"]);
    expect(cycles).toContain("CLAUDE.md");
  });

  it("skips an import that does not resolve to a file", async () => {
    const repo = createFakeRepo({ files: { "CLAUDE.md": "@missing.md\n" } });
    const guide = await readGuide(repo);
    const { files } = await resolveImports(repo, /** @type {any} */ (guide));
    expect(files.map((f) => f.path)).toEqual(["CLAUDE.md"]);
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
});

describe("countLines", () => {
  it("counts the way wc -l does", () => {
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("")).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/guide.test.js`
Expected: FAIL — `Failed to resolve import "../lib/guide.js"`

- [ ] **Step 3: Write the implementation**

Create `lib/guide.js`:

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/guide.test.js`
Expected: PASS, 12 tests

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass, typecheck exit 0

- [ ] **Step 6: Commit**

```bash
git add lib/guide.js test/guide.test.js
git commit -m "feat(guide): one accessor for the agent guide and its imports

Three checks in this milestone read the guide and two need its @-imports
resolved. Extracting it now rather than after the third copy: two
independent copies of the pull-request-gate predicate drifted in the last
plan and produced contradictory verdicts on the same repository.

Imports inside code spans and fences are skipped, matching how import
parsing actually works — counting them would inflate the very budget this
module exists to measure."
```

---

## Task 2: Checks `guide.exists` and `guide.guardrails`

These ship together because both answer questions about the same file, and because `guide.guardrails` must not re-report the absence that `guide.exists` owns.

**Files:**
- Create: `lib/checks/guide-exists.js`
- Create: `lib/checks/guide-guardrails.js`
- Test: `test/checks/guide.test.js`

**Interfaces:**
- Consumes: `makeFinding` (`lib/finding.js`), `readGuide` (Task 1), `Repo`
- Produces: two default-exported `Check` objects — `{id, tier, cost, run}`. `guide.exists` is `tier: 0, cost: "S"`; `guide.guardrails` is `tier: 0, cost: "S"`.

**Contracts:**

`guide.exists`
- No guide at any of `GUIDE_PATHS` → **`fail`**, fix directs to `/init`
- Guide exists, `package.json` has a `test` script, and the guide never mentions that command → **`fail`**
- Guide exists and names the test command → **`pass`**
- Guide exists but there is no `package.json` → **`unknown`** (we cannot know what the commands are, and guessing would manufacture a finding)

`guide.guardrails`
- No guide → **`unknown`** (`guide.exists` owns that finding; reporting it twice trains a reader to skim)
- Guide exists, and neither the guide contains a prohibition (`never`, `do not`, `must not`, case-insensitive) nor `.claude/settings.json` declares `permissions.deny` → **`fail`**
- Either present → **`pass`**

- [ ] **Step 1: Write the failing test**

Create `test/checks/guide.test.js`:

```js
import { describe, it, expect } from "vitest";
import { createFakeRepo } from "../../lib/repo.js";
import exists from "../../lib/checks/guide-exists.js";
import guardrails from "../../lib/checks/guide-guardrails.js";

const pkg = (scripts = { test: "vitest run" }) =>
  JSON.stringify({ name: "x", scripts });

describe("guide.exists", () => {
  it("fails when there is no agent guide at all", async () => {
    const f = await exists.run(
      createFakeRepo({ files: { "package.json": pkg() } }),
    );
    expect(f.status).toBe("fail");
    expect(f.fix).toMatch(/\/init/);
  });

  it("fails when the guide never names the project's test command", async () => {
    const f = await exists.run(
      createFakeRepo({
        files: { "package.json": pkg(), "CLAUDE.md": "# Guide\nSome prose.\n" },
      }),
    );
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/npm test/);
  });

  it("passes when the guide names the test command", async () => {
    const f = await exists.run(
      createFakeRepo({
        files: {
          "package.json": pkg(),
          "CLAUDE.md": "# Guide\nRun `npm test` before committing.\n",
        },
      }),
    );
    expect(f.status).toBe("pass");
  });

  // Without a manifest we do not know what the commands ARE, and asserting the
  // guide is missing one would be a finding invented from nothing.
  it("is unknown when there is no package.json to learn the commands from", async () => {
    const f = await exists.run(
      createFakeRepo({ files: { "CLAUDE.md": "# Guide\n" } }),
    );
    expect(f.status).toBe("unknown");
  });
});

describe("guide.guardrails", () => {
  it("is unknown when there is no guide, which guide.exists already reports", async () => {
    const f = await guardrails.run(createFakeRepo({ files: {} }));
    expect(f.status).toBe("unknown");
    expect(f.evidence).toMatch(/guide\.exists/);
  });

  it("fails when neither the guide nor settings forbid anything", async () => {
    const f = await guardrails.run(
      createFakeRepo({ files: { "CLAUDE.md": "# Guide\nRun npm test.\n" } }),
    );
    expect(f.status).toBe("fail");
    expect(f.fix).toBeTruthy();
  });

  it("passes on a prohibition written in the guide", async () => {
    const f = await guardrails.run(
      createFakeRepo({
        files: { "CLAUDE.md": "Never modify the user's photo folders.\n" },
      }),
    );
    expect(f.status).toBe("pass");
  });

  it("passes on a deny list in committed settings", async () => {
    const f = await guardrails.run(
      createFakeRepo({
        files: {
          "CLAUDE.md": "# Guide\n",
          ".claude/settings.json": JSON.stringify({
            permissions: { deny: ["Bash(rm -rf *)"] },
          }),
        },
      }),
    );
    expect(f.status).toBe("pass");
  });

  it("does not treat malformed settings as a deny list", async () => {
    const f = await guardrails.run(
      createFakeRepo({
        files: { "CLAUDE.md": "# Guide\n", ".claude/settings.json": "{ not json" },
      }),
    );
    expect(f.status).toBe("fail");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/checks/guide.test.js`
Expected: FAIL — modules not found

- [ ] **Step 3: Write `lib/checks/guide-exists.js`**

```js
import { makeFinding } from "../finding.js";
import { readGuide, GUIDE_PATHS } from "../guide.js";

const ID = "guide.exists";
const TIER = /** @type {const} */ (0);

/**
 * @param {import('../repo.js').Repo} repo
 * @returns {Promise<import('../finding.js').Finding>}
 */
async function run(repo) {
  const base = {
    id: ID,
    tier: TIER,
    layer: /** @type {const} */ ("deterministic"),
    effort: /** @type {const} */ ("S"),
    why:
      "An agent that cannot find how to build, test and run a project will " +
      "guess, and a wrong guess costs more than the file would have.",
    precondition: null,
  };

  const guide = await readGuide(repo);
  if (guide === null) {
    return makeFinding({
      ...base,
      status: "fail",
      evidence: `No agent guide found (looked for ${GUIDE_PATHS.join(", ")}).`,
      fix:
        "Run `/init` — it interviews you, explores the codebase with a " +
        "subagent, and proposes a guide before writing anything. Then add the " +
        "parts it cannot know: guardrails, the concurrency protocol, and how " +
        "work gets validated.",
      autoFixable: false,
    });
  }

  const manifest = await repo.readFile("package.json");
  if (manifest === null) {
    return makeFinding({
      ...base,
      status: "unknown",
      evidence: `Found ${guide.path}, but no package.json, so the project's own build and test commands are unknown and cannot be looked for.`,
      fix: null,
      autoFixable: false,
    });
  }

  let scripts = {};
  try {
    scripts = JSON.parse(manifest)?.scripts ?? {};
  } catch {
    return makeFinding({
      ...base,
      status: "unknown",
      evidence: `Found ${guide.path}, but package.json could not be parsed, so its scripts are unknown.`,
      fix: null,
      autoFixable: false,
    });
  }

  if (!("test" in scripts)) {
    return makeFinding({
      ...base,
      status: "unknown",
      evidence: `Found ${guide.path}, but package.json declares no "test" script, so there is no test command to look for.`,
      fix: null,
      autoFixable: false,
    });
  }

  if (/npm\s+(run\s+)?test|\bvitest\b|\bjest\b/.test(guide.text)) {
    return makeFinding({
      ...base,
      status: "pass",
      evidence: `${guide.path} names the project's test command.`,
      fix: null,
      autoFixable: false,
    });
  }

  return makeFinding({
    ...base,
    status: "fail",
    evidence: `${guide.path} exists but never mentions \`npm test\`, the command package.json declares for running the suite.`,
    fix: `Add a Commands section to ${guide.path} listing build, test and run — the commands an agent cannot guess from the code.`,
    autoFixable: true,
  });
}

export default { id: ID, tier: TIER, cost: /** @type {const} */ ("S"), run };
```

- [ ] **Step 4: Write `lib/checks/guide-guardrails.js`**

```js
import { makeFinding } from "../finding.js";
import { readGuide } from "../guide.js";

const ID = "guide.guardrails";
const TIER = /** @type {const} */ (0);

/** Prohibitions read as prose, not as a schema. This is the shape they take. */
const PROHIBITION = /\b(never|do not|don't|must not|do NOT)\b/i;

/**
 * @param {import('../repo.js').Repo} repo
 * @returns {Promise<import('../finding.js').Finding>}
 */
async function run(repo) {
  const base = {
    id: ID,
    tier: TIER,
    layer: /** @type {const} */ ("deterministic"),
    effort: /** @type {const} */ ("S"),
    why:
      "An agent with no stated boundary will infer one, and the inference is " +
      "discovered by watching it cross the line.",
    precondition: null,
  };

  const guide = await readGuide(repo);
  if (guide === null) {
    return makeFinding({
      ...base,
      status: "unknown",
      evidence:
        "There is no agent guide to state guardrails in. `guide.exists` " +
        "reports that; repeating it here would just teach the reader to skim.",
      fix: null,
      autoFixable: false,
    });
  }

  if (PROHIBITION.test(guide.text)) {
    return makeFinding({
      ...base,
      status: "pass",
      evidence: `${guide.path} states at least one prohibition.`,
      fix: null,
      autoFixable: false,
    });
  }

  const settings = await repo.readFile(".claude/settings.json");
  if (settings !== null) {
    try {
      const deny = JSON.parse(settings)?.permissions?.deny;
      if (Array.isArray(deny) && deny.length > 0) {
        return makeFinding({
          ...base,
          status: "pass",
          evidence: `.claude/settings.json declares ${deny.length} denied permission(s).`,
          fix: null,
          autoFixable: false,
        });
      }
    } catch {
      // Unparseable settings declare nothing. Fall through to the failure
      // rather than crediting a file that no tool can read.
    }
  }

  return makeFinding({
    ...base,
    status: "fail",
    evidence: `${guide.path} states no prohibition, and .claude/settings.json declares no denied permissions.`,
    fix:
      `Add a Guardrails section to ${guide.path} naming what an agent must ` +
      "never touch — production data, user files, credentials — and the " +
      "destructive-action policy (prefer soft-delete with an undo over a hard " +
      "delete). Back the non-negotiable ones with a `permissions.deny` entry " +
      "in a committed `.claude/settings.json`: guide prose is persuasion, a " +
      "deny rule is enforcement.",
    autoFixable: true,
  });
}

export default { id: ID, tier: TIER, cost: /** @type {const} */ ("S"), run };
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/checks/guide.test.js`
Expected: PASS, 9 tests

- [ ] **Step 6: Commit**

```bash
git add lib/checks/guide-exists.js lib/checks/guide-guardrails.js test/checks/guide.test.js
git commit -m "feat(checks): the agent guide exists, and states a boundary

guide.exists is deliberately narrowed to the mechanical half — a guide is
present and names the test command package.json declares. Judging whether a
guide is any GOOD needs a model and belongs to the skill layer.

guide.guardrails reports unknown rather than fail when there is no guide:
guide.exists owns that finding, and saying it twice teaches a reader to skim.
It credits a committed deny list as well as prose, because a deny rule is
enforcement where guide prose is only persuasion."
```

---

## Task 3: Check `guide.context-budget`

**Files:**
- Create: `lib/checks/guide-context-budget.js`
- Test: `test/checks/guide-context-budget.test.js`

**Interfaces:**
- Consumes: `makeFinding`, `readGuide` / `resolveImports` / `alwaysLoadedRules` (Task 1)
- Produces: default-exported `Check`, `id: "guide.context-budget"`, `tier: 0`, `cost: "S"`

**Contract:**
- No guide → **`unknown`** (`guide.exists` owns it)
- Total always-loaded lines ≤ 200 → **`pass`**
- Total > 200 → **`fail`**, evidence itemising each contributing file, largest first
- `precondition` is required and load-bearing: **only content with an identifiable path scope can move to `.claude/rules/`.** A rule relocated with a *guessed* `paths:` loads **less often** than the `@`-import did, which weakens the very persuasion the guide was relying on. Everything without a path scope must be *mechanized*, not relocated.

- [ ] **Step 1: Write the failing test**

Create `test/checks/guide-context-budget.test.js`:

```js
import { describe, it, expect } from "vitest";
import { createFakeRepo } from "../../lib/repo.js";
import check from "../../lib/checks/guide-context-budget.js";

const lines = (n) => "x\n".repeat(n);

describe("guide.context-budget", () => {
  it("is unknown when there is no guide", async () => {
    expect((await check.run(createFakeRepo({ files: {} }))).status).toBe(
      "unknown",
    );
  });

  it("passes a guide comfortably under the budget", async () => {
    const f = await check.run(
      createFakeRepo({ files: { "CLAUDE.md": lines(120) } }),
    );
    expect(f.status).toBe("pass");
    expect(f.evidence).toMatch(/120/);
  });

  // Imports do not reduce context — they load at launch — so they count.
  it("counts @-imported files against the budget", async () => {
    const f = await check.run(
      createFakeRepo({
        files: {
          "CLAUDE.md": `@docs/big.md\n${lines(50)}`,
          "docs/big.md": lines(400),
        },
      }),
    );
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/docs\/big\.md/);
    expect(f.evidence).toMatch(/45[0-9]|4[0-9][0-9]/);
  });

  it("counts an unscoped rule but not a paths-scoped one", async () => {
    const f = await check.run(
      createFakeRepo({
        files: {
          "CLAUDE.md": lines(150),
          ".claude/rules/always.md": lines(100),
          ".claude/rules/scoped.md": `---\npaths:\n  - "src/**"\n---\n${lines(500)}`,
        },
      }),
    );
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/always\.md/);
    expect(f.evidence).not.toMatch(/scoped\.md/);
  });

  it("carries the precondition that only path-scopable content can move", async () => {
    const f = await check.run(
      createFakeRepo({ files: { "CLAUDE.md": lines(400) } }),
    );
    expect(f.status).toBe("fail");
    expect(f.precondition).toMatch(/path scope/i);
    expect(f.fix).toMatch(/mechaniz/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/checks/guide-context-budget.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `lib/checks/guide-context-budget.js`:

```js
import { makeFinding } from "../finding.js";
import { readGuide, resolveImports, alwaysLoadedRules } from "../guide.js";

const ID = "guide.context-budget";
const TIER = /** @type {const} */ (0);

/** The documented target for a single agent guide. */
const BUDGET_LINES = 200;

/**
 * @param {import('../repo.js').Repo} repo
 * @returns {Promise<import('../finding.js').Finding>}
 */
async function run(repo) {
  const base = {
    id: ID,
    tier: TIER,
    layer: /** @type {const} */ ("deterministic"),
    effort: /** @type {const} */ ("M"),
    why:
      "Every line here is re-read at the start of every session, and a guide " +
      "that grows past the point of being read is one whose rules get lost in " +
      "its own noise.",
  };

  const guide = await readGuide(repo);
  if (guide === null) {
    return makeFinding({
      ...base,
      status: "unknown",
      evidence:
        "There is no agent guide, so there is no always-loaded budget to " +
        "measure. `guide.exists` reports the absence.",
      precondition: null,
      fix: null,
      autoFixable: false,
    });
  }

  const { files } = await resolveImports(repo, guide);
  const rules = await alwaysLoadedRules(repo);
  const all = [...files, ...rules].sort((a, b) => b.lines - a.lines);
  const total = all.reduce((sum, f) => sum + f.lines, 0);

  const itemised = all.map((f) => `${f.path} — ${f.lines} lines`).join("\n  ");

  if (total <= BUDGET_LINES) {
    return makeFinding({
      ...base,
      status: "pass",
      evidence: `${total} lines load at the start of every session, within the ${BUDGET_LINES}-line target:\n  ${itemised}`,
      precondition: null,
      fix: null,
      autoFixable: false,
    });
  }

  return makeFinding({
    ...base,
    status: "fail",
    evidence:
      `${total} lines load at the start of every session — ` +
      `${Math.round(total / BUDGET_LINES)}× the ${BUDGET_LINES}-line target:\n  ${itemised}\n\n` +
      "`@`-imports do not reduce this. They are expanded at launch, so " +
      "splitting a guide into imports reorganises it without making it cheaper.",
    precondition:
      "Only content with an identifiable path scope can move. Measure that " +
      "fraction before prescribing: process knowledge — release steps, CI " +
      "gotchas, debugging traps — has no path to scope it to.",
    fix:
      "Relocate path-scopable content to `.claude/rules/` with `paths:` " +
      "frontmatter, so it loads only when a matching file is touched. " +
      "Everything else must be MECHANIZED rather than relocated — a rule " +
      "moved with a guessed `paths:` loads LESS often than the import did, " +
      "which weakens the persuasion the guide was relying on. Turn those into " +
      "a lint rule, a test, or a hook.",
    autoFixable: false,
  });
}

export default { id: ID, tier: TIER, cost: /** @type {const} */ ("S"), run };
```

- [ ] **Step 4: Run the tests, then the full suite**

Run: `npx vitest run test/checks/guide-context-budget.test.js && npm test && npm run typecheck`
Expected: all pass

- [ ] **Step 5: Verify against ground truth**

```bash
node -e "
import('./lib/repo.js').then(async ({createFsRepo}) => {
  const c = (await import('./lib/checks/guide-context-budget.js')).default;
  const f = await c.run(createFsRepo('/Users/aguerra/workspace/autogallery'));
  console.log(f.status); console.log(f.evidence);
});
"
```

Expected: **`fail`**, total around **1,595 lines** — `CLAUDE.md` (438) plus three `@`-imported docs (`docs/UI-CONTRACTS.md` 400, `docs/AGENT-NOTES.md` 593, `docs/TESTING.md` 164). If the total is near 438, imports are not being resolved. That repository is read-only: run the check against it and nothing else.

- [ ] **Step 6: Commit**

```bash
git add lib/checks/guide-context-budget.js test/checks/guide-context-budget.test.js
git commit -m "feat(checks): measure what actually loads every session

Counts the guide plus everything it @-imports plus unscoped .claude/rules
files. Imports are NOT a reduction — they expand at launch — so a guide
split into imports is reorganised, not cheaper.

The precondition is load-bearing: only path-scopable content can move to
.claude/rules/. A rule relocated with a guessed \`paths:\` loads less often
than the import did, weakening the persuasion the guide was relying on, so
everything without a path scope must be mechanized instead."
```

---

## Task 4: Check `repo.hygiene`

**Files:**
- Create: `lib/checks/repo-hygiene.js`
- Test: `test/checks/repo-hygiene.test.js`

**Interfaces:**
- Consumes: `makeFinding`, `Repo`
- Produces: default-exported `Check`, `id: "repo.hygiene"`, `tier: 0`, `cost: "S"`

**Contract:** a composite over two conditions, reported together.

1. **Lockfile.** `package.json` present but none of `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml` / `bun.lockb` → contributes a failure.
2. **`.gitignore` coverage.** Missing, or not covering `node_modules`, build output (`dist` or `build`), `.env`, `.DS_Store` → contributes a failure per gap.

- No `package.json` → **`unknown`** (ecosystem unknown; this milestone ships the node pack only)
- Any gap → **`fail`**, listing every gap
- No gaps → **`pass`**

**The evidence must not imply secret scanning happened.** Detecting tracked secrets needs a recursive listing of tracked files, which `Repo` does not provide; claiming otherwise would be a false all-clear on the highest-stakes item in the check's name.

- [ ] **Step 1: Write the failing test**

Create `test/checks/repo-hygiene.test.js`:

```js
import { describe, it, expect } from "vitest";
import { createFakeRepo } from "../../lib/repo.js";
import check from "../../lib/checks/repo-hygiene.js";

const IGNORE_ALL = "node_modules/\ndist/\n.env\n.DS_Store\n";

describe("repo.hygiene", () => {
  it("is unknown without a package.json to identify the ecosystem", async () => {
    expect((await check.run(createFakeRepo({ files: {} }))).status).toBe(
      "unknown",
    );
  });

  it("fails when the lockfile is missing", async () => {
    const f = await check.run(
      createFakeRepo({
        files: { "package.json": "{}", ".gitignore": IGNORE_ALL },
      }),
    );
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/lockfile/i);
    expect(f.fix).toMatch(/--package-lock-only/);
  });

  it("accepts any of the ecosystem's lockfiles", async () => {
    for (const lock of [
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "bun.lockb",
    ]) {
      const f = await check.run(
        createFakeRepo({
          files: { "package.json": "{}", [lock]: "x", ".gitignore": IGNORE_ALL },
        }),
      );
      expect(f.status, lock).toBe("pass");
    }
  });

  it("names every .gitignore gap rather than only the first", async () => {
    const f = await check.run(
      createFakeRepo({
        files: {
          "package.json": "{}",
          "package-lock.json": "x",
          ".gitignore": "node_modules/\n",
        },
      }),
    );
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/\.env/);
    expect(f.evidence).toMatch(/\.DS_Store/);
  });

  it("fails when there is no .gitignore at all", async () => {
    const f = await check.run(
      createFakeRepo({
        files: { "package.json": "{}", "package-lock.json": "x" },
      }),
    );
    expect(f.status).toBe("fail");
  });

  // The check cannot see tracked files, so it must not imply it looked.
  it("never claims to have scanned for secrets", async () => {
    const f = await check.run(
      createFakeRepo({
        files: { "package.json": "{}", "package-lock.json": "x", ".gitignore": IGNORE_ALL },
      }),
    );
    expect(f.evidence).not.toMatch(/secret|credential|token/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/checks/repo-hygiene.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `lib/checks/repo-hygiene.js`:

```js
import { makeFinding } from "../finding.js";

const ID = "repo.hygiene";
const TIER = /** @type {const} */ (0);

const LOCKFILES = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
];

/**
 * What a `.gitignore` must cover for an agent's diffs and directory listings
 * to stay readable. Each entry is a label and the patterns that satisfy it.
 */
const IGNORE_REQUIREMENTS = [
  { label: "node_modules", patterns: [/(^|\/)node_modules\/?/m] },
  { label: "build output (dist or build)", patterns: [/^\/?(dist|build)\/?/m] },
  { label: ".env", patterns: [/^\.env/m] },
  { label: ".DS_Store", patterns: [/\.DS_Store/m] },
];

/**
 * @param {import('../repo.js').Repo} repo
 * @returns {Promise<import('../finding.js').Finding>}
 */
async function run(repo) {
  const base = {
    id: ID,
    tier: TIER,
    layer: /** @type {const} */ ("deterministic"),
    effort: /** @type {const} */ ("S"),
    why:
      "A missing lockfile means nobody installs the same tree twice, and " +
      "untracked noise pollutes every diff and directory listing an agent reads.",
  };

  if ((await repo.readFile("package.json")) === null) {
    return makeFinding({
      ...base,
      status: "unknown",
      evidence:
        "No package.json found. This milestone ships the Node pack only, so " +
        "the project's ecosystem — and therefore its lockfile — is unknown.",
      precondition: null,
      fix: null,
      autoFixable: false,
    });
  }

  const gaps = [];

  let hasLock = false;
  for (const lock of LOCKFILES) {
    if ((await repo.readFile(lock)) !== null) {
      hasLock = true;
      break;
    }
  }
  if (!hasLock) {
    gaps.push(`no lockfile (looked for ${LOCKFILES.join(", ")})`);
  }

  const ignore = await repo.readFile(".gitignore");
  if (ignore === null) {
    gaps.push("no .gitignore");
  } else {
    for (const req of IGNORE_REQUIREMENTS) {
      if (!req.patterns.some((p) => p.test(ignore))) {
        gaps.push(`.gitignore does not cover ${req.label}`);
      }
    }
  }

  if (gaps.length === 0) {
    return makeFinding({
      ...base,
      status: "pass",
      evidence:
        "A lockfile is committed and .gitignore covers dependencies, build " +
        "output, environment files and OS cruft.",
      precondition: null,
      fix: null,
      autoFixable: false,
    });
  }

  return makeFinding({
    ...base,
    status: "fail",
    evidence: `${gaps.length} hygiene gap(s):\n  ${gaps.join("\n  ")}`,
    precondition: hasLock
      ? null
      : "Generating a lockfile resolves the dependency graph as it is TODAY, " +
        "which can move transitive versions off whatever has been running. " +
        "Commit it, then confirm the suite is still green.",
    fix:
      (hasLock
        ? ""
        : "Run `npm install --package-lock-only` and commit the result. ") +
      "Add the missing `.gitignore` entries. Neither of these is a matter of " +
      "taste: an uncommitted lockfile makes every install a different tree, " +
      "and tracked build output turns every diff into noise an agent has to " +
      "read past.",
    autoFixable: true,
  });
}

export default { id: ID, tier: TIER, cost: /** @type {const} */ ("S"), run };
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/checks/repo-hygiene.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add lib/checks/repo-hygiene.js test/checks/repo-hygiene.test.js
git commit -m "feat(checks): lockfile and gitignore hygiene

Deliberately does NOT scan for tracked secrets: that needs a recursive
listing of tracked files, which Repo does not provide, and a check that
implied it had looked would be a false all-clear on the highest-stakes item
in its own name. A test asserts the evidence never mentions secrets.

The lockfile fix carries a precondition — generating one resolves the graph
as it is today and can move transitive versions off what has been running."
```

---

## Task 5: Check `github.contribution-scaffold`

**Files:**
- Create: `lib/checks/github-contribution-scaffold.js`
- Test: `test/checks/github-contribution-scaffold.test.js`

**Interfaces:**
- Consumes: `makeFinding`, `Repo`
- Produces: default-exported `Check`, `id: "github.contribution-scaffold"`, `tier: 1`, `cost: "S"`

**Contract:** a composite over three artefacts, each with several accepted locations.

| Artefact | Accepted at |
| --- | --- |
| Issue template | any file in `.github/ISSUE_TEMPLATE/`, or `.github/ISSUE_TEMPLATE.md` |
| PR template | `.github/PULL_REQUEST_TEMPLATE.md`, `.github/pull_request_template.md`, or `PULL_REQUEST_TEMPLATE.md` |
| CODEOWNERS | `.github/CODEOWNERS`, `CODEOWNERS`, or `docs/CODEOWNERS` |

- All three present → **`pass`**
- Any missing → **`fail`**, naming each

There is no `unknown` case: absence is directly observable, and no credential is needed.

- [ ] **Step 1: Write the failing test**

Create `test/checks/github-contribution-scaffold.test.js`:

```js
import { describe, it, expect } from "vitest";
import { createFakeRepo } from "../../lib/repo.js";
import check from "../../lib/checks/github-contribution-scaffold.js";

const ALL = {
  ".github/ISSUE_TEMPLATE/bug.md": "x",
  ".github/PULL_REQUEST_TEMPLATE.md": "x",
  ".github/CODEOWNERS": "* @me",
};

describe("github.contribution-scaffold", () => {
  it("passes when all three are present", async () => {
    expect((await check.run(createFakeRepo({ files: ALL }))).status).toBe(
      "pass",
    );
  });

  it("names every missing artefact, not just the first", async () => {
    const f = await check.run(createFakeRepo({ files: {} }));
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/issue template/i);
    expect(f.evidence).toMatch(/pull request template/i);
    expect(f.evidence).toMatch(/CODEOWNERS/);
  });

  it("accepts the alternative locations", async () => {
    const f = await check.run(
      createFakeRepo({
        files: {
          ".github/ISSUE_TEMPLATE.md": "x",
          "PULL_REQUEST_TEMPLATE.md": "x",
          CODEOWNERS: "* @me",
        },
      }),
    );
    expect(f.status).toBe("pass");
  });

  it("does not accept an empty ISSUE_TEMPLATE directory", async () => {
    const f = await check.run(
      createFakeRepo({
        files: {
          ".github/PULL_REQUEST_TEMPLATE.md": "x",
          ".github/CODEOWNERS": "* @me",
        },
      }),
    );
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/issue template/i);
  });

  it("explains why a bug template matters, not just that one is missing", async () => {
    const f = await check.run(createFakeRepo({ files: {} }));
    expect(f.fix).toMatch(/repro/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/checks/github-contribution-scaffold.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `lib/checks/github-contribution-scaffold.js`:

```js
import { makeFinding } from "../finding.js";

const ID = "github.contribution-scaffold";
const TIER = /** @type {const} */ (1);

/**
 * @param {import('../repo.js').Repo} repo
 * @returns {Promise<import('../finding.js').Finding>}
 */
async function run(repo) {
  const base = {
    id: ID,
    tier: TIER,
    layer: /** @type {const} */ ("deterministic"),
    effort: /** @type {const} */ ("S"),
    why:
      "These are how a repository tells a contributor — human or agent — what " +
      "a report must contain and who has to look at a change.",
    precondition: null,
  };

  const missing = [];

  const issueDir = await repo.listFiles(".github/ISSUE_TEMPLATE");
  const issueFlat = await repo.readFile(".github/ISSUE_TEMPLATE.md");
  if (issueDir.length === 0 && issueFlat === null) {
    missing.push(
      "issue template (.github/ISSUE_TEMPLATE/ or .github/ISSUE_TEMPLATE.md)",
    );
  }

  const prPaths = [
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/pull_request_template.md",
    "PULL_REQUEST_TEMPLATE.md",
  ];
  let hasPr = false;
  for (const p of prPaths) {
    if ((await repo.readFile(p)) !== null) {
      hasPr = true;
      break;
    }
  }
  if (!hasPr) missing.push(`pull request template (${prPaths[0]})`);

  const ownerPaths = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
  let hasOwners = false;
  for (const p of ownerPaths) {
    if ((await repo.readFile(p)) !== null) {
      hasOwners = true;
      break;
    }
  }
  if (!hasOwners) missing.push(`CODEOWNERS (${ownerPaths.join(" or ")})`);

  if (missing.length === 0) {
    return makeFinding({
      ...base,
      status: "pass",
      evidence:
        "Issue template, pull request template and CODEOWNERS are all present.",
      fix: null,
      autoFixable: false,
    });
  }

  return makeFinding({
    ...base,
    status: "fail",
    evidence: `${missing.length} of 3 missing:\n  ${missing.join("\n  ")}`,
    fix:
      "Add the missing files. A bug template that asks for repro steps " +
      "institutionalises `verify against the reported scenario` — the single " +
      "habit that stops a fix being declared done against a similar case " +
      "rather than the actual one. CODEOWNERS is the mechanism teams use for " +
      "the human half of review, and it is what makes required review mean " +
      "something specific rather than `somebody looked`.",
    autoFixable: true,
  });
}

export default { id: ID, tier: TIER, cost: /** @type {const} */ ("S"), run };
```

- [ ] **Step 4: Run the tests, full suite, typecheck**

Run: `npx vitest run test/checks/github-contribution-scaffold.test.js && npm test && npm run typecheck`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add lib/checks/github-contribution-scaffold.js test/checks/github-contribution-scaffold.test.js
git commit -m "feat(checks): issue template, PR template and CODEOWNERS

A composite, because half of it is worse than neither: CODEOWNERS without a
review requirement is decoration, and templates without owners route a
well-formed report to nobody. Each accepted location is checked, so a repo
that already put CODEOWNERS at the root is not told to add one."
```

---

## Task 6: Register the checks, and make it installable

**Files:**
- Modify: `bin/audit.mjs` (register five checks)
- Modify: `package.json` (add the `ai-ready` bin alias)
- Create: `.claude-plugin/plugin.json`
- Create: `.claude-plugin/marketplace.json`
- Create: `skills/audit/SKILL.md`
- Modify: `README.md` (installation)

**Interfaces:**
- Consumes: the five checks from Tasks 2–5, plus the four existing ones
- Produces: a plugin installable with `/plugin marketplace add john-guerra/ai-coding-readiness`, exposing `/ai-ready:audit`

- [ ] **Step 1: Register the checks in `bin/audit.mjs`**

Add the imports alongside the existing four and extend the `CHECKS` array:

```js
import guideExists from "../lib/checks/guide-exists.js";
import guideGuardrails from "../lib/checks/guide-guardrails.js";
import guideContextBudget from "../lib/checks/guide-context-budget.js";
import repoHygiene from "../lib/checks/repo-hygiene.js";
import contributionScaffold from "../lib/checks/github-contribution-scaffold.js";

const CHECKS = [
  guideExists,
  guideGuardrails,
  guideContextBudget,
  repoHygiene,
  contributionScaffold,
  noDiffCanFail,
  e2eSharded,
  flakeObservability,
  prPathContention,
];
```

- [ ] **Step 2: Add the `ai-ready` alias to `package.json`**

```json
"bin": {
  "ai-coding-readiness": "./bin/audit.mjs",
  "ai-ready": "./bin/audit.mjs"
}
```

- [ ] **Step 3: Create `.claude-plugin/plugin.json`**

```json
{
  "name": "ai-ready",
  "description": "Diagnose how ready a repository is for AI-assisted collaboration under concurrent contributors, and adapt it",
  "version": "0.1.0",
  "author": { "name": "John Alexis Guerra Gómez" },
  "homepage": "https://github.com/john-guerra/ai-coding-readiness",
  "repository": "https://github.com/john-guerra/ai-coding-readiness",
  "license": "MIT",
  "keywords": ["audit", "ci", "concurrency", "code-quality", "agents"]
}
```

- [ ] **Step 4: Create `.claude-plugin/marketplace.json`**

```json
{
  "name": "john-guerra",
  "owner": { "name": "John Alexis Guerra Gómez" },
  "plugins": [
    {
      "name": "ai-ready",
      "source": "./",
      "description": "Audit a repository's readiness for concurrent AI-assisted contribution"
    }
  ]
}
```

- [ ] **Step 5: Create `skills/audit/SKILL.md`**

```markdown
---
name: audit
description: Use when asked to audit a repository's AI-coding readiness, check whether a repo is ready for AI agents or concurrent contributors, or diagnose CI feedback-loop and merge-contention problems. Read-only — it never modifies the audited repository.
---

# Auditing a repository's AI-coding readiness

## What this does

Runs a deterministic, read-only audit and reports what it found. It never
writes to the repository under audit.

## Run it

```bash
npx ai-ready --path <repo>          # markdown report
npx ai-ready --path <repo> --json   # machine-readable
```

From a clone of this plugin, `node bin/audit.mjs --path <repo>` is equivalent.

Exit codes: `0` no failures · `1` at least one failure · `2` usage error.

## Reading the result

Three statuses, and the third is the one that matters:

- **`fail`** — a real finding, with a remediation attached.
- **`pass`** — verified, not assumed.
- **`unknown`** — the check could not determine an answer. **Never report an
  `unknown` as a pass.** It means a file was absent, a credential was missing,
  or the sample was too small to support a claim. Say which.

## What to do with it

1. Report the failures with their evidence, in the order the tool emits them —
   cheapest checks resolve first, so the top of the report is the fastest thing
   to act on.
2. **Quote a finding's `precondition` before proposing its fix.** Several
   remediations are unsafe to apply blindly: raising a test-runner's worker
   count on a suite with shared state buys flake rather than speed, and
   generating a lockfile resolves the dependency graph as it is today.
3. When a finding says it has no automatic fix, say so plainly rather than
   inventing one.
4. Do not apply fixes as a side effect of an audit. Adapting a repository is a
   separate, explicit step.

## What it does not do

It has nothing to say about a repository with no CI, no test suite and no merge
history — several checks will honestly report `unknown`. That is the correct
answer, not a gap to work around.
```

- [ ] **Step 6: Update `README.md` installation section**

Replace the "Status" note with:

```markdown
## Install

As a Claude Code plugin:

```
/plugin marketplace add john-guerra/ai-coding-readiness
/plugin install ai-ready@john-guerra
```

Then `/ai-ready:audit`, or run the CLI directly from a clone:

```bash
node bin/audit.mjs --path <repo>
```
```

- [ ] **Step 7: Verify end to end**

```bash
npm test && npm run typecheck && npm run format:check
node bin/audit.mjs --path .
node bin/audit.mjs --path /Users/aguerra/workspace/autogallery
```

Expected:

| Target | Expectation |
| --- | --- |
| This repo | The four concurrency/CI checks unchanged; the five new ones report real verdicts. **`guide.context-budget` must `pass`** — `CLAUDE.md` + `AGENTS.md` are ~120 lines together |
| autogallery | Still 4 `fail` from the original checks, **plus `guide.context-budget` `fail` at ~1,595 lines** |

**If this repo now reports a `fail` it did not before, fix the repo, not the check** — it must pass its own audit. Both repositories other than this one are read-only.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(plugin): install as ai-ready, with the five universal checks wired in

The audit reported four unknowns and nothing else on a fresh project,
because every check built so far measures how a repo behaves under
concurrent contributors — which a young repo has not started doing. The
Tier-0 checks work on any repository that exists.

Plugin name is \`ai-ready\` so the skill invokes as \`/ai-ready:audit\`, as
the spec specifies; the repository and npm package keep the longer,
searchable name, with \`ai-ready\` as a bin alias."
```

---

## Self-Review

**1. Spec coverage.** This plan implements five of the twelve unbuilt checks from §5 — `guide.exists` (narrowed, see decision 1), `guide.guardrails`, `guide.context-budget`, `repo.hygiene` (narrowed, see decision 2), `github.contribution-scaffold` — plus the distribution surface §13 lists under "v0.1 ships".

Deliberately **not** covered, needing their own plans: `ci.gate-completeness`, `quality.static-analysis`, `security.workflow-hygiene`, `concurrency.parallel-suite`, `concurrency.claim-composite`, `test.assertion-free`, `docs.unenforced-invariants` (judgment layer); the whole adapt half (marked regions, manifest, interview, one-PR delivery); the `working-issues` and `enforce-a-rule` skills; the validation loop.

**2. Placeholder scan.** No TBDs. Every code step carries complete, runnable code; every verification step names an exact command and expected result.

**3. Type consistency.** All five checks export `{id, tier, cost, run}`, matching the `Check` typedef in `lib/registry.js` as amended in the previous plan. Every `makeFinding` call site supplies all ten required fields by spreading a `base` and adding `status`, `evidence`, `fix`, `autoFixable`, and — where `base` omits it — `precondition`. `lib/guide.js` exports `GUIDE_PATHS`, `readGuide`, `resolveImports`, `alwaysLoadedRules`, `countLines`; Tasks 2–3 import only those names.

One duplication is deliberate: `countLines` also exists in `concurrency-pr-path-contention.js`. Consolidating it is a reasonable follow-up once a third consumer appears — two copies is not yet a seam, by the threshold this project already applies.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-15-milestone-1-universal-checks.md`.
