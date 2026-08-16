import { makeFinding } from "../finding.js";
import { readGuide, GUIDE_PATHS } from "../guide.js";

const ID = "guide.exists";
// Declared once: the registry reads it to render a check that THREW at the
// right tier, and the check's own findings must not drift from that.
const TIER = /** @type {const} */ (0);

/**
 * Is there an agent guide at all? Deliberately narrowed to the mechanical
 * half of the question — absence is directly observable, so this check never
 * reports `unknown`. Whether the guide is any GOOD (names the right command,
 * states a boundary) needs a model or the project's own manifest and is split
 * into `guide.commands` and `guide.guardrails`, which read the guide corpus
 * this check merely confirms exists.
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
      "An agent that cannot find how to build, test and run a project will " +
      "guess, and a wrong guess costs more than the file would have.",
    precondition: null,
  };

  const guide = await readGuide(repo);
  if (guide === null) {
    return makeFinding({
      ...base,
      status: "fail",
      evidence: `No agent guide found (looked for ${GUIDE_PATHS.join(", ")}).`,
      fix:
        "Run `/init` — it interviews you, explores the codebase with a " +
        "subagent, and proposes a guide before writing anything. Then add the " +
        "parts it cannot know: guardrails, the concurrency protocol, and how " +
        "work gets validated.",
      autoFixable: false,
    });
  }

  return makeFinding({
    ...base,
    status: "pass",
    evidence: `${guide.path} exists.`,
    fix: null,
    autoFixable: false,
  });
}

export default { id: ID, tier: TIER, cost: /** @type {const} */ ("S"), run };
