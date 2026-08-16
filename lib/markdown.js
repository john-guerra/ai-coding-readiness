/**
 * Separating markdown prose from markdown code.
 *
 * Three near-duplicate strippers lived in `lib/guide.js`,
 * `lib/checks/guide-guardrails.js` and `lib/checks/guide-commands.js`. By this
 * project's own stated threshold — two copies are not a seam, three is, the
 * rule that moved `countLines` into `lib/text.js` after two copies disagreed
 * about `"a\nb"` — that is a seam. They had already started to differ: one
 * deleted a fenced block outright while another blanked it in place, and only
 * one of them knew that a fence's info string is not code. Any of those
 * differences changes a verdict, and none of them was a decision anybody made.
 *
 * Both functions here preserve line alignment: the result has the same number
 * of lines as the input and every line sits at the same index, so a caller
 * that matches against the transformed text can quote the UNTOUCHED original
 * line at that index. Quoting the original — backticks and all — is what makes
 * a finding's evidence a citation a reader can check and reject, rather than a
 * mangled derivative of the guide.
 */

/** A fenced code block, opening delimiter through closing delimiter. */
const FENCE_RE = /```[\s\S]*?```/g;

/** An inline code span. Never spans a line. */
const SPAN_RE = /`[^`\n]*`/g;

/**
 * `text` with every fenced block and inline code span blanked out, leaving
 * only prose. Newlines survive; everything else inside code becomes a space.
 *
 * A prohibition or an `@import` inside a fence is documentation ABOUT one, not
 * one — a fenced example reading "Never touch production data." states no
 * guardrail, and an `@path` in a fence imports nothing. Counting either
 * inflates exactly the thing the caller set out to measure.
 *
 * @param {string} text
 * @returns {string}
 */
export function withoutCode(text) {
  const blank = (/** @type {string} */ m) => m.replace(/[^\n]/g, " ");
  return text.replace(FENCE_RE, blank).replace(SPAN_RE, blank);
}

/**
 * The inverse: `text` with everything OUTSIDE a fenced block or inline code
 * span blanked out, leaving only code.
 *
 * The opening fence LINE is excluded. That line is the delimiter plus its info
 * string (```` ```bash ````), and a language tag is never a command — before
 * this, a `bash`-launched test script "passed" `guide.commands` on a fence
 * whose body was `git status`, with the evidence quoting the literal string
 * "```bash" as the command it had found.
 *
 * @param {string} text
 * @returns {string}
 */
export function onlyCode(text) {
  /** @type {string[]} */
  const mask = Array.from(text, (ch) => (ch === "\n" ? "\n" : " "));
  const keep = (/** @type {number} */ start, /** @type {number} */ end) => {
    for (let i = start; i < end; i++) mask[i] = text[i];
  };

  const fenceRe = new RegExp(FENCE_RE.source, "g");
  let m;
  while ((m = fenceRe.exec(text))) {
    // Start after the newline that ends the opening fence line. A fence with
    // no newline is entirely delimiter and info string, so none of it is kept.
    const nl = text.indexOf("\n", m.index);
    const end = m.index + m[0].length;
    if (nl !== -1 && nl + 1 < end) keep(nl + 1, end);
  }

  // Inline spans are searched over the text with fenced ranges blanked out, so
  // a stray backtick inside fenced content is never mistaken for a boundary.
  const withoutFences = text.replace(FENCE_RE, (block) =>
    block.replace(/[^\n]/g, " "),
  );
  const spanRe = new RegExp(SPAN_RE.source, "g");
  while ((m = spanRe.exec(withoutFences))) {
    keep(m.index, m.index + m[0].length);
  }

  return mask.join("");
}
