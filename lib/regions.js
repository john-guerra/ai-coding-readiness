/**
 * Marked regions: the mechanism that lets a generator write into a file it
 * does not own.
 *
 * Everything this tool generates lives between markers, and nothing outside
 * them is ever touched. That is not a convention — `stripRegions` exists so a
 * test can assert it byte-for-byte, and `upsertRegion`'s contract is written
 * in those terms.
 *
 * Two properties this module refuses to get wrong quietly:
 *
 * - Line endings. A hardcoded `\n` after the begin marker returns no match on
 *   a CRLF checkout (most Windows contributors have `core.autocrlf=true`),
 *   which makes `upsertRegion` append a brand-new region every single run,
 *   unbounded. Every regex here is `\r?\n`, and `upsertRegion` detects the
 *   file's dominant line ending and emits the block with it.
 * - Ambiguous markers. A document with a duplicate or nested marker for the
 *   same id is not a case to guess at: the non-greedy end-marker match will
 *   happily swallow a nested begin as part of "inner", and
 *   `stripRegions(before) === stripRegions(after)` even though real content
 *   vanished — the safety oracle's blind spot. `upsertRegion` refuses instead
 *   of writing into a document (or with content) it cannot parse cleanly.
 *
 * Borrowed from `all-contributors`, which survived a decade of writing into
 * other people's READMEs on exactly this idea.
 */

/** Ids are ours, not user input, but an unescaped id lands directly in a
 * RegExp — validate it everywhere one is accepted so a metacharacter can
 * never shift a match instead of failing loudly. */
const ID_RE = /^[a-z0-9-]+$/;
const ID = "[a-z0-9-]+";

/** @param {string} id */
function assertValidId(id) {
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw new Error(
      `invalid region id ${JSON.stringify(id)}: must match ${ID_RE}`,
    );
  }
}

/** Any begin or end marker, regardless of id — used to refuse content that
 * would nest a marker inside a region we are about to write.
 */
const MARKER_TOKEN_RE = /<!-- ai-readiness:(?:begin|end) id=/;

/**
 * @param {string} id
 * @param {number} v
 */
export const REGION_BEGIN = (id, v) => {
  assertValidId(id);
  return `<!-- ai-readiness:begin id=${id} v=${v} -->`;
};

/** @param {string} id */
export const REGION_END = (id) => {
  assertValidId(id);
  return `<!-- ai-readiness:end id=${id} -->`;
};

const ANY_REGION = new RegExp(
  `<!-- ai-readiness:begin id=(${ID}) v=(\\d+) -->\\r?\\n([\\s\\S]*?)\\r?\\n?<!-- ai-readiness:end id=\\1 -->`,
  "g",
);

/**
 * @typedef {Object} Region
 * @property {number} start - offset of the first character of the begin marker
 * @property {number} end - offset just past the last character of the end marker
 * @property {string} inner
 * @property {number} version
 */

/**
 * @param {string} text
 * @param {string} id
 * @returns {Region|null}
 */
export function findRegion(text, id) {
  assertValidId(id);
  // A begin marker with no matching end matches nothing. That is deliberate:
  // a greedy fallback would let a truncated region swallow the rest of a
  // human's file the next time it was rewritten.
  const re = new RegExp(
    `<!-- ai-readiness:begin id=(${id}) v=(\\d+) -->\\r?\\n([\\s\\S]*?)\\r?\\n?<!-- ai-readiness:end id=${id} -->`,
  );
  const m = re.exec(text);
  if (!m) return null;
  return {
    start: m.index,
    end: m.index + m[0].length,
    inner: m[3],
    version: Number(m[2]),
  };
}

/**
 * Count raw (unpaired) begin/end marker occurrences for one id. Deliberately
 * not routed through the paired begin…end regex: a nested marker
 * (`begin(g) / AAA / begin(g) / BBB / end(g)`) still parses as exactly one
 * paired match — the non-greedy search just walks past the inner begin to
 * reach the only end marker in the text — so counting *matches* would miss
 * the corruption entirely. Counting raw markers catches both the plain
 * duplicate (two complete regions) and the nested case (two begins, one end).
 *
 * @param {string} text
 * @param {string} id
 */
function rawMarkerCounts(text, id) {
  const beginRe = new RegExp(
    `<!-- ai-readiness:begin id=${id} v=\\d+ -->`,
    "g",
  );
  const endRe = new RegExp(`<!-- ai-readiness:end id=${id} -->`, "g");
  return {
    begins: (text.match(beginRe) ?? []).length,
    ends: (text.match(endRe) ?? []).length,
  };
}

/**
 * The file's dominant line ending, for emitting a new block that matches the
 * rest of the file rather than mixing endings in. Defaults to "\n" when the
 * text has no newlines at all.
 *
 * @param {string} text
 * @returns {"\r\n"|"\n"}
 */
function detectEol(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const totalNewlines = (text.match(/\n/g) ?? []).length;
  const lf = totalNewlines - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

/**
 * Replace a region's inner content, or append the region if it is absent.
 * Text outside the targeted region is never modified.
 *
 * Refuses (throws) rather than guessing when:
 * - the supplied `inner` itself contains marker syntax, which would nest a
 *   region inside the one being written; or
 * - the text already contains a duplicate or nested marker for `id` — an
 *   ambiguous document is not safe to blindly overwrite.
 *
 * @param {string} text
 * @param {string} id
 * @param {string} inner
 * @param {number} version
 * @returns {string}
 */
export function upsertRegion(text, id, inner, version) {
  assertValidId(id);

  if (MARKER_TOKEN_RE.test(inner)) {
    throw new Error(
      `region content for id ${JSON.stringify(id)} must not itself contain a marker`,
    );
  }

  const { begins, ends } = rawMarkerCounts(text, id);
  if (begins > 1 || ends > 1) {
    throw new Error(
      `refusing to upsert id ${JSON.stringify(id)}: text already contains a duplicate or nested marker for this id`,
    );
  }

  const eol = detectEol(text);
  const block = `${REGION_BEGIN(id, version)}${eol}${inner}${eol}${REGION_END(id)}`;

  const found = findRegion(text, id);
  if (found) {
    return text.slice(0, found.start) + block + text.slice(found.end);
  }
  if (text === "") return `${block}${eol}`;
  const separator = text.endsWith(eol + eol)
    ? ""
    : text.endsWith(eol)
      ? eol
      : eol + eol;
  return `${text}${separator}${block}${eol}`;
}

/**
 * @param {string} text
 * @returns {Array<{id: string, version: number, inner: string}>}
 */
export function listRegions(text) {
  /** @type {Array<{id: string, version: number, inner: string}>} */
  const out = [];
  for (const m of text.matchAll(ANY_REGION)) {
    out.push({ id: m[1], version: Number(m[2]), inner: m[3] });
  }
  return out;
}

/**
 * The text with every marked block removed. Comparing this before and after a
 * write is how a test proves nothing outside a region changed.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripRegions(text) {
  return text.replace(ANY_REGION, "");
}
