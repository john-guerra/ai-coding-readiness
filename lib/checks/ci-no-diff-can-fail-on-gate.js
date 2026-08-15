import { parse } from "yaml";
import { makeFinding } from "../finding.js";

/**
 * Steps that can go red without anybody changing a line of code: a new
 * advisory published overnight, an expired licence, an external service.
 *
 * The list is deliberately an allowlist of known-volatile commands rather than
 * a heuristic. A false positive here tells someone to move a gate that was
 * fine, which is worse than missing one.
 */
export const VOLATILE_STEP_PATTERNS = [
  { pattern: /\b(npm|pnpm|yarn|bun)\s+audit\b/, label: "dependency advisory scan" },
  { pattern: /\bsnyk\s+(test|monitor)\b/, label: "Snyk scan" },
  { pattern: /\blicense-checker\b/, label: "licence scan" },
  { pattern: /\bosv-scanner\b/, label: "OSV scan" },
  { pattern: /\bsafety\s+check\b/, label: "Python advisory scan" },
  { pattern: /\bpip-audit\b/, label: "Python advisory scan" },
  { pattern: /\bcargo\s+audit\b/, label: "Rust advisory scan" },
];

const ID = "ci.no-diff-can-fail-on-gate";

/**
 * Does `on:` include pull_request in any of its three spellings?
 * `on: pull_request` | `on: [push, pull_request]` | `on: {pull_request: {...}}`
 * @param {unknown} on
 */
function gatesPullRequests(on) {
  if (typeof on === "string") return on === "pull_request";
  if (Array.isArray(on)) return on.includes("pull_request");
  if (on && typeof on === "object") return "pull_request" in on;
  return false;
}

/**
 * @param {import('../repo.js').Repo} repo
 * @returns {Promise<import('../finding.js').Finding>}
 */
async function run(repo) {
  const paths = await repo.listFiles(".github/workflows");
  const yamls = paths.filter((p) => /\.ya?ml$/.test(p));

  const base = {
    id: ID,
    tier: /** @type {const} */ (1),
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

  const hits = [];
  let unparseable = 0;

  for (const path of yamls) {
    const text = await repo.readFile(path);
    if (text === null) continue;

    let doc;
    try {
      doc = parse(text);
    } catch {
      unparseable += 1;
      continue;
    }
    if (!doc || typeof doc !== "object") continue;

    // YAML 1.1 reads a bare `on` key as the boolean true. `yaml` parses as
    // 1.2 where it stays a string, but a workflow written for either spelling
    // should be handled, so check both.
    const on = "on" in doc ? doc.on : doc["true"];
    if (!gatesPullRequests(on)) continue;

    for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
      for (const step of job?.steps ?? []) {
        const cmd = typeof step?.run === "string" ? step.run : "";
        if (!cmd) continue;
        for (const { pattern, label } of VOLATILE_STEP_PATTERNS) {
          if (pattern.test(cmd)) {
            hits.push({ path, jobName, label, cmd: cmd.trim().split("\n")[0] });
          }
        }
      }
    }
  }

  if (hits.length > 0) {
    const lines = hits.map(
      (h) => `${h.path} job "${h.jobName}": ${h.label} — \`${h.cmd}\``
    );
    return makeFinding({
      ...base,
      status: "fail",
      evidence: `${hits.length} step(s) on a pull-request gate can fail with no diff:\n  ${lines.join("\n  ")}`,
      fix:
        "Move these steps to a scheduled workflow. On failure the scheduled " +
        "job must search by title and update ONE issue rather than filing per " +
        "run — a nightly job that files daily is a bot-authored backlog.",
    });
  }

  if (unparseable > 0 && yamls.length === unparseable) {
    return makeFinding({
      ...base,
      status: "unknown",
      evidence: `All ${unparseable} workflow file(s) failed to parse as YAML.`,
      fix: null,
      autoFixable: false,
    });
  }

  return makeFinding({
    ...base,
    status: "pass",
    evidence: `No volatile steps found on pull-request gates across ${yamls.length} workflow file(s).`,
    fix: null,
    autoFixable: false,
  });
}

export default { id: ID, cost: /** @type {const} */ ("S"), run };
