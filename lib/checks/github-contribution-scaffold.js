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
  if (!hasRealIssueTemplate && issueFlat === null) {
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

  return makeFinding({
    ...base,
    status: "fail",
    evidence: `${missing.length} of 3 missing:\n  ${missing.join("\n  ")}`,
    fix:
      "Add the missing files. A bug template that asks for repro steps " +
      "institutionalises `verify against the reported scenario` — the single " +
      "habit that stops a fix being declared done against a similar case " +
      "rather than the actual one. CODEOWNERS is the mechanism teams use for " +
      "the human half of review, and it is what makes required review mean " +
      "something specific rather than `somebody looked`.",
    // TEMPORARY: false only until this check carries `write-file` actions for
    // the two templates. `autoFixable` now means "ships something a machine
    // can apply", and this one does not yet.
    autoFixable: false,
    action: null,
  });
}

export default { id: ID, tier: TIER, cost: /** @type {const} */ ("S"), run };
