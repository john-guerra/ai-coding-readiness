# Audit Detection Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `bin/audit.mjs` — a deterministic, read-only auditor that reports four measurable findings about how a repository behaves under concurrent contributors, and prove it on `john-guerra/autogallery` where every finding has known ground truth.

**Architecture:** A check registry of pure functions. Each check receives a `Repo` accessor (an interface over the filesystem and git, injectable so tests need no real repositories) and returns exactly one `Finding`. The runner sorts checks cheapest-first and emits findings incrementally as they resolve. No model, no network, no writes.

**Tech Stack:** Node 20+ ESM, plain JavaScript with JSDoc types, `tsc --checkJs --noEmit` for typechecking, vitest for tests, `yaml` for workflow parsing. No other runtime dependencies.

**Spec:** `docs/specs/2026-08-15-ai-coding-readiness-design.md` (revision 4)

## Global Constraints

Copied verbatim from the spec. Every task's requirements implicitly include these.

- **Every check ships with its remediation, or it doesn't ship.** A `fail` finding without a `fix` is a bug, and Task 1 enforces this at runtime.
- **`status` has three values: `pass | fail | unknown`.** When a check cannot determine the answer — file missing, unparseable, credentials absent — the answer is `unknown`, never `pass`.
- **Every `fix` carries a `precondition` where one exists.** Where none exists, the field is explicitly `null`, never omitted.
- **Any check whose fix is not verifiable by re-running the audit does not ship.**
- **A check may report a finding it cannot auto-fix, provided it says so.** It may never prescribe a fix that does not apply.
- **`layer: 'deterministic' | 'judgment'`.** `bin/audit.mjs` runs **only** `deterministic` checks. This plan builds no judgment checks.
- **Findings-first and bounded.** The runner emits each finding as it resolves, cheapest checks first. No long silent exploration phase — five open-ended reviews were abandoned mid-exploration in the reference repo's usage data.
- **Read-only.** This layer never writes to the audited repository.
- **No telemetry.** Nothing leaves the machine.
- **v0.1 targets single-package Node repositories on GitHub.** Monorepos are out of scope for this plan.
- **The plugin's own repo must pass its own audit.**

---

## File Structure

| File | Responsibility |
| --- | --- |
| `package.json` | ESM project, scripts, pinned deps, `bin` entry |
| `lib/finding.js` | The `Finding` shape and its runtime invariants. Single source of truth for what a check may return |
| `lib/repo.js` | `Repo` accessor: filesystem + git reads. One `createFsRepo()` for real use, one `createFakeRepo()` for tests |
| `lib/registry.js` | Check registration and the cheapest-first runner |
| `lib/checks/ci-no-diff-can-fail-on-gate.js` | One check |
| `lib/checks/ci-e2e-sharded.js` | One check |
| `lib/checks/ci-flake-observability.js` | One check |
| `lib/checks/concurrency-pr-path-contention.js` | One check |
| `lib/report.js` | Renders findings as markdown and as JSON |
| `bin/audit.mjs` | CLI: arg parsing, wiring, exit codes |
| `test/*.test.js` | vitest, colocated by module name |

**Why `Repo` is injectable.** Three of the four checks depend on git history or on files that would otherwise require committing fixture repositories inside this repository. A fake accessor keeps fixtures as plain JavaScript objects, makes tests fast and hermetic, and means a check is never coupled to a real checkout. `createFsRepo()` is the only code that touches the disk.

---

## Task 1: Project scaffold and the Finding contract

**Files:**
- Create: `package.json`
- Create: `lib/finding.js`
- Test: `test/finding.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `makeFinding(spec) -> Finding`, throwing `TypeError` on invariant violation. `Finding` fields: `id: string`, `tier: 0|1|2`, `layer: 'deterministic'|'judgment'`, `status: 'pass'|'fail'|'unknown'`, `effort: 'S'|'M'|'L'`, `evidence: string`, `why: string`, `precondition: string|null`, `fix: string|null`, `autoFixable: boolean`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "ai-coding-readiness",
  "version": "0.0.1",
  "description": "Diagnose and adapt a GitHub repo for AI-assisted collaboration under concurrent contributors",
  "license": "MIT",
  "type": "module",
  "engines": { "node": ">=20" },
  "bin": { "ai-coding-readiness": "./bin/audit.mjs" },
  "files": ["bin", "lib"],
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --checkJs --noEmit --allowJs --target es2022 --module nodenext --moduleResolution nodenext lib/*.js lib/checks/*.js bin/*.mjs",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  },
  "dependencies": { "yaml": "2.8.1" },
  "devDependencies": {
    "prettier": "3.6.2",
    "typescript": "5.9.3",
    "vitest": "3.2.4"
  }
}
```

- [ ] **Step 2: Install and commit the lockfile**

```bash
cd /Users/aguerra/workspace/ai-coding-readiness
npm install
```

The lockfile is a Tier 0 requirement of the tool itself. Commit it in Step 8.

- [ ] **Step 3: Write the failing test**

Create `test/finding.test.js`:

```js
import { describe, it, expect } from "vitest";
import { makeFinding } from "../lib/finding.js";

const base = {
  id: "ci.example",
  tier: 1,
  layer: "deterministic",
  status: "pass",
  effort: "S",
  evidence: "nothing to report",
  why: "because",
  precondition: null,
  fix: null,
  autoFixable: false,
};

describe("makeFinding", () => {
  it("returns a frozen finding when the shape is valid", () => {
    const f = makeFinding(base);
    expect(f.id).toBe("ci.example");
    expect(Object.isFrozen(f)).toBe(true);
  });

  // The spec's binding rule, enforced at runtime rather than by review.
  it("rejects a failing finding that carries no fix", () => {
    expect(() => makeFinding({ ...base, status: "fail", fix: null })).toThrow(
      /every check ships with its remediation/i
    );
  });

  it("allows a failing finding with a fix", () => {
    const f = makeFinding({ ...base, status: "fail", fix: "do the thing" });
    expect(f.status).toBe("fail");
  });

  // `precondition` must be explicitly null, never absent, so a missing
  // precondition is a deliberate statement rather than an oversight.
  it("rejects a finding that omits precondition entirely", () => {
    const { precondition, ...withoutPrecondition } = base;
    expect(() => makeFinding(withoutPrecondition)).toThrow(/precondition/i);
  });

  it("rejects an unknown status value", () => {
    expect(() => makeFinding({ ...base, status: "maybe" })).toThrow(/status/i);
  });

  it("rejects a judgment-layer finding, which the binary must never emit", () => {
    expect(() => makeFinding({ ...base, layer: "judgment" })).toThrow(
      /judgment/i
    );
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run test/finding.test.js`
Expected: FAIL — `Failed to resolve import "../lib/finding.js"`

- [ ] **Step 5: Write the implementation**

Create `lib/finding.js`:

```js
/**
 * The single shape every check returns, and the invariants the spec requires.
 *
 * These are enforced at runtime rather than by code review because the `fix`
 * field is the tool's liability surface: a `fail` with no remediation is the
 * failure mode the spec's binding rule exists to prevent.
 *
 * @typedef {Object} Finding
 * @property {string} id                              Dotted check id, e.g. "ci.e2e-sharded"
 * @property {0|1|2} tier                             Report vocabulary only; not an install branch
 * @property {'deterministic'|'judgment'} layer       The binary emits deterministic only
 * @property {'pass'|'fail'|'unknown'} status         `unknown` when the check could not determine
 * @property {'S'|'M'|'L'} effort                     Effort to apply the fix
 * @property {string} evidence                        What was observed, concretely
 * @property {string} why                             Why it matters, in one sentence
 * @property {string|null} precondition               Explicitly null when none applies
 * @property {string|null} fix                        Required when status is "fail"
 * @property {boolean} autoFixable                    False when the fix needs a human
 */

const STATUSES = new Set(["pass", "fail", "unknown"]);
const EFFORTS = new Set(["S", "M", "L"]);
const TIERS = new Set([0, 1, 2]);

/**
 * Validate and freeze a finding.
 * @param {Partial<Finding>} spec
 * @returns {Finding}
 */
export function makeFinding(spec) {
  const required = [
    "id",
    "tier",
    "layer",
    "status",
    "effort",
    "evidence",
    "why",
    "precondition",
    "fix",
    "autoFixable",
  ];
  for (const key of required) {
    if (!(key in spec)) {
      throw new TypeError(
        `makeFinding: missing required field "${key}". ` +
          `Fields are never optional — "precondition" and "fix" must be an ` +
          `explicit null so their absence is a deliberate statement.`
      );
    }
  }

  if (!TIERS.has(/** @type {any} */ (spec.tier))) {
    throw new TypeError(`makeFinding: tier must be 0, 1 or 2 (got ${spec.tier})`);
  }
  if (!STATUSES.has(/** @type {any} */ (spec.status))) {
    throw new TypeError(
      `makeFinding: status must be pass|fail|unknown (got ${spec.status})`
    );
  }
  if (!EFFORTS.has(/** @type {any} */ (spec.effort))) {
    throw new TypeError(`makeFinding: effort must be S|M|L (got ${spec.effort})`);
  }
  if (spec.layer !== "deterministic") {
    throw new TypeError(
      `makeFinding: layer must be "deterministic" — the audit binary must ` +
        `never emit a judgment finding, because reproducibility is the whole ` +
        `rationale for the two-layer split.`
    );
  }
  if (spec.status === "fail" && !spec.fix) {
    throw new TypeError(
      `makeFinding: check "${spec.id}" failed without a fix. ` +
        `Every check ships with its remediation, or it doesn't ship.`
    );
  }

  return Object.freeze(/** @type {Finding} */ ({ ...spec }));
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/finding.test.js`
Expected: PASS, 6 tests

- [ ] **Step 7: Run the typechecker**

Run: `npm run typecheck`
Expected: exit 0, no output. If `tsc` reports errors in `node_modules`, add `--skipLibCheck` to the script.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json lib/finding.js test/finding.test.js
git commit -m "feat(finding): the Finding contract, with the binding rule enforced at runtime

A failing finding with no fix now throws rather than being caught in review.
\"Every check ships with its remediation\" is the spec's binding rule; making
it a runtime invariant is cheaper than remembering it."
```

---

## Task 2: The Repo accessor

**Files:**
- Create: `lib/repo.js`
- Test: `test/repo.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `createFakeRepo({ files?, mergedPrFileLists? }) -> Repo`
  - `createFsRepo(root) -> Repo`
  - `Repo` = `{ root: string, readFile(path): Promise<string|null>, listFiles(dir): Promise<string[]>, mergedPrFileLists(n): Promise<string[][]> }`
  - `readFile` returns `null` for a missing file — it never throws, because "the file isn't there" is a finding, not an error.
  - `listFiles(dir)` returns repo-relative paths, non-recursive, `[]` when the directory is absent.
  - `mergedPrFileLists(n)` returns one array of changed paths per merge commit, newest first, `[]` when there is no git history.

- [ ] **Step 1: Write the failing test**

Create `test/repo.test.js`:

```js
import { describe, it, expect } from "vitest";
import { createFakeRepo } from "../lib/repo.js";

describe("createFakeRepo", () => {
  it("reads a file that exists", async () => {
    const repo = createFakeRepo({ files: { "a.txt": "hello" } });
    expect(await repo.readFile("a.txt")).toBe("hello");
  });

  // Absence is a finding, not an exception. Every check relies on this.
  it("returns null for a missing file rather than throwing", async () => {
    const repo = createFakeRepo({ files: {} });
    expect(await repo.readFile("nope.txt")).toBeNull();
  });

  it("lists files in a directory, non-recursively", async () => {
    const repo = createFakeRepo({
      files: {
        ".github/workflows/ci.yml": "",
        ".github/workflows/release.yml": "",
        ".github/dependabot.yml": "",
      },
    });
    const found = await repo.listFiles(".github/workflows");
    expect(found.sort()).toEqual([
      ".github/workflows/ci.yml",
      ".github/workflows/release.yml",
    ]);
  });

  it("returns an empty list for a missing directory", async () => {
    const repo = createFakeRepo({ files: {} });
    expect(await repo.listFiles(".github/workflows")).toEqual([]);
  });

  it("returns merge file lists newest first", async () => {
    const repo = createFakeRepo({
      mergedPrFileLists: [["a.js"], ["b.js", "CHANGELOG.md"]],
    });
    expect(await repo.mergedPrFileLists(10)).toEqual([
      ["a.js"],
      ["b.js", "CHANGELOG.md"],
    ]);
  });

  it("truncates merge file lists to the requested count", async () => {
    const repo = createFakeRepo({
      mergedPrFileLists: [["a"], ["b"], ["c"]],
    });
    expect(await repo.mergedPrFileLists(2)).toEqual([["a"], ["b"]]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/repo.test.js`
Expected: FAIL — `Failed to resolve import "../lib/repo.js"`

- [ ] **Step 3: Write the implementation**

Create `lib/repo.js`:

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/repo.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add lib/repo.js test/repo.test.js
git commit -m "feat(repo): injectable read-only repo accessor

Filesystem and git access behind one interface so checks stay pure and
tests need no fixture repositories. Missing files return null rather than
throwing: absence is a finding, not an error."
```

---

## Task 3: Check registry and the incremental runner

**Files:**
- Create: `lib/registry.js`
- Test: `test/registry.test.js`

**Interfaces:**
- Consumes: `makeFinding` (Task 1), `Repo` (Task 2)
- Produces:
  - `Check` = `{ id: string, cost: 'S'|'M'|'L', run(repo: Repo): Promise<Finding> }`
  - `runChecks(checks: Check[], repo: Repo, onFinding?: (f: Finding) => void): Promise<Finding[]>`
  - Runs cheapest-first (`S` before `M` before `L`), calls `onFinding` as each resolves, and converts a thrown check into an `unknown` finding rather than aborting the run.

- [ ] **Step 1: Write the failing test**

Create `test/registry.test.js`:

```js
import { describe, it, expect, vi } from "vitest";
import { runChecks } from "../lib/registry.js";
import { makeFinding } from "../lib/finding.js";
import { createFakeRepo } from "../lib/repo.js";

const finding = (id, status = "pass") =>
  makeFinding({
    id,
    tier: 1,
    layer: "deterministic",
    status,
    effort: "S",
    evidence: "e",
    why: "w",
    precondition: null,
    fix: status === "fail" ? "f" : null,
    autoFixable: false,
  });

const check = (id, cost) => ({
  id,
  cost,
  run: async () => finding(id),
});

describe("runChecks", () => {
  it("runs cheapest checks first so findings appear early", async () => {
    const repo = createFakeRepo();
    const order = [];
    const spy = (f) => order.push(f.id);
    await runChecks(
      [check("slow", "L"), check("fast", "S"), check("mid", "M")],
      repo,
      spy
    );
    expect(order).toEqual(["fast", "mid", "slow"]);
  });

  it("emits each finding as it resolves rather than only at the end", async () => {
    const repo = createFakeRepo();
    const onFinding = vi.fn();
    const all = await runChecks([check("a", "S"), check("b", "S")], repo, onFinding);
    expect(onFinding).toHaveBeenCalledTimes(2);
    expect(all).toHaveLength(2);
  });

  // One broken check must not cost the user the other fifteen.
  it("converts a thrown check into an unknown finding and keeps going", async () => {
    const repo = createFakeRepo();
    const exploding = {
      id: "ci.boom",
      cost: "S",
      run: async () => {
        throw new Error("kaboom");
      },
    };
    const all = await runChecks([exploding, check("ok", "S")], repo);
    const boom = all.find((f) => f.id === "ci.boom");
    expect(boom.status).toBe("unknown");
    expect(boom.evidence).toMatch(/kaboom/);
    expect(all.find((f) => f.id === "ok").status).toBe("pass");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/registry.test.js`
Expected: FAIL — `Failed to resolve import "../lib/registry.js"`

- [ ] **Step 3: Write the implementation**

Create `lib/registry.js`:

```js
import { makeFinding } from "./finding.js";

/**
 * @typedef {import('./repo.js').Repo} Repo
 * @typedef {import('./finding.js').Finding} Finding
 *
 * @typedef {Object} Check
 * @property {string} id
 * @property {'S'|'M'|'L'} cost   Ordering hint: cheap checks report first
 * @property {(repo: Repo) => Promise<Finding>} run
 */

const COST_ORDER = { S: 0, M: 1, L: 2 };

/**
 * Run checks cheapest-first, emitting each finding as it resolves.
 *
 * Ordering is not cosmetic. Usage data on the reference repo showed five
 * open-ended reviews abandoned mid-exploration with zero output; an audit that
 * sweeps silently and reports at the end gets interrupted before it reports.
 *
 * @param {Check[]} checks
 * @param {Repo} repo
 * @param {(f: Finding) => void} [onFinding]
 * @returns {Promise<Finding[]>}
 */
export async function runChecks(checks, repo, onFinding) {
  const ordered = [...checks].sort(
    (a, b) => COST_ORDER[a.cost] - COST_ORDER[b.cost]
  );

  const findings = [];
  for (const check of ordered) {
    let finding;
    try {
      finding = await check.run(repo);
    } catch (err) {
      // A check that throws is a bug in the check, not a verdict about the
      // repo. Report `unknown` — never `pass` — and let the rest of the run
      // continue; one broken check must not cost the user the others.
      finding = makeFinding({
        id: check.id,
        tier: 1,
        layer: "deterministic",
        status: "unknown",
        effort: "S",
        evidence: `check threw: ${err instanceof Error ? err.message : String(err)}`,
        why: "A check that cannot run tells you nothing about the repository.",
        precondition: null,
        fix: null,
        autoFixable: false,
      });
    }
    findings.push(finding);
    onFinding?.(finding);
  }
  return findings;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/registry.test.js`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add lib/registry.js test/registry.test.js
git commit -m "feat(registry): cheapest-first runner that emits findings incrementally

Ordering is a UX requirement, not a nicety: usage data showed five
open-ended reviews abandoned before producing any output. A thrown check
becomes an `unknown` finding so one bug doesn't cost the user the rest."
```

---

## Task 4: Check `ci.no-diff-can-fail-on-gate`

This is the demonstration check. On the reference repo it fires on `npm audit`, the failing step in 9 of 13 inspected CI failures — a problem whose *symptom* was already filed as issue #338 and fixed at the instance level (a scoped `overrides` entry) while the gate itself stayed on the merge path.

**Files:**
- Create: `lib/checks/ci-no-diff-can-fail-on-gate.js`
- Test: `test/checks/ci-no-diff-can-fail-on-gate.test.js`

**Interfaces:**
- Consumes: `makeFinding` (Task 1), `Repo` (Task 2), `Check` shape (Task 3)
- Produces: default export `check` conforming to `Check`, with `id: 'ci.no-diff-can-fail-on-gate'`, `cost: 'S'`
- Also exports `VOLATILE_STEP_PATTERNS` (array of `{pattern: RegExp, label: string}`) so later tasks and tests can reference the same list

- [ ] **Step 1: Write the failing test**

Create `test/checks/ci-no-diff-can-fail-on-gate.test.js`:

```js
import { describe, it, expect } from "vitest";
import check from "../../lib/checks/ci-no-diff-can-fail-on-gate.js";
import { createFakeRepo } from "../../lib/repo.js";

const wf = (body) => ({ ".github/workflows/ci.yml": body });

describe("ci.no-diff-can-fail-on-gate", () => {
  it("is unknown when there are no workflows at all", async () => {
    const f = await check.run(createFakeRepo({ files: {} }));
    expect(f.status).toBe("unknown");
    expect(f.evidence).toMatch(/no workflow/i);
  });

  it("fails when `npm audit` runs on a pull_request-triggered job", async () => {
    const repo = createFakeRepo({
      files: wf(`
on:
  pull_request:
    branches: [main]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci
      - run: npm audit --omit=dev --audit-level=high
      - run: npm test
`),
    });
    const f = await check.run(repo);
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/npm audit/);
    expect(f.evidence).toMatch(/ci\.yml/);
    expect(f.fix).toBeTruthy();
    // The remediation must warn against the per-run filing pattern, since the
    // reference repo's measured complaint is issue volume.
    expect(f.fix).toMatch(/search by title|update one issue/i);
  });

  it("passes when the same step runs only on a schedule", async () => {
    const repo = createFakeRepo({
      files: wf(`
on:
  schedule:
    - cron: "0 3 * * *"
jobs:
  nightly:
    runs-on: ubuntu-latest
    steps:
      - run: npm audit --audit-level=high
`),
    });
    const f = await check.run(repo);
    expect(f.status).toBe("pass");
  });

  it("detects the shorthand `on: pull_request` form", async () => {
    const repo = createFakeRepo({
      files: wf(`
on: pull_request
jobs:
  check:
    steps:
      - run: npx snyk test
`),
    });
    const f = await check.run(repo);
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/snyk/);
  });

  it("detects the array form `on: [push, pull_request]`", async () => {
    const repo = createFakeRepo({
      files: wf(`
on: [push, pull_request]
jobs:
  check:
    steps:
      - run: pnpm audit
`),
    });
    expect((await check.run(repo)).status).toBe("fail");
  });

  it("passes a gate whose steps can only fail because of the diff", async () => {
    const repo = createFakeRepo({
      files: wf(`
on: pull_request
jobs:
  check:
    steps:
      - run: npm ci
      - run: npm test
      - run: npm run build
`),
    });
    expect((await check.run(repo)).status).toBe("pass");
  });

  it("is unknown when a workflow cannot be parsed", async () => {
    const repo = createFakeRepo({ files: wf("this: is: not: valid: yaml:\n  - [") });
    const f = await check.run(repo);
    expect(f.status).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/checks/ci-no-diff-can-fail-on-gate.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `lib/checks/ci-no-diff-can-fail-on-gate.js`:

```js
import { parse } from "yaml";
import { makeFinding } from "../finding.js";

/**
 * Steps that can go red without anybody changing a line of code: a new
 * advisory published overnight, an expired licence, an external service.
 *
 * The list is deliberately an allowlist of known-volatile commands rather than
 * a heuristic. A false positive here tells someone to move a gate that was
 * fine, which is worse than missing one.
 */
export const VOLATILE_STEP_PATTERNS = [
  { pattern: /\b(npm|pnpm|yarn|bun)\s+audit\b/, label: "dependency advisory scan" },
  { pattern: /\bsnyk\s+(test|monitor)\b/, label: "Snyk scan" },
  { pattern: /\blicense-checker\b/, label: "licence scan" },
  { pattern: /\bosv-scanner\b/, label: "OSV scan" },
  { pattern: /\bsafety\s+check\b/, label: "Python advisory scan" },
  { pattern: /\bpip-audit\b/, label: "Python advisory scan" },
  { pattern: /\bcargo\s+audit\b/, label: "Rust advisory scan" },
];

const ID = "ci.no-diff-can-fail-on-gate";

/**
 * Does `on:` include pull_request in any of its three spellings?
 * `on: pull_request` | `on: [push, pull_request]` | `on: {pull_request: {...}}`
 * @param {unknown} on
 */
function gatesPullRequests(on) {
  if (typeof on === "string") return on === "pull_request";
  if (Array.isArray(on)) return on.includes("pull_request");
  if (on && typeof on === "object") return "pull_request" in on;
  return false;
}

/**
 * @param {import('../repo.js').Repo} repo
 * @returns {Promise<import('../finding.js').Finding>}
 */
async function run(repo) {
  const paths = await repo.listFiles(".github/workflows");
  const yamls = paths.filter((p) => /\.ya?ml$/.test(p));

  const base = {
    id: ID,
    tier: 1,
    layer: /** @type {const} */ ("deterministic"),
    effort: /** @type {const} */ ("M"),
    why:
      "A gate that can go red without a code change blocks every contributor " +
      "at once, for a reason none of their diffs caused.",
    precondition: null,
    autoFixable: true,
  };

  if (yamls.length === 0) {
    return makeFinding({
      ...base,
      status: "unknown",
      evidence: "No workflow files found under .github/workflows.",
      fix: null,
      autoFixable: false,
    });
  }

  const hits = [];
  let unparseable = 0;

  for (const path of yamls) {
    const text = await repo.readFile(path);
    if (text === null) continue;

    let doc;
    try {
      doc = parse(text);
    } catch {
      unparseable += 1;
      continue;
    }
    if (!doc || typeof doc !== "object") continue;

    // YAML 1.1 reads a bare `on` key as the boolean true. `yaml` parses as
    // 1.2 where it stays a string, but a workflow written for either spelling
    // should be handled, so check both.
    const on = "on" in doc ? doc.on : doc[true];
    if (!gatesPullRequests(on)) continue;

    for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
      for (const step of job?.steps ?? []) {
        const cmd = typeof step?.run === "string" ? step.run : "";
        if (!cmd) continue;
        for (const { pattern, label } of VOLATILE_STEP_PATTERNS) {
          if (pattern.test(cmd)) {
            hits.push({ path, jobName, label, cmd: cmd.trim().split("\n")[0] });
          }
        }
      }
    }
  }

  if (hits.length > 0) {
    const lines = hits.map(
      (h) => `${h.path} job "${h.jobName}": ${h.label} — \`${h.cmd}\``
    );
    return makeFinding({
      ...base,
      status: "fail",
      evidence: `${hits.length} step(s) on a pull-request gate can fail with no diff:\n  ${lines.join("\n  ")}`,
      fix:
        "Move these steps to a scheduled workflow. On failure the scheduled " +
        "job must search by title and update ONE issue rather than filing per " +
        "run — a nightly job that files daily is a bot-authored backlog.",
    });
  }

  if (unparseable > 0 && yamls.length === unparseable) {
    return makeFinding({
      ...base,
      status: "unknown",
      evidence: `All ${unparseable} workflow file(s) failed to parse as YAML.`,
      fix: null,
      autoFixable: false,
    });
  }

  return makeFinding({
    ...base,
    status: "pass",
    evidence: `No volatile steps found on pull-request gates across ${yamls.length} workflow file(s).`,
    fix: null,
    autoFixable: false,
  });
}

export default { id: ID, cost: /** @type {const} */ ("S"), run };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/checks/ci-no-diff-can-fail-on-gate.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Verify against ground truth**

```bash
node -e "
import('./lib/repo.js').then(async ({createFsRepo}) => {
  const check = (await import('./lib/checks/ci-no-diff-can-fail-on-gate.js')).default;
  const f = await check.run(createFsRepo('/Users/aguerra/workspace/autogallery'));
  console.log(f.status); console.log(f.evidence);
});
"
```

Expected: `fail`, and the evidence names `.github/workflows/ci.yml`, job `check`, and `npm audit --omit=dev --audit-level=high`. If it reports `pass`, the `on:` parsing is wrong — that workflow triggers on both `push` and `pull_request` in object form.

- [ ] **Step 6: Commit**

```bash
git add lib/checks/ci-no-diff-can-fail-on-gate.js test/checks/ci-no-diff-can-fail-on-gate.test.js
git commit -m "feat(checks): detect merge gates that can fail with no diff

Fires on the reference repo's \`npm audit\` step — the failing step in 9 of
13 inspected CI failures, whose symptom was filed as #338 and fixed at the
instance level while the gate stayed on the merge path.

Volatile commands are an allowlist rather than a heuristic: a false
positive tells someone to move a gate that was fine."
```

---

## Task 5: Checks `ci.e2e-sharded` and `ci.flake-observability`

These ship together because both read the browser tier's configuration, and because the second exists only as a consequence of the first spec revision's retracted flake measurement — the reference repo's Playwright config has no `retries` key, so Playwright can never classify a test as `flaky`, so a zero-flake reading was the only possible result.

**Files:**
- Create: `lib/checks/ci-e2e-sharded.js`
- Create: `lib/checks/ci-flake-observability.js`
- Test: `test/checks/browser-tier.test.js`

**Interfaces:**
- Consumes: `makeFinding` (Task 1), `Repo` (Task 2), `gatesPullRequests` logic (re-implemented locally — do **not** import it from Task 4, which does not export it)
- Produces: two default-exported `Check` objects, `id: 'ci.e2e-sharded'` (`cost: 'S'`) and `id: 'ci.flake-observability'` (`cost: 'S'`)

- [ ] **Step 1: Write the failing test**

Create `test/checks/browser-tier.test.js`:

```js
import { describe, it, expect } from "vitest";
import sharded from "../../lib/checks/ci-e2e-sharded.js";
import flake from "../../lib/checks/ci-flake-observability.js";
import { createFakeRepo } from "../../lib/repo.js";

const PW_CONFIG = "playwright.config.js";

describe("ci.e2e-sharded", () => {
  it("is unknown when no browser tier is configured", async () => {
    const f = await sharded.run(createFakeRepo({ files: {} }));
    expect(f.status).toBe("unknown");
  });

  it("fails when a pull-request job runs the browser tier unsharded", async () => {
    const repo = createFakeRepo({
      files: {
        [PW_CONFIG]: "export default { workers: 1 };",
        ".github/workflows/ci.yml": `
on: [pull_request]
jobs:
  e2e:
    steps:
      - run: npx playwright install --with-deps chromium
      - run: npm run test:e2e
`,
      },
    });
    const f = await sharded.run(repo);
    expect(f.status).toBe("fail");
    expect(f.fix).toMatch(/shard/i);
    // The precondition is the whole point: sharding splits by FILE, so wall
    // clock becomes max(file), not total/N.
    expect(f.precondition).toMatch(/dominat/i);
  });

  it("passes when the job shards", async () => {
    const repo = createFakeRepo({
      files: {
        [PW_CONFIG]: "export default {};",
        ".github/workflows/ci.yml": `
on: [pull_request]
jobs:
  e2e:
    strategy:
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      - run: npx playwright test --shard=\${{ matrix.shard }}/4
`,
      },
    });
    expect((await sharded.run(repo)).status).toBe("pass");
  });
});

describe("ci.flake-observability", () => {
  it("fails when the browser config declares no retries", async () => {
    const repo = createFakeRepo({
      files: { [PW_CONFIG]: "export default { workers: 1, testDir: './e2e' };" },
    });
    const f = await flake.run(repo);
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/retries/);
    expect(f.fix).toMatch(/retries/);
  });

  it("passes when retries are configured", async () => {
    const repo = createFakeRepo({
      files: { [PW_CONFIG]: "export default { retries: process.env.CI ? 1 : 0 };" },
    });
    expect((await flake.run(repo)).status).toBe("pass");
  });

  it("is unknown when there is no browser config to read", async () => {
    expect((await flake.run(createFakeRepo({ files: {} }))).status).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/checks/browser-tier.test.js`
Expected: FAIL — modules not found

- [ ] **Step 3: Write `lib/checks/ci-e2e-sharded.js`**

```js
import { parse } from "yaml";
import { makeFinding } from "../finding.js";

const ID = "ci.e2e-sharded";

const CONFIG_PATHS = [
  "playwright.config.js",
  "playwright.config.mjs",
  "playwright.config.ts",
  "cypress.config.js",
];

/** @param {unknown} on */
function gatesPullRequests(on) {
  if (typeof on === "string") return on === "pull_request";
  if (Array.isArray(on)) return on.includes("pull_request");
  if (on && typeof on === "object") return "pull_request" in on;
  return false;
}

/**
 * @param {import('../repo.js').Repo} repo
 * @returns {Promise<import('../finding.js').Finding>}
 */
async function run(repo) {
  const base = {
    id: ID,
    tier: 1,
    layer: /** @type {const} */ ("deterministic"),
    effort: /** @type {const} */ ("M"),
    why:
      "An unsharded browser tier on the merge gate sets the floor for how " +
      "fast anything can merge, and every concurrent contributor waits on it.",
    autoFixable: true,
  };

  let configPath = null;
  for (const p of CONFIG_PATHS) {
    if ((await repo.readFile(p)) !== null) {
      configPath = p;
      break;
    }
  }
  if (!configPath) {
    return makeFinding({
      ...base,
      status: "unknown",
      evidence: `No browser-tier config found (looked for ${CONFIG_PATHS.join(", ")}).`,
      precondition: null,
      fix: null,
      autoFixable: false,
    });
  }

  const paths = (await repo.listFiles(".github/workflows")).filter((p) =>
    /\.ya?ml$/.test(p)
  );

  let sawPrJobRunningBrowserTier = false;
  let sawSharding = false;

  for (const path of paths) {
    const text = await repo.readFile(path);
    if (text === null) continue;
    let doc;
    try {
      doc = parse(text);
    } catch {
      continue;
    }
    if (!doc || typeof doc !== "object") continue;

    const on = "on" in doc ? doc.on : doc[true];
    if (!gatesPullRequests(on)) continue;

    for (const job of Object.values(doc.jobs ?? {})) {
      const steps = job?.steps ?? [];
      const commands = steps
        .map((s) => (typeof s?.run === "string" ? s.run : ""))
        .join("\n");
      if (!/playwright|cypress|test:e2e/.test(commands)) continue;

      sawPrJobRunningBrowserTier = true;
      const matrixKeys = Object.keys(job?.strategy?.matrix ?? {});
      if (/--shard/.test(commands) || matrixKeys.some((k) => /shard/i.test(k))) {
        sawSharding = true;
      }
    }
  }

  if (!sawPrJobRunningBrowserTier) {
    return makeFinding({
      ...base,
      status: "unknown",
      evidence: `Found ${configPath} but no pull-request job that runs the browser tier.`,
      precondition: null,
      fix: null,
      autoFixable: false,
    });
  }

  if (sawSharding) {
    return makeFinding({
      ...base,
      status: "pass",
      evidence: "The browser tier is sharded across runners on the pull-request gate.",
      precondition: null,
      fix: null,
      autoFixable: false,
    });
  }

  return makeFinding({
    ...base,
    status: "fail",
    evidence: `${configPath} exists and a pull-request job runs the browser tier, but no --shard or shard matrix was found.`,
    precondition:
      "No single spec file dominates total duration. Sharding splits by FILE, " +
      "so wall clock becomes max(file), not total/N — measure per-file " +
      "duration first and split any dominant file. Specs needing bespoke " +
      "fixtures must have that setup in whichever shard draws them.",
    fix:
      "Add a shard matrix to the browser job and pass --shard=N/M. Each shard " +
      "gets its own runner, therefore its own server and temp dir, so " +
      "hermeticity holds with no test rewrites. Do NOT raise the worker count " +
      "instead: on a suite with shared state that buys flake, not speed.",
  });
}

export default { id: ID, cost: /** @type {const} */ ("S"), run };
```

- [ ] **Step 4: Write `lib/checks/ci-flake-observability.js`**

```js
import { makeFinding } from "../finding.js";

const ID = "ci.flake-observability";

const CONFIG_PATHS = [
  "playwright.config.js",
  "playwright.config.mjs",
  "playwright.config.ts",
];

/**
 * @param {import('../repo.js').Repo} repo
 * @returns {Promise<import('../finding.js').Finding>}
 */
async function run(repo) {
  const base = {
    id: ID,
    tier: 1,
    layer: /** @type {const} */ ("deterministic"),
    effort: /** @type {const} */ ("S"),
    why:
      "With retries unset, Playwright never classifies a test as flaky — a " +
      "flaky test simply fails. Any measurement of flake rate then returns " +
      "zero whether the true rate is 0% or 30%.",
    precondition: null,
    autoFixable: true,
  };

  let configPath = null;
  let text = null;
  for (const p of CONFIG_PATHS) {
    const t = await repo.readFile(p);
    if (t !== null) {
      configPath = p;
      text = t;
      break;
    }
  }

  if (!configPath || text === null) {
    return makeFinding({
      ...base,
      status: "unknown",
      evidence: `No Playwright config found (looked for ${CONFIG_PATHS.join(", ")}).`,
      fix: null,
      autoFixable: false,
    });
  }

  // The config is executable JavaScript, so this is a textual check rather
  // than a parse. A commented-out `retries` would read as present; that is an
  // accepted limitation, stated here rather than hidden.
  if (/^\s*retries\s*:/m.test(text)) {
    return makeFinding({
      ...base,
      status: "pass",
      evidence: `${configPath} declares a retries value.`,
      fix: null,
      autoFixable: false,
    });
  }

  return makeFinding({
    ...base,
    status: "fail",
    evidence: `${configPath} declares no "retries" key, so retries default to 0 and no test is ever reported as flaky.`,
    fix:
      'Set `retries: process.env.CI ? 1 : 0` and surface the "flaky" count ' +
      "from the run summary. One line, no cost on a green run, and it turns " +
      "flake from an unmeasurable into a measurable.",
  });
}

export default { id: ID, cost: /** @type {const} */ ("S"), run };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/checks/browser-tier.test.js`
Expected: PASS, 6 tests

- [ ] **Step 6: Commit**

```bash
git add lib/checks/ci-e2e-sharded.js lib/checks/ci-flake-observability.js test/checks/browser-tier.test.js
git commit -m "feat(checks): browser-tier sharding and flake observability

ci.e2e-sharded carries the precondition that makes it safe: sharding splits
by file, so wall clock becomes max(file) and a dominant spec must be split
first. Its fix explicitly warns against raising the worker count instead,
which on a shared-state suite buys flake rather than speed.

ci.flake-observability exists because a first-pass flake measurement on the
reference repo returned zero from an instrument that could not have returned
anything else."
```

---

## Task 6: Check `concurrency.pr-path-contention`

The most novel check in the set. On the reference repo it profiles `package.json` at 87% of merged PRs and `CHANGELOG.md` at 77% — and, because it profiles rather than thresholds, it also surfaces `ui/src/App.svelte` (7,409 lines, 23%) and `server/api.js` (4,913 lines, 27%), which a 70% cut would have missed entirely.

**Files:**
- Create: `lib/checks/concurrency-pr-path-contention.js`
- Test: `test/checks/concurrency-pr-path-contention.test.js`

**Interfaces:**
- Consumes: `makeFinding` (Task 1), `Repo` (Task 2)
- Produces: default-exported `Check`, `id: 'concurrency.pr-path-contention'`, `cost: 'L'` (it shells out to git once per merge commit)
- Also exports `profile(fileLists, sizes)` returning `Array<{path, count, share, lines, kind}>` sorted by `share` descending, where `kind` is `'metadata' | 'source'`

- [ ] **Step 1: Write the failing test**

Create `test/checks/concurrency-pr-path-contention.test.js`:

```js
import { describe, it, expect } from "vitest";
import check, { profile } from "../../lib/checks/concurrency-pr-path-contention.js";
import { createFakeRepo } from "../../lib/repo.js";

describe("profile", () => {
  it("ranks by share of PRs touched, descending", () => {
    const rows = profile(
      [["a.js", "CHANGELOG.md"], ["b.js", "CHANGELOG.md"], ["CHANGELOG.md"]],
      {}
    );
    expect(rows[0].path).toBe("CHANGELOG.md");
    expect(rows[0].count).toBe(3);
    expect(rows[0].share).toBe(1);
  });

  it("classifies changelog and manifest files as metadata", () => {
    const rows = profile([["CHANGELOG.md", "package.json", "src/app.js"]], {});
    const kinds = Object.fromEntries(rows.map((r) => [r.path, r.kind]));
    expect(kinds["CHANGELOG.md"]).toBe("metadata");
    expect(kinds["package.json"]).toBe("metadata");
    expect(kinds["src/app.js"]).toBe("source");
  });

  it("carries line counts through when known", () => {
    const rows = profile([["src/app.js"]], { "src/app.js": 7409 });
    expect(rows[0].lines).toBe(7409);
  });
});

describe("concurrency.pr-path-contention", () => {
  it("is unknown when there is no merge history to profile", async () => {
    const f = await check.run(createFakeRepo({ mergedPrFileLists: [] }));
    expect(f.status).toBe("unknown");
  });

  it("fails on a contended metadata file and prescribes changesets", async () => {
    const lists = Array.from({ length: 10 }, (_, i) => [
      `src/f${i}.js`,
      "CHANGELOG.md",
    ]);
    const f = await check.run(createFakeRepo({ mergedPrFileLists: lists }));
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/CHANGELOG\.md/);
    expect(f.fix).toMatch(/changesets|towncrier/i);
    expect(f.autoFixable).toBe(true);
  });

  // Rule 5: report what you cannot fix, and say so.
  it("reports a contended god-file without claiming it can fix it", async () => {
    const big = "a\n".repeat(6000);
    const lists = Array.from({ length: 10 }, (_, i) => [
      `src/f${i}.js`,
      "src/App.svelte",
    ]);
    const f = await check.run(
      createFakeRepo({ files: { "src/App.svelte": big }, mergedPrFileLists: lists })
    );
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/App\.svelte/);
    expect(f.fix).toMatch(/no automatic fix/i);
    expect(f.autoFixable).toBe(false);
  });

  it("passes when no file is contended", async () => {
    const lists = Array.from({ length: 10 }, (_, i) => [`src/f${i}.js`]);
    expect((await check.run(createFakeRepo({ mergedPrFileLists: lists }))).status).toBe(
      "pass"
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/checks/concurrency-pr-path-contention.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `lib/checks/concurrency-pr-path-contention.js`:

```js
import { makeFinding } from "../finding.js";

const ID = "concurrency.pr-path-contention";

const SAMPLE = 50;
const CONTENDED_SHARE = 0.5; // half of merged PRs touch it
const BIG_FILE_LINES = 1500;

/**
 * Files whose contention is solved by removing the shared write, not by
 * refactoring: per-PR fragments make them conflict-free by construction.
 */
const METADATA = [
  /(^|\/)CHANGELOG(\.md)?$/i,
  /(^|\/)package\.json$/,
  /(^|\/)pyproject\.toml$/,
  /(^|\/)Cargo\.toml$/,
  /(^|\/)version(\.txt|\.json)?$/i,
];

/**
 * Rank files by the share of merged PRs that touch them.
 *
 * A ranked profile rather than a boolean over a threshold: on a real repo a
 * 70% cut finds only the files everyone already knows about, and misses the
 * 4,000-line module that 27% of PRs touch — which is the more dangerous one,
 * for concurrency and for quality both.
 *
 * @param {string[][]} fileLists  one entry per merged PR
 * @param {Record<string, number>} sizes  path -> line count, where known
 * @returns {Array<{path:string,count:number,share:number,lines:number|null,kind:'metadata'|'source'}>}
 */
export function profile(fileLists, sizes) {
  const counts = new Map();
  for (const list of fileLists) {
    for (const path of new Set(list)) {
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  const total = fileLists.length || 1;
  return [...counts.entries()]
    .map(([path, count]) => ({
      path,
      count,
      share: count / total,
      lines: sizes[path] ?? null,
      kind: METADATA.some((re) => re.test(path))
        ? /** @type {const} */ ("metadata")
        : /** @type {const} */ ("source"),
    }))
    .sort((a, b) => b.share - a.share || a.path.localeCompare(b.path));
}

/**
 * @param {import('../repo.js').Repo} repo
 * @returns {Promise<import('../finding.js').Finding>}
 */
async function run(repo) {
  const base = {
    id: ID,
    tier: 2,
    layer: /** @type {const} */ ("deterministic"),
    effort: /** @type {const} */ ("M"),
    why:
      "A file in most pull requests is where two concurrent contributors " +
      "collide. Metadata files can stop being shared; large source files are " +
      "the decay signal of a module nobody dares split.",
    precondition: null,
  };

  const lists = await repo.mergedPrFileLists(SAMPLE);
  if (lists.length === 0) {
    return makeFinding({
      ...base,
      status: "unknown",
      evidence:
        "No merge commits found. A squash-merge or rebase workflow leaves no " +
        "merge commits to profile.",
      fix: null,
      autoFixable: false,
    });
  }

  const candidates = profile(lists, {}).filter((r) => r.share >= CONTENDED_SHARE);

  // Only measure the size of files that are actually contended — reading every
  // file in the repo to answer a question about a handful is wasteful.
  const sizes = {};
  for (const row of candidates) {
    const text = await repo.readFile(row.path);
    if (text !== null) sizes[row.path] = text.split("\n").length;
  }
  const rows = profile(lists, sizes).filter((r) => r.share >= CONTENDED_SHARE);

  if (rows.length === 0) {
    return makeFinding({
      ...base,
      status: "pass",
      evidence: `No file appears in ${Math.round(CONTENDED_SHARE * 100)}% or more of the last ${lists.length} merged PRs.`,
      fix: null,
      autoFixable: false,
    });
  }

  const metadata = rows.filter((r) => r.kind === "metadata");
  const godFiles = rows.filter(
    (r) => r.kind === "source" && (r.lines ?? 0) >= BIG_FILE_LINES
  );

  const lines = rows.map((r) => {
    const pct = Math.round(r.share * 100);
    const size = r.lines ? `, ${r.lines} lines` : "";
    return `${r.path} — ${r.count}/${lists.length} PRs (${pct}%${size}) [${r.kind}]`;
  });

  const fixes = [];
  if (metadata.length > 0) {
    fixes.push(
      `Metadata (${metadata.map((r) => r.path).join(", ")}): adopt per-PR ` +
        `fragments — changesets for Node, towncrier for Python — so each PR ` +
        `writes a NEW file and CI assembles the version and changelog at ` +
        `release. Add .gitattributes as a backstop.`
    );
  }
  if (godFiles.length > 0) {
    fixes.push(
      `Large source files (${godFiles.map((r) => r.path).join(", ")}): ` +
        `there is no automatic fix. Set a size budget and extract ` +
        `framework-free logic into testable modules. Reported because it is ` +
        `real, not because it can be automated.`
    );
  }
  if (fixes.length === 0) {
    fixes.push(
      "Contended files are neither metadata nor large. Review whether the " +
        "shared write is necessary; there is no automatic fix."
    );
  }

  return makeFinding({
    ...base,
    status: "fail",
    evidence: `Contention profile over the last ${lists.length} merged PRs:\n  ${lines.join("\n  ")}`,
    fix: fixes.join("\n\n"),
    autoFixable: metadata.length > 0 && godFiles.length === 0,
  });
}

export default { id: ID, cost: /** @type {const} */ ("L"), run };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/checks/concurrency-pr-path-contention.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Verify against ground truth**

```bash
node -e "
import('./lib/repo.js').then(async ({createFsRepo}) => {
  const check = (await import('./lib/checks/concurrency-pr-path-contention.js')).default;
  const f = await check.run(createFsRepo('/Users/aguerra/workspace/autogallery'));
  console.log(f.status); console.log(f.evidence);
});
"
```

Expected: `fail`, with `package.json` around 87% and `CHANGELOG.md` around 77% over 50 merges, both classified `metadata`.

- [ ] **Step 6: Commit**

```bash
git add lib/checks/concurrency-pr-path-contention.js test/checks/concurrency-pr-path-contention.test.js
git commit -m "feat(checks): rank PR-path contention as a profile, not a threshold

A 70% cut finds only the files everyone already knows about. Ranking by
share surfaces the 4,900-line module that 27% of PRs touch, which is more
dangerous for both concurrency and quality.

The remediation splits by kind: metadata files get per-PR fragments;
large source files are reported with no automatic fix, per rule 5."
```

---

## Task 7: CLI, report renderer, and the live run

**Files:**
- Create: `lib/report.js`
- Create: `bin/audit.mjs`
- Test: `test/report.test.js`

**Interfaces:**
- Consumes: everything above
- Produces: `renderMarkdown(findings) -> string`, `renderJson(findings) -> string`, and an executable CLI: `ai-coding-readiness [--json] [--path <dir>]`
- Exit codes: `0` when no check failed, `1` when at least one failed, `2` on a usage error. `unknown` never fails the run — it is not a verdict.

- [ ] **Step 1: Write the failing test**

Create `test/report.test.js`:

```js
import { describe, it, expect } from "vitest";
import { renderMarkdown, renderJson } from "../lib/report.js";
import { makeFinding } from "../lib/finding.js";

const f = (id, status, extra = {}) =>
  makeFinding({
    id,
    tier: 1,
    layer: "deterministic",
    status,
    effort: "S",
    evidence: "ev",
    why: "why",
    precondition: null,
    fix: status === "fail" ? "do it" : null,
    autoFixable: false,
    ...extra,
  });

describe("renderMarkdown", () => {
  it("puts failures first, since they are the point", () => {
    const out = renderMarkdown([f("a.pass", "pass"), f("b.fail", "fail")]);
    expect(out.indexOf("b.fail")).toBeLessThan(out.indexOf("a.pass"));
  });

  it("renders the precondition when one exists", () => {
    const out = renderMarkdown([
      f("c.fail", "fail", { precondition: "measure first" }),
    ]);
    expect(out).toMatch(/measure first/);
  });

  it("distinguishes unknown from pass in the summary", () => {
    const out = renderMarkdown([f("a", "unknown"), f("b", "pass")]);
    expect(out).toMatch(/1 unknown/);
    expect(out).toMatch(/1 pass/);
  });

  it("says plainly when a finding has no automatic fix", () => {
    const out = renderMarkdown([f("d.fail", "fail", { autoFixable: false })]);
    expect(out).toMatch(/no automatic fix/i);
  });
});

describe("renderJson", () => {
  it("emits a parseable array of findings", () => {
    const parsed = JSON.parse(renderJson([f("a", "pass")]));
    expect(parsed.findings[0].id).toBe("a");
    expect(parsed.summary.pass).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/report.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write `lib/report.js`**

```js
/** @typedef {import('./finding.js').Finding} Finding */

const ORDER = { fail: 0, unknown: 1, pass: 2 };
const ICON = { fail: "✗", unknown: "?", pass: "✓" };

/** @param {Finding[]} findings */
function summarize(findings) {
  return {
    fail: findings.filter((f) => f.status === "fail").length,
    unknown: findings.filter((f) => f.status === "unknown").length,
    pass: findings.filter((f) => f.status === "pass").length,
  };
}

/**
 * @param {Finding[]} findings
 * @returns {string}
 */
export function renderMarkdown(findings) {
  const sorted = [...findings].sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || a.id.localeCompare(b.id)
  );
  const s = summarize(findings);

  const out = [
    "# AI-coding readiness",
    "",
    `${s.fail} fail · ${s.unknown} unknown · ${s.pass} pass`,
    "",
    "> `unknown` means the check could not determine an answer — never that " +
      "the repository passed.",
    "",
  ];

  for (const f of sorted) {
    out.push(`## ${ICON[f.status]} \`${f.id}\` — ${f.status} (T${f.tier})`);
    out.push("");
    out.push(f.evidence);
    out.push("");
    if (f.status === "fail") {
      out.push(`**Why it matters.** ${f.why}`);
      out.push("");
      if (f.precondition) {
        out.push(`**Before applying the fix.** ${f.precondition}`);
        out.push("");
      }
      out.push(`**Fix.** ${f.fix}`);
      out.push("");
      if (!f.autoFixable) {
        out.push("_This finding has no automatic fix; it needs a person._");
        out.push("");
      }
    }
  }
  return out.join("\n");
}

/**
 * @param {Finding[]} findings
 * @returns {string}
 */
export function renderJson(findings) {
  return JSON.stringify({ summary: summarize(findings), findings }, null, 2);
}
```

- [ ] **Step 4: Run the report tests**

Run: `npx vitest run test/report.test.js`
Expected: PASS, 5 tests

- [ ] **Step 5: Write `bin/audit.mjs`**

```js
#!/usr/bin/env node
import { resolve } from "node:path";
import { createFsRepo } from "../lib/repo.js";
import { runChecks } from "../lib/registry.js";
import { renderMarkdown, renderJson } from "../lib/report.js";

import noDiffCanFail from "../lib/checks/ci-no-diff-can-fail-on-gate.js";
import e2eSharded from "../lib/checks/ci-e2e-sharded.js";
import flakeObservability from "../lib/checks/ci-flake-observability.js";
import prPathContention from "../lib/checks/concurrency-pr-path-contention.js";

const CHECKS = [noDiffCanFail, e2eSharded, flakeObservability, prPathContention];

const USAGE = `ai-coding-readiness — read-only audit

Usage:
  ai-coding-readiness [--path <dir>] [--json]

  --path <dir>  Repository to audit (default: current directory)
  --json        Emit JSON instead of markdown

Exit codes: 0 no failures · 1 at least one failure · 2 usage error
This command never writes to the audited repository.
`;

function parseArgs(argv) {
  const opts = { path: process.cwd(), json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") opts.json = true;
    else if (argv[i] === "--path") {
      const next = argv[++i];
      if (!next) throw new Error("--path requires a directory");
      opts.path = resolve(next);
    } else if (argv[i] === "--help" || argv[i] === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return opts;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`${err.message}\n\n${USAGE}`);
  process.exit(2);
}

if (opts.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const repo = createFsRepo(opts.path);

// Stream findings as they resolve in markdown mode. JSON needs the whole set,
// so it stays quiet until the end.
const onFinding = opts.json
  ? undefined
  : (f) => process.stderr.write(`  ${f.status.padEnd(7)} ${f.id}\n`);

if (!opts.json) process.stderr.write(`Auditing ${opts.path}\n`);

const findings = await runChecks(CHECKS, repo, onFinding);

process.stdout.write(
  opts.json ? `${renderJson(findings)}\n` : `\n${renderMarkdown(findings)}\n`
);

process.exit(findings.some((f) => f.status === "fail") ? 1 : 0);
```

- [ ] **Step 6: Make it executable and run the full suite**

```bash
chmod +x bin/audit.mjs
npm test
npm run typecheck
npm run format
```

Expected: all tests pass, typecheck clean.

- [ ] **Step 7: Run against the ground-truth repo**

```bash
node bin/audit.mjs --path /Users/aguerra/workspace/autogallery
```

Expected — all four verified independently before this plan was written:

| Check | Expected | Ground truth |
| --- | --- | --- |
| `ci.no-diff-can-fail-on-gate` | **fail** | `npm audit` on the `check` job; failing step in 9 of 13 inspected CI failures |
| `ci.e2e-sharded` | **fail** | 52 spec files, no `--shard` anywhere in `package.json` or the workflows |
| `ci.flake-observability` | **fail** | `playwright.config.js` has no `retries` key |
| `concurrency.pr-path-contention` | **fail** | `package.json` 87%, `CHANGELOG.md` 77% of merged PRs |

If any reports `pass`, the check is wrong — not the repo. Fix the check.

- [ ] **Step 8: Run against this repo, which must pass its own audit**

```bash
node bin/audit.mjs --path .
```

Expected: no `fail`. `ci.e2e-sharded` and `ci.flake-observability` will report `unknown` (no browser tier), and `concurrency.pr-path-contention` will report `unknown` (no merge commits yet). That is the correct answer, and it is exactly why `unknown` is a first-class status.

- [ ] **Step 9: Commit**

```bash
git add lib/report.js bin/audit.mjs test/report.test.js package.json
git commit -m "feat(cli): read-only audit CLI with an incremental markdown report

Failures render first; \`unknown\` is called out as \"could not determine\",
never as a pass; a finding with no automatic fix says so. Exit 1 on any
failure, and \`unknown\` never fails the run because it is not a verdict.

Verified against ground truth: all four checks fire correctly on the
reference repo, and this repo passes its own audit."
```

---

## Self-Review

**1. Spec coverage.** This plan implements the detection half of §5 for four checks, plus §5 rules 1–6 (Task 1 enforces the binding rule and the deterministic-layer constraint at runtime; Task 3 enforces `unknown`-on-error), and §15's findings-first requirement (Task 3's cheapest-first incremental runner).

Deliberately **not** covered, and needing their own plans: the remaining 10 deterministic checks; the 2 judgment checks (`guide.exists`, `docs.unenforced-invariants`) which belong to the skill layer, not the binary; the whole adapt/remediation layer (§4 marked regions, §6 concurrency harness, §9 validation loop, §10 interview); and `.ai-readiness.json`. This is intentional — the spec's §16.1 requires remediations to be written after someone hand-applies them once.

**2. Placeholder scan.** No TBDs. Every code step carries complete, runnable code. Every test step names an exact command and an expected result.

**3. Type consistency.** `Finding` fields defined in Task 1 are used unchanged in Tasks 4–7. `Repo` methods defined in Task 2 (`readFile`, `listFiles`, `mergedPrFileLists`) are the only ones any check calls. `Check` shape from Task 3 (`{id, cost, run}`) is what Tasks 4–6 export and Task 7 imports. `makeFinding` requires all ten fields in every call site; each check spreads a `base` object and supplies the rest.

One deliberate duplication: `gatesPullRequests` exists in both Task 4 and Task 5 because Task 4 does not export it. Extracting it to a shared module is a reasonable follow-up once a third check needs it — two copies is not yet a seam.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-15-audit-detection-layer.md`.
