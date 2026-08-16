import { makeFinding } from "../finding.js";
import { readGuide, resolveImports, alwaysLoadedRules } from "../guide.js";

const ID = "guide.context-budget";
const TIER = /** @type {const} */ (0);

/** The documented target for a single agent guide. */
const BUDGET_LINES = 200;

/**
 * How many lines load into context at the start of every session: the guide,
 * everything it `@`-imports, and any `.claude/rules/*.md` without a
 * non-empty `paths:` scope — against a documented 200-line target.
 *
 * `@`-imports are NOT a reduction: they expand at launch, so splitting a
 * guide into imports reorganises it without making it cheaper. The real
 * remedy is `.claude/rules/` with `paths:` frontmatter, which loads only
 * when Claude touches a matching file — but only content with an
 * identifiable path scope can move there. A rule relocated with a guessed
 * `paths:` loads LESS often than the import did, weakening the persuasion
 * the guide was relying on. Everything without a path scope must be
 * mechanized instead (a lint rule, a test, a hook), never relocated on a
 * guess — that distinction is this check's `precondition` and its `fix`.
 *
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
      "Every line here is re-read at the start of every session, and a guide " +
      "that grows past the point of being read is one whose rules get lost in " +
      "its own noise.",
  };

  const guide = await readGuide(repo);
  if (guide === null) {
    return makeFinding({
      ...base,
      status: "unknown",
      evidence:
        "There is no agent guide, so there is no always-loaded budget to " +
        "measure. `guide.exists` reports the absence.",
      precondition: null,
      fix: null,
      autoFixable: false,
      action: null,
    });
  }

  const { files } = await resolveImports(repo, guide);
  const rules = await alwaysLoadedRules(repo);
  const all = [...files, ...rules].sort((a, b) => b.lines - a.lines);
  const total = all.reduce((sum, f) => sum + f.lines, 0);

  const itemised = all.map((f) => `${f.path} — ${f.lines} lines`).join("\n  ");

  if (total <= BUDGET_LINES) {
    return makeFinding({
      ...base,
      status: "pass",
      evidence:
        `${total} lines load at the start of every session, within the ` +
        `${BUDGET_LINES}-line target:\n  ${itemised}`,
      precondition: null,
      fix: null,
      autoFixable: false,
      action: null,
    });
  }

  // Math.round(total / BUDGET_LINES) prints "1×" for 201, 250 and 299 lines
  // alike, which reads as "barely failing" regardless of how far over budget
  // the guide actually is. One decimal place keeps those distinguishable.
  const multiplier = (total / BUDGET_LINES).toFixed(1);

  return makeFinding({
    ...base,
    status: "fail",
    evidence:
      `${total} lines load at the start of every session — ${multiplier}× ` +
      `the ${BUDGET_LINES}-line target:\n  ${itemised}\n\n` +
      "`@`-imports do not reduce this. They are expanded at launch, so " +
      "splitting a guide into imports reorganises it without making it cheaper.",
    precondition:
      "Only content with an identifiable path scope can move. Measure that " +
      "fraction before prescribing: process knowledge — release steps, CI " +
      "gotchas, debugging traps — has no path to scope it to.",
    fix:
      "Relocate path-scopable content to `.claude/rules/` with `paths:` " +
      "frontmatter, so it loads only when a matching file is touched. " +
      "Everything else must be MECHANIZED rather than relocated — a rule " +
      "moved with a guessed `paths:` loads LESS often than the import did, " +
      "which weakens the persuasion the guide was relying on. Turn those into " +
      "a lint rule, a test, or a hook.",
    autoFixable: false,
    action: null,
  });
}

export default { id: ID, tier: TIER, cost: /** @type {const} */ ("S"), run };
