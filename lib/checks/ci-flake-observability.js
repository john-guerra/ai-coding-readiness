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

  // The config is executable JavaScript, so this is a textual read rather
  // than a parse — it can never be exact. What it handles: `/* */` block
  // comments (including ones spanning multiple lines), full-line `//`
  // comments, and both quoted (`"retries"` / `'retries'`) and unquoted
  // (`retries`) keys in property position. What it does NOT handle: a
  // retries value assembled at runtime — spread from another object, read
  // off a variable, produced by a helper call, or pulled in from a config
  // imported from another module — reads as absent and reports `fail`.
  // That is a known false-alarm direction: a repo with retries genuinely
  // configured, just not as a literal key in this file, will be told it is
  // missing one.
  //
  // Block comments are stripped before line comments so a `//` that
  // happens to sit inside a block comment does not confuse the order.
  const source = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  // Require `retries:` to sit in property position — preceded, after
  // optional whitespace, by `{`, `,`, or the start of a line, with an
  // optional matching quote around the key — so a quoted mention such as
  // `"retries: none"` inside some other string value does not read as the
  // key being set.
  if (/(^|[{,])\s*["']?retries["']?\s*:/m.test(source)) {
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
