import { parse } from "yaml";
import { makeFinding } from "../finding.js";

const ID = "ci.e2e-sharded";

const CONFIG_PATHS = [
  "playwright.config.js",
  "playwright.config.mjs",
  "playwright.config.ts",
  "cypress.config.js",
];

/** @param {unknown} on */
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
  const base = {
    id: ID,
    tier: /** @type {const} */ (1),
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

  let sawPrJobRunningBrowserTier = false;
  /** @type {{path: string, jobName: string}[]} */
  const unshardedHits = [];
  // Files we could not actually look at: unreadable or unparseable as YAML.
  // A genuine unsharded PR-gate browser job could be hiding in one of these,
  // so a file dropping out silently must not be able to turn a real problem
  // into a `pass` — see ci-no-diff-can-fail-on-gate.js for the same pattern.
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
    if (!doc || typeof doc !== "object") continue;

    const on = "on" in doc ? doc.on : doc["true"];
    if (!gatesPullRequests(on)) continue;

    for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
      const steps = /** @type {Array<{run?: string}>} */ (job?.steps ?? []);
      const commands = steps
        .map((s) => (typeof s?.run === "string" ? s.run : ""))
        .join("\n");
      if (!/playwright|cypress|test:e2e/.test(commands)) continue;

      sawPrJobRunningBrowserTier = true;
      const matrixKeys = Object.keys(job?.strategy?.matrix ?? {});
      const isSharded =
        /--shard/.test(commands) || matrixKeys.some((k) => /shard/i.test(k));
      if (!isSharded) {
        unshardedHits.push({ path, jobName });
      }
    }
  }

  // A real hit outranks incomplete coverage: a confirmed unsharded PR-gate
  // browser job is a `fail` no matter what else could not be examined.
  if (unshardedHits.length > 0) {
    const lines = unshardedHits.map((h) => `${h.path} job "${h.jobName}"`);
    return makeFinding({
      ...base,
      status: "fail",
      evidence: `${unshardedHits.length} pull-request job(s) run the browser tier unsharded:\n  ${lines.join("\n  ")}`,
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

  if (!sawPrJobRunningBrowserTier) {
    const evidence =
      unexamined.length > 0
        ? `Found ${configPath} but no pull-request job that runs the browser tier ` +
          `among the workflow file(s) examined; could not examine: ` +
          `${unexamined.map((u) => `${u.path} (${u.reason})`).join(", ")}.`
        : `Found ${configPath} but no pull-request job that runs the browser tier.`;
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
        `Every examined pull-request job that runs the browser tier is sharded, ` +
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
    evidence: "The browser tier is sharded across runners on the pull-request gate.",
    precondition: null,
    fix: null,
    autoFixable: false,
  });
}

export default { id: ID, cost: /** @type {const} */ ("S"), run };
