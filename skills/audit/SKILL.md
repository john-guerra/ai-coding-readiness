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
node "${CLAUDE_PLUGIN_ROOT}/bin/audit.mjs" --path <repo>          # markdown report
node "${CLAUDE_PLUGIN_ROOT}/bin/audit.mjs" --path <repo> --json   # machine-readable
```

The audit ships inside this plugin, so it runs straight from the plugin root.
It does not shell out to npm, and it must not: this tool's own guardrail is
"one network path, and only one", and reaching the registry to run an audit
would be a second.

From a clone rather than an install, `node bin/audit.mjs --path <repo>` is the
same command.

⚠️ **`npx ai-ready` is an unrelated third-party package — do not run it.**
`ai-ready` on npm is "Automatic Claude Code plugin discovery for npm
dependencies" by another author; `ai-ready` is only this plugin's name and a
`bin` alias inside this package. `npx ai-coding-readiness` does not work
either: that name is not published (404). Once it is published, `npx
ai-coding-readiness --path <repo>` will be the alternative for people who have
not installed the plugin — but it is not available today.

Exit codes: `0` no failures · `1` at least one failure · `2` usage error.

## Reading the result

Three statuses, and the third is the one that matters:

- **`fail`** — a real finding, with a remediation attached.
- **`pass`** — verified, not assumed.
- **`unknown`** — the check could not determine an answer. **Never report an
  `unknown` as a pass.** It means a file was absent, a credential was missing,
  or the sample was too small to support a claim. Say which.

## What to do with it

1. Report the failures with their evidence, in report order: the markdown
   report is sorted `fail` → `unknown` → `pass`, then by check id, so the
   failures are already at the top. Two other orders exist and neither is the
   report — the progress lines on stderr stream as checks resolve (cheapest
   first), and `--json` emits findings in registry order.
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
