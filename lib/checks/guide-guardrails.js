import { makeFinding } from "../finding.js";
import { readGuide, resolveImports } from "../guide.js";
import { withoutCode } from "../markdown.js";

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
 * A heading whose text suggests the section below it is about boundaries.
 * `never` and `do not` are in here as well as in `PROHIBITION` because
 * "## Never do these things" is a guardrail heading, not a guardrail.
 */
const GUARDRAIL_HEADING = /guardrail|boundar|safety|never|do not/i;

/** An ATX heading line, capturing its level and its text. */
const HEADING = /^(#{1,6})\s+(.*)$/;

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
 * The first prohibition stated UNDER a guardrail-ish heading, plus the heading
 * that scoped it — or null.
 *
 * This is the strongest signal available to a text scan short of enforcement:
 * a maintainer who wrote `## Guardrails` and put a prohibition under it was
 * deliberately stating a boundary, whereas a `never` anywhere in prose may
 * only be a sentence shaped like one. Headings are located on the
 * code-stripped text so a `#` inside a fence is not read as one, and the
 * section ends at the next heading of the SAME OR HIGHER level — otherwise a
 * `## Guardrails` section that says nothing would swallow the rest of the file
 * and cite an unrelated `never` from a later section.
 * @param {string} text
 * @returns {{heading: string, line: string}|null}
 */
function prohibitionUnderGuardrailHeading(text) {
  const original = text.split("\n");
  const stripped = withoutCode(text).split("\n");

  for (let i = 0; i < stripped.length; i++) {
    const head = HEADING.exec(stripped[i].trim());
    if (!head || !GUARDRAIL_HEADING.test(head[2])) continue;

    const level = head[1].length;
    for (let j = i + 1; j < stripped.length; j++) {
      const line = stripped[j].trim();
      const next = HEADING.exec(line);
      if (next && next[1].length <= level) break;
      if (line !== "" && PROHIBITION.test(line)) {
        return { heading: original[i].trim(), line: original[j].trim() };
      }
    }
  }
  return null;
}

const REGION_ID = "guardrails";

/**
 * The version of the text below.
 *
 * **Bumping this does NOT rewrite an existing region, and cannot.** The
 * comment here used to say it did. Once the region is on disk this check
 * PASSES — a `## Guardrails` heading with a `Never` under it is exactly what
 * it looks for — so no finding is emitted, so no action is emitted, and
 * `applyAction`'s version comparison (correctly implemented, and covered by
 * `test/actions.test.js`) is unreachable from production. Every repository
 * that already has a v1 region keeps it forever.
 *
 * A real migration has to iterate the MANIFEST — the record of every region
 * this tool wrote, which is the only place a v1 region is still visible once
 * the check that produced it is green — and not the failing findings, which by
 * construction exclude it. That is deliberately not built here: it needs a
 * decision about what happens to a region a human has since edited, and one
 * about `retireRegion`, and neither belongs in a version constant.
 *
 * The version marker itself is still worth writing: it is what a migration
 * would key on, and `applyAction` already refuses to treat a version change as
 * "already current", so the mechanism is ready for the day the migration is.
 */
const REGION_VERSION = 1;

/**
 * The generated Guardrails section.
 *
 * Written to satisfy the check that emits it — deliberately, not
 * incidentally. This check passes on `PROHIBITION` matching under a
 * guardrail-ish heading, so the section carries a real `Never` under a real
 * `## Guardrails` heading. A region that was applied and left the finding red
 * would be worse than no action at all: the run would report "applied 1
 * change" beside a still-failing check, having written into somebody's guide
 * for nothing. The round-trip test in `test/checks/guide.test.js` is what
 * keeps this true if the text is ever edited.
 *
 * It says what it is. A generic section presented as if it described this
 * repository would be a confidently wrong remediation, which is the failure
 * mode rule 4 exists to prevent — so the first line tells the reader it is a
 * starting point and asks them to edit it.
 *
 * The four boundaries are the ones an agent cannot infer and discovers by
 * crossing: environments other than the local one, files outside the
 * repository, credentials, and irreversible deletion.
 */
const GUARDRAILS_SECTION = `## Guardrails

Generated by \`ai-readiness\` as a **starting point**, not as a description of
this repository. Read it, cut what does not apply, and add the boundary that
only somebody here knows about.

- **Never** touch production data or any environment other than the local
  development one, unless the task explicitly asks for it in that session.
- **Never** read, move, or delete a user's files outside this repository.
- **Never** commit or print a credential — API keys, tokens, \`.env\` contents.
  If one is needed, read it from the environment and say that you did.
- **Prefer a soft delete with an undo to a hard delete.** When a change cannot
  be undone — dropping a table, force-pushing, rewriting history, deleting a
  file that is not tracked — stop and ask first.

Prose is persuasion. Back the non-negotiable ones with a \`permissions.deny\`
entry in a committed \`.claude/settings.json\`, which the harness enforces
whatever a guide says.`;

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
      action: null,
    });
  }

  // Enforcement first. A `permissions.deny` entry is a mechanism, not a
  // sentence, so it is the strongest evidence this check can cite — and when
  // both exist it is the one worth citing. Prose used to win purely because
  // it was tested first, which meant the report never mentioned the mechanism.
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
          evidence:
            `Matched a denied permission in .claude/settings.json, which ` +
            `declares ${deny.length} denied permission(s): ${quoted}. This is ` +
            `enforcement rather than prose — the harness refuses these ` +
            `regardless of what any guide says.`,
          fix: null,
          autoFixable: false,
          action: null,
        });
      }
    } catch {
      // Unparseable settings declare nothing verifiable; fall through to the
      // prose scan rather than crediting a file no tool can read.
    }
  }

  const { files } = await resolveImports(repo, guide);

  // Then a prohibition that a maintainer deliberately filed under a
  // guardrail-ish heading, anywhere in the corpus.
  for (const file of files) {
    const scoped = prohibitionUnderGuardrailHeading(file.text);
    if (scoped !== null) {
      return makeFinding({
        ...base,
        status: "pass",
        evidence:
          `Matched a prohibition under a "${scoped.heading}" heading in ` +
          `${file.path}: "${scoped.line}"`,
        fix: null,
        autoFixable: false,
        action: null,
      });
    }
  }

  // Last, any prohibition-shaped line at all — reported with what it actually
  // is. "The cache never expires, so restart after a config change." matches
  // this pattern and constrains nobody; the check has no way to tell that
  // sentence from a real boundary, so it must not imply that it did.
  for (const file of files) {
    const line = firstProhibitionLine(file.text);
    if (line !== null) {
      return makeFinding({
        ...base,
        status: "pass",
        evidence:
          `Matched a prohibition-shaped line in prose in ${file.path}: ` +
          `"${line}" — this is a text match, not a judgment that the line ` +
          `constrains an agent. A prohibition filed under an explicit ` +
          `Guardrails heading, or a \`permissions.deny\` entry in ` +
          `\`.claude/settings.json\`, would be stronger evidence.`,
        fix: null,
        autoFixable: false,
        action: null,
      });
    }
  }

  // The region goes in the guide this repository actually has — `guide.path`,
  // whichever of CLAUDE.md / .claude/CLAUDE.md / AGENTS.md was found. Not a
  // fixed filename: writing a second guide beside an existing one would be a
  // new finding for `guide.exists`, not a fix for this one. The no-guide case
  // never reaches here — it returned `unknown` above, because there is
  // nothing to write into and creating a guide is that check's business.
  /** @type {import('../actions.js').Action} */
  const action = {
    kind: "write-region",
    path: guide.path,
    id: REGION_ID,
    inner: GUARDRAILS_SECTION,
    version: REGION_VERSION,
  };

  return makeFinding({
    ...base,
    status: "fail",
    evidence: `${files.map((f) => f.path).join(", ")} state no prohibition in prose, and .claude/settings.json declares no denied permissions.`,
    // Printed before the region is applied, because a generic guardrail
    // presented as this repository's own is exactly the confidently wrong
    // remediation rule 4 exists to prevent. The section says so itself; this
    // says it where somebody deciding whether to run `--write` will see it.
    precondition:
      "What gets written is a generic starting point. Read it before " +
      "relying on it: the boundary that matters here is usually the one only " +
      "somebody on this project knows about, and a guardrail nobody has read " +
      "constrains nobody.",
    fix:
      `Add a Guardrails section to ${guide.path} naming what an agent must ` +
      "never touch — production data, user files, credentials — and the " +
      "destructive-action policy (prefer soft-delete with an undo over a hard " +
      "delete). Back the non-negotiable ones with a `permissions.deny` entry " +
      "in a committed `.claude/settings.json`: guide prose is persuasion, a " +
      "deny rule is enforcement.",
    autoFixable: true,
    action,
  });
}

export default { id: ID, tier: TIER, cost: /** @type {const} */ ("S"), run };
