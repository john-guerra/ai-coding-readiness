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
npx ai-coding-readiness --path <repo>          # markdown report
npx ai-coding-readiness --path <repo> --json   # machine-readable
```

`npx ai-ready` does **not** resolve to this tool — `npx` resolves by package
name, and `ai-ready` is only a `bin` alias available after this package is
installed. Use the package name above.

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
