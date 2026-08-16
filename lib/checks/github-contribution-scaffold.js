import { makeFinding } from "../finding.js";

const ID = "github.contribution-scaffold";
// Declared once: the registry reads it to render a check that THREW at the
// right tier, and the check's own findings must not drift from that.
const TIER = /** @type {const} */ (1);

/**
 * `.github/ISSUE_TEMPLATE/` containing only a config.yml (the file that turns
 * off blank issues, or points elsewhere) is the single most common way the
 * directory exists with no actual template in it. It must not count.
 * @param {string} name
 * @returns {boolean}
 */
function isConfigOnly(name) {
  return /^config\.ya?ml$/i.test(name);
}

/**
 * Where a generated artefact goes. `write-file` has no fallback list — it
 * writes one path — so each of these is a choice, not a default:
 *
 * - **`.github/ISSUE_TEMPLATE/bug.md`**, not the flat `.github/ISSUE_TEMPLATE.md`.
 *   The flat form supports exactly one template forever; the directory form is
 *   what GitHub's "New issue" chooser reads, and a second template can be
 *   dropped beside this one without moving anything. The name must also not be
 *   `config.yml`, which `isConfigOnly` (rightly) refuses to credit — a
 *   generated file this check would not accept would make the CLI loop.
 * - **`.github/PULL_REQUEST_TEMPLATE.md`**, the first entry of `prPaths` and
 *   the path this check already names in its own evidence. GitHub honours all
 *   three spellings; writing the one we tell people about keeps the report and
 *   the repository saying the same thing.
 */
const ISSUE_TEMPLATE_PATH = ".github/ISSUE_TEMPLATE/bug.md";
const PR_TEMPLATE_PATH = ".github/PULL_REQUEST_TEMPLATE.md";

/**
 * The bug template. The three headings are the artefact's entire reason for
 * existing: a report that states the scenario, the expectation and the
 * observation can be verified AGAINST, which is what stops a fix being
 * declared done against a similar case rather than the actual one.
 */
const ISSUE_TEMPLATE = `---
name: Bug report
about: Report something that does not work, in a form somebody else can reproduce
labels: bug
---

## What happened

<!-- What you observed. Paste the actual error or output, not a summary of it. -->

## What you expected to happen

## Steps to reproduce

1.
2.
3.

<!-- The smallest sequence that produces it. A fix is verified against THIS
     scenario, not against a similar one, so the more exact this is the more a
     "fixed" claim is worth. -->

## Environment

- Version or commit:
- Operating system:
- How it was run (command, CI job, browser):

## Anything else

<!-- Logs, screenshots, a link to a failing run, what you already ruled out. -->
`;

/**
 * The pull request template. Same idea from the other side: what changed, why,
 * and the evidence that it works — stated by the author, so a reviewer (human
 * or agent) is checking a claim rather than reconstructing one.
 */
const PR_TEMPLATE = `## What changed

<!-- One or two sentences. The diff says how; this says what. -->

## Why

<!-- The problem this solves, or a link to the issue that states it. -->

## How it was verified

<!-- Commands run, tests added, and what was checked by hand. "CI is green"
     verifies the suite, not the change: name the test that would have failed
     before this. -->

## Risk and rollback

<!-- What could break, who is affected, and how to undo this if it does. -->
`;

/**
 * A composite over three artefacts that tell a contributor — human or agent —
 * what a report must contain and who has to look at a change. Absence of each
 * is directly observable, so there is no `unknown` case.
 *
 * @param {import('../repo.js').Repo} repo
 * @returns {Promise<import('../finding.js').Finding>}
 */
async function run(repo) {
  const base = {
    id: ID,
    tier: TIER,
    layer: /** @type {const} */ ("deterministic"),
    effort: /** @type {const} */ ("S"),
    why:
      "These are how a repository tells a contributor — human or agent — what " +
      "a report must contain and who has to look at a change.",
    precondition: null,
  };

  const missing = [];

  const issueDir = await repo.listFiles(".github/ISSUE_TEMPLATE");
  const hasRealIssueTemplate = issueDir.some((p) => {
    const name = p.split("/").pop() ?? "";
    return !isConfigOnly(name);
  });
  const issueFlat = await repo.readFile(".github/ISSUE_TEMPLATE.md");
  const hasIssue = hasRealIssueTemplate || issueFlat !== null;
  if (!hasIssue) {
    missing.push(
      "issue template (a non-config file in .github/ISSUE_TEMPLATE/, or " +
        ".github/ISSUE_TEMPLATE.md — a directory containing only config.yml " +
        "does not count)",
    );
  }

  const prPaths = [
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/pull_request_template.md",
    "PULL_REQUEST_TEMPLATE.md",
  ];
  let hasPr = false;
  for (const p of prPaths) {
    if ((await repo.readFile(p)) !== null) {
      hasPr = true;
      break;
    }
  }
  if (!hasPr) missing.push(`pull request template (${prPaths[0]})`);

  const ownerPaths = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
  let hasOwners = false;
  for (const p of ownerPaths) {
    if ((await repo.readFile(p)) !== null) {
      hasOwners = true;
      break;
    }
  }
  if (!hasOwners) missing.push(`CODEOWNERS (${ownerPaths.join(" or ")})`);

  if (missing.length === 0) {
    return makeFinding({
      ...base,
      status: "pass",
      evidence:
        "Issue template, pull request template and CODEOWNERS are all present.",
      fix: null,
      autoFixable: false,
      action: null,
    });
  }

  // ONE action per finding, and the CLI re-runs the checks after applying —
  // so a repo missing both templates converges in two passes rather than
  // needing a `Finding` to carry an action list this milestone does not
  // otherwise need. The order is the order they are reported in.
  //
  // CODEOWNERS is deliberately absent (amendment B7). Deriving an owner needs
  // either a second network path (`gh repo view`, which this project forbids
  // without a decision in the spec) or a git remote `Repo` does not expose,
  // and the owner so derived is usually an ORGANISATION — `* @some-org` is not
  // valid CODEOWNERS syntax, so GitHub shows "Unknown owner" and
  // required-review-by-owner silently never fires. A generated file that looks
  // right and quietly does nothing is worse than no file, so this one stays a
  // human step named in `fix`, and the check keeps counting it as missing.
  /** @type {import('../actions.js').Action|null} */
  const action = !hasIssue
    ? {
        kind: "write-file",
        path: ISSUE_TEMPLATE_PATH,
        content: ISSUE_TEMPLATE,
      }
    : !hasPr
      ? { kind: "write-file", path: PR_TEMPLATE_PATH, content: PR_TEMPLATE }
      : null;

  return makeFinding({
    ...base,
    status: "fail",
    evidence: `${missing.length} of 3 missing:\n  ${missing.join("\n  ")}`,
    // Stated because the CLI prints it before applying: what gets written is a
    // generic starting point, and one repository in particular should not take
    // it as read.
    precondition:
      action === null
        ? null
        : "The generated templates are a starting point, not a description of " +
          "this project — edit them for what a report here actually needs. If " +
          "this repository deliberately routes reports elsewhere (a " +
          "`.github/ISSUE_TEMPLATE/config.yml` with contact links and blank " +
          "issues disabled), a bug template may not be wanted at all.",
    fix:
      "Add the missing files. A bug template that asks for repro steps " +
      "institutionalises `verify against the reported scenario` — the single " +
      "habit that stops a fix being declared done against a similar case " +
      "rather than the actual one. CODEOWNERS is the mechanism teams use for " +
      "the human half of review, and it is what makes required review mean " +
      "something specific rather than `somebody looked`; it is NOT generated " +
      "here and has to be written by hand, because a valid entry names a real " +
      "reviewer or team and an owner guessed from the remote is usually an " +
      "organisation, which GitHub reads as `Unknown owner` and silently " +
      "enforces nothing.",
    autoFixable: action !== null,
    action,
  });
}

export default { id: ID, tier: TIER, cost: /** @type {const} */ ("S"), run };
