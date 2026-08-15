# AGENTS.md

Cross-agent guide for `ai-coding-readiness` (Codex, Cursor, Copilot, and anything
else that reads `AGENTS.md`). Claude Code reads `CLAUDE.md`, which imports this
file — so this is the substance and `CLAUDE.md` adds only Claude-specific notes.

## What this is

A Claude Code plugin that **diagnoses** how ready a GitHub repository is for
AI-assisted collaboration and then **adapts** it in one reviewable PR. The design
center is a repo where several agents and several humans work at once.

Status: pre-v0.1. The detection layer is being built; nothing is published.

## Commands

```bash
npm test            # vitest run
npm run test:watch  # vitest
npm run typecheck   # tsc -p tsconfig.json (JSDoc types, checkJs)
npm run format      # prettier --write .
npm run format:check
node bin/audit.mjs --path <dir> [--json]   # the audit itself, read-only
```

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

- **The audit never writes to the repository it audits.** No exceptions in this
  layer.
- **No network calls, no telemetry.** Nothing leaves the machine.
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
