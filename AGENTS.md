# AGENTS.md

Cross-agent guide for `ai-coding-readiness` (Codex, Cursor, Copilot, and anything
else that reads `AGENTS.md`). Claude Code reads `CLAUDE.md`, which imports this
file — so this is the substance and `CLAUDE.md` adds only Claude-specific notes.

## What this is

A Claude Code plugin that **diagnoses** how ready a GitHub repository is for
AI-assisted collaboration and then **adapts** it. The design center is a repo
where several agents and several humans work at once.

Status: v0.2.0. Ten deterministic checks, plus a narrow first slice of the
adapt layer: marked regions, the manifest, and `bin/adapt.mjs`, which applies
**three** fixes — the missing `.gitignore` entries, a generated `## Guardrails`
region in the agent guide, and the issue/PR templates. **Not published to npm**
(`ai-coding-readiness` 404s; `ai-ready` there is an unrelated third party).
Deliberately not built: the interview, `.ai-readiness.json`, the one-PR
delivery, remediations that rewrite existing CI / `package.json` / Playwright
config, `CODEOWNERS`, and the judgment layer. `adapt` never commits and never
opens a PR; the diff is the deliverable.

## Commands

```bash
npm test              # vitest run, then the idempotency gate
npm run test:unit     # vitest run alone
npm run test:idempotent   # the release gate, on its own
npm run test:watch    # vitest
npm run typecheck     # tsc -p tsconfig.json (JSDoc types, checkJs)
npm run format        # prettier --write .
npm run format:check
node bin/audit.mjs --path <dir> [--json]   # the audit itself, read-only
node bin/adapt.mjs --path <dir> [--write] [--allow-dirty] [--json]
```

`npm test` runs `scripts/check-idempotent.mjs` after the suite: it seeds a temp
git repo (with a **CRLF** guide), runs `adapt --write`, **commits**, runs it
again, and fails if `git diff` or `git status --porcelain` reports anything.
The commit in the middle is not optional — the first write dirties the tree and
the dirty-tree rule makes a second `--write` exit 2 — and it also proves the
manifest survives a commit, which is load-bearing.

## Four rules that are not style preferences

These come from `docs/specs/2026-08-15-ai-coding-readiness-design.md` and each one
is load-bearing. Breaking one is an incomplete change, not a nitpick.

1. **Every check ships with its remediation, or it doesn't ship.** A `fail`
   finding with no `fix` is the failure this tool exists to prevent, so
   `makeFinding()` throws on it rather than trusting review to catch it.
2. **`unknown` is never `pass`.** When a check cannot determine an answer —
   missing file, unparseable input, no credentials — it returns `unknown`. A tool
   that reports green because it could not look is worse than no tool.
3. **The binary is deterministic; judgment is advisory.** `bin/audit.mjs` runs
   only `layer: "deterministic"` checks. Reproducibility when a stranger files a
   bug is the entire rationale for the two-layer split, so `makeFinding()` refuses
   a judgment finding. Model-judged checks run in the skill layer and never gate.
4. **Every `fix` carries a `precondition` where one exists.** A confidently wrong
   remediation is worse than a missing check, because the human delegated the
   judgment. If a fix cannot be applied safely in some cases, say so in
   `precondition`; if it cannot be automated at all, set `autoFixable: false` and
   say that in the `fix` text.

## Guardrails

- **The audit never writes to the repository it audits**, and that is checkable:
  `test/read-only-guarantee.test.js` walks the import graph from `bin/audit.mjs`
  recursively and asserts it never reaches `lib/writer.js` or `lib/actions.js`.
  `lib/finding.js` may name `Action` only as an **erased JSDoc type**
  (`import('./actions.js').Action`) — the scanner strips comments first, and a
  test asserts the strip is load-bearing so nobody "simplifies" it away.
  `ACTION_KINDS` there is a deliberate second copy of the list in
  `lib/actions.js`; a test asserts they agree, because drift is silent —
  `makeFinding` throws, `runChecks` catches, and a real `fail` becomes
  `unknown`.
- **The adapter writes only three things:** a file that is not there, appended
  lines, and a marked region it has a record of writing. It never replaces a
  file it did not create, never rewrites a region whose hash no longer matches
  the manifest, and — unknown is not "unchanged" — never rewrites a region the
  manifest has no record of.
- **`.ai-readiness/manifest.json` must be committed and never ignored.** It is
  what distinguishes generated regions from a human's edits; `repo.hygiene`'s
  action must never propose a line covering it, and a test asserts that.
- **`--write` refuses a dirty tree** (`--allow-dirty` overrides, and prints what
  it is overriding) **and refuses to run outside a git repository**, which
  `--allow-dirty` does _not_ override: no version control, no diff, no undo. The
  dirty check is scoped to `--path`, not the enclosing repository.
- **No telemetry.** Nothing about you or your code is reported anywhere.
- **One network path, and only one:** `mergedPrFileLists` shells out to `gh` to
  list a repository's own merged pull requests, because a squash-merge repo
  leaves no merge commits to read locally and that is most of GitHub. Local git
  is always tried first; the API is the fallback. Nothing else in the audit
  touches the network, and no new one should be added without a decision
  recorded in the spec.
- **Subprocesses are invoked with an argument array, never a shell string.**
  `promisify(execFile)`, not `exec`. Nothing here can be shell-injected, and it
  should stay that way.
- **Never `npm audit fix --force`.** It resolves semver-major bumps silently.
- **Do not add runtime dependencies** without a decision recorded in the spec.
  The production tree is `yaml` and nothing else, deliberately.

## Traps that cost real time

- **`tsc` with file globs on the command line errors `TS6053` when a glob matches
  nothing.** Globs inside a tsconfig `include` array tolerate empty matches. This
  is why `typecheck` is `tsc -p tsconfig.json` and not a list of paths — the
  original form broke the moment a planned directory did not exist yet.
- **Never `process.exit()` straight after `process.stdout.write()`.** On a pipe it
  can truncate the write, so `--json | jq` loses findings intermittently. Set
  `process.exitCode` and let the process end on its own.
- **A bare `on:` key in a GitHub workflow parses as the boolean `true` under YAML
  1.1.** The `yaml` package parses as 1.2 where it stays a string, but workflows
  in the wild are written for both. Read `doc.on ?? doc[true]`.
- **`on:` has three spellings** — `on: pull_request`, `on: [push, pull_request]`,
  and `on: {pull_request: {...}}`. A check that handles only the object form
  silently passes repositories it should fail.
- **Playwright config is executable JavaScript, not data.** Checks that inspect it
  use text matching and must say so in their evidence rather than implying a parse.
- **`findRegion` must tolerate CRLF.** A hardcoded `\n` after the begin marker
  matches nothing on a `core.autocrlf=true` checkout, so `upsertRegion` appends
  a brand-new region every run, unbounded. Every regex in `lib/regions.js` is
  `\r?\n`, and the idempotency gate uses a CRLF fixture because a macOS-only one
  would never see it.
- **`lstat`/`O_NOFOLLOW` cannot see a hardlink** — the entry _is_ the file, so
  `O_TRUNC` wrote through an inode shared outside the root. Every write now
  goes to a **same-directory** temp file `rename()`d over the target, and both
  sides realpath before acting (`lib/repo.js` reads too: a symlinked guide
  leaked an outside file into a public report). An in-root symlink is accepted.
- **`adapt`'s convergence loop runs only `ACTION_CAPABLE`**, then the full set
  once for the summary — all ten per pass would mean up to five `gh` calls over
  the one permitted network path to answer a question no action can change.
  Expected pass count is **3** against a cap of **5**, so hitting the cap reads
  as a bug (an action reporting a change it did not make). Findings whose action
  changed nothing are not retried: every "no change" reason here is
  deterministic, so the loop is progress-driven, not cap-driven.

## Testing

- **vitest**, tests under `test/` mirroring `lib/`.
- **Checks are pure functions over an injected `Repo`.** Never reach for the real
  filesystem in a check test — `createFakeRepo({files, mergedPrFileLists})` exists
  so fixtures are plain objects and tests stay hermetic. `createFsRepo()` is the
  only code that touches disk.
- **A check with real ground truth gets verified against it.** Several checks were
  written against measured behaviour of a specific repository; those measurements
  are in the spec's evidence table. If a check disagrees with its ground truth,
  the check is wrong.
- **Before reporting a measurement, establish that the instrument can produce a
  non-trivial result.** Two findings were retracted during design for violating
  this — a flake proxy reading a signal the test runner could not emit, and an age
  statistic that only restated the age of the tracker. A confident number from an
  instrument that could only return that number is worse than no number.

## Where the reasoning lives

- `docs/specs/2026-08-15-ai-coding-readiness-design.md` — the design, revision 4,
  after three independent review passes. The binding authority.
- `docs/superpowers/plans/` — build plans for work in flight. These are
  instructions; check the work is still open before following one.
- `.superpowers/` — git-ignored scratch for in-flight execution. Not a source of
  truth.

## Git

- Feature branches; never commit directly to `main`.
- **Never push without explicit approval.** This is a public repository.
