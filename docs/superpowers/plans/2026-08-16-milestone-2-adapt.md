# Milestone 2: Adapt — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the tool fix what it finds — safely, idempotently, and only where a fix is a pure file write. This is what stops it being a linter.

**Architecture:** A finding gains an optional `action`: a structured, machine-applicable description of its remediation. `makeFinding` enforces `autoFixable === true` ⟺ `action !== null`, so the claim stops being free. A separate binary applies actions; the audit binary gains **no** write path, keeping its read-only promise structural rather than behavioural. Generated content lives inside marked regions, and a hash manifest distinguishes "unchanged since we wrote it" from "a human edited this."

**Tech Stack:** Node 20+ ESM, plain JavaScript with JSDoc types, `tsc -p tsconfig.json` under `strict`, vitest. No new runtime dependencies.

**Spec:** `docs/specs/2026-08-15-ai-coding-readiness-design.md` — §4 (marked regions and the manifest) and §12 (blast radius).

## Why this milestone

Ten checks report findings and two claim to be auto-fixable. Verified: neither carries anything a machine could apply, and `makeFinding` does not constrain the field at all — it only requires that it be present. `autoFixable` is currently a comment.

## Global Constraints

- **`bin/audit.mjs` must contain no write path, at all.** The read-only guarantee is structural. A reviewer must be able to confirm it by reading imports.
- **Never write outside the target root.** Reuse the containment added to `createFsRepo`; a path escaping the root is refused, not clamped.
- **Never write inside `.git/`.**
- **Dry-run is the default.** Writing requires an explicit `--write`.
- **Never overwrite content the tool did not author.** The manifest hash is the arbiter; a changed hash means a human edited it, and the answer is to report a diff, never to overwrite.
- **Idempotent:** `adapt --write; adapt --write; git diff --exit-code` must be clean. This is a release gate, not an aspiration.
- **`autoFixable === true` ⟺ `action !== null`**, enforced at runtime by `makeFinding`.
- Every `fail` still carries a human-readable `fix`. An `action` supplements it; it never replaces it.
- No new runtime dependencies. Plain JS + JSDoc under `strict`. No telemetry. The only network path remains `gh` in `mergedPrFileLists`.
- **Report accurately.** List every deviation including type annotations.

## Controller decisions recorded up front

**1. Two binaries, not a flag.** `bin/audit.mjs` (read-only) and `bin/adapt.mjs` (writes). A `--apply` flag on a command named *audit* would make the read-only promise a behavioural claim that a reader has to trace. With two binaries it is structural: `audit.mjs` never imports the apply layer.

**2. Three action kinds, and no more.** `write-file` (create only, never overwrite), `append-lines` (add missing lines to an existing file), `write-region` (create or update a marked region). Anything needing to rewrite existing prose or YAML — CI workflows, `package.json` — is **out of scope for this milestone** and its finding stays `autoFixable: false`.

**3. No PR creation.** The spec's §12 describes one reviewable PR. This milestone writes to the working tree and stops, leaving the commit to the user. Branch creation, committing and PR-opening are outward-facing side effects that deserve their own milestone and their own review.

**4. A dirty working tree blocks `--write` by default.** The value of this tool is a diff a human can read. Writing into a tree that already has uncommitted changes destroys that. `--allow-dirty` exists for people who know what they are doing.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `lib/regions.js` | Find, insert and update marked regions in a text file. Knows nothing about findings |
| `lib/manifest.js` | Read/write `.ai-readiness/manifest.json`; hash content; classify a region as untouched, edited, or absent |
| `lib/actions.js` | The `Action` shape and `applyAction(repo, writer, action)`; the only module that knows how to change a file |
| `lib/writer.js` | `createFsWriter(root)` and `createFakeWriter()` — the write-side twin of `Repo`, with the same containment rules |
| `lib/finding.js` | Add `action`; enforce the `autoFixable` ⟺ `action` invariant (modify) |
| `lib/checks/repo-hygiene.js` | Attach an `append-lines` action for `.gitignore` gaps (modify) |
| `lib/checks/github-contribution-scaffold.js` | Attach `write-file` actions for the three missing artefacts (modify) |
| `lib/checks/guide-guardrails.js` | Attach a `write-region` action for a Guardrails section (modify) |
| `bin/adapt.mjs` | The apply CLI: dry-run by default, `--write`, `--allow-dirty` |
| `skills/adapt/SKILL.md` | The `/ai-ready:adapt` skill |
| `test/…` | vitest, mirroring `lib/` |

**Why `writer.js` is separate from `repo.js`.** `Repo` is handed to every check, and a check must never be able to write. Keeping the write capability in a different object means a check *cannot* mutate anything even by mistake — the capability is simply not in scope. This is the same reasoning as decision 1, one level down.

---

## Task 1: Marked regions

**Files:**
- Create: `lib/regions.js`
- Test: `test/regions.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `REGION_BEGIN(id, v)` / `REGION_END(id)` — the exact marker strings
  - `findRegion(text, id) -> {start: number, end: number, inner: string, version: number}|null` — character offsets of the whole block including markers
  - `upsertRegion(text, id, inner, version) -> string` — replace the region's inner content if present; otherwise append the block at the end of the text, separated by a blank line
  - `listRegions(text) -> Array<{id: string, version: number, inner: string}>`
  - `stripRegions(text) -> string` — the text with every marked block removed, used to prove nothing outside a region changed

Marker format, fixed:

```
<!-- ai-readiness:begin id=guardrails v=1 -->
…generated…
<!-- ai-readiness:end id=guardrails -->
```

- [ ] **Step 1: Write the failing test**

Create `test/regions.test.js`:

```js
import { describe, it, expect } from "vitest";
import {
  findRegion,
  upsertRegion,
  listRegions,
  stripRegions,
} from "../lib/regions.js";

const wrapped = (id, inner, v = 1) =>
  `<!-- ai-readiness:begin id=${id} v=${v} -->\n${inner}\n<!-- ai-readiness:end id=${id} -->`;

describe("findRegion", () => {
  it("returns null when the region is absent", () => {
    expect(findRegion("# Guide\n", "guardrails")).toBeNull();
  });

  it("finds a region and reports its inner content and version", () => {
    const text = `# Guide\n\n${wrapped("guardrails", "never do X", 2)}\n`;
    const r = findRegion(text, "guardrails");
    expect(r?.inner).toBe("never do X");
    expect(r?.version).toBe(2);
  });

  it("does not confuse two different regions", () => {
    const text = `${wrapped("a", "AAA")}\n\n${wrapped("b", "BBB")}\n`;
    expect(findRegion(text, "a")?.inner).toBe("AAA");
    expect(findRegion(text, "b")?.inner).toBe("BBB");
  });

  // An unterminated region must not swallow the rest of the file — that is how
  // a generator eats a human's prose.
  it("returns null for a begin marker with no matching end", () => {
    const text = `<!-- ai-readiness:begin id=x v=1 -->\nhalf a region\n`;
    expect(findRegion(text, "x")).toBeNull();
  });
});

describe("upsertRegion", () => {
  it("appends a new region at the end, leaving existing text byte-identical", () => {
    const before = "# Guide\n\nSome prose.\n";
    const after = upsertRegion(before, "guardrails", "never do X", 1);
    expect(after.startsWith(before)).toBe(true);
    expect(findRegion(after, "guardrails")?.inner).toBe("never do X");
  });

  it("replaces only the inner content of an existing region", () => {
    const before = `Intro.\n\n${wrapped("g", "old")}\n\nOutro.\n`;
    const after = upsertRegion(before, "g", "new", 1);
    expect(findRegion(after, "g")?.inner).toBe("new");
    expect(after).toContain("Intro.");
    expect(after).toContain("Outro.");
    expect(after).not.toContain("old");
  });

  // The whole safety property in one assertion.
  it("changes nothing outside the region it targets", () => {
    const before = `A\n\n${wrapped("g", "old")}\n\nB\n\n${wrapped("h", "keep")}\n`;
    const after = upsertRegion(before, "g", "new", 1);
    expect(stripRegions(after)).toBe(stripRegions(before));
    expect(findRegion(after, "h")?.inner).toBe("keep");
  });

  it("is idempotent when the content is unchanged", () => {
    const once = upsertRegion("# Guide\n", "g", "same", 1);
    expect(upsertRegion(once, "g", "same", 1)).toBe(once);
  });

  it("bumps the recorded version when it changes", () => {
    const v1 = upsertRegion("", "g", "x", 1);
    expect(findRegion(upsertRegion(v1, "g", "x", 2), "g")?.version).toBe(2);
  });
});

describe("listRegions", () => {
  it("lists every region in document order", () => {
    const text = `${wrapped("a", "1")}\n${wrapped("b", "2")}\n`;
    expect(listRegions(text).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("returns an empty list for text with no regions", () => {
    expect(listRegions("plain\n")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/regions.test.js`
Expected: FAIL — `Failed to resolve import "../lib/regions.js"`

- [ ] **Step 3: Write the implementation**

Create `lib/regions.js`:

```js
/**
 * Marked regions: the mechanism that lets a generator write into a file it
 * does not own.
 *
 * Everything this tool generates lives between markers, and nothing outside
 * them is ever touched. That is not a convention — `stripRegions` exists so a
 * test can assert it byte-for-byte, and `upsertRegion`'s contract is written
 * in those terms.
 *
 * Borrowed from `all-contributors`, which survived a decade of writing into
 * other people's READMEs on exactly this idea.
 */

/**
 * @param {string} id
 * @param {number} v
 */
export const REGION_BEGIN = (id, v) =>
  `<!-- ai-readiness:begin id=${id} v=${v} -->`;

/** @param {string} id */
export const REGION_END = (id) => `<!-- ai-readiness:end id=${id} -->`;

/** Ids are ours, not user input, but keep them boring so the regex stays safe. */
const ID = "[a-z0-9-]+";

const ANY_REGION = new RegExp(
  `<!-- ai-readiness:begin id=(${ID}) v=(\\d+) -->\\n([\\s\\S]*?)\\n?<!-- ai-readiness:end id=\\1 -->`,
  "g",
);

/**
 * @typedef {Object} Region
 * @property {number} start - offset of the first character of the begin marker
 * @property {number} end - offset just past the last character of the end marker
 * @property {string} inner
 * @property {number} version
 */

/**
 * @param {string} text
 * @param {string} id
 * @returns {Region|null}
 */
export function findRegion(text, id) {
  // A begin marker with no matching end matches nothing. That is deliberate:
  // a greedy fallback would let a truncated region swallow the rest of a
  // human's file the next time it was rewritten.
  const re = new RegExp(
    `<!-- ai-readiness:begin id=(${id}) v=(\\d+) -->\\n([\\s\\S]*?)\\n?<!-- ai-readiness:end id=${id} -->`,
  );
  const m = re.exec(text);
  if (!m) return null;
  return {
    start: m.index,
    end: m.index + m[0].length,
    inner: m[3],
    version: Number(m[2]),
  };
}

/**
 * Replace a region's inner content, or append the region if it is absent.
 * Text outside the targeted region is never modified.
 *
 * @param {string} text
 * @param {string} id
 * @param {string} inner
 * @param {number} version
 * @returns {string}
 */
export function upsertRegion(text, id, inner, version) {
  const block = `${REGION_BEGIN(id, version)}\n${inner}\n${REGION_END(id)}`;
  const found = findRegion(text, id);
  if (found) {
    return text.slice(0, found.start) + block + text.slice(found.end);
  }
  if (text === "") return `${block}\n`;
  const separator = text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return `${text}${separator}${block}\n`;
}

/**
 * @param {string} text
 * @returns {Array<{id: string, version: number, inner: string}>}
 */
export function listRegions(text) {
  const out = [];
  for (const m of text.matchAll(ANY_REGION)) {
    out.push({ id: m[1], version: Number(m[2]), inner: m[3] });
  }
  return out;
}

/**
 * The text with every marked block removed. Comparing this before and after a
 * write is how a test proves nothing outside a region changed.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripRegions(text) {
  return text.replace(ANY_REGION, "");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/regions.test.js`
Expected: PASS, 12 tests

- [ ] **Step 5: Full suite and typecheck, then commit**

```bash
npm test && npm run typecheck && npm run format:check
git add lib/regions.js test/regions.test.js
git commit -m "feat(regions): write into a file without owning it

Everything generated lives between markers and nothing outside them is
touched. stripRegions exists so a test can assert that byte-for-byte rather
than trusting the implementation to be careful.

An unterminated region matches nothing, deliberately: a greedy fallback
would let a truncated region swallow the rest of a human's file the next
time it was rewritten."
```

---

## Task 2: The manifest

**Files:**
- Create: `lib/manifest.js`
- Test: `test/manifest.test.js`

**Interfaces:**
- Consumes: `Repo` (read side only)
- Produces:
  - `MANIFEST_PATH` — `.ai-readiness/manifest.json`
  - `hashContent(text) -> string` — a short stable digest, `node:crypto` sha256, first 16 hex chars
  - `readManifest(repo) -> Promise<Manifest>` — `{schemaVersion: 1, entries: {}}` when absent or unparseable
  - `classify(manifest, path, id, currentInner) -> "absent" | "untouched" | "edited"`
  - `recordRegion(manifest, path, id, inner) -> Manifest` — returns a new manifest with the entry set to `active`
  - `retireRegion(manifest, path, id) -> Manifest` — marks an entry `retired` without deleting it

`Manifest` shape:

```jsonc
{
  "schemaVersion": 1,
  "entries": {
    "CLAUDE.md#guardrails": { "hash": "ab12…", "status": "active", "writtenAt": "2026-08-16" }
  }
}
```

**Why `retired` rather than deletion.** When a later version stops generating a region, the entry must survive so the tool can offer to remove the orphan. Deleting the record makes an abandoned region indistinguishable from a human's own content — and then nothing ever cleans it up.

- [ ] **Step 1: Write the failing test**

Create `test/manifest.test.js`:

```js
import { describe, it, expect } from "vitest";
import { createFakeRepo } from "../lib/repo.js";
import {
  MANIFEST_PATH,
  hashContent,
  readManifest,
  classify,
  recordRegion,
  retireRegion,
} from "../lib/manifest.js";

describe("readManifest", () => {
  it("returns an empty manifest when the file is absent", async () => {
    const m = await readManifest(createFakeRepo({ files: {} }));
    expect(m).toEqual({ schemaVersion: 1, entries: {} });
  });

  // An unreadable manifest must not be treated as "no regions were ever
  // written" — that would let the tool overwrite a human's edits. It is
  // treated as empty here, and the caller refuses to write; see bin/adapt.
  it("returns an empty manifest when the file will not parse", async () => {
    const m = await readManifest(
      createFakeRepo({ files: { [MANIFEST_PATH]: "{ not json" } }),
    );
    expect(m.entries).toEqual({});
  });

  it("reads recorded entries", async () => {
    const m = await readManifest(
      createFakeRepo({
        files: {
          [MANIFEST_PATH]: JSON.stringify({
            schemaVersion: 1,
            entries: { "a.md#x": { hash: "deadbeef", status: "active" } },
          }),
        },
      }),
    );
    expect(m.entries["a.md#x"].hash).toBe("deadbeef");
  });
});

describe("classify", () => {
  const inner = "generated content";
  const base = recordRegion({ schemaVersion: 1, entries: {} }, "a.md", "x", inner);

  it("reports absent when nothing was ever recorded", () => {
    expect(classify({ schemaVersion: 1, entries: {} }, "a.md", "x", inner)).toBe(
      "absent",
    );
  });

  it("reports untouched when the content still hashes to what we wrote", () => {
    expect(classify(base, "a.md", "x", inner)).toBe("untouched");
  });

  // This is the whole point of the manifest: telling "we wrote this and
  // nobody changed it" apart from "a human edited this", so the second case
  // can be a diff rather than an overwrite.
  it("reports edited when the content has changed since we wrote it", () => {
    expect(classify(base, "a.md", "x", "a human rewrote this")).toBe("edited");
  });
});

describe("recordRegion / retireRegion", () => {
  it("records an entry as active with its hash", () => {
    const m = recordRegion({ schemaVersion: 1, entries: {} }, "a.md", "x", "hi");
    expect(m.entries["a.md#x"].status).toBe("active");
    expect(m.entries["a.md#x"].hash).toBe(hashContent("hi"));
  });

  it("does not mutate the manifest it was given", () => {
    const before = { schemaVersion: 1, entries: {} };
    recordRegion(before, "a.md", "x", "hi");
    expect(before.entries).toEqual({});
  });

  it("retires an entry without deleting it, so an orphan stays discoverable", () => {
    const active = recordRegion({ schemaVersion: 1, entries: {} }, "a.md", "x", "hi");
    const retired = retireRegion(active, "a.md", "x");
    expect(retired.entries["a.md#x"].status).toBe("retired");
    expect(retired.entries["a.md#x"].hash).toBe(active.entries["a.md#x"].hash);
  });

  it("retiring an unknown entry is a no-op rather than an error", () => {
    const m = { schemaVersion: 1, entries: {} };
    expect(retireRegion(m, "a.md", "nope").entries).toEqual({});
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/manifest.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `lib/manifest.js`:

```js
import { createHash } from "node:crypto";

/**
 * The record of what this tool wrote, and whether a human has touched it since.
 *
 * Without it, a second run cannot tell "we generated this and nobody changed
 * it" from "a person edited this" — and a generator that cannot tell the
 * difference must either clobber edits or never update anything. Both are
 * fatal for a tool that writes into repositories it does not own.
 *
 * @typedef {{hash: string, status: "active"|"retired", writtenAt?: string}} Entry
 * @typedef {{schemaVersion: number, entries: Record<string, Entry>}} Manifest
 */

export const MANIFEST_PATH = ".ai-readiness/manifest.json";

/** @param {string} text */
export function hashContent(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/**
 * @param {string} path
 * @param {string} id
 */
const key = (path, id) => `${path}#${id}`;

/**
 * @param {import('./repo.js').Repo} repo
 * @returns {Promise<Manifest>}
 */
export async function readManifest(repo) {
  const raw = await repo.readFile(MANIFEST_PATH);
  if (raw === null) return { schemaVersion: 1, entries: {} };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.entries) {
      return { schemaVersion: parsed.schemaVersion ?? 1, entries: parsed.entries };
    }
  } catch {
    // Fall through. An unreadable manifest is reported as empty here; the
    // caller must refuse to write rather than assume nothing was generated.
  }
  return { schemaVersion: 1, entries: {} };
}

/**
 * @param {Manifest} manifest
 * @param {string} path
 * @param {string} id
 * @param {string} currentInner
 * @returns {"absent"|"untouched"|"edited"}
 */
export function classify(manifest, path, id, currentInner) {
  const entry = manifest.entries[key(path, id)];
  if (!entry) return "absent";
  return entry.hash === hashContent(currentInner) ? "untouched" : "edited";
}

/**
 * @param {Manifest} manifest
 * @param {string} path
 * @param {string} id
 * @param {string} inner
 * @returns {Manifest}
 */
export function recordRegion(manifest, path, id, inner) {
  return {
    schemaVersion: manifest.schemaVersion,
    entries: {
      ...manifest.entries,
      [key(path, id)]: { hash: hashContent(inner), status: "active" },
    },
  };
}

/**
 * Mark an entry retired without dropping it. A deleted record makes an
 * abandoned region indistinguishable from a human's own content, and then
 * nothing ever cleans it up.
 *
 * @param {Manifest} manifest
 * @param {string} path
 * @param {string} id
 * @returns {Manifest}
 */
export function retireRegion(manifest, path, id) {
  const existing = manifest.entries[key(path, id)];
  if (!existing) return manifest;
  return {
    schemaVersion: manifest.schemaVersion,
    entries: {
      ...manifest.entries,
      [key(path, id)]: { ...existing, status: "retired" },
    },
  };
}
```

- [ ] **Step 4: Run the tests, full suite, typecheck, commit**

```bash
npx vitest run test/manifest.test.js && npm test && npm run typecheck && npm run format:check
git add lib/manifest.js test/manifest.test.js
git commit -m "feat(manifest): tell our own output apart from a human's edit

A generator that cannot distinguish 'we wrote this and nobody changed it'
from 'a person edited this' must either clobber edits or never update
anything. Both are fatal for a tool that writes into repos it does not own.

Entries retire rather than delete: dropping the record makes an abandoned
region indistinguishable from a human's own content, and then nothing ever
cleans it up."
```

---

## Task 3: The writer, and actions

**Files:**
- Create: `lib/writer.js`
- Create: `lib/actions.js`
- Test: `test/writer.test.js`, `test/actions.test.js`

**Interfaces:**
- Consumes: `Repo`, `lib/regions.js`, `lib/manifest.js`
- Produces:
  - `createFsWriter(root) -> Writer`, `createFakeWriter(initial?) -> Writer & {files: Record<string,string>}`
  - `Writer` = `{ write(path, content): Promise<void> }` — refuses any path escaping `root` or inside `.git/`, creating parent directories as needed
  - `applyAction(repo, writer, action, manifest) -> Promise<{changed: boolean, reason: string, manifest: Manifest}>`
  - `Action` — a discriminated union, exactly three kinds:

```js
{ kind: "write-file",   path, content }            // create only; never overwrites
{ kind: "append-lines", path, lines: string[] }    // adds only lines not already present
{ kind: "write-region", path, id, inner, version } // creates or updates a marked region
```

**Contract for each kind:**

| Kind | If the target does not exist | If it exists |
| --- | --- | --- |
| `write-file` | create it | **no-op**, reason `"exists"` — never overwrite a file we did not author |
| `append-lines` | create it with the lines | append only the lines not already present; no-op if all are |
| `write-region` | create the file with the region | update the region if the manifest says `untouched`; **no-op** with reason `"edited"` if a human changed it |

`changed: false` on every no-op is what makes a second run a no-op, which is what makes the idempotency gate pass.

- [ ] **Step 1: Write the failing tests**

Create `test/writer.test.js`:

```js
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsWriter, createFakeWriter } from "../lib/writer.js";

describe("createFakeWriter", () => {
  it("records what was written", async () => {
    const w = createFakeWriter();
    await w.write("a/b.txt", "hi");
    expect(w.files["a/b.txt"]).toBe("hi");
  });
});

describe("createFsWriter", () => {
  it("writes a file, creating parent directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writer-"));
    const w = createFsWriter(dir);
    await w.write("deep/nested/file.txt", "hi");
    expect(await readFile(join(dir, "deep/nested/file.txt"), "utf8")).toBe("hi");
  });

  // The containment rule, stated as a test rather than a comment. A repo can
  // influence what gets written; it must never influence WHERE.
  it("refuses a path escaping the root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writer-"));
    const w = createFsWriter(dir);
    await expect(w.write("../escaped.txt", "x")).rejects.toThrow(/outside/i);
  });

  it("refuses an absolute path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writer-"));
    const w = createFsWriter(dir);
    await expect(w.write("/etc/passwd", "x")).rejects.toThrow(/outside/i);
  });

  it("refuses to write inside .git", async () => {
    const dir = await mkdtemp(join(tmpdir(), "writer-"));
    await mkdir(join(dir, ".git"), { recursive: true });
    const w = createFsWriter(dir);
    await expect(w.write(".git/config", "x")).rejects.toThrow(/\.git/i);
  });
});
```

Create `test/actions.test.js`:

```js
import { describe, it, expect } from "vitest";
import { createFakeRepo } from "../lib/repo.js";
import { createFakeWriter } from "../lib/writer.js";
import { applyAction } from "../lib/actions.js";
import { recordRegion } from "../lib/manifest.js";
import { findRegion } from "../lib/regions.js";

const EMPTY = { schemaVersion: 1, entries: {} };

describe("write-file", () => {
  it("creates a file that does not exist", async () => {
    const w = createFakeWriter();
    const r = await applyAction(
      createFakeRepo({ files: {} }),
      w,
      { kind: "write-file", path: "CODEOWNERS", content: "* @me\n" },
      EMPTY,
    );
    expect(r.changed).toBe(true);
    expect(w.files["CODEOWNERS"]).toBe("* @me\n");
  });

  // Never overwrite a file we did not author. A repo's existing CODEOWNERS is
  // theirs, and a generator that replaces it has destroyed something.
  it("does not overwrite an existing file", async () => {
    const w = createFakeWriter();
    const r = await applyAction(
      createFakeRepo({ files: { CODEOWNERS: "* @someone-else\n" } }),
      w,
      { kind: "write-file", path: "CODEOWNERS", content: "* @me\n" },
      EMPTY,
    );
    expect(r.changed).toBe(false);
    expect(r.reason).toMatch(/exists/i);
    expect(w.files["CODEOWNERS"]).toBeUndefined();
  });
});

describe("append-lines", () => {
  it("creates the file when absent", async () => {
    const w = createFakeWriter();
    await applyAction(
      createFakeRepo({ files: {} }),
      w,
      { kind: "append-lines", path: ".gitignore", lines: [".env", "dist/"] },
      EMPTY,
    );
    expect(w.files[".gitignore"]).toBe(".env\ndist/\n");
  });

  it("appends only the lines that are missing", async () => {
    const w = createFakeWriter();
    await applyAction(
      createFakeRepo({ files: { ".gitignore": "node_modules/\n.env\n" } }),
      w,
      { kind: "append-lines", path: ".gitignore", lines: [".env", "dist/"] },
      EMPTY,
    );
    expect(w.files[".gitignore"]).toBe("node_modules/\n.env\ndist/\n");
  });

  it("is a no-op when every line is already present", async () => {
    const w = createFakeWriter();
    const r = await applyAction(
      createFakeRepo({ files: { ".gitignore": ".env\ndist/\n" } }),
      w,
      { kind: "append-lines", path: ".gitignore", lines: [".env", "dist/"] },
      EMPTY,
    );
    expect(r.changed).toBe(false);
    expect(w.files[".gitignore"]).toBeUndefined();
  });
});

describe("write-region", () => {
  const action = {
    kind: "write-region",
    path: "CLAUDE.md",
    id: "guardrails",
    inner: "- never touch production",
    version: 1,
  };

  it("creates the file with the region when absent", async () => {
    const w = createFakeWriter();
    const r = await applyAction(createFakeRepo({ files: {} }), w, action, EMPTY);
    expect(r.changed).toBe(true);
    expect(findRegion(w.files["CLAUDE.md"], "guardrails")?.inner).toBe(
      "- never touch production",
    );
  });

  it("appends the region to an existing file without touching its prose", async () => {
    const w = createFakeWriter();
    const before = "# Guide\n\nExisting prose.\n";
    await applyAction(createFakeRepo({ files: { "CLAUDE.md": before } }), w, action, EMPTY);
    expect(w.files["CLAUDE.md"].startsWith(before)).toBe(true);
  });

  it("updates a region the manifest says we wrote and nobody changed", async () => {
    const w = createFakeWriter();
    const existing = `# Guide\n\n<!-- ai-readiness:begin id=guardrails v=1 -->\nold\n<!-- ai-readiness:end id=guardrails -->\n`;
    const manifest = recordRegion(EMPTY, "CLAUDE.md", "guardrails", "old");
    const r = await applyAction(
      createFakeRepo({ files: { "CLAUDE.md": existing } }),
      w,
      action,
      manifest,
    );
    expect(r.changed).toBe(true);
    expect(findRegion(w.files["CLAUDE.md"], "guardrails")?.inner).toBe(
      "- never touch production",
    );
  });

  // The manifest's reason for existing. A human edited our region; the answer
  // is to report it, not to overwrite it.
  it("refuses to overwrite a region a human has edited", async () => {
    const w = createFakeWriter();
    const edited = `<!-- ai-readiness:begin id=guardrails v=1 -->\nI changed this by hand\n<!-- ai-readiness:end id=guardrails -->\n`;
    const manifest = recordRegion(EMPTY, "CLAUDE.md", "guardrails", "old");
    const r = await applyAction(
      createFakeRepo({ files: { "CLAUDE.md": edited } }),
      w,
      action,
      manifest,
    );
    expect(r.changed).toBe(false);
    expect(r.reason).toMatch(/edited/i);
    expect(w.files["CLAUDE.md"]).toBeUndefined();
  });

  it("is a no-op when the region already holds the intended content", async () => {
    const w = createFakeWriter();
    const same = `<!-- ai-readiness:begin id=guardrails v=1 -->\n- never touch production\n<!-- ai-readiness:end id=guardrails -->\n`;
    const manifest = recordRegion(EMPTY, "CLAUDE.md", "guardrails", "- never touch production");
    const r = await applyAction(
      createFakeRepo({ files: { "CLAUDE.md": same } }),
      w,
      action,
      manifest,
    );
    expect(r.changed).toBe(false);
  });
});
```

- [ ] **Step 2: Run both to verify they fail**

Run: `npx vitest run test/writer.test.js test/actions.test.js`
Expected: FAIL — modules not found

- [ ] **Step 3: Write `lib/writer.js`**

```js
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

/**
 * The write-side twin of `Repo`, deliberately a separate object.
 *
 * A check is handed a `Repo` and nothing else, so a check *cannot* mutate the
 * repository even by mistake — the capability is not in scope. Keeping writes
 * in a different type is what makes that structural rather than a rule
 * somebody has to remember.
 *
 * @typedef {Object} Writer
 * @property {(path: string, content: string) => Promise<void>} write
 */

/**
 * @param {string} root
 * @param {string} path
 */
function assertInside(root, path) {
  const target = resolve(root, path);
  const base = resolve(root);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`refusing to write outside the target directory: ${path}`);
  }
  const rel = target.slice(base.length + 1);
  if (rel === ".git" || rel.startsWith(`.git${sep}`)) {
    throw new Error(`refusing to write inside .git: ${path}`);
  }
  return target;
}

/**
 * @param {string} root
 * @returns {Writer}
 */
export function createFsWriter(root) {
  return {
    async write(path, content) {
      const target = assertInside(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    },
  };
}

/**
 * @param {Record<string, string>} [initial]
 * @returns {Writer & {files: Record<string, string>}}
 */
export function createFakeWriter(initial = {}) {
  const files = { ...initial };
  return {
    files,
    async write(path, content) {
      files[path] = content;
    },
  };
}
```

- [ ] **Step 4: Write `lib/actions.js`**

```js
import { upsertRegion, findRegion } from "./regions.js";
import { classify, recordRegion } from "./manifest.js";

/**
 * The three things this tool is allowed to do to a file, and nothing else.
 *
 * Anything that would rewrite existing prose or YAML — a CI workflow,
 * package.json — is deliberately absent. Those remediations stay
 * `autoFixable: false` until a milestone gives them the review they need.
 *
 * @typedef {{kind: "write-file", path: string, content: string}} WriteFile
 * @typedef {{kind: "append-lines", path: string, lines: string[]}} AppendLines
 * @typedef {{kind: "write-region", path: string, id: string, inner: string, version: number}} WriteRegion
 * @typedef {WriteFile|AppendLines|WriteRegion} Action
 */

/**
 * @param {import('./repo.js').Repo} repo
 * @param {import('./writer.js').Writer} writer
 * @param {Action} action
 * @param {import('./manifest.js').Manifest} manifest
 * @returns {Promise<{changed: boolean, reason: string, manifest: import('./manifest.js').Manifest}>}
 */
export async function applyAction(repo, writer, action, manifest) {
  const existing = await repo.readFile(action.path);

  if (action.kind === "write-file") {
    if (existing !== null) {
      return {
        changed: false,
        reason: `exists — ${action.path} is already there and is not ours to replace`,
        manifest,
      };
    }
    await writer.write(action.path, action.content);
    return { changed: true, reason: `created ${action.path}`, manifest };
  }

  if (action.kind === "append-lines") {
    const current = existing ?? "";
    const present = new Set(
      current.split("\n").map((l) => l.trim()).filter(Boolean),
    );
    const missing = action.lines.filter((l) => !present.has(l.trim()));
    if (missing.length === 0) {
      return { changed: false, reason: `every line already present`, manifest };
    }
    const separator = current === "" || current.endsWith("\n") ? "" : "\n";
    await writer.write(
      action.path,
      `${current}${separator}${missing.join("\n")}\n`,
    );
    return {
      changed: true,
      reason: `appended ${missing.length} line(s) to ${action.path}`,
      manifest,
    };
  }

  // write-region
  const current = existing ?? "";
  const found = findRegion(current, action.id);
  if (found) {
    const state = classify(manifest, action.path, action.id, found.inner);
    if (state === "edited") {
      return {
        changed: false,
        reason: `edited — the ${action.id} region in ${action.path} was changed by hand; not overwriting`,
        manifest,
      };
    }
    if (found.inner === action.inner) {
      return { changed: false, reason: `already current`, manifest };
    }
  }
  const next = upsertRegion(current, action.id, action.inner, action.version);
  await writer.write(action.path, next);
  return {
    changed: true,
    reason: found
      ? `updated the ${action.id} region in ${action.path}`
      : `added the ${action.id} region to ${action.path}`,
    manifest: recordRegion(manifest, action.path, action.id, action.inner),
  };
}
```

- [ ] **Step 5: Run the tests, full suite, typecheck, commit**

```bash
npx vitest run test/writer.test.js test/actions.test.js && npm test && npm run typecheck && npm run format:check
git add lib/writer.js lib/actions.js test/writer.test.js test/actions.test.js
git commit -m "feat(actions): three things the tool may do to a file, and nothing else

The writer is a separate type from Repo on purpose: a check is handed a Repo
and nothing else, so it cannot mutate a repository even by mistake. The
capability is not in scope rather than forbidden by a rule someone has to
remember.

write-file never overwrites, append-lines adds only what is missing, and
write-region refuses a region a human has edited. Every no-op returns
changed:false, which is what makes a second run a no-op and the idempotency
gate meaningful."
```

---

## Task 4: `action` on `Finding`, and the invariant

**Files:**
- Modify: `lib/finding.js`
- Modify: `test/finding.test.js`
- Test: the existing file, extended

**Interfaces:**
- Produces: `Finding.action: Action|null`, and the enforced rule **`autoFixable === true` ⟺ `action !== null`**

**Why this is the centre of the milestone.** Verified before this plan was written: two findings claim `autoFixable: true`, neither carries anything a machine could apply, and `makeFinding` does not constrain the field — it only requires it to be present. The claim is currently free. This makes it cost something.

- [ ] **Step 1: Add the failing tests**

Append to `test/finding.test.js`:

```js
describe("makeFinding action invariant", () => {
  const base = {
    id: "x.y",
    tier: 1,
    layer: "deterministic",
    status: "fail",
    effort: "S",
    evidence: "e",
    why: "w",
    precondition: null,
    fix: "do it",
    autoFixable: false,
    action: null,
  };

  it("accepts a finding with no action when autoFixable is false", () => {
    expect(makeFinding(base).action).toBeNull();
  });

  it("accepts an action when autoFixable is true", () => {
    const action = { kind: "write-file", path: "a", content: "b" };
    expect(makeFinding({ ...base, autoFixable: true, action }).action).toEqual(action);
  });

  // The claim stops being free: saying a fix is automatic now requires
  // shipping the thing that automates it.
  it("rejects autoFixable true with no action", () => {
    expect(() => makeFinding({ ...base, autoFixable: true, action: null })).toThrow(
      /autoFixable/i,
    );
  });

  it("rejects an action when autoFixable is false", () => {
    expect(() =>
      makeFinding({
        ...base,
        autoFixable: false,
        action: { kind: "write-file", path: "a", content: "b" },
      }),
    ).toThrow(/autoFixable/i);
  });

  it("rejects an unknown action kind", () => {
    expect(() =>
      makeFinding({
        ...base,
        autoFixable: true,
        action: { kind: "rm -rf", path: "a" },
      }),
    ).toThrow(/kind/i);
  });

  it("still requires action to be present, not merely undefined", () => {
    const { action, ...without } = base;
    expect(() => makeFinding(without)).toThrow(/action/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/finding.test.js`
Expected: FAIL — `action` is not a required field and no invariant exists.

**Note:** `test/finding.test.js` is excluded from typechecking for a documented reason; that exclusion still applies and must not be widened.

- [ ] **Step 3: Implement**

In `lib/finding.js`: add `"action"` to the required-field list, add `action` to the typedef, and add the invariant after the existing `fail`-needs-`fix` check:

```js
const ACTION_KINDS = new Set(["write-file", "append-lines", "write-region"]);

// … inside makeFinding, after the fail/fix check:

if (spec.action !== null) {
  const kind = /** @type {any} */ (spec.action)?.kind;
  if (!ACTION_KINDS.has(kind)) {
    throw new TypeError(
      `makeFinding: check "${spec.id}" carries an action of unknown kind ` +
        `"${kind}". Allowed: ${[...ACTION_KINDS].join(", ")}.`,
    );
  }
}

// `autoFixable` used to be a comment. An automatic fix now has to ship the
// thing that performs it, and a finding that carries a machine-applicable
// action has to admit it is automatic.
if (spec.autoFixable && spec.action === null) {
  throw new TypeError(
    `makeFinding: check "${spec.id}" claims autoFixable but carries no action. ` +
      `Either attach one, or say the fix needs a person.`,
  );
}
if (!spec.autoFixable && spec.action !== null) {
  throw new TypeError(
    `makeFinding: check "${spec.id}" carries an action but claims it is not ` +
      `auto-fixable. One of the two is wrong.`,
  );
}
```

- [ ] **Step 4: Fix every existing call site**

Every `makeFinding` call in `lib/checks/*.js` and `lib/registry.js` now needs `action`. The two checks currently claiming `autoFixable: true` on a `fail` (`repo.hygiene`, `github.contribution-scaffold`) must **temporarily** flip to `autoFixable: false, action: null` — Task 5 gives them real actions. Every other call site adds `action: null`.

Run `npm test` after this step: it must be green with no behaviour change except those two findings no longer claiming to be automatic.

- [ ] **Step 5: Full suite, typecheck, commit**

```bash
npm test && npm run typecheck && npm run format:check
git add lib/finding.js lib/checks lib/registry.js test/finding.test.js
git commit -m "feat(finding): make autoFixable cost something

Two findings claimed autoFixable and neither carried anything a machine
could apply; makeFinding only required the field to be present. The claim
was a comment.

autoFixable is now true if and only if the finding carries a structured
action, enforced at runtime in both directions. The two checks that claimed
it drop to false until the next commit gives them real actions."
```

---

## Task 5: Give three checks real actions

**Files:**
- Modify: `lib/checks/github-contribution-scaffold.js`
- Modify: `lib/checks/repo-hygiene.js`
- Modify: `lib/checks/guide-guardrails.js`
- Modify: their tests

**Contracts:**

| Check | Action | Notes |
| --- | --- | --- |
| `github.contribution-scaffold` | **the first missing artefact only**, as `write-file` | See below — one action per finding, and the CLI re-runs to convergence |
| `repo.hygiene` | `append-lines` on `.gitignore` for the missing entries | Only when `.gitignore` is the *only* gap; a missing lockfile needs `npm install`, which is not a file write |
| `guide.guardrails` | `write-region` adding a `guardrails` region to the guide | Only when a guide exists; otherwise `guide.exists` owns it |

**Why one action per finding.** A `Finding` carries at most one `action`, and inventing an action list now would be scope the milestone does not need. `bin/adapt.mjs` re-runs the checks after applying, so a repo missing all three scaffold files converges in three passes. State the pass count in the CLI output so it is not mysterious.

**Content for the generated files** must be genuinely useful, not placeholders — the bug template asks for repro steps, expected, actual; the PR template asks what changed, why, and how it was verified; `CODEOWNERS` needs a real owner, so derive it from the `gh` remote if available and otherwise **do not offer the action** (an action that writes `* @TODO` is worse than no action).

- [ ] **Step 1: Write the failing tests**

For each check, add tests asserting: the finding carries an action of the right kind with the right path; `autoFixable` is `true` when it does; and the action is **absent** (`autoFixable: false`) in the cases named above — a missing lockfile, no guide, no derivable owner.

Write these tests before touching the checks, and run them to see them fail.

- [ ] **Step 2: Implement, one check per commit**

Each check builds its action only in the branch where it applies, and continues to return `autoFixable: false, action: null` everywhere else.

- [ ] **Step 3: Verify no check regressed**

```bash
npm test && npm run typecheck
node bin/audit.mjs --path .                                     # still 0 fail, exit 0
node bin/audit.mjs --path /Users/aguerra/workspace/autogallery  # still 6 fail, exit 1
```

`/Users/aguerra/workspace/autogallery` is **read-only**: run the CLI against it and nothing else.

- [ ] **Step 4: Commit** — three commits, one per check, each explaining why its action is scoped the way it is.

---

## Task 6: `bin/adapt.mjs`, the skill, and the idempotency gate

**Files:**
- Create: `bin/adapt.mjs`
- Create: `skills/adapt/SKILL.md`
- Create: `test/adapt-cli.test.js`
- Modify: `package.json` (bin entry), `README.md`, `AGENTS.md`

**CLI contract:**

```
ai-ready-adapt [--path <dir>] [--write] [--allow-dirty] [--json]
```

- **Dry-run by default.** Without `--write` it prints what it would do and changes nothing.
- **`--write` refuses a dirty working tree** unless `--allow-dirty`. The value of this tool is a diff a human can read; writing into a tree that already has uncommitted changes destroys that.
- Applies only findings with an action, re-running the checks after each pass until no action changes anything, to a **cap of 5 passes**. Report the pass count and say plainly if the cap was hit.
- Writes the manifest last, and only if something changed.
- Exit `0` when it completes (whether or not anything changed), `1` if any action failed, `2` on a usage error or a refused dirty tree.
- **Never calls `process.exit()` after writing to stdout** — set `process.exitCode`. This project has already been bitten by a truncated piped write.

**`bin/audit.mjs` must not import anything from `lib/writer.js` or `lib/actions.js`.** Add a test asserting that, by reading the file — the read-only guarantee should be checkable, not just true.

- [ ] **Step 1: Write the failing tests**

`test/adapt-cli.test.js` must cover:
- dry-run writes nothing to a seeded temp repo, and its output names what it would do
- `--write` on the same repo creates the expected files
- **running `--write` twice leaves the second run reporting no changes**, and the tree byte-identical — the idempotency gate
- a dirty tree without `--allow-dirty` exits 2 and writes nothing
- `--json` output parses and is not truncated when piped
- `bin/audit.mjs` contains no import of `writer.js` or `actions.js`

- [ ] **Step 2: Implement `bin/adapt.mjs`**

Structure it as: parse args → detect a dirty tree via `git status --porcelain` → loop passes { run checks, collect findings with actions, apply each, stop when nothing changed } → write manifest → render summary. Reuse `lib/report.js`'s rendering conventions where they fit; do not duplicate the whole renderer.

- [ ] **Step 3: Write `skills/adapt/SKILL.md`**

It must say, in this order: what it changes; that dry-run is the default and the user should read the dry-run first; that it never overwrites a file it did not author or a region a human edited; and that it does not commit or open a PR. Use `node "${CLAUDE_PLUGIN_ROOT}/bin/adapt.mjs"` as the invocation — **not** `npx`, for the reason recorded in `skills/audit/SKILL.md`.

- [ ] **Step 4: The idempotency release gate**

Add to `package.json`:

```json
"test:idempotent": "node scripts/check-idempotent.mjs"
```

and a script that: creates a temp git repo seeded to fail several checks, runs `adapt --write` twice, and fails if `git diff` between the two runs is non-empty. Wire it into `npm test` or document it as a release step — say which you chose.

- [ ] **Step 5: Verify end to end and paste verbatim into the report**

```bash
npm test && npm run typecheck && npm run format:check
node bin/adapt.mjs --path <temp repo>            # dry run: names actions, writes nothing
node bin/adapt.mjs --path <temp repo> --write    # applies
node bin/adapt.mjs --path <temp repo> --write    # second run: no changes
node bin/audit.mjs --path .                      # still 0 fail, exit 0
node bin/audit.mjs --path /Users/aguerra/workspace/autogallery   # still 6 fail, exit 1
```

- [ ] **Step 6: Commit** in logical groups, and update `README.md` and `AGENTS.md` to describe the adapt half honestly — including what it still does not do (no CI rewriting, no commit, no PR).

---

## Self-Review

**1. Spec coverage.** Implements §4 (marked regions, the manifest, idempotency as a gate) and the file-writing subset of §12. Deliberately **not** covered: PR creation and gated GitHub API actions (decision 3); the interview; `.ai-readiness.json` config; remediations that rewrite existing CI or `package.json` (decision 2); the judgment-layer checks.

**2. Placeholder scan.** Tasks 1–4 and 6 carry complete code or complete contracts. **Task 5 deliberately specifies contracts and tests rather than code** — the three checks differ enough that dictating their internals would be guessing at code the implementer can see and I cannot. Its acceptance criteria are exact.

**3. Type consistency.** `Action` is defined once in `lib/actions.js` and referenced by `lib/finding.js` and the three checks. `Writer` is defined in `lib/writer.js` and consumed only by `lib/actions.js` and `bin/adapt.mjs`. `Manifest` is defined in `lib/manifest.js`; `applyAction` both accepts and returns one, so the caller threads it through the loop rather than mutating it.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-16-milestone-2-adapt.md`.

---

# Amendments after independent plan review

**Verdict was Rework.** These supersede the task text above wherever they
conflict. Seven Criticals, three of which I reproduced live before writing this.
Each amendment names what it replaces.

## B1 — supersedes Task 3's `assertInside`: it does not contain anything

Reproduced on this machine, with the plan's function verbatim:

```
symlinked file   : assertInside ALLOWED -> root/CLAUDE.md
                   outside/secret.txt is now: CLOBBERED
symlinked dir    : mkdir -p created outside/deep/ ? true
.GIT/config      : allowed on a case-insensitive filesystem; .git/config overwritten
```

`resolve()` is **lexical** — it does not follow symlinks, and `writeFile`/`mkdir`
do. So a repo containing a symlink can make the tool destroy a file outside the
directory it was pointed at, and `mkdir -p` creates directories outside the root
*before* any refusal runs. This is the write-side twin of the `@../secret.md`
path-traversal the previous milestone shipped, with destruction instead of
disclosure as the consequence.

The plan also said "reuse the containment added to `createFsRepo`" and then
**reimplemented it, worse**: `lib/repo.js` guards the trailing-separator case
(`base.endsWith(sep) ? base : base + sep`); the plan's copy does not, so a root
of `/` yields `//` and refuses everything. A second copy of a security predicate
is a second thing to get wrong, and it already was.

**Required:**

1. **Extract `insideRoot(root, path)` into one shared module** and have both
   `lib/repo.js` and `lib/writer.js` import it. Not a copy.
2. After `mkdir`, **`realpath()` the parent directory** and re-assert
   containment before writing.
3. **`lstat()` the final target and refuse a symlink** (or open with
   `O_NOFOLLOW`).
4. **Refuse when the existing target is a directory.**
5. **Case-fold the `.git` comparison, and refuse a `.git` component at any
   depth** — a submodule or vendored `.git` is currently writable.
6. Fix the off-by-one in `rel = target.slice(base.length + 1)` when `base` ends
   with a separator.

Add a test for each of the three reproduced bypasses. The plan's four writer
tests all pass against the broken implementation — that is the point.

## B2 — supersedes Task 4's premise and Step 4: it is eight sites, not two

The plan states three times that two findings claim `autoFixable: true`.
Verified: **seven check files** contain it, plus a conditional in
`concurrency-pr-path-contention.js` — eight sites.

```
repo-hygiene · github-contribution-scaffold · guide-guardrails · guide-commands
ci-no-diff-can-fail-on-gate · ci-flake-observability · ci-e2e-sharded
concurrency-pr-path-contention (conditional)
```

My earlier survey ran against a temp directory that only made three checks fail;
the rest carry `autoFixable: true` in their `base` and inherit it. The premise
was wrong by a factor of four.

**Consequence the plan must own rather than discover.** Under decision 2, four of
those eight can never carry an action this milestone — `ci.e2e-sharded`,
`ci.flake-observability`, `ci.no-diff-can-fail-on-gate` and `guide.commands` all
need YAML or Playwright-config rewrites. They become **permanently**
`autoFixable: false`, and `lib/report.js` will therefore append *"This finding
has no automatic fix; it needs a person."* to four more findings. That is more
honest and it is the right outcome — but it is a deliberate, user-visible report
change that belongs in the commit message, not a surprise in Task 4.

**Failure mode if executed as written:** six checks would call `makeFinding` with
`autoFixable: true, action: null`, the new invariant throws, `runChecks` catches
it (`lib/registry.js`) and converts it to `status: "unknown"`. So six real `fail`
verdicts would silently become `unknown` with evidence reading `check threw: …`.
Not a loud crash — a quiet downgrade.

**Also missing from Step 4's call-site list:** `test/report.test.js`,
`test/registry.test.js`, and the module-level `base` in `test/finding.test.js`
all call `makeFinding` without `action`. The first two are not in Step 5's
`git add` list either.

## B3 — supersedes Task 1: CRLF corrupts the file on every run

Verified: `findRegion` hardcodes `\n` after the begin marker, so on a CRLF
checkout it returns `null` — and `upsertRegion` therefore **appends a brand-new
region every single run**, unbounded, while the manifest never matches.

```
LF   findRegion: MATCH
CRLF findRegion: null
```

Most Windows contributors check out with `core.autocrlf=true`. For a tool whose
headline safety property is "idempotent, byte-identical", silently growing a
file forever is the worst available outcome.

**Required:** `\r?\n` throughout `findRegion`, `ANY_REGION` and `stripRegions`;
detect the file's dominant line ending and emit the block with it; add a CRLF
fixture to `test/regions.test.js` **and** to the idempotency gate, which
otherwise only ever runs on a macOS temp repo and will never see this.

## B4 — supersedes Task 3's `write-region`: an unrecorded region is silently overwritten

`applyAction` refuses only on `classify(...) === "edited"`. `"absent"` falls
through to the overwrite — so a region that physically exists with **no manifest
entry** gets clobbered. That happens whenever the manifest was deleted, was
unparseable, or a human copied the marker syntax into their own file.

Spec §4 says "hash unchanged → safe to update; hash changed → the human edited
it." No entry means the hash is **unknown**, which is not "unchanged". This is
the write-side analogue of *"`unknown` is never `pass`"* — the rule this
codebase has broken six times — reintroduced in the one function where breaking
it costs a user their file.

**Required:** refuse when the region exists and `classify` returns `"absent"`,
with a distinct reason naming that we have no record of writing it. Every
`write-region` test in the plan seeds a manifest entry; add one that does not.

## B5 — supersedes Task 2 and Task 6: the corrupt-manifest refusal is a comment

`readManifest` returns the same empty value for "absent" and "corrupt", so the
caller **cannot** distinguish them even if it wanted to — and Task 6's CLI
contract never mentions the refusal at all. Combined with B4, one corrupt byte in
`manifest.json` silently overwrites every generated region in the repository.

**Required:** `readManifest` returns `{ok: false}` (or throws) on unparseable
input; `bin/adapt.mjs` **refuses `--write`** on an unreadable manifest with a
named exit code; both get tests.

## B6 — supersedes Global Constraints and Task 6 Step 4: the gate contradicts decision 4

`adapt --write; adapt --write; git diff --exit-code` cannot run: the first
`--write` dirties the tree, and decision 4 makes the second exit 2.

**Ruling: the gate commits between runs.** That is closer to real usage than
`--allow-dirty` and it additionally proves the manifest survives a commit —
which B4 makes load-bearing. `scripts/check-idempotent.mjs` must
`git add -A && git commit` between the two `--write` invocations, and assert
`git diff --exit-code` is clean after the second.

## B7 — supersedes Task 5: drop CODEOWNERS generation

The plan says derive the owner "from the `gh` remote if available." Every reading
is wrong: `gh repo view` is **a second network path**, which `AGENTS.md` forbids
without a spec decision; `git remote get-url` is local but `Repo` exposes no
accessor for it; and the derived owner is usually an **organization**, so
`* @some-org` is not valid CODEOWNERS syntax — GitHub renders it as "Unknown
owner" and required-review-by-owner silently never fires.

A generated file that looks correct and quietly does nothing is worse than the
`* @TODO` the plan already rejects, and it is exactly the confidently-wrong
remediation this project's rule 4 exists to prevent.

**Required:** `github.contribution-scaffold` generates the **two templates
only**, converging in two passes. CODEOWNERS stays in the finding's `fix` prose
as a human step.

## B8 — new acceptance criterion for all of Task 5

`guide.guardrails` passes only when its `PROHIBITION` regex matches. Nothing in
Task 5 required the generated region to contain such a token — so pass 1 writes,
pass 2 sees identical content and stops, and **the finding still fails**. The
user gets "applied 1 change, nothing left to do" beside a still-red check: the
tool wrote into their guide and achieved nothing.

**Required, for all three actions:** after the action is applied, the check that
produced it **must pass**, and the test must assert it by re-running the check
against the post-write repo. That closes the loop between an action and the
finding that emitted it, and it is the only assertion that proves a remediation
actually remediates.

## B9 — the Important findings, all accepted

- **Version bumps never land.** `applyAction` short-circuits on
  `found.inner === action.inner` before `upsertRegion` runs, so `v=` freezes at
  whatever it was when content last changed and any future migration keyed on it
  never fires. Compare `found.version !== action.version || found.inner !== action.inner`.
- **Duplicate or nested markers destroy content while passing the safety
  oracle.** `stripRegions` reduces before and after to the same string, so the
  assertion reports the write as clean while inner content vanishes. `upsertRegion`
  must refuse when `listRegions` reports a duplicate id, or when `inner` itself
  contains a marker. Separately, `findRegion` interpolates `id` into a `RegExp`
  **unescaped** — validate it against `[a-z0-9-]+` on entry.
- **Print `precondition` before applying**, in both dry-run and `--write`. A tool
  that applies a fix while suppressing the caveat attached to that fix is worse
  than one that does not apply it.
- **Run only action-capable checks in the convergence loop**, then the full set
  once for the summary. Otherwise five passes means up to five `gh` invocations.
  Expected pass count is now **3** (two scaffold writes plus a confirming pass)
  against a cap of 5; state that so hitting the cap reads as a bug.
- **Persist the manifest per successful action**, not once at the end. If a later
  action throws after regions were written, those regions exist on disk with no
  manifest entry — which under B4 means the next run refuses them, or worse,
  under the old behaviour overwrote them.
- **The no-write guarantee needs a real test.** Grepping one file misses
  transitive imports. Walk the static import graph recursively from
  `bin/audit.mjs`, and state that `lib/finding.js` may reference `Action` only as
  an erased JSDoc type (`import('./actions.js').Action`), never a runtime import.
- **Specify the three dirty-tree branches:** not a git repo → **refuse `--write`**
  (no diff, no review, no undo — decision 4's own logic); untracked files count
  as dirty; scope the check to the audited path, not the enclosing repository.
  Invoke `git` with an argument array.
- **`--allow-dirty` must print what it is overriding.**

## B10 — minors folded in

`recordRegion` records `writtenAt` (it is in the typedef and the spec) ·
`retireRegion` has no caller this milestone, say so rather than leaving it
looking like an oversight · the manifest **must be committed** for classification
to survive, say so in the skill and README, and never let a `.gitignore` action
ignore `.ai-readiness/` · Task 5 names the exact target path per artefact, since
`write-file` has no fallback but the check accepts several locations ·
`append-lines`' exact-match notion of "already present" differs from
`repo.hygiene`'s glob-aware `covers()` — note the coupling in a comment · Task 6
also bumps `.claude-plugin/plugin.json` and its description.
