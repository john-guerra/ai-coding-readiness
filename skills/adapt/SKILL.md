---
name: adapt
description: Use when asked to fix, adapt, or remediate what the AI-coding readiness audit found — to apply the automatic fixes for a missing .gitignore entry, an absent Guardrails section, or a missing issue/PR template. Dry-run by default; it writes only with --write, never commits, and never opens a pull request.
---

# Adapting a repository to what the audit found

## What it changes

Three things, and nothing else:

- **`.gitignore`** — appends the entries `repo.hygiene` reported missing
  (`node_modules/`, `dist/`, `.env`, `.DS_Store`), and only those. Existing
  lines are never rewritten or reordered.
- **The agent guide** (`CLAUDE.md`, `.claude/CLAUDE.md` or `AGENTS.md`,
  whichever the repository has) — adds a generated `## Guardrails` section
  inside a marked region. Text outside the markers is never touched.
- **`.github/ISSUE_TEMPLATE/bug.md` and `.github/PULL_REQUEST_TEMPLATE.md`** —
  created if absent. An existing template is never replaced.

It does **not** rewrite CI workflows, `package.json`, Playwright config, or any
other existing YAML or code, and it does **not** generate `CODEOWNERS` — a
valid entry names a real reviewer or team, and an owner guessed from the remote
is usually an organisation, which GitHub reads as "Unknown owner" and silently
enforces nothing. Those findings stay `fail` with a fix written for a person.

## Dry run is the default — read it first

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/adapt.mjs" --path <repo>            # dry run
node "${CLAUDE_PLUGIN_ROOT}/bin/adapt.mjs" --path <repo> --json     # machine-readable
node "${CLAUDE_PLUGIN_ROOT}/bin/adapt.mjs" --path <repo> --write    # apply
```

Without `--write` nothing is written: the output is a description of what
would be, including each action's **precondition** — the caveat attached to
that fix. Two of the three carry one, and they matter: what gets written into
the guide is a generic starting point, not a description of this repository.
Show the user the dry run and let them decide before running `--write`.

`--write` refuses a working tree that already has uncommitted changes, because
the value of this tool is a diff a human can read. `--allow-dirty` overrides
that and says what it is writing on top of. It also refuses outside a git
repository, and `--allow-dirty` does not override that one — with no version
control there is no diff, no review and no undo.

Exit codes: `0` completed · `1` an action failed · `2` usage error, a refused
dirty tree, or an unreadable manifest.

The adapter ships inside this plugin, so it runs straight from the plugin root.
It does not shell out to npm, and it must not: this tool's own guardrail is
"one network path, and only one", and reaching the registry would be a second.

⚠️ **`npx ai-ready` is an unrelated third-party package — do not run it.**
`ai-ready` on npm is "Automatic Claude Code plugin discovery for npm
dependencies" by another author; `ai-ready` is only this plugin's name and a
`bin` alias inside this package. `npx ai-coding-readiness` does not work
either: that name is not published (404).

From a clone rather than an install, `node bin/adapt.mjs --path <repo>` is the
same command.

## It never overwrites what it did not write

- **A file it did not author is never replaced.** `write-file` creates; if the
  path is already there, the action is skipped and the run says so.
- **A region a human edited is left alone.** Everything generated inside a file
  lives between `<!-- ai-readiness:begin id=… -->` markers, and the manifest
  records a hash of what was written. If the current content does not match
  that hash, somebody edited it and the region is not touched.
- **A region with no manifest record is also left alone.** No record means the
  hash is _unknown_, and unknown is not "unchanged" — the write-side version of
  this project's rule that `unknown` is never `pass`.

Report skipped actions to the user as skips, with their reason. A skip is a
fact about the repository, not a failure.

## It does not commit and does not open a pull request

The run ends with the changes in the working tree and nothing else done. Show
the user `git diff`, let them read it, and let them commit. Do not commit on
their behalf unless they ask for it in that turn.

## Commit `.ai-readiness/manifest.json`

It is the record of which regions this tool wrote. It only survives if it is
committed — and without it a later run cannot tell its own output from the
user's edits, so it refuses to touch any of it. Include it in the commit, and
never add it to `.gitignore`.

## After a run

1. Re-run the audit (or read the report this command prints at the end) and
   report what still fails. `github.contribution-scaffold` normally still fails
   on CODEOWNERS by design; say that plainly rather than treating it as an
   error.
2. Read the generated Guardrails section with the user and cut what does not
   apply. A guardrail nobody has read constrains nobody.
3. If an action failed, quote the refusal. The write layer refuses paths that
   escape the target directory, name `.git`, or are symlinks; those refusals
   mean something is wrong with the repository or the tool, not with the run.
