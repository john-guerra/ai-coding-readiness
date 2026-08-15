# Sequencing checkpoint — input to the implementation plan

**Date:** 2026-08-15
**Status:** notes, not a plan. Superseded once `writing-plans` produces the real
implementation plan.

This captures build-order thinking that came up during design. It is recorded
here so it is not lost, and so the implementation plan can absorb or reject it.
It is **not** authoritative.

---

## The dogfood target

`john-guerra/autogallery` has four measured, unfixed findings (§2 of the design
spec). They are the first real input this tool will ever see.

| Finding | Measurement | Status in autogallery |
| --- | --- | --- |
| `npm audit` on the merge gate | failing step in **9 of 13** inspected CI failures | **Symptom already filed as #338** (2026-08-07, `bug`/`priority: high`). The CVE was fixed with a scoped `overrides` entry; **the gate was never moved off the merge path** |
| Instruction context budget | **1,595 lines** loaded every session (`CLAUDE.md` 438 + three `@`-imports) vs. a documented <200-line target | unfixed |
| No static analysis | no eslint / oxlint / biome / typescript | unfixed |
| Serialized browser tier | 187 tests, `workers: 1`, `fullyParallel: false`, ~10 min on the merge gate | unfixed |

**#338 is the strongest demo case available**, and it was not designed — it was
found. A human saw *"this PR is blocked"* and fixed the instance. The check sees
*"a gate that can fail with no diff sits on the merge path"* and fixes the class.
The tool's value here is **reframing a known symptom as a structural class**, not
discovering something nobody noticed.

---

## Proposed ordering, and the reasoning behind it

The open question was whether to hand-fix autogallery first, or build the
checker and let it drive. The answer is neither, because **detection and
remediation have different risk profiles**:

| | Detection | Remediation |
| --- | --- | --- |
| Worst case when wrong | reports something the maintainer disagrees with | **breaks someone's repo** |
| Confidence available today | deterministic, testable against fixtures | low — review already caught one of five remediations (`test.e2e-parallel` prescribing "unpin workers", which would have produced a flaky suite rather than a faster one) |

So, in order:

1. **Detection layer first.** Read-only, zero blast radius. Running it live on
   autogallery is the demonstration, and it exists before any fix is encoded.
2. **Hand-apply the fixes, with the audit as the instrument.** Audit red → fix →
   audit green. This is design-spec rule 3 (*any check whose fix is not
   verifiable by re-running the audit does not ship*) used as the tracking
   mechanism, so no separate journal discipline is required.
3. **Encode the remediations last**, with the preconditions step 2 taught us.
   Every surprise in step 2 becomes a `precondition` field rather than a bug
   report from a stranger.

**Open question for the plan:** build one check end-to-end as a vertical slice
(check → report → the #338 finding) before replicating the shape three times, or
build all four together?

---

## Reconciliation note

The "monitor for these improvements" idea is **not a new artifact**. It is the
audit binary, re-run — the scheduled drift Action deferred in §13 of the design
spec for want of adopters. autogallery is now an adopter, so that trigger has
fired. Building a separate monitor would be a second implementation of something
that already exists.

## Constraint the plan must respect

autogallery runs the `working-issues` protocol with several agents in parallel.
Any hand-applied remediation there must: check the issue is unclaimed, claim it,
branch from `origin/testing` in a worktree, PR with `--base testing` and
`Refs #N`, and leave validation to the maintainer. State verified 2026-08-15: no
live claim tags, no `wip` issues, two open dependabot PRs (#357, #359).
