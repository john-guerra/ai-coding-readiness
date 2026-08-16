# ai-coding-readiness

## Install

As a Claude Code plugin:

```
/plugin marketplace add john-guerra/ai-coding-readiness
/plugin install ai-ready@john-guerra
```

Then `/ai-ready:audit` or `/ai-ready:adapt`, or run the CLIs directly from a
clone:

```bash
node bin/audit.mjs --path <repo>            # read-only, always
node bin/adapt.mjs --path <repo>            # dry run: what it would change
node bin/adapt.mjs --path <repo> --write    # apply it
```

> **What v0.2 actually ships: the _diagnose_ half — ten deterministic,
> read-only checks — and a narrow first slice of the _adapt_ half.** `adapt`
> applies three fixes: the missing `.gitignore` entries, a generated
> `## Guardrails` section inside a marked region of the agent guide, and the
> issue and pull-request templates. **It does not do the rest of the adapt
> design**: no interview, no `.ai-readiness.json` config, no rewriting of CI
> workflows, `package.json` or Playwright config, no `CODEOWNERS`, no commit,
> and no pull request. The unenforced-invariant report below is still designed
> and not built. Everything under "The idea" is where this is going, not what
> it does today.

### What `adapt` will and will not touch

- **Dry run is the default.** Without `--write` it prints what it would do —
  including each fix's precondition — and changes nothing.
- **It never replaces a file it did not create**, and never rewrites a marked
  region whose content no longer matches what it recorded writing. A region it
  has no record of writing is also left alone: no record means the hash is
  unknown, and unknown is not "unchanged".
- **It never commits and never opens a pull request.** The changes land in your
  working tree and the diff is yours to read.
- **`--write` refuses a dirty working tree** (`--allow-dirty` overrides, and
  says what it is writing on top of) and refuses to run outside a git
  repository at all — with no version control there is no diff, no review and
  no undo, so `--allow-dirty` does not override that one.
- **Running it twice is a no-op.** That is enforced by a release gate,
  `npm run test:idempotent`, which seeds a repo (with CRLF line endings, where
  a naive region matcher appends a fresh region every run), writes, commits,
  writes again, and fails if anything moved. It is part of `npm test`.

### Commit `.ai-readiness/manifest.json`

`adapt` records a hash of every region it writes in `.ai-readiness/manifest.json`.
That file is how a later run tells its own output from your edits — so it has
to be committed, and it must never be added to `.gitignore`. Without it, the
next run refuses to touch the regions it wrote rather than risk overwriting
something you changed.

A Claude Code plugin that **diagnoses** how ready a GitHub repository is for
AI-assisted collaboration, and then **adapts** it — writing the harness that
lets multiple AI agents and multiple humans work on the same repo
simultaneously without colliding, and making its quality rules _mechanically
enforced_ rather than merely documented.

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

The headline finding it is being built to produce looks like this (**not built
yet** — see the banner above):

> Your `CLAUDE.md` states 11 rules. Nothing enforces 9 of them.
> Here are tests for 4, a lint rule for 2, and a CI grep for 1 — in one PR.

That report exists because the failure mode is well documented and near
universal: a rule gets settled once, written down, and then broken by the next
feature — because prose in a markdown file is persuasion, not enforcement.

## What it looks at

Items marked _(planned)_ are part of the design, not of the ten checks v0.2
registers.

- **Contention** — which files appear in nearly every PR diff? Those are the
  points where two agents collide, and they're usually fixable by _removing_
  the shared file rather than locking it.
- **Feedback loop health** — is the merge gate fast, and can it fail without a
  code change? A gate that goes red with no diff blocks every agent at once.
- **Unenforced invariants** _(planned)_ — which stated MUST/NEVER rules have no
  test, lint rule, or CI check behind them.
- **The harness basics** — agent guide, guardrails, lockfile, CI completeness,
  static analysis, issue/PR templates, CODEOWNERS.

It **defers rather than duplicates**: `/init` writes the agent guide (it already
interviews, explores, and ingests Cursor/Copilot/Devin rule files), `/doctor`
trims an over-long one, OpenSSF Scorecard owns security posture, and changesets
owns changelog concurrency. What's left — and what nothing else measures — is
**how a repository behaves under concurrent contributors.**

## Scope, honestly

v0.2 targets **single-package Node repositories hosted on GitHub**. Monorepo
detection-and-refusal is designed but _not built yet_ — point v0.2 at a
monorepo today and it will answer as if it were one package. Other ecosystems
and forges come later, or not at all if they don't earn it.

Of the ten checks, **three carry an automatic fix**. The other seven stay
`autoFixable: false` on purpose: their remediations mean rewriting CI YAML,
`package.json` or Playwright config — editing files somebody else wrote, in
formats where a confidently wrong edit is worse than no edit — and that needs a
review this milestone did not give it. The report says so on each of them
rather than implying `adapt` will handle it.

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
