import { makeFinding } from "../finding.js";
import { readGuide, resolveImports } from "../guide.js";

const ID = "guide.guardrails";
// Declared once: the registry reads it to render a check that THREW at the
// right tier, and the check's own findings must not drift from that.
const TIER = /** @type {const} */ (0);

/**
 * Prohibitions read as prose, not as a schema. This is the shape they take.
 * `do NOT` is deliberately absent from the alternation — the case-insensitive
 * flag already matches it via `do not` — and the curly apostrophe `don’t`
 * sits alongside the straight one because guides are prose, typed either way.
 */
const PROHIBITION = /\b(never|do not|don't|don’t|must not)\b/i;

/**
 * Strip fenced code blocks and inline code spans before matching, but blank
 * their characters out rather than deleting them so every line of the
 * returned text still lines up 1:1 with the original — `firstProhibitionLine`
 * relies on that alignment to quote the untouched original line once a
 * stripped one matches. A fenced example ("```\nNever do this.\n```") is
 * documentation ABOUT a prohibition-shaped sentence, not a guardrail actually
 * stated in prose, and must not count.
 * @param {string} text
 */
function withoutCode(text) {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ""))
    .replace(/`[^`\n]*`/g, "");
}

/**
 * The first line of `text` that states a prohibition once code is stripped
 * out, returned in its ORIGINAL form (backticks and all) rather than the
 * stripped one — quoting the actual guide text, not a mangled derivative of
 * it, is what makes the evidence a citation a reader can check and reject.
 * @param {string} text
 */
function firstProhibitionLine(text) {
  const original = text.split("\n");
  const stripped = withoutCode(text).split("\n");
  for (let i = 0; i < stripped.length; i++) {
    const strippedLine = stripped[i].trim();
    if (strippedLine !== "" && PROHIBITION.test(strippedLine)) {
      return original[i].trim();
    }
  }
  return null;
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
      "An agent with no stated boundary will infer one, and the inference is " +
      "discovered by watching it cross the line.",
    precondition: null,
  };

  const guide = await readGuide(repo);
  if (guide === null) {
    return makeFinding({
      ...base,
      status: "unknown",
      evidence:
        "There is no agent guide to state guardrails in. `guide.exists` " +
        "reports that; repeating it here would just teach the reader to skim.",
      fix: null,
      autoFixable: false,
    });
  }

  const { files } = await resolveImports(repo, guide);
  for (const file of files) {
    const line = firstProhibitionLine(file.text);
    if (line !== null) {
      return makeFinding({
        ...base,
        status: "pass",
        evidence: `${file.path} states a prohibition: "${line}"`,
        fix: null,
        autoFixable: false,
      });
    }
  }

  const settings = await repo.readFile(".claude/settings.json");
  if (settings !== null) {
    try {
      const parsed = JSON.parse(settings);
      const deny = parsed?.permissions?.deny;
      if (Array.isArray(deny) && deny.length > 0) {
        const quoted = deny
          .map((/** @type {unknown} */ d) => `"${String(d)}"`)
          .join(", ");
        return makeFinding({
          ...base,
          status: "pass",
          evidence: `.claude/settings.json declares ${deny.length} denied permission(s): ${quoted}.`,
          fix: null,
          autoFixable: false,
        });
      }
    } catch {
      // Unparseable settings declare nothing verifiable; fall through to the
      // failure rather than crediting a file no tool can read.
    }
  }

  return makeFinding({
    ...base,
    status: "fail",
    evidence: `${files.map((f) => f.path).join(", ")} state no prohibition in prose, and .claude/settings.json declares no denied permissions.`,
    fix:
      `Add a Guardrails section to ${guide.path} naming what an agent must ` +
      "never touch — production data, user files, credentials — and the " +
      "destructive-action policy (prefer soft-delete with an undo over a hard " +
      "delete). Back the non-negotiable ones with a `permissions.deny` entry " +
      "in a committed `.claude/settings.json`: guide prose is persuasion, a " +
      "deny rule is enforcement.",
    autoFixable: true,
  });
}

export default { id: ID, tier: TIER, cost: /** @type {const} */ ("S"), run };
