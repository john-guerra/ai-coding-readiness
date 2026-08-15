import { parse } from "yaml";
import { makeFinding } from "../finding.js";
import { readTriggers, gatesMerge, gateJobs, IF_NOTE } from "../workflow.js";

const ID = "ci.e2e-sharded";
// Declared once: the registry reads it to render a check that THREW at the
// right tier, and the check's own findings must not drift from that.
const TIER = /** @type {const} */ (1);

const CONFIG_PATHS = [
  "playwright.config.js",
  "playwright.config.mjs",
  "playwright.config.ts",
  "cypress.config.js",
];

/** A command line that runs the browser tier. */
const BROWSER_TIER = /playwright|cypress|test:e2e/;

/**
 * Downloading a browser binary is not running browser tests. A unit job that
 * does `npx playwright install --with-deps` so some other tool has a browser
 * available matched `/playwright/` and was recorded as running the tier —
 * and its maintainer was then told to shard a job containing no browser
 * tests, which is advice that cannot be followed.
 */
const INSTALL_ONLY = /\b(playwright|cypress)\s+install\b/;

/**
 * The command lines in a `run:` block that actually run the browser tier.
 * @param {string} run
 * @returns {string[]}
 */
function browserTierLines(run) {
  return run
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) => l && !l.startsWith("#") && !INSTALL_ONLY.test(l) && BROWSER_TIER.test(l)
    );
}

/**
 * Does a matrix key reach a command, i.e. does the job actually split its
 * work by it?
 *
 * A `strategy.matrix.shard` that nothing consumes runs the WHOLE suite once
 * per leg — strictly worse than not sharding at all, since it multiplies the
 * cost while the wall clock stays put. The matrix key alone was treated as
 * proof of sharding, so that configuration reported green.
 *
 * @param {string} commands
 * @param {string} key
 */
function matrixKeyReachesCommand(commands, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\$\\{\\{\\s*matrix\\.${escaped}\\s*\\}\\}`).test(commands);
}

/**
 * @param {import('../repo.js').Repo} repo
 * @returns {Promise<import('../finding.js').Finding>}
 */
async function run(repo) {
  const base = {
    id: ID,
    tier: TIER,
    layer: /** @type {const} */ ("deterministic"),
    effort: /** @type {const} */ ("M"),
    why:
      "An unsharded browser tier on the merge gate sets the floor for how " +
      "fast anything can merge, and every concurrent contributor waits on it.",
    autoFixable: true,
  };

  let configPath = null;
  for (const p of CONFIG_PATHS) {
    if ((await repo.readFile(p)) !== null) {
      configPath = p;
      break;
    }
  }
  if (!configPath) {
    return makeFinding({
      ...base,
      status: "unknown",
      evidence: `No browser-tier config found (looked for ${CONFIG_PATHS.join(", ")}).`,
      precondition: null,
      fix: null,
      autoFixable: false,
    });
  }

  const paths = (await repo.listFiles(".github/workflows")).filter((p) =>
    /\.ya?ml$/.test(p)
  );

  let sawGateJobRunningBrowserTier = false;
  /** @type {{path: string, jobName: string, unevaluatedIf: boolean}[]} */
  const unshardedHits = [];
  // Files we could not actually look at: unreadable, unparseable as YAML, or
  // parsed but not a mapping. A genuine unsharded merge-gate browser job
  // could be hiding in one of these, so a file dropping out silently must not
  // be able to turn a real problem into a `pass` — see
  // ci-no-diff-can-fail-on-gate.js for the same pattern.
  /** @type {{path: string, reason: string}[]} */
  const unexamined = [];

  for (const path of paths) {
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
    // a string, a list or null is not something this check looked inside, so
    // it joins the unexamined list rather than counting as examined.
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      unexamined.push({ path, reason: "is not a YAML mapping" });
      continue;
    }

    if (!gatesMerge(readTriggers(doc))) continue;

    for (const { jobName, steps, matrixKeys } of gateJobs(doc)) {
      const tierSteps = steps.filter((s) => browserTierLines(s.run).length > 0);
      if (tierSteps.length === 0) continue;

      sawGateJobRunningBrowserTier = true;
      const commands = steps.map((s) => s.run).join("\n");
      const isSharded =
        /--shard/.test(commands) ||
        matrixKeys.some(
          (k) => /shard/i.test(k) && matrixKeyReachesCommand(commands, k)
        );
      if (!isSharded) {
        unshardedHits.push({
          path,
          jobName,
          unevaluatedIf: tierSteps.some((s) => s.unevaluatedIf),
        });
      }
    }
  }

  // A real hit outranks incomplete coverage: a confirmed unsharded merge-gate
  // browser job is a `fail` no matter what else could not be examined.
  if (unshardedHits.length > 0) {
    const lines = unshardedHits.map(
      (h) =>
        `${h.path} job "${h.jobName}"` + (h.unevaluatedIf ? ` ${IF_NOTE}` : "")
    );
    return makeFinding({
      ...base,
      status: "fail",
      evidence: `${unshardedHits.length} merge-gate job(s) run the browser tier unsharded:\n  ${lines.join("\n  ")}`,
      precondition:
        "No single spec file dominates total duration. Sharding splits by FILE, " +
        "so wall clock becomes max(file), not total/N — measure per-file " +
        "duration first and split any dominant file. Specs needing bespoke " +
        "fixtures must have that setup in whichever shard draws them.",
      fix:
        "Add a shard matrix to the browser job and pass --shard=N/M. Each shard " +
        "gets its own runner, therefore its own server and temp dir, so " +
        "hermeticity holds with no test rewrites. Do NOT raise the worker count " +
        "instead: on a suite with shared state that buys flake, not speed.",
    });
  }

  if (!sawGateJobRunningBrowserTier) {
    const evidence =
      unexamined.length > 0
        ? `Found ${configPath} but no merge-gate job that runs the browser tier ` +
          `among the workflow file(s) examined; could not examine: ` +
          `${unexamined.map((u) => `${u.path} (${u.reason})`).join(", ")}.`
        : `Found ${configPath} but no merge-gate job that runs the browser tier.`;
    return makeFinding({
      ...base,
      status: "unknown",
      evidence,
      precondition: null,
      fix: null,
      autoFixable: false,
    });
  }

  if (unexamined.length > 0) {
    const skipped = unexamined.map((u) => `${u.path} (${u.reason})`).join(", ");
    return makeFinding({
      ...base,
      status: "unknown",
      evidence:
        `Every examined merge-gate job that runs the browser tier is sharded, ` +
        `but sharding could not be verified for: ${skipped}. A genuine unsharded ` +
        "job cannot be ruled out in the file(s) that were skipped.",
      precondition: null,
      fix: null,
      autoFixable: false,
    });
  }

  return makeFinding({
    ...base,
    status: "pass",
    evidence: "The browser tier is sharded across runners on the merge gate.",
    precondition: null,
    fix: null,
    autoFixable: false,
  });
}

export default { id: ID, tier: TIER, cost: /** @type {const} */ ("S"), run };
