import { makeFinding } from "../finding.js";

const ID = "ci.flake-observability";

const CONFIG_PATHS = [
  "playwright.config.js",
  "playwright.config.mjs",
  "playwright.config.ts",
];

/**
 * @param {import('../repo.js').Repo} repo
 * @returns {Promise<import('../finding.js').Finding>}
 */
async function run(repo) {
  const base = {
    id: ID,
    tier: /** @type {const} */ (1),
    layer: /** @type {const} */ ("deterministic"),
    effort: /** @type {const} */ ("S"),
    why:
      "With retries unset, Playwright never classifies a test as flaky — a " +
      "flaky test simply fails. Any measurement of flake rate then returns " +
      "zero whether the true rate is 0% or 30%.",
    precondition: null,
    autoFixable: true,
  };

  let configPath = null;
  let text = null;
  for (const p of CONFIG_PATHS) {
    const t = await repo.readFile(p);
    if (t !== null) {
      configPath = p;
      text = t;
      break;
    }
  }

  if (!configPath || text === null) {
    return makeFinding({
      ...base,
      status: "unknown",
      evidence: `No Playwright config found (looked for ${CONFIG_PATHS.join(", ")}).`,
      fix: null,
      autoFixable: false,
    });
  }

  // The config is executable JavaScript, so this is a textual check rather
  // than a parse. Two guards keep a mere mention from reading as a real
  // setting — either would tell a repo its flake instrument is installed
  // when it is not, which is exactly the blindness this check exists to
  // catch:
  //   1. Drop full-line `//` comments before matching, mirroring
  //      ci-no-diff-can-fail-on-gate.js: a trailing `// comment` after real
  //      code could contain a `//` inside a quoted argument, so only a line
  //      whose trimmed content itself starts with `//` is dropped.
  //   2. Require `retries:` to sit in property position — preceded, after
  //      optional whitespace, by `{`, `,`, or the start of a line — so a
  //      quoted mention such as `"retries: none"` inside some other string
  //      value does not read as the key being set.
  const codeOnly = text
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  if (/(^|[{,])\s*retries\s*:/m.test(codeOnly)) {
    return makeFinding({
      ...base,
      status: "pass",
      evidence: `${configPath} declares a retries value.`,
      fix: null,
      autoFixable: false,
    });
  }

  return makeFinding({
    ...base,
    status: "fail",
    evidence: `${configPath} declares no "retries" key, so retries default to 0 and no test is ever reported as flaky.`,
    fix:
      'Set `retries: process.env.CI ? 1 : 0` and surface the "flaky" count ' +
      "from the run summary. One line, no cost on a green run, and it turns " +
      "flake from an unmeasurable into a measurable.",
  });
}

export default { id: ID, cost: /** @type {const} */ ("S"), run };
