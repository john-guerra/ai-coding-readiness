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
  let sawSharding = false;

  for (const path of paths) {
    const text = await repo.readFile(path);
    if (text === null) continue;
    let doc;
    try {
      doc = parse(text);
    } catch {
      continue;
    }
    if (!doc || typeof doc !== "object") continue;

    const on = "on" in doc ? doc.on : doc["true"];
    if (!gatesPullRequests(on)) continue;

    for (const job of Object.values(doc.jobs ?? {})) {
      const steps = /** @type {Array<{run?: string}>} */ (job?.steps ?? []);
      const commands = steps
        .map((s) => (typeof s?.run === "string" ? s.run : ""))
        .join("\n");
      if (!/playwright|cypress|test:e2e/.test(commands)) continue;

      sawPrJobRunningBrowserTier = true;
      const matrixKeys = Object.keys(job?.strategy?.matrix ?? {});
      if (/--shard/.test(commands) || matrixKeys.some((k) => /shard/i.test(k))) {
        sawSharding = true;
      }
    }
  }

  if (!sawPrJobRunningBrowserTier) {
    return makeFinding({
      ...base,
      status: "unknown",
      evidence: `Found ${configPath} but no pull-request job that runs the browser tier.`,
      precondition: null,
      fix: null,
      autoFixable: false,
    });
  }

  if (sawSharding) {
    return makeFinding({
      ...base,
      status: "pass",
      evidence: "The browser tier is sharded across runners on the pull-request gate.",
      precondition: null,
      fix: null,
      autoFixable: false,
    });
  }

  return makeFinding({
    ...base,
    status: "fail",
    evidence: `${configPath} exists and a pull-request job runs the browser tier, but no --shard or shard matrix was found.`,
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

export default { id: ID, cost: /** @type {const} */ ("S"), run };
