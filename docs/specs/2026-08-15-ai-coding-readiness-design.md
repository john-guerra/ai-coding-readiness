# `ai-coding-readiness` — design

**Date:** 2026-08-15
**Status:** draft, pending review
**Ships as:** a separate public repository, `john-guerra/ai-coding-readiness`,
installable as a Claude Code plugin. Command namespace `/ai-ready`.

---

## 1. What this is

A tool that **diagnoses** how ready a GitHub repository is for AI-assisted
collaboration, and then **adapts** it — writing the harness that makes multiple
AI agents and multiple humans able to work on it simultaneously without
colliding, and making its quality rules mechanically enforced rather than merely
documented.

Two halves of one tool, bound by a single rule:

> **Every check ships with its remediation, or it doesn't ship.**

That rule is what separates this from a linter. It also disciplines the check
list from the far end: if you cannot write the fix, you do not understand the
problem well enough to assert it is one.

| Command | Does | Mutates |
| --- | --- | --- |
| `/ai-ready:audit` | Read-only diagnosis: readiness report, unenforced-invariant report, contention scan | No |
| `/ai-ready:adapt` | Confirm detected facts → interview → editable plan → **one PR** → gated GitHub actions | Yes, reviewably |

### Non-goals

- **Not a greenfield scaffolder.** GitHub Spec Kit owns that lane. This is
  brownfield audit-and-adapt.
- **Not a rules engine.** `repolinter` proved that shape is a graveyard. ~12
  hardcoded checks as plain functions; no configurable rulesets.
- **Not a generic code reviewer.** `/code-review`, `/security-review`, and
  `feature-dev:code-reviewer` already exist and are better resourced.
- **Not a TDD or verification skill.** `superpowers` ships two.
- **Not a monorepo tool** in v0.1. Detect and refuse with a clear message.
- **Not a security scanner.** Defer to OpenSSF Scorecard (v0.2 integration).

---

## 2. Evidence base

Every design decision below traces to a measurement taken on
`john-guerra/autogallery`, a mature AI-coded repo (2,078 unit tests, 187 e2e
tests, 68 open issues, 3+ concurrent agents). Measured 2026-08-15.

| Measurement | Value | Drives |
| --- | --- | --- |
| Files in >70% of last 30 merged PR diffs | `package.json` 27/30, `CHANGELOG.md` 23/30 | §6 contention scan |
| CI wall clock, last 12 runs | 10–11 min | §7 gate ladder |
| Unit suite, local | 2,078 tests / 19 s | §7 — units are not the problem |
| e2e config | `workers: 1`, `fullyParallel: false`, 52 files | §7 sharding remediation |
| e2e tests tagged `@p0` | 10 of 187; **no runner wired** for the tag | §8 — a rule with no runner is decoration |
| CI failures by job, last 20 | `check` 12, `e2e` 4 | §7 — the fast job is the problem |
| Failing step in 13 inspected failures | **`npm audit` in 9** | §7 `ci.no-diff-can-fail-on-gate` |
| Same-SHA fail→pass (flake proxy), last 200 | **0** | Flake quarantine **cut** — unsupported |
| Merged PR size, last 60 | median 302 lines; 6 under 30 | Tiny-PR batching **cut** — unsupported |
| Issue backlog | 68 open / 158 closed, 94% prioritized, none >39 days | Grooming **cut**; filing bar kept |
| Linter / static analysis | **none** (Prettier only) | §8 rung 3 is unavailable → rules fall to rung 6 |
| `.gitattributes` | absent | §6 |
| `agent-id.sh` non-Claude fallback | `hostname#$$` — PID, changes per call | §6 identity fix |
| `docs/TESTING.md` claims e2e is "~30s" | actual ~10 min | §5 `loop.timing` |

**Method note:** the flake proxy only detects flakes that were re-run, and only
3 SHAs were re-run at all, so it is weak evidence of *absence*. It is strong
evidence that flake is not the *dominant* cause; `npm audit` is.

---

## 3. Architecture

Two layers, split by what each side is good at.

```
ai-coding-readiness/
├─ .claude-plugin/plugin.json, marketplace.json
├─ bin/
│  ├─ audit.mjs           # DETERMINISTIC. No LLM. `npx ai-coding-readiness audit`
│  └─ validate.mjs        # the validation-queue CLI (§9) — v0.1 stretch, see §13
├─ lib/checks/*.mjs       # one file per check, unit-tested against fixtures
├─ lib/regions.mjs        # marked-region read/write + manifest (§4)
├─ packs/node/            # version read/bump, CI matrix, test runner, browser tier
├─ skills/
│  ├─ adapt-repo/         # audit → interview → plan → PR          [one-time]
│  ├─ working-issues/     # claim protocol, filing bar, `next`     [recurring]
│  └─ enforce-a-rule/     # walk a prose rule down the ladder      [recurring]
├─ agents/invariant-reviewer.md
├─ templates/             # what gets written INTO target repos
└─ test/fixtures/         # repos at each readiness level
```

**Why the split.** Checking whether `.github/dependabot.yml` exists does not need
a model: a script is faster, deterministic, testable, and reproducible when
someone files a bug. Judging whether a `CLAUDE.md` is *good*, or whether a rule
can be mechanized, does need one.

**Deliberate exception to "procedure stays in the plugin":** `pr-closeout.yml`
and any claim scripts are written into the target repo, because CI and
non-plugin-users must be able to run them. Because they must also be templated
per-repo, they are **generated files** and go through the marked-region
machinery in §4 like everything else.

---

## 4. Generated files: marked regions and a manifest

The single largest failure mode for a repo-mutating tool is destroying
hand-written content on the second run. autogallery's `CLAUDE.md` is 438 lines
containing four traps that each cost an afternoon to learn; they cannot be
regenerated.

**Mechanism** (borrowed wholesale from `all-contributors`, which survived a
decade of writing into other people's READMEs):

```markdown
<!-- ai-readiness:begin id=commands v=1 -->
...generated...
<!-- ai-readiness:end id=commands -->
```

- The tool writes **only** inside marked regions. Never a byte outside.
- `.ai-readiness/manifest.json` records `file → region → hash` at write time.
  On re-run: hash unchanged → safe to update; hash changed → the human edited
  it, so **propose a diff, never overwrite**.
- Files with no markers (a pre-existing `CLAUDE.md`) get markers inserted around
  *newly added* sections only; existing prose is left alone.

**Idempotency is an assertion, not an aspiration.** For every fixture:
`run; run; git diff --exit-code` must be clean. This is a test, and it gates
release.

`.ai-readiness.json` (separate from the manifest) records the interview answers,
the chosen pack, and any waived check **with a reason**, plus a `schemaVersion`
so check-ID churn is survivable.

```jsonc
{
  "schemaVersion": 1,
  "pack": "node",
  "concurrency": { "agents": "many", "humans": 1, "validator": "human-before-close" },
  "blastRadius": "user-data",
  "branches": { "trunk": "testing", "releaseLine": "main" },
  "verification": { "browserTier": true, "driver": "playwright" },
  "waived": { "ci.codeql": "private repo, no Advanced Security seat" }
}
```

---

## 5. The audit contract

Each check emits:

```jsonc
{
  "id": "ci.build-step",
  "tier": 1,
  "status": "pass" | "fail" | "unknown",
  "effort": "S" | "M" | "L",
  "evidence": ".github/workflows/ci.yml runs `npm test` but no build step",
  "why": "A unit suite cannot see integration/import breakage; the build can.",
  "precondition": null,
  "fix": "Add a build step to the `check` job."
}
```

Four rules govern the check set:

1. **`unknown` is a first-class status.** Branch protection, code scanning, and
   issue labels need the GitHub API. Without credentials the honest answer is
   "could not check", never "pass". To keep `unknown` from being the modal
   state, the tool **reuses `gh auth`** rather than demanding a token — nearly
   every target user already has `gh` authenticated.
2. **Every `fix` carries a `precondition` where one exists.** This is not
   cosmetic. `test.e2e-parallel` naively prescribes "unpin workers"; on
   autogallery that produces a flaky suite, because one shared SQLite home and
   one dev server are load-bearing. A confidently wrong `fix` is worse than a
   missing check, because the human delegated the judgment.
3. **Any check whose fix is not verifiable by re-running the audit does not
   ship.**
4. **Coupled checks report as a composite.** Claim tags without a close-out
   workflow are worse than neither, so they cannot be half-adopted.

### v0.1 check set (~12)

Tiers survive as the report's **vocabulary** (each check is labeled T0/T1/T2, so
the scorecard reads as a ladder). They are *not* an install-time branch:
installation offers `--express` (defaults) or recommended, plus `--minimal`.

| id | T | Detects | Remediation it writes |
| --- | --- | --- | --- |
| `guide.exists` | 0 | No agent guide, or one that never names build/test/run | `CLAUDE.md` + `AGENTS.md`, seeded from the interview |
| `guide.guardrails` | 0 | No "never touch" / destructive-action policy | Guardrails region + `deny` list in `.claude/settings.json` |
| `repo.hygiene` | 0 | Missing lockfile; `.gitignore` gaps; secret-shaped tracked strings | Lockfile commit, `.gitignore` additions |
| `ci.gate-completeness` | 1 | CI does not resolve to format → test → build (parsed from the job graph, not grepped) | Adds the missing steps |
| `ci.no-diff-can-fail-on-gate` | 1 | Merge-gate steps that fail without a code change — `npm audit`, license scans, external APIs | Moves them to a scheduled job that files an issue on failure |
| `ci.e2e-sharded` | 1 | Browser tier runs unsharded on the merge gate | `--shard` matrix; each shard gets its own runner, therefore its own server and temp dir. **No test rewrites, hermeticity preserved** |
| `quality.static-analysis` | 1 | No linter / typechecker at all | Bootstraps ESLint (+ `tsc --checkJs` where JSDoc types exist) and wires it to the hooks and CI |
| `loop.timing` | 1 | Each gate rung timed against its budget; also flags docs asserting stale numbers | Wires the fast subset; corrects generated doc numbers |
| `concurrency.pr-path-contention` | 2 | Files appearing in >70% of the last 50 merged PR diffs | changesets/towncrier + `.gitattributes`; CI assembles at release |
| `concurrency.parallel-suite` | 2 | Suite cannot run twice concurrently | Env-parameterized ports + per-run temp dirs |
| `concurrency.claim-composite` | 2 | Claim mechanism present without close-out or labels (or vice versa) | Installs the missing half, or removes the orphan |
| `docs.unenforced-invariants` | 2 | MUST/NEVER statements in the agent guide with no mechanical backing | Per §8: tests, lint rules, or CI greps |
| `security.workflow-hygiene` | 1 | `pull_request_target` on untrusted input; unpinned third-party actions; over-broad `permissions:`; untrusted text interpolated into `run:` | Rewrites to SHA pins, minimal permissions, `env:`-passed values. **The plugin's own generated workflows must pass this** (§12) |

`concurrency.parallel-suite` is the highest-value check in the set: one command,
no configuration, and it is a direct empirical proxy for *"can two agents work
here at once?"* — the entire design center reduced to pass/fail.

---

## 6. Concurrency: remove contention, then lock what remains

The reframe is deliberate. The instinct is to add locks; the better first
question is *why is this file in every diff?*

| Rung | Installs | Verified by |
| --- | --- | --- |
| **A — always** | worktree + branch per agent · **no shared mutable file on the PR path** (changesets / towncrier) · per-agent test isolation | `concurrency.pr-path-contention`, `concurrency.parallel-suite` |
| **B — agents > 1** | issue claim (`wip` label + claim comment) · `pr-closeout.yml` | `concurrency.claim-composite` |
| **C — escape hatch** | remote-tag CAS version claim, for repos that must bump per PR | precondition-gated; not offered otherwise |
| **Human half** | CODEOWNERS · required review · **merge queue** | — |

**Why changesets replaces the version-claim CAS as the default.** The CAS is a
correct primitive — creating a remote ref is the only true compare-and-swap
GitHub offers — but it locks one of two contended files and has an inherent
liveness defect (claim order need not match merge order, requiring a manual
re-claim). Per-PR changelog *fragments* are new files, conflict-free by
construction, and eliminate the version race, the changelog conflict, and the
stale-claim defect together, using a maintained upstream dependency instead of
bespoke bash.

**The CAS stays as a documented escape hatch**, because autogallery legitimately
needs it: its version appears in the title bar and is how the maintainer
confirms which build he is validating, so it must bump per PR.

**Merge queue is the T2 headline**, not the CAS. It is the only mechanism that
*mechanically* prevents two individually-green PRs going red together — a class
autogallery has already been bitten by, and which no local gate can catch.

**Agent identity.** `agent-id.sh` currently falls back to `hostname#$$` when
`CLAUDE_CODE_SESSION_ID` is absent — the PID, which changes on every
invocation, violating its own documented "never changes" contract for every
non-Claude agent and every human. Replaced with a UUID persisted at
`.git/ai-agent-id`: harness-agnostic, per-worktree, outside the tree, stable
across invocations. Transcript parsing is demoted to optional *label*
enrichment, never used for matching.

---

## 7. CI/CD: local-fast, remote-authoritative

**Invariant: local gates optimize for speed and are advisory; remote gates
optimize for truth and are authoritative. Never the reverse.**

Local checks cannot gate a merge queue, can be bypassed, can pass on a stale
`node_modules`, and cannot catch two-individually-green-PRs-red-together. Under
a multi-agent design center they are also actively harmful as the primary gate:
N agents running a 10-minute suite contend for the same cores, where CI is
elastically parallel.

| Stage | Runs | Budget | Enforced by |
| --- | --- | --- | --- |
| Inner loop (TDD) | the one test being driven, watch mode | < 2 s | nothing — it's the loop |
| Pre-commit | format + lint, staged files only | < 5 s | hook (bypassable, fine) |
| Pre-push | typecheck + affected units + `@p0` browser subset | < 60 s | hook |
| **PR CI** | full units + sharded browser tier | < 3 min | **required check — the gate** |
| Post-merge / nightly | full matrix, `npm audit`, CodeQL, slow tier | unbounded | branch health |

For **agents**, CI latency is a merge-queue-depth problem, not a feedback
problem — the agent ends its turn at `gh pr merge --auto` and never waits. The
goal is therefore making CI *rarely red*, not fast. Which is why
`ci.no-diff-can-fail-on-gate` matters more than raw speed: on autogallery,
`npm audit` on the merge gate accounts for 9 of 13 inspected failures.

**Outages** are handled by protocol, not architecture: an `--admin` break-glass
gated on pasted local evidence plus a status-page link, shipped as part of
`working-issues`.

---

## 8. Mechanical enforcement — the headline

The diagnosis is written in autogallery's own guide: three UI contracts were
*"settled once… then re-broken by the next feature, because the rule lived only
in a closed issue."* The fix attempted — `@`-importing the contracts so they are
in context from token zero — is stronger *persuasion*, paid for on every
session. It is not enforcement, and it did not stop the re-breaks.

Four independent instances of the same pattern were measured in one repo:
`@p0` tags with no runner; `TESTING.md` asserting 30 s for a 10-minute suite;
three UI contracts re-broken; the validation-handoff rule (§9) ignored. That is
not bad luck — it is the thesis.

### The ladder

| Rung | Mechanism | Real example from autogallery |
| --- | --- | --- |
| 1 | **Make it impossible** (API shape) | "Long ops are jobs" holds if the only entry point returns `{jobId}` |
| 2 | **Registry-driven test** | One test enumerates every *registered* operation and asserts each exposes its scope control — new features are covered the day they register |
| 3 | **Lint rule** | "`$:` must never depend on a `bind:this` element" is a plain AST rule. **Currently unavailable — the repo has no linter** |
| 4 | **CI grep / parity check** | every shortcut ⟺ a `ShortcutsOverlay` row; every file-serving route ⟺ `safeResolve.js` |
| 5 | PR-template checkbox | — |
| 6 | Prose in the agent guide | **where all three contracts live today** |

### Deliverables

- **Skill `enforce-a-rule`** — takes a MUST/NEVER from the agent guide and walks
  the author down to the strongest mechanizable rung, then writes the check.
  This is *the* post-adapt skill: it converts new scar tissue into new
  enforcement, which is the difference between a one-time cleanup and a
  practice.
- **Check `docs.unenforced-invariants`** — extracts MUST/NEVER statements and
  reports which have no mechanical backing.
- **Agent `invariant-reviewer`** — a fresh context seeing only the diff and the
  rules that *could not* be mechanized (rungs 5–6), told to report gaps rather
  than style preferences. Wired into a generated PR job that posts a comment.
  **Advisory, never a gate** — model judgment in CI is nondeterministic, and
  gating on it recreates the flaky-red-with-no-diff problem `npm audit` is being
  moved off the gate to avoid.

**Mechanical rules gate. Model judgment advises. Never the reverse.**

---

## 9. The validation loop

The gap between *"the agent says done"* and *"the maintainer agrees it's done"*
is where issues die. autogallery specifies the fix in prose — always answer
Where / What command / What to check — and agents still skip it, so
`needs-validation` issues accumulate unvalidated.

Rung 6 failing, again. So mechanize it.

**1 — The agent emits a machine-readable block**, not prose:

````markdown
```validation
where:   http://localhost:5173   # title bar must read v2.21.8
run:     npm run electron:dev
cwd:     .
prereq:  kill other dev servers — Vite silently moves to 5174
steps:
  - do:     Run face detection on the 597 photos with none
    expect: an amber pill appears; pressing it raises the count
    risk:   most likely wrong here — the idle gate may not fire
```
````

**2 — CI enforces it.** `pr-closeout.yml` already swaps `wip →
needs-validation`. Extended: **no parseable `validation` block, no label swap** —
the bot comments asking for one. An agent cannot hand off work without a
runnable handoff.

**3 — `npx ai-ready validate` makes it cheap.** Reads the `needs-validation`
queue; per issue prints the block, offers to run the command, takes
`[p]ass / [f]ail / [s]kip`. Pass closes with a comment; fail relabels and
captures why.

**4 — The same session captures usability findings.** A validation session *is*
a usability run: the maintainer finds six things at once, and the failure mode
is that two get fixed inline and four evaporate with the conversation. The CLI
ends by batching them — dedupe against open issues, triage each (file / fold
into existing / fix now / wontfix), and **one** priority confirmation covering
all of them rather than six round-trips, which is the approval fatigue the
readiness checklist warns about explicitly.

> You reported 6 things. 2 match existing issues (#341, #298 — commented).
> 3 new issues filed (#357–359). 1 fixed inline. Nothing was dropped.

**Implementation constraint:** plain readline, no TUI framework. The job is
print-three-lines-and-read-a-key.

---

## 10. The interview

**Rule: never ask what the audit can detect.** Detected facts are presented as
one batch of *confirmations*; only the genuinely unmeasurable is asked.

| Asks | Why unmeasurable | Changes | Default |
| --- | --- | --- | --- |
| Concurrent agents / humans | Agent commits are authored *as the human* — git history cannot tell you | Whether the claim protocol installs at all | solo, one agent |
| Who validates; is merge == done | Social fact | `Refs` vs `Closes`; validation queue; review count | merge == done |
| Blast radius | Intent | Which actions auto-approve vs. gate; soft-delete mandate | **required — no default** |
| Trunk / release line | Branch names show shape, not intent | Version floor; PR base; which branches CI gates | repo default branch |
| Versioning policy | Policy | changesets vs. nothing vs. the CAS escape hatch | inferred from CHANGELOG + tags |
| Browser tier needed | A repo can have a UI and still not need it | Whether the browser tier and `.mcp.json` install | on if e2e dir or UI framework detected |
| **What has cost you an afternoon?** | Pure tribal knowledge | The traps section — the highest-value content, ungeneratable | **required** |
| **What must an agent never touch?** | Pure policy | Guardrails + `deny` list | **required** |

**Default everything except where a wrong default is costly in both
directions.** Blast radius is exactly that case: default low and you under-gate
something touching PII; default high and you over-gate everything, producing the
approval fatigue that inverts into *less* oversight. Traps and guardrails are
required because they are the only content no tool can synthesize.

**Adaptive follow-ups.** A cheap model call receives the audit JSON, the answers
so far, and a repo fingerprint, held to one test: *propose a question only if a
different answer would change a file we write.* Maximum 3, each naming the file
it affects and carrying a default. This catches what a fixed list cannot —
workspaces detected, competing `.cursor/rules` files, a trunk with 400 commits
and no PRs.

**The catch-all is attached to the plan, not the questionnaire.** "Anything else
I should know?" after a questionnaire reliably returns "no"; people are poor at
free recall and excellent at criticism. So the open question is asked once,
against a concrete file list, and is explicitly two-way — it can add context and
remove files. Whatever comes back is recorded verbatim, never absorbed into one
turn's reasoning and lost.

`--express` accepts every default and asks only the three required questions.

---

## 11. Backlog discipline

Measured: 68 open / 158 closed, 94% prioritized, nothing older than 39 days,
~4 issues filed per day. The backlog is **healthy**; the complaint is **rate**.

So: a **significance bar at filing time**, not grooming. Grooming solves
staleness, which is not the problem. The `working-issues` filing rule gains an
explicit bar and a "propose, don't file" path for anything the agent originated
itself rather than a human reporting it.

**Cut, as unsupported by evidence:** tiny-PR batching (median PR is 302 lines;
only 6 of 60 under 30 lines) and flake quarantine (0 of 200 runs show same-SHA
fail→pass). Adding either would be speculative harness — precisely the debt the
readiness checklist warns has a ~90-day half-life.

`/ai-ready:next` is a thin command inside `working-issues`, not a separate
skill: priority order × unclaimed × unblocked is a `gh` query plus the
pre-flight check the skill already specifies. Selection and claim are one atomic
decision — choosing an issue you cannot claim is a wasted turn.

---

## 12. Blast radius and trust

- **All file changes land as one reviewable PR** on a branch, which also
  dogfoods the harness just installed.
- **Irreversible GitHub API actions** — branch protection, label creation,
  enabling code scanning, merge queue — are proposed as a checklist requiring
  explicit per-action approval. They cannot be reviewed in a diff or undone with
  `git revert`.
- A popular plugin that writes `.github/workflows/` is a high-value compromise
  target. Generated workflows therefore: never use `pull_request_target`; pin
  third-party actions by SHA; declare minimal `permissions:`; and never
  interpolate untrusted text into `run:` (pass via `env:` and re-validate).
  **The plugin's own generated workflows must pass the plugin's own
  `security.workflow-hygiene` check** — that is the credibility demonstration.
- Signed releases with provenance from v0.1. Cheap now, impossible
  retroactively.
- **No telemetry.** `--report` emits redactable JSON plus an issue template that
  asks for it. That is the entire feedback loop a public tool needs.

---

## 13. Scope

### v0.1 ships

Node pack only · ~12 checks · `/ai-ready:audit` and `/ai-ready:adapt` · skills
`adapt-repo`, `working-issues`, `enforce-a-rule` · agent `invariant-reviewer` ·
marked regions + manifest + idempotency tests · the validation block and its CI
enforcement.

### Deferred

| Deferred | Trigger to add |
| --- | --- |
| Python pack | The node pack interface proven against a second real repo — not written blind |
| `npx ai-ready validate` CLI | v0.1 stretch. The block + CI check deliver value alone; the CLI multiplies it |
| Scorecard integration | v0.2. Do not rebuild its ~8 checks; detect it, defer to it, recommend its Action |
| GitHub Action entrypoint | A consumer exists |
| Scheduled drift Action | Real adopters exist. `.ai-readiness.json` is retained; only the Action is deferred |
| Monorepo support | v0.1 detects and refuses |
| Non-GitHub forges | v0.1 is GitHub-only, detected early, refused with one sentence |

### Validation before release

1. Every fixture asserts `run; run; git diff --exit-code` is clean.
2. **Run the audit against ~20 well-known public repos and read the output.**
   Fixtures test the checks; this tests whether the output is *smart*. Anything
   dumb said about a repo everyone agrees is well-run is a bug.
3. The plugin's own repo passes its own audit at the recommended level.

---

## 14. Prior art

**Depend, do not rebuild:** OpenSSF Scorecard (branch protection, dangerous
workflows, token permissions, pinned deps, SAST, signed releases) · changesets /
towncrier (the contention fix) · nx / turbo `affected` (detect the tool, do not
build selection) · husky + lint-staged / pre-commit (the local rungs) ·
`claude init` (initial guide generation).

**Positioning:** GitHub Spec Kit owns greenfield SDD scaffolding — defer to it.
`repolinter` is archived, and its lesson is twofold: the generic-rules-engine
shape is a known graveyard, and the differentiator must be AI-agent-specific
*content*, not a linting engine. `all-contributors` supplies the marked-region
mechanism. Backstage scaffolder shows that scaffold-then-drift is the whole
problem, which is why §4 is not optional.

**Genuinely novel:** the interview → one-PR flow on a *brownfield* repo; the
parallel-agent contention model; the unenforced-invariant report; the enforced
validation handoff.

---

## 15. Open risks

1. **The `fix` field is the product's liability surface.** A confidently wrong
   remediation is worse than no check. Mitigated by preconditions, by requiring
   fixes to be audit-verifiable, and by the 20-public-repo read-through — but it
   remains the thing most likely to cause harm.
2. **`unknown` fatigue.** If `gh auth` reuse fails often, most users see a wall
   of `unknown` and conclude the tool is broken.
3. **Scope of `enforce-a-rule`.** Walking an arbitrary prose rule down to a lint
   rule is genuinely hard. It may only reliably reach rung 4 (CI grep), which is
   still a large improvement over rung 6 but less than the pitch implies.
4. **N=1 reference repo.** Nearly every measurement here comes from one
   codebase, by one author, in one language. The 20-repo read-through is the
   only planned defense.
