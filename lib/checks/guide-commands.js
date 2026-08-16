import { makeFinding } from "../finding.js";
import { readGuide, resolveImports } from "../guide.js";

const ID = "guide.commands";
// Declared once: the registry reads it to render a check that THREW at the
// right tier, and the check's own findings must not drift from that.
const TIER = /** @type {const} */ (0);

/**
 * Escape a string for literal use inside a RegExp.
 * @param {string} s
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A regex that matches `token` literally, bounded by `\b` on whichever edges
 * are word characters. "npm test" inside "Run `npm test` before committing"
 * must match; "vitest" inside a longer identifier like "vitest-plugin" must
 * not.
 * @param {string} token
 */
function tokenPattern(token) {
  const esc = escapeRegExp(token);
  const lead = /^\w/.test(token) ? "\\b" : "";
  const trail = /\w$/.test(token) ? "\\b" : "";
  return new RegExp(`${lead}${esc}${trail}`);
}

/**
 * The tokens worth searching the corpus for, derived from the project's own
 * `scripts.test` rather than a fixed list of test-runner names. A fixed list
 * (`/vitest|jest/`) both false-passes — any runner's name mentioned anywhere,
 * including a devDependency list or a "we migrated off X" note — and
 * false-fails a project whose `scripts.test` is `turbo run test` or
 * `make test`, documented correctly. The first executable word covers a guide
 * that names the underlying runner; the whole string covers one that quotes
 * the command verbatim; `npm test` / `npm run test` are always valid
 * regardless of what the script itself invokes, since npm dispatches to it
 * either way.
 * @param {string} testScript
 * @returns {string[]}
 */
function candidateTokens(testScript) {
  const trimmed = testScript.trim();
  const firstWord = trimmed.split(/\s+/)[0] ?? trimmed;
  return [...new Set([firstWord, trimmed, "npm test", "npm run test"])];
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
    effort: /** @type {const} */ ("S"),
    why:
      "An agent that cannot find the project's real test command will guess " +
      "one, run the wrong thing, and report false confidence either way.",
    precondition: null,
  };

  const guide = await readGuide(repo);
  if (guide === null) {
    return makeFinding({
      ...base,
      status: "unknown",
      evidence:
        "There is no agent guide to name a test command in. `guide.exists` " +
        "reports the absence; repeating it here would just teach the reader " +
        "to skim.",
      fix: null,
      autoFixable: false,
    });
  }

  const manifest = await repo.readFile("package.json");
  if (manifest === null) {
    return makeFinding({
      ...base,
      status: "unknown",
      evidence: `Found ${guide.path}, but no package.json, so the project's own test command is unknown and cannot be looked for.`,
      fix: null,
      autoFixable: false,
    });
  }

  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(manifest);
  } catch {
    return makeFinding({
      ...base,
      status: "unknown",
      evidence: `Found ${guide.path}, but package.json could not be parsed as JSON, so its scripts are unknown.`,
      fix: null,
      autoFixable: false,
    });
  }

  const testScript = parsed?.scripts?.test;
  if (typeof testScript !== "string" || testScript.trim() === "") {
    return makeFinding({
      ...base,
      status: "unknown",
      evidence: `Found ${guide.path}, but package.json declares no "test" script, so there is no test command to look for.`,
      fix: null,
      autoFixable: false,
    });
  }

  const tokens = candidateTokens(testScript);
  const { files } = await resolveImports(repo, guide);

  for (const file of files) {
    for (const token of tokens) {
      if (tokenPattern(token).test(file.text)) {
        return makeFinding({
          ...base,
          status: "pass",
          evidence: `${file.path} names the test command via "${token}" (package.json declares scripts.test: "${testScript}").`,
          fix: null,
          autoFixable: false,
        });
      }
    }
  }

  return makeFinding({
    ...base,
    status: "fail",
    evidence:
      `None of the guide corpus (${files.map((f) => f.path).join(", ")}) ` +
      `mentions the project's test command; package.json declares ` +
      `scripts.test: "${testScript}". Looked for: ` +
      `${tokens.map((t) => `"${t}"`).join(", ")}.`,
    fix: `Add a Commands section to ${guide.path} (or a file it imports) naming the exact command from package.json's scripts.test: \`${testScript}\`.`,
    autoFixable: true,
  });
}

export default { id: ID, tier: TIER, cost: /** @type {const} */ ("S"), run };
