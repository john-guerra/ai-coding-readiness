# ai-coding-readiness

> **Status: design phase. Nothing is implemented yet.**
> The design is in [`docs/specs/`](docs/specs/). There is no installable
> plugin at this commit — do not expect one until v0.1 is tagged.

A Claude Code plugin that **diagnoses** how ready a GitHub repository is for
AI-assisted collaboration, and then **adapts** it — writing the harness that
lets multiple AI agents and multiple humans work on the same repo
simultaneously without colliding, and making its quality rules *mechanically
enforced* rather than merely documented.

Two halves of one tool, bound by a single rule:

> **Every check ships with its remediation, or it doesn't ship.**

That rule is what separates this from a linter. It also disciplines the check
list from the far end: if you can't write the fix, you don't understand the
problem well enough to assert it is one.

## The idea

Most advice about "making your repo AI-ready" is a checklist. Checklists tell
you what's wrong and leave. This runs on a **brownfield** repo — one that
already exists, with history and conventions worth preserving — measures it,
interviews you about what it can't measure, and opens **one reviewable PR**.

The headline finding it produces looks like this:

> Your `CLAUDE.md` states 11 rules. Nothing enforces 9 of them.
> Here are tests for 4, a lint rule for 2, and a CI grep for 1 — in one PR.

That report exists because the failure mode is well documented and near
universal: a rule gets settled once, written down, and then broken by the next
feature — because prose in a markdown file is persuasion, not enforcement.

## What it looks at

- **Contention** — which files appear in nearly every PR diff? Those are the
  points where two agents collide, and they're usually fixable by *removing*
  the shared file rather than locking it.
- **Feedback loop health** — is the merge gate fast, and can it fail without a
  code change? A gate that goes red with no diff blocks every agent at once.
- **Unenforced invariants** — which stated MUST/NEVER rules have no test, lint
  rule, or CI check behind them.
- **The harness basics** — agent guide, guardrails, lockfile, CI completeness,
  static analysis, issue/PR templates, branch protection.

## Scope, honestly

v0.1 targets **single-package Node repositories hosted on GitHub**. Monorepos
are detected and refused rather than given confident garbage. Other ecosystems
and forges come later, or not at all if they don't earn it.

It deliberately does **not** rebuild things that already exist. Security and
supply-chain hygiene defer to [OpenSSF
Scorecard](https://github.com/ossf/scorecard); greenfield spec-driven
scaffolding defers to [GitHub Spec Kit](https://github.com/github/spec-kit);
changelog and version concurrency defer to
[changesets](https://github.com/changesets/changesets).

## Design

[`docs/specs/2026-08-15-ai-coding-readiness-design.md`](docs/specs/2026-08-15-ai-coding-readiness-design.md)

Every decision in it traces to a measurement taken on a real, mature AI-coded
repository — including four measurements that contradicted the author's own
assumptions and removed features from the plan before they were built.

## License

MIT © 2026 John Alexis Guerra Gómez
