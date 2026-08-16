---
name: Bug report
about: Something is wrong with a check, the CLI, or a finding it produced
title: ""
labels: bug
assignees: ""
---

## Repro steps

The exact command that triggers the bug, and the smallest repository (or
fixture) that reproduces it. If it's specific to a repo you can't share,
try to reduce it to a minimal `createFakeRepo`-style file list.

```bash
node bin/audit.mjs --path <repo> ...
```

## Expected

What the audit should have reported — which check, which status, and why.

## Actual

What it actually reported. Paste the finding's `evidence` verbatim rather than
paraphrasing it; the exact string is often the bug.

```
<paste the finding or CLI output here>
```

## Environment

- `ai-coding-readiness` version (or commit SHA):
- Node version (`node --version`):
- OS:
