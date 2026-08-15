# CLAUDE.md

@AGENTS.md

The imported file above is the whole guide — what this is, the commands, the four
binding rules, the guardrails, the traps, and the testing conventions. Read it
first. What follows is Claude-specific only.

## Claude Code specifics

- **This repository is the tool's own first adopter.** `node bin/audit.mjs
--path .` must not report a `fail`. Several checks will report `unknown` here
  (no browser tier, few merge commits) and that is the correct answer — see rule
  2 in the imported guide.
- **Keep this file and `AGENTS.md` small.** Together they are the always-loaded
  instruction budget, and the tool ships a check (`guide.context-budget`)
  measuring exactly that against a <200-line target. A repository that fails its
  own check has no standing to report it. Path-specific rules belong in
  `.claude/rules/` with `paths:` frontmatter, where they load only when Claude
  touches matching files — `@`-imports do **not** reduce context, they load at
  launch.
- **Prefer a hook over a rule when something must happen every time.** The tool's
  central argument is that prose in a guide is persuasion, not enforcement; this
  repository should not violate its own thesis. If a rule here keeps getting
  broken, that is evidence it belongs in `.claude/settings.json` as a hook, in a
  lint rule, or in a test.

## Working an in-flight plan

When executing a plan from `docs/superpowers/plans/`, the ledger under
`.superpowers/sdd/<plan>/progress.md` is the record of what is already done, and
it outranks recollection after a context compaction. The commits it names exist
in `git log` whether or not the session remembers creating them.
