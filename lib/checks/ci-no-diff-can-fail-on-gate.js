import { parse } from "yaml";
import { makeFinding } from "../finding.js";
import { readTriggers, gatesMerge, gateJobs, IF_NOTE } from "../workflow.js";

/**
 * Steps that can go red without anybody changing a line of code: a new
 * advisory published overnight, an expired licence, an external service.
 *
 * The list is deliberately an allowlist of known-volatile commands rather than
 * a heuristic. A false positive here tells someone to move a gate that was
 * fine, which is worse than missing one.
 */
export const VOLATILE_STEP_PATTERNS = [
  {
    pattern: /\b(npm|pnpm|yarn|bun)\s+audit\b/,
    label: "dependency advisory scan",
  },
  { pattern: /\bsnyk\s+(test|monitor)\b/, label: "Snyk scan" },
  { pattern: /\blicense-checker\b/, label: "licence scan" },
  { pattern: /\bosv-scanner\b/, label: "OSV scan" },
  { pattern: /\bsafety\s+check\b/, label: "Python advisory scan" },
  { pattern: /\bpip-audit\b/, label: "Python advisory scan" },
  { pattern: /\bcargo\s+audit\b/, label: "Rust advisory scan" },
];

const ID = "ci.no-diff-can-fail-on-gate";
// Declared once: the registry reads it to render a check that THREW at the
// right tier, and the check's own findings must not drift from that.
const TIER = /** @type {const} */ (1);

/**
 * @param {import('../repo.js').Repo} repo
 * @returns {Promise<import('../finding.js').Finding>}
 */
async function run(repo) {
  const paths = await repo.listFiles(".github/workflows");
  const yamls = paths.filter((p) => /\.ya?ml$/.test(p));

  const base = {
    id: ID,
    tier: TIER,
    layer: /** @type {const} */ ("deterministic"),
    effort: /** @type {const} */ ("M"),
    why:
      "A gate that can go red without a code change blocks every contributor " +
      "at once, for a reason none of their diffs caused.",
    precondition: null,
    autoFixable: true,
  };

  if (yamls.length === 0) {
    return makeFinding({
      ...base,
      status: "unknown",
      evidence: "No workflow files found under .github/workflows.",
      fix: null,
      autoFixable: false,
    });
  }

  /** @type {{path: string, jobName: string, label: string, cmd: string, unevaluatedIf: boolean}[]} */
  const hits = [];
  // Files we could not actually look at: unreadable (readFile returned null
  // for a path listFiles just handed us — e.g. a race with something that
  // deleted it), unparseable as YAML, or parsed but not a mapping. All three
  // are the same defect class: a merge gate could be hiding in a file we
  // never read, so none may silently drop out of the count that decides
  // `pass`.
  const unexamined = [];
  // Workflows that actually gate a merge. Reporting `pass` without having
  // found one means reporting green on a repository whose gate was never
  // examined.
  const gating = [];

  for (const path of yamls) {
    const text = await repo.readFile(path);
    if (text === null) {
      unexamined.push({ path, reason: "could not be read" });
      continue;
    }

    let doc;
    try {
      doc = parse(text);
    } catch {
      unexamined.push({ path, reason: "failed to parse as YAML" });
      continue;
    }
    // Parsing as YAML is not the same as being a workflow: a document that is
    // a string, a list or null is not something this check looked inside.
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      unexamined.push({ path, reason: "is not a YAML mapping" });
      continue;
    }

    if (!gatesMerge(readTriggers(doc))) continue;
    gating.push(path);

    for (const { jobName, steps } of gateJobs(doc)) {
      for (const { run: cmd, unevaluatedIf } of steps) {
        if (!cmd) continue;

        // Match line-by-line rather than across the whole block, for two
        // reasons: it lets us drop full-line comments before testing (a
        // `# npm audit ...` explanation must not read as the command), and
        // it lets the evidence name the actual line that matched instead of
        // just the first line of a multi-line `run: |` block. Trailing
        // inline comments are deliberately NOT stripped — a `#` can appear
        // inside a legitimate quoted argument, and a naive trailing-comment
        // stripper would mangle real commands. This also means a command
        // split across a `\` line-continuation won't be detected; an
        // accepted false-negative, since a wrong "move this" is worse than
        // a missed one.
        for (const rawLine of cmd.split("\n")) {
          const line = rawLine.trim();
          if (!line || line.startsWith("#")) continue;
          for (const { pattern, label } of VOLATILE_STEP_PATTERNS) {
            if (pattern.test(line)) {
              hits.push({ path, jobName, label, cmd: line, unevaluatedIf });
            }
          }
        }
      }
    }
  }

  if (hits.length > 0) {
    const lines = hits.map(
      (h) =>
        `${h.path} job "${h.jobName}": ${h.label} — \`${h.cmd}\`` +
        (h.unevaluatedIf ? ` ${IF_NOTE}` : ""),
    );
    return makeFinding({
      ...base,
      status: "fail",
      evidence: `${hits.length} step(s) on a merge gate can fail with no diff:\n  ${lines.join("\n  ")}`,
      fix:
        "Move these steps to a scheduled workflow. On failure the scheduled " +
        "job must search by title and update ONE issue rather than filing per " +
        "run — a nightly job that files daily is a bot-authored backlog.",
    });
  }

  if (unexamined.length > 0) {
    const examined = yamls.length - unexamined.length;
    const skipped = unexamined.map((u) => `${u.path} (${u.reason})`).join(", ");
    return makeFinding({
      ...base,
      status: "unknown",
      evidence:
        `${examined} of ${yamls.length} workflow file(s) examined; ` +
        `could not examine: ${skipped}. A merge gate cannot be ruled ` +
        "out in the file(s) that were skipped.",
      fix: null,
      autoFixable: false,
    });
  }

  // Nothing gates a merge here, so nothing was examined that could have gone
  // red without a diff. That is not a `pass`: the question this check asks
  // was never answered. A repository whose real gate is a merge queue used to
  // land here and be told it was fine.
  if (gating.length === 0) {
    return makeFinding({
      ...base,
      status: "unknown",
      evidence:
        `No pull-request or merge-queue gate was found across ${yamls.length} ` +
        `workflow file(s), so no gate was examined. Triggers that count as a ` +
        `gate: \`pull_request\` (with no \`types:\` filter, or one that ` +
        `includes a type firing while the PR is open) and \`merge_group\`. A ` +
        `\`push\` to the default branch is post-merge branch health, not a gate.`,
      fix: null,
      autoFixable: false,
    });
  }

  return makeFinding({
    ...base,
    status: "pass",
    evidence:
      `No volatile steps found on the merge gate(s) in ` +
      `${gating.join(", ")} (${yamls.length} workflow file(s) examined).`,
    fix: null,
    autoFixable: false,
  });
}

export default { id: ID, tier: TIER, cost: /** @type {const} */ ("S"), run };
