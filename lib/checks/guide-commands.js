import { makeFinding } from "../finding.js";
import { readGuide, resolveImports } from "../guide.js";
import { onlyCode } from "../markdown.js";

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
 * The tokens worth searching the corpus for, split by how unambiguous they
 * are — the defect a derived-but-common single word invites (`scripts.test:
 * "check"` false-passes on "Double check your changes.") is the same class
 * A2 closed for a *fixed* word list, so it gets the same discipline: only a
 * phrase that could not plausibly occur by accident is trusted to match
 * ordinary prose.
 *
 * - `anywhere`: the whole `scripts.test` string, but only when it is more
 *   than one word (a multi-word phrase like `turbo run test` cannot occur in
 *   prose by accident the way a single word can), plus `npm test` and
 *   `npm run test`, which are always valid regardless of what the script
 *   itself invokes.
 * - `code`: the whole script, but only when it is a SINGLE word — e.g.
 *   `vitest`, `check`, `jest`. Credited only where guides actually put
 *   commands (inside a code span or fence), never in prose, because a bare
 *   word is exactly as likely to be ordinary English (`check`, `lint`,
 *   `build`, `format`) as the fixed-list problem A2 closed.
 *
 *   It is deliberately NOT the first word of a multi-word script. That
 *   derivation re-opened A2's defect class through the back door: the first
 *   word of `node --test`, `npm run test:unit`, `bash scripts/test.sh` or
 *   `pnpm test` is a *launcher*, so any unrelated command written in the
 *   guide (`node bin/x.mjs`, `npm install`, a ```` ```bash ```` fence) satisfied
 *   it and the check reported `pass` on a guide that never named the test
 *   command. When the script has whitespace the whole string is already in
 *   `anywhere`, so `node --test`, `npm run test:unit` and `turbo run test`
 *   still pass when they are documented literally — which is the only thing
 *   worth crediting.
 *
 * @param {string} testScript
 * @returns {{anywhere: string[], code: string|null}}
 */
function candidateTokens(testScript) {
  const trimmed = testScript.trim();
  const multiWord = /\s/.test(trimmed);
  const anywhere = new Set(["npm test", "npm run test"]);
  if (multiWord) anywhere.add(trimmed);
  return { anywhere: [...anywhere], code: multiWord ? null : trimmed };
}

/**
 * The first line of `text` matching `pattern`, trimmed — or null. Quoting the
 * actual matched line (rather than just asserting a match happened) turns an
 * unverifiable claim into a citation a reader can check and reject, the same
 * treatment `guide.guardrails` applies to a matched prohibition — including
 * the case that treatment exists for here too: "Do not run `npm test` — use
 * `make check`." still matches literally, but quoting the whole line lets a
 * reader see the negation and reject the verdict themselves.
 * @param {string} text
 * @param {RegExp} pattern
 */
function firstMatchingLine(text, pattern) {
  for (const rawLine of text.split("\n")) {
    if (pattern.test(rawLine)) return rawLine.trim();
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

  const { anywhere, code } = candidateTokens(testScript);
  // null when the script is more than one word: there is no safe single-word
  // token to derive, and the whole string is already searched for above.
  const codePattern = code === null ? null : tokenPattern(code);
  const { files } = await resolveImports(repo, guide);

  for (const file of files) {
    for (const token of anywhere) {
      const line = firstMatchingLine(file.text, tokenPattern(token));
      if (line !== null) {
        return makeFinding({
          ...base,
          status: "pass",
          evidence:
            `${file.path} names the test command via "${token}": "${line}" ` +
            `(package.json declares scripts.test: "${testScript}").`,
          fix: null,
          autoFixable: false,
        });
      }
    }

    // onlyCode blanks non-code characters but preserves line alignment, so a
    // matched line's index is valid in the original text too — recovering the
    // quote there means it is the real guide text, backticks included, not a
    // blanked derivative of it.
    if (codePattern === null) continue;
    const originalLines = file.text.split("\n");
    const codeLines = onlyCode(file.text).split("\n");
    const codeIdx = codeLines.findIndex((l) => codePattern.test(l));
    if (codeIdx >= 0) {
      const quoted = originalLines[codeIdx].trim();
      return makeFinding({
        ...base,
        status: "pass",
        evidence:
          `${file.path} names the test command via "${code}" in a code ` +
          `span or fence: "${quoted}" (package.json declares scripts.test: ` +
          `"${testScript}").`,
        fix: null,
        autoFixable: false,
      });
    }
  }

  // The single-word token is credited only inside code, but if it shows up
  // in ordinary prose that is still worth reporting — it means someone
  // probably meant to document the command and didn't put it where this
  // check (or an agent) would recognize it as one.
  let proseHit = null;
  if (codePattern !== null) {
    for (const file of files) {
      const line = firstMatchingLine(file.text, codePattern);
      if (line !== null) {
        proseHit = { path: file.path, line };
        break;
      }
    }
  }
  const proseNote = proseHit
    ? ` "${code}" does appear in ${proseHit.path} ("${proseHit.line}"), but ` +
      "not inside a code span or fence, so it is not credited as naming the " +
      "command."
    : "";

  const lookedForCode =
    code === null
      ? ` scripts.test is more than one word, so no single-word token was ` +
        `derived from it — the first word of a multi-word script is a ` +
        `launcher (\`node\`, \`npm\`, \`bash\`) and crediting it would pass ` +
        `any unrelated command.`
      : ` "${code}" was also looked for inside a code span or fence (never a ` +
        `fence's language tag).`;

  return makeFinding({
    ...base,
    status: "fail",
    evidence:
      `None of the guide corpus (${files.map((f) => f.path).join(", ")}) ` +
      `names the test command; package.json declares scripts.test: ` +
      `"${testScript}". Looked for ${anywhere.map((t) => `"${t}"`).join(", ")} ` +
      `anywhere.${lookedForCode}${proseNote}`,
    fix: `Add a Commands section to ${guide.path} (or a file it imports) naming the exact command from package.json's scripts.test — \`${testScript}\` — inside a code span or fence.`,
    autoFixable: true,
  });
}

export default { id: ID, tier: TIER, cost: /** @type {const} */ ("S"), run };
