# `ai-coding-readiness` — design

**Date:** 2026-08-15 · **Revision:** 2 (after two independent review passes)
**Status:** draft
**Ships as:** the public repository `john-guerra/ai-coding-readiness`,
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

That rule separates this from a linter, and it disciplines the check list from
the far end: if you cannot write the fix, you do not understand the problem well
enough to assert it is one.

| Command | Does | Mutates |
| --- | --- | --- |
| `/ai-ready:audit` | Read-only diagnosis: readiness report, unenforced-invariant report, contention profile | No |
| `/ai-ready:adapt` | Confirm detected facts → interview → editable plan → **one PR** → gated GitHub actions | Yes, reviewably |

### Non-goals

- **Not a greenfield scaffolder.** GitHub Spec Kit owns that lane; this is
  brownfield audit-and-adapt.
- **Not a rules engine.** `repolinter` proved that shape is a graveyard. ~13
  hardcoded checks as plain functions; no configurable rulesets.
- **Not a code reviewer.** `/code-review`, `/security-review`, and
  `feature-dev:code-reviewer` exist and are better resourced.
- **Not a TDD or verification skill.** `superpowers` ships two.
- **Not a monorepo tool** in v0.1 — detect and refuse.
- **Not a security scanner.** Defer to OpenSSF Scorecard.

---

## 2. Evidence base

Every decision below traces to a measurement on `john-guerra/autogallery`, a
mature AI-coded repo (2,078 unit tests, 187 e2e tests, 68 open issues, 3+
concurrent agents). Measured 2026-08-15.

| Measurement | Value | Drives |
| --- | --- | --- |
| Files in >70% of last 30 merged PR diffs | `package.json` 26–27/30, `CHANGELOG.md` 23/30 | §6 |
| Largest source files, and their PR frequency | `ui/src/App.svelte` **7,409 lines** at 23%; `server/api.js` **4,913** at 27% | §5 — **a 70% threshold misses both** |
| CI wall clock, last 12 runs | 10–11 min | §7 |
| Unit suite, local | 2,078 tests / 19 s | §7 — units are not the problem |
| e2e config | `workers: 1`, `fullyParallel: false`, 52 files | §7 |
| Largest e2e spec vs. next | `face-map.spec.js` **676** vs `faces-scope.spec.js` **475** | §5 — sharding wall clock is `max(file)`, not `total/N` |
| e2e tests tagged `@p0` | 10 of 187; **no runner wired** | §8 — a rule with no runner is decoration |
| CI failures by job, last 20 | `check` 12, `e2e` 4 | §7 — the *fast* job is the problem |
| Failing step, 13 inspected failures | **`npm audit` in 9** | §7 `ci.no-diff-can-fail-on-gate` |
| Merged PR size, last 60 | median 302 lines; 6 under 30 | Tiny-PR batching **cut — unsupported** |
| Linter / static analysis | **none** (Prettier only) | §8 rung 3 unavailable → rules fall to rung 6 |
| `.gitattributes` | absent | §6 |
| `agent-id.sh` non-Claude fallback | `hostname#$$` — PID, changes per call | §6 |
| `docs/TESTING.md` claims e2e is "~30s" | actual ~10 min | §5 doc-staleness |

### Two measurements that were retracted

Recorded because they nearly became features, and because the failure mode
generalizes.

**Flake.** A first pass found 0 of 200 CI runs with a same-SHA fail→pass and
concluded flake was not a problem. That conclusion is void:
`playwright.config.js` has **no `retries` key**, so retries default to 0 and
Playwright never classifies a test as `flaky` — a flaky test simply fails. With
`--auto` merges nobody re-runs (3 SHAs of 200). The instrument cannot emit the
signal that was measured, so zero was the only possible result whether real
flake is 0% or 30%. **This drives `ci.flake-observability` (§5): install the
instrument before drawing the conclusion.** The independent finding that
survives — `npm audit` in 9 of 13 failures — does not depend on the flake proxy
at all.

**Backlog staleness.** A first pass observed "nothing older than 39 days" and
concluded the backlog was healthy. The tracker's *first* issue is from
2026-07-06 and today is 2026-08-15: the repo is 40 days old, so that observation
restates the tracker's age rather than measuring health. (The first issue ever
filed is also still open — mild evidence the other way.) **Correct statement: we
cannot yet tell whether this backlog stales.** Grooming is therefore cut, on the
same standard that cut flake quarantine and tiny-PR batching.

> **Standing method rule: before reporting a measurement, establish that the
> instrument can produce a non-trivial result.** Both retractions are the same
> error — a confident number from an instrument that could only ever return that
> number.

---

## 3. Architecture

```
ai-coding-readiness/
├─ .claude-plugin/plugin.json, marketplace.json
├─ bin/audit.mjs          # DETERMINISTIC. No LLM.
├─ lib/checks/*.mjs       # one file per check, unit-tested against fixtures
├─ lib/regions.mjs        # marked-region read/write + manifest (§4)
├─ lib/validation.mjs     # THE single parser for the §9 block (CI + CLI share it)
├─ packs/node/
├─ skills/
│  ├─ adapt-repo/         # audit → interview → plan → PR       [one-time]
│  ├─ working-issues/     # claim protocol, filing bar, `next`  [recurring]
│  └─ enforce-a-rule/     # walk a prose rule down the ladder   [recurring]
├─ templates/
└─ test/fixtures/
```

**Why the split.** Checking whether `.github/dependabot.yml` exists does not
need a model: a script is faster, deterministic, testable, and reproducible when
someone files a bug. Judging whether an agent guide is *good*, or whether a rule
can be mechanized, does.

`pr-closeout.yml` and any claim scripts are written into the target repo,
because CI and non-plugin-users must run them. Since they must also be templated
per-repo, they are **generated files** and go through §4 like everything else.

---

## 4. Generated files: marked regions and a manifest

The largest failure mode for a repo-mutating tool is destroying hand-written
content on the second run. autogallery's `CLAUDE.md` holds four traps that each
cost an afternoon; they cannot be regenerated.

Mechanism, borrowed from `all-contributors`:

```markdown
<!-- ai-readiness:begin id=commands v=1 -->
...generated...
<!-- ai-readiness:end id=commands -->
```

- Write **only** inside marked regions. Never a byte outside.
- `.ai-readiness/manifest.json` records `file → region → hash → status` at write
  time. On re-run: hash unchanged → safe to update; hash changed → the human
  edited it, so **propose a diff, never overwrite**.
- `status: active | retired`. When a later version stops generating a region it
  is marked `retired` and removal offered — otherwise abandoned regions
  accumulate across every adopting repo with nothing knowing they are dead.
- Pre-existing files get markers inserted around *newly added* sections only.
- **Generated regions are written append-friendly** (one fact per line) wherever
  possible. Marked regions protect the human's prose from the tool; they do not
  protect two concurrent agents editing the same generated region. The agent
  guide is itself contended — measured at 7/30 PRs, with `docs/AGENT-NOTES.md`
  at 9/30.

**Idempotency is a release gate, not an aspiration.** For every fixture:
`run; run; git diff --exit-code` must be clean.

`.ai-readiness.json` is **re-readable input, not just a record**: editing
`concurrency.agents` from `solo` to `many` and re-running installs rung B. Every
`waived` entry carries a **date**, and the audit surfaces waivers older than six
months as a finding — an undated waiver is permanent, invisible debt.

```jsonc
{
  "schemaVersion": 1,
  "pack": "node",
  "concurrency": { "agents": "many", "humans": 1, "validator": "human-before-close" },
  "blastRadius": "user-data",
  "branches": { "trunk": "testing", "releaseLine": "main" },
  "verification": { "browserTier": true, "driver": "playwright" },
  "waived": { "ci.codeql": { "why": "private repo, no Advanced Security seat", "on": "2026-08-15" } }
}
```

---

## 5. The audit contract

```jsonc
{
  "id": "ci.e2e-sharded",
  "tier": 1,
  "status": "pass" | "fail" | "unknown",
  "effort": "S" | "M" | "L",
  "evidence": "...",
  "why": "...",
  "precondition": "No single spec file dominates total duration.",
  "fix": "..."
}
```

Five rules govern the set:

1. **`unknown` is a first-class status.** Branch protection, code scanning, and
   labels need the GitHub API; without credentials the honest answer is "could
   not check", never "pass". To keep `unknown` from being the modal state, the
   tool **reuses `gh auth`** rather than demanding a token.
2. **Every `fix` carries a `precondition` where one exists** — applied, not
   merely stated. A confidently wrong `fix` is worse than a missing check,
   because the human delegated the judgment.
3. **Any check whose fix is not verifiable by re-running the audit does not
   ship.**
4. **Coupled checks report as a composite.** Half-adopting is worse than
   neither.
5. **A check may report a finding it cannot auto-fix, provided it says so.**
   What it may never do is prescribe a fix that does not apply.

### v0.1 check set

Tiers are the report's **vocabulary** (each check labeled T0/T1/T2, so the
scorecard reads as a ladder), not an install-time branch. Two **orthogonal**
flags: `--express` governs *how many questions are asked* (§10); `--minimal`
governs *how many checks are installed*. They compose.

| id | T | Detects | Precondition | Remediation |
| --- | --- | --- | --- | --- |
| `guide.exists` | 0 | No agent guide, or one that never names build/test/run | — | `CLAUDE.md` + `AGENTS.md` from the interview |
| `guide.guardrails` | 0 | No "never touch" / destructive-action policy | — | Guardrails region + `deny` list in `.claude/settings.json` |
| `guide.context-budget` | 0 | **Total instruction lines loaded every session** — the guide plus everything it `@`-imports — against the official <200-line target. Imports do **not** reduce context; they load at launch | — | Move path-specific content into `.claude/rules/` with `paths:` frontmatter, so a rule loads when Claude touches matching files and never otherwise. Defer to `/doctor`'s trim check where available |
| `guide.gold-standard` | 1 | The guide names no exemplary file that demonstrates its conventions | Requires a human to nominate the file | Interview question → a guide region pointing at it, plus correct/incorrect snippets for the rules that most often get broken |
| `test.assertion-free` | 1 | Tests containing no assertion at all | — | Reported per file with the test name; no auto-fix — a test with no assertion needs an author, not a generator |
| `repo.hygiene` | 0 | Missing lockfile; `.gitignore` gaps; secret-shaped tracked strings | Lockfile generation resolves the graph *now* | `npm i --package-lock-only`, **flagged as requiring a green CI run** — it can silently move transitive versions off what the maintainer has been running |
| `ci.gate-completeness` | 1 | CI does not resolve to format → test → build (parsed from the job graph, never grepped) | — | Adds the missing steps |
| `ci.no-diff-can-fail-on-gate` | 1 | Merge-gate steps that fail without a code change — `npm audit`, license scans, external APIs | — | Moves them to a scheduled job that **updates one search-by-title issue, never files per run** (§11) |
| `ci.e2e-sharded` | 1 | Browser tier unsharded on the merge gate | **No single spec dominates**; special fixtures (e.g. a big-library spec) must be set up in whichever shard draws them | Measure per-file duration; split dominant files; *then* `--shard` matrix. Each shard gets its own runner → own server → own temp dir, so hermeticity holds with **no test rewrites** |
| `ci.flake-observability` | 1 | The browser tier cannot report flakes at all (no `retries` configured) | — | `retries: 1` in CI + report the `flaky` count. One line; converts an unmeasurable into a measurable (§2) |
| `quality.static-analysis` | 1 | No linter / typechecker | **Measure the finding count first.** Above threshold the fix is a baseline, not a gate | **Baseline-and-ratchet**: lint changed files at the hook rung; at CI a checked-in baseline or `--max-warnings <current>`, so the gate is *no new violations*, never *zero violations* |
| `security.workflow-hygiene` | 1 | `pull_request_target` on untrusted input; unpinned third-party actions; over-broad `permissions:`; untrusted text in `run:` | — | SHA pins, minimal permissions, `env:`-passed values. **Composite with Dependabot `github-actions`** — a rotting SHA pin is worse than a tag, which at least receives upstream patches |
| `concurrency.pr-path-contention` | 2 | Ranked **contention profile**: file × PR-frequency × size × churn | — | *Split by kind:* shared **metadata** files (version, changelog) → changesets/towncrier + `.gitattributes`. **God-files** → reported as a finding with **no auto-fix**, routed to `enforce-a-rule` and a size budget |
| `concurrency.parallel-suite` | 2 | Suite cannot run twice concurrently | — | *By failure mode:* port collision → env-parameterized ports [S] · shared temp dir/DB → per-run temp [S] · shared remote fixture or global lock → **reported, may not be fixable** [L] |
| `concurrency.claim-composite` | 2 | Claim mechanism without close-out or labels, or vice versa | — | Install the missing half, or remove the orphan |
| `docs.unenforced-invariants` | 2 | MUST/NEVER statements with no mechanical backing; **plus docs asserting numbers the repo contradicts** | — | Per §8: tests, lint rules, CI greps. Stale numbers corrected in place |

`concurrency.parallel-suite` remains the highest-value check: one command, no
configuration, a direct empirical proxy for *"can two agents work here at
once?"*

**Why the contention check became a profile.** A boolean over a 70% threshold
finds exactly the two files already known — and misses `App.svelte` (7,409
lines, 23% of PRs) and `server/api.js` (4,913, 27%), which are worse risks for
both concurrency and quality. That is the decay signal the source checklist
already names: *one monolithic file that keeps growing, that agents pile changes
into because nobody dares refactor it.*

---

## 6. Concurrency: remove contention, then lock what remains

The instinct is to add locks; the better first question is *why is this file in
every diff?*

| Rung | Installs | Verified by |
| --- | --- | --- |
| **A — always** | worktree + branch per agent · no shared mutable **metadata** file on the PR path · per-agent test isolation | `concurrency.pr-path-contention`, `concurrency.parallel-suite` |
| **B — agents > 1** | issue claim (`wip` + claim comment) · `pr-closeout.yml` | `concurrency.claim-composite` |
| **C — escape hatch** | remote-tag CAS version claim, for repos that must bump per PR | precondition-gated |
| **Human half** | CODEOWNERS · required review · **merge queue** | — |

**Why changesets is the default.** The CAS is a correct primitive — a remote ref
is the only true compare-and-swap GitHub offers — but it locks one of two
contended files and has a liveness defect (claim order need not match merge
order, requiring manual re-claim). Per-PR changelog *fragments* are new files,
conflict-free by construction, and remove the version race, the changelog
conflict, and the stale-claim defect together, using a maintained dependency
instead of bespoke bash.

**The CAS stays as a documented escape hatch**, because autogallery legitimately
needs it: its version appears in the title bar and is how the maintainer
confirms which build he is validating.

**Merge queue is the T2 headline**, not the CAS — the only mechanism that
mechanically prevents two individually-green PRs going red together, a class
autogallery has already hit and no local gate can catch.

**Agent identity.** `agent-id.sh` falls back to `hostname#$$` — the PID, which
changes every invocation, violating its own "never changes" contract for every
non-Claude agent and every human. Replaced with a UUID at
**`$(git rev-parse --git-dir)/ai-agent-id`** — *not* the literal `.git/…`, which
breaks in exactly the setup this design centers on: in a linked worktree `.git`
is a **file**, not a directory. Resolving it properly also yields the
per-worktree scoping the protocol wants, for free. Transcript parsing is demoted
to optional *label* enrichment, never used for matching.

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
| Pre-commit | format + lint, **staged files only** | < 5 s | hook (bypassable, fine) |
| Pre-push | typecheck + affected units + fast browser subset | < 60 s | hook |
| **PR CI** | full units + sharded browser tier | < 3 min | **required check — the gate** |
| Post-merge / nightly | full matrix, `npm audit`, CodeQL, slow tier | unbounded | branch health |

For **agents**, CI latency is a merge-queue-depth problem, not a feedback
problem — the agent ends its turn at `gh pr merge --auto` and never waits. The
goal is making CI *rarely red*, not fast. Hence `ci.no-diff-can-fail-on-gate`
matters more than raw speed: `npm audit` on the merge gate accounts for 9 of 13
inspected failures.

**Outages** are handled by protocol, not architecture: an `--admin` break-glass
gated on pasted local evidence plus a status-page link, shipped in
`working-issues`.

---

## 8. Mechanical enforcement — the headline

The diagnosis is in autogallery's own guide: three UI contracts were *"settled
once… then re-broken by the next feature, because the rule lived only in a
closed issue."* The fix attempted — `@`-importing the contracts so they are in
context from token zero — is stronger *persuasion*, paid for on every session.
It is not enforcement, and it did not stop the re-breaks.

Four independent instances of the pattern were measured in one repo: `@p0` tags
with no runner; `TESTING.md` asserting 30 s for a 10-minute suite; three UI
contracts re-broken; the validation-handoff rule (§9) ignored. Not bad luck —
the thesis.

| Rung | Mechanism | Real example |
| --- | --- | --- |
| 1 | **Make it impossible** (API shape) | "Long ops are jobs" holds if the only entry point returns `{jobId}` |
| 2 | **Registry-driven test** | One test enumerates every *registered* operation and asserts each exposes its scope control — new features covered the day they register |
| 3 | **Claude Code hook** — `PreToolUse` blocks a disallowed edit; `Stop` blocks the turn from ending until a check passes | The official enforcement layer: the docs are explicit that *"CLAUDE.md instructions shape Claude's behavior but are not a hard enforcement layer"* and that a hook applies *"regardless of what Claude decides"*. Cheap, immediate, and it fires before the agent can walk away |
| 4 | **Lint rule** | "`$:` must never depend on a `bind:this` element" is a plain AST rule. **Currently unavailable — the repo has no linter** |
| 5 | **CI grep / parity check** | every shortcut ⟺ a `ShortcutsOverlay` row; every file-serving route ⟺ `safeResolve.js` |
| 6 | **Mutation testing** | The general form of the revert-to-confirm-red rule. Already proven in the reference repo: *two vacuous e2e tests shipped and mutation testing is what exposed them.* Nightly, never a gate — it is slow |
| 7 | PR-template checkbox | — |
| 8 | Prose in the agent guide | **where all three contracts live today** |

**Deliverables:**

- **Skill `enforce-a-rule`** — takes a MUST/NEVER from the agent guide and walks
  it down to the strongest mechanizable rung, then writes the check. This is
  *the* post-adapt skill: it converts new scar tissue into new enforcement,
  which is the difference between a one-time cleanup and a practice.
- **Check `docs.unenforced-invariants`** — reports which stated rules have no
  mechanical backing.

**Mechanical rules gate. Model judgment advises. Never the reverse.**

An `invariant-reviewer` agent (a fresh context seeing only the diff and the
rules that *could not* be mechanized) is **deferred to v0.2**: it is a narrowed
version of tools that already exist, advisory by construction, and
`docs.unenforced-invariants` + `enforce-a-rule` deliver the whole thesis without
a CI bot.

---

## 9. The validation loop

The gap between *"the agent says done"* and *"the maintainer agrees it's done"*
is where issues die. autogallery specifies the fix in prose — always answer
Where / What command / What to check — and agents still skip it. Rung 6 failing
again.

**1 — A machine-readable block**, versioned, parsed by **one shared parser**
(`lib/validation.mjs`) so CI can never accept a block the CLI cannot read:

````markdown
```validation v=1
where:   http://localhost:5173
build:   ${GITHUB_SHA}          # the app must report this SHA
run:     npm run electron:dev
cwd:     .
prereq:  kill other dev servers — Vite silently moves to 5174
steps:
  - do:     Run face detection on the 597 photos with none
    expect: an amber pill appears; pressing it raises the count
    risk:   most likely wrong here — the idle gate may not fire
```
````

**Keyed on git SHA, not version.** Under changesets (§6's default) there is no
per-PR version, so a version-keyed handoff gives the validator nothing to check
they are running the right build. Repos on the CAS escape hatch may additionally
show the version.

**Not web-only.** The consumed artifact may be a rendered document, a CLI
output, or a packaged binary. The reference repo's sharpest instance of this
failure was a generated `.docx` that passed XML text checks and still had broken
bullets, collapsed headers, and wrong table styling — caught only by rendering
it to PDF and looking. `where:` therefore accepts a render command, not just a
URL.

**2a — Enforced first by a `Stop` hook, then by CI.** A `Stop` hook blocks the
turn from ending until the handoff parses. That is a better enforcement point
than any CI check, because it fires *before* the agent walks away — and per the
official docs, hooks apply regardless of what the model decides, where guide
prose does not. CI remains the backstop for work that arrives by other paths.

**2b — Enforced at PR open, not at closeout.** The backstop check runs on
`pull_request: [opened, edited, synchronize]` as a **required status check**,
because that is where the leverage is: `pr-closeout.yml` fires on PR *closed*,
by which point the code is already merged.

> This correction matters beyond timing. An earlier design withheld the
> `wip → needs-validation` label swap when the block was missing. But under the
> claim protocol `wip` means *another agent holds this* — so a missing block
> would silently **leak a claim**, removing a finished issue from every other
> agent's candidate set permanently. Punishing a formatting omission by
> orphaning completed work is worse than the problem it prevents. **The label
> swap is now unconditional**; a missing block adds a separate `missing-handoff`
> label.

**3 — `npx ai-ready validate` makes it cheap** *(v0.2)*. Reads the
`needs-validation` queue; per issue prints the block, offers to run the command,
takes `[p]ass / [f]ail / [s]kip`. Pass closes with a comment; fail relabels and
captures why.

> **Security:** `run:` is an agent-authored string executing on the maintainer's
> machine. It is displayed and confirmed **per command**. Never blanket-yes,
> never auto-run. Plain readline; no TUI framework.

**4 — The same session captures usability findings.** A validation session *is*
a usability run: the maintainer finds six things at once, and the failure mode
is that two get fixed inline and four evaporate with the conversation. The CLI
ends by batching them — dedupe against open issues, triage each, and **one**
priority confirmation covering all of them rather than six round-trips, which is
the approval fatigue the source checklist warns about.

> You reported 6 things. 2 match existing issues (#341, #298 — commented).
> 3 new issues filed (#357–359). 1 fixed inline. Nothing was dropped.

---

## 10. The interview

**Never ask what the audit can detect.** Detected facts are presented as one
batch of *confirmations*; only the genuinely unmeasurable is asked.

| Asks | Why unmeasurable | Default |
| --- | --- | --- |
| Concurrent agents / humans | Agent commits are authored *as the human* | solo, one agent |
| Who validates; is merge == done | Social fact | merge == done |
| Blast radius | Intent | **inferred and confirmed** — see below |
| Trunk / release line | Branch names show shape, not intent | repo default branch |
| Versioning policy | Policy | inferred from CHANGELOG + tags |
| Browser tier needed | A repo can have a UI and still not need it | on if e2e dir or UI framework detected |
| **What has cost you an afternoon?** | Pure tribal knowledge — ungeneratable | **required** |
| **What must an agent never touch?** | Pure policy | **required** |

**Default everything except where a wrong default is costly in both
directions.** Blast radius is that case — default low and you under-gate
something touching PII; default high and you over-gate everything, producing the
approval fatigue that inverts into *less* oversight. But it need not be a blank
question: repo signals (does it read `$HOME`? write outside the tree? handle
credentials?) support an inference, and inference-plus-confirmation is this
section's own rule applied consistently. So `--express` **confirms** a proposed
blast radius rather than asking, leaving two genuinely required questions.

**Adaptive follow-ups.** A cheap model call receives the audit JSON, the answers
so far, and a repo fingerprint, held to one test: *propose a question only if a
different answer would change a file we write.* Maximum 3, each naming the file
it affects and carrying a default. This catches what a fixed list cannot —
workspaces detected, competing `.cursor/rules` files, a trunk with 400 commits
and no PRs.

**The catch-all is attached to the plan, not the questionnaire.** "Anything else
I should know?" after a questionnaire reliably returns "no"; people are poor at
free recall and excellent at criticism. So the open question is asked once,
against a concrete file list, explicitly two-way — it can add context and remove
files. Whatever comes back is recorded verbatim.

---

## 11. Backlog

Grooming, staleness policy, and tiny-PR batching are **cut** — see §2. What
remains is defensible on principle without leaning on unsupported evidence:

- **`working-issues` gains one rule:** agents *propose*, never file, anything
  they originated themselves. Human-reported items are filed as before —
  unconditionally, because the conversation is gone tomorrow and the tracker is
  the backlog. The bar applies to agent-originated observations only.
- **Automated issue filing must be idempotent.** Any generated job that files on
  failure (the nightly audit moved off the merge gate, §5) searches by title and
  **updates one issue**, never files per run. A nightly job filing daily until
  someone fixes it is a bot-authored backlog.
- **`/ai-ready:next`** is a thin command inside `working-issues`, not a separate
  skill: priority × unclaimed × unblocked is a `gh` query plus the pre-flight
  check the skill already specifies. Selection and claim are one atomic decision
  — choosing an issue you cannot claim is a wasted turn.

---

## 12. Blast radius and trust

- **All file changes land as one reviewable PR**, which also dogfoods the
  harness just installed.
- **Irreversible GitHub API actions** — branch protection, label creation,
  enabling code scanning, merge queue — are proposed as a checklist requiring
  explicit **per-action** approval. They cannot be reviewed in a diff or undone
  with `git revert`.
- A popular plugin that writes `.github/workflows/` is a high-value compromise
  target. Generated workflows never use `pull_request_target`; pin third-party
  actions by SHA **paired with Dependabot `github-actions`**; declare minimal
  `permissions:`; and never interpolate untrusted text into `run:`. **The
  plugin's own workflows must pass its own `security.workflow-hygiene` check** —
  that is the credibility demonstration.
- Signed releases with provenance from v0.1.
- **No telemetry.** `--report` emits redactable JSON plus an issue template that
  asks for it.

---

## 13. Scope

**v0.1 ships:** node pack · the 16 checks in §5 · `/ai-ready:audit` and
`/ai-ready:adapt` · skills `adapt-repo`, `working-issues`, `enforce-a-rule` ·
marked regions + manifest + idempotency gate · the validation block and its
**PR-open required check**.

| Deferred | Trigger |
| --- | --- |
| `npx ai-ready validate` CLI | v0.2 — fix the enforcement point first; the block + gate deliver value alone |
| `invariant-reviewer` agent + PR job | v0.2 — the thesis ships without a CI bot |
| Gate-rung timing (`loop.timing`) | v0.2 — slow, environment-dependent, and its fix presupposes a tagged subset. The cheap half (docs asserting stale numbers) folds into `docs.unenforced-invariants` |
| Python pack | The node pack interface proven against a second real repo — not written blind |
| Scorecard integration | v0.2. Not because it is heavy to run — `api.securityscorecards.dev` serves precomputed results for public repos over a plain GET, no token — but because its vocabulary is *security posture*, not AI readiness, and taking a dependency before there are adopters buys coupling for nothing |
| GitHub Action entrypoint | A consumer exists |
| Scheduled drift Action | Real adopters exist. `.ai-readiness.json` is retained; only the Action is deferred |
| Monorepo support | v0.1 detects and refuses |
| Non-GitHub forges | v0.1 is GitHub-only, detected early, refused in one sentence |

### Validation before release

1. Every fixture asserts `run; run; git diff --exit-code` is clean.
2. **Run against ~20 well-known public repos and read the output.** Fixtures
   test the checks; this tests whether the output is *smart*. Anything dumb said
   about a widely-admired repo is a bug.
3. **The same run collects distributions**, not just verdicts: contention
   profiles, CI-failure attribution, PR-size spread. Publishing those converts
   §15.4 from the weakest section into an asset — same run, no extra cost.
4. **Cross-check against Scorecard's hosted API** on those same public repos.
   Where `security.workflow-hygiene` disagrees with `Dangerous-Workflow` or
   `Token-Permissions`, one of us is wrong. Free ground truth for the liability
   surface §15.1 names as the biggest risk, at one `curl` per repo.
5. The plugin's own repo passes its own audit.

---

## 14. Prior art

**Depend, do not rebuild:** OpenSSF Scorecard · changesets / towncrier ·
nx / turbo `affected` (detect the tool, do not build selection) · husky +
lint-staged / pre-commit · Stryker (mutation testing).

**Overlap with Claude Code itself — stated plainly, because it is substantial.**
`/init` under `CLAUDE_CODE_NEW_INIT=1` already runs an interactive multi-phase
flow: it asks which artifacts to set up, explores with a subagent, fills gaps
with follow-up questions, and presents a reviewable proposal before writing. It
also already ingests Cursor, Copilot, Devin, Windsurf, and Cline rule files.
`/doctor` already proposes trims for an over-long guide. **This tool must invoke
or assume those rather than reimplement them.** What remains genuinely ours: the
brownfield *measurements* (contention profile, CI-failure attribution, feedback
loop health), the unenforced-invariant report, the concurrency harness, and
one-PR delivery with gated GitHub-side actions.

**`.claude/rules/` is the supported mechanism for splitting instructions** —
path-scoped, loaded only when Claude touches matching files. `@`-imports are
explicitly *not* a context reduction; they load at launch. Generated guides use
rules for anything path-specific.

**Positioning:** Spec Kit owns greenfield SDD scaffolding — defer to it.
`repolinter` is archived, and its lesson is twofold: the generic-rules-engine
shape is a known graveyard, and the differentiator must be AI-agent-specific
*content*, not a linting engine. `all-contributors` supplies the marked-region
mechanism. Backstage's scaffolder shows scaffold-then-drift is the whole
problem, which is why §4 is not optional.

**Genuinely novel:** the interview → one-PR flow on a *brownfield* repo; the
contention profile; the unenforced-invariant report; the enforced validation
handoff.

---

## 15. Two lanes for browser work, and story↔test linkage

### Browser verification has two lanes, and conflating them is the failure mode

| | Interactive verification | Regression tier |
| --- | --- | --- |
| Tool | claude-in-chrome (MCP) | Playwright |
| Job | "does this work right now, on real data?" | "does this still work, on every PR?" |
| Runs in | an agent's session, reusing the developer's browser | CI, headless, sharded |
| Costs | tokens — materially fewer than per-navigation snapshot dumps | runner minutes + maintenance |

`adapt` installs claude-in-chrome in `.mcp.json` for the verification lane and
Playwright for the regression tier, **plus one guardrail in the guide**:

> A live-browser verification is **not** a substitute for a regression test. A
> fixed bug still gets a test at the tier that would have caught it, in the same
> commit.

Without that line, "I verified it in the browser" becomes the reason a fix ships
with no durable protection — verification without an asset.

### Story ↔ test linkage: install the convention, defer the report

User-story *management* is out of scope; GitHub Issues already holds them. What
is in scope is **traceability**, which is the same shape as every other finding
in this design: an artifact exists but nothing links it to what it serves — tags
with no runner, rules with no enforcement, tests with no story.

- **v0.1 installs the convention.** Issue templates gain an *Acceptance
  criteria* section; the guide documents the test↔issue reference convention.
- **v0.2 ships the coverage report** — stories with no test, tests tracing to no
  story, stories closed whose test was later deleted. This is the PM-facing
  view, and it is deferred for the reason §2's method rule demands: the report
  cannot produce a non-trivial result until repos have been running the
  convention long enough to generate linkage.

### The audit must be findings-first and bounded

Session-usage analysis of the reference repo found **five separate sessions
where an open-ended review was abandoned mid-exploration, producing zero
output**. An audit that sweeps silently and reports at the end will be
interrupted before it reports. `/ai-ready:audit` therefore emits findings
incrementally, cheapest checks first, and every check carries a bounded cost —
never a long silent exploration phase.

---

## 16. Open risks

1. **The `fix` field is the liability surface.** A confidently wrong remediation
   is worse than no check. Mitigated by preconditions (now applied, not just
   stated), by rule 3, by the 20-repo read-through, and by the Scorecard
   cross-check. It remains the thing most likely to cause harm — and
   `quality.static-analysis` is the one to watch: a naive version would install
   a permanently-red gate, i.e. the exact disease `ci.no-diff-can-fail-on-gate`
   diagnoses one row above it.
2. **`unknown` fatigue.** If `gh auth` reuse fails often, users see a wall of
   `unknown` and conclude the tool is broken.
3. **Scope of `enforce-a-rule`.** Walking arbitrary prose down to a lint rule is
   genuinely hard. It may reliably reach only rung 4 (CI grep) — still a large
   improvement over rung 6, but less than the pitch implies.
4. **N=1 evidence base.** Every row in §2 is one codebase, one author, one
   language, 40 days old, and several rows drive *cuts*. §13's widened
   read-through is the planned defense; until it runs, §2 should be read as
   *hypotheses with worked examples* rather than established distributions.
