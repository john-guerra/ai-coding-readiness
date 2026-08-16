import { describe, it, expect } from "vitest";
import {
  REGION_BEGIN,
  REGION_END,
  findRegion,
  upsertRegion,
  listRegions,
  stripRegions,
} from "../lib/regions.js";

/**
 * @param {string} id
 * @param {string} inner
 * @param {number} [v]
 */
const wrapped = (id, inner, v = 1) =>
  `<!-- ai-readiness:begin id=${id} v=${v} -->\n${inner}\n<!-- ai-readiness:end id=${id} -->`;

/**
 * @param {string} id
 * @param {string} inner
 * @param {number} [v]
 */
const wrappedCRLF = (id, inner, v = 1) =>
  `<!-- ai-readiness:begin id=${id} v=${v} -->\r\n${inner}\r\n<!-- ai-readiness:end id=${id} -->`;

describe("findRegion", () => {
  it("returns null when the region is absent", () => {
    expect(findRegion("# Guide\n", "guardrails")).toBeNull();
  });

  it("finds a region and reports its inner content and version", () => {
    const text = `# Guide\n\n${wrapped("guardrails", "never do X", 2)}\n`;
    const r = findRegion(text, "guardrails");
    expect(r?.inner).toBe("never do X");
    expect(r?.version).toBe(2);
  });

  it("does not confuse two different regions", () => {
    const text = `${wrapped("a", "AAA")}\n\n${wrapped("b", "BBB")}\n`;
    expect(findRegion(text, "a")?.inner).toBe("AAA");
    expect(findRegion(text, "b")?.inner).toBe("BBB");
  });

  // An unterminated region must not swallow the rest of the file — that is how
  // a generator eats a human's prose.
  it("returns null for a begin marker with no matching end", () => {
    const text = `<!-- ai-readiness:begin id=x v=1 -->\nhalf a region\n`;
    expect(findRegion(text, "x")).toBeNull();
  });

  // B3 — most Windows contributors check out with core.autocrlf=true. A
  // hardcoded \n after the begin marker returns null on every CRLF file,
  // which makes upsertRegion append an unbounded new region on every run.
  it("finds a region on a CRLF file", () => {
    const text = `# Guide\r\n\r\n${wrappedCRLF("guardrails", "never do X", 2)}\r\n`;
    const r = findRegion(text, "guardrails");
    expect(r?.inner).toBe("never do X");
    expect(r?.version).toBe(2);
  });

  // B9b — id is interpolated into a RegExp. An id containing a capture group
  // (or any other regex metacharacter) must be rejected, not silently used.
  it("throws on an id that is not [a-z0-9-]+", () => {
    expect(() => findRegion("text", "(evil)")).toThrow();
    expect(() => findRegion("text", "Bad_Id")).toThrow();
  });
});

describe("upsertRegion", () => {
  it("appends a new region at the end, leaving existing text byte-identical", () => {
    const before = "# Guide\n\nSome prose.\n";
    const after = upsertRegion(before, "guardrails", "never do X", 1);
    expect(after.startsWith(before)).toBe(true);
    expect(findRegion(after, "guardrails")?.inner).toBe("never do X");
  });

  it("replaces only the inner content of an existing region", () => {
    const before = `Intro.\n\n${wrapped("g", "old")}\n\nOutro.\n`;
    const after = upsertRegion(before, "g", "new", 1);
    expect(findRegion(after, "g")?.inner).toBe("new");
    expect(after).toContain("Intro.");
    expect(after).toContain("Outro.");
    expect(after).not.toContain("old");
  });

  // The whole safety property in one assertion.
  it("changes nothing outside the region it targets", () => {
    const before = `A\n\n${wrapped("g", "old")}\n\nB\n\n${wrapped("h", "keep")}\n`;
    const after = upsertRegion(before, "g", "new", 1);
    expect(stripRegions(after)).toBe(stripRegions(before));
    expect(findRegion(after, "h")?.inner).toBe("keep");
  });

  it("is idempotent when the content is unchanged", () => {
    const once = upsertRegion("# Guide\n", "g", "same", 1);
    expect(upsertRegion(once, "g", "same", 1)).toBe(once);
  });

  it("bumps the recorded version when it changes", () => {
    const v1 = upsertRegion("", "g", "x", 1);
    expect(findRegion(upsertRegion(v1, "g", "x", 2), "g")?.version).toBe(2);
  });

  // B3 — CRLF fixtures for upsert-into-existing and idempotency, per the
  // amendment: the idempotency gate otherwise only ever runs on a macOS temp
  // repo and never sees a CRLF checkout.
  it("replaces only the inner content of an existing region on a CRLF file", () => {
    const before = `Intro.\r\n\r\n${wrappedCRLF("g", "old")}\r\n\r\nOutro.\r\n`;
    const after = upsertRegion(before, "g", "new", 1);
    expect(findRegion(after, "g")?.inner).toBe("new");
    expect(after).toContain("Intro.");
    expect(after).toContain("Outro.");
    expect(after).not.toContain("old");
    expect(after).not.toMatch(/[^\r]\n/); // no bare LF introduced into a CRLF file
  });

  // Strengthened per review: idempotency alone (once === twice) would pass
  // even if eol detection were entirely broken, as long as it were broken
  // *consistently* between the two calls. The "no bare LF" assertion is what
  // actually proves the emitted block used the file's CRLF, not just that
  // repeating the same (possibly wrong) choice is stable.
  it("is idempotent on a CRLF file, and actually emits CRLF", () => {
    const before = "# Guide\r\n";
    const once = upsertRegion(before, "g", "same", 1);
    expect(once).not.toMatch(/[^\r]\n/);
    expect(upsertRegion(once, "g", "same", 1)).toBe(once);
  });

  // B9a — a document already ambiguous about which "g" region is the real one
  // must never be guessed at. Two complete, non-overlapping regions sharing an
  // id is the plain duplicate case.
  it("throws when the text already contains two complete regions with the same id", () => {
    const before = `${wrapped("g", "first")}\n\n${wrapped("g", "second")}\n`;
    expect(() => upsertRegion(before, "g", "new", 1)).toThrow();
  });

  // B9a — nested markers: begin(g) / AAA / begin(g) / BBB / end(g). Against
  // the brief's original implementation this makes findRegion's non-greedy
  // match swallow the nested begin as "inner", so an upsert silently deletes
  // AAA and BBB while stripRegions(before) === stripRegions(after) — the
  // safety oracle reports the write as clean. Must throw instead.
  it("throws when the text contains a nested marker for the same id", () => {
    const before = `<!-- ai-readiness:begin id=g v=1 -->\nAAA\n<!-- ai-readiness:begin id=g v=1 -->\nBBB\n<!-- ai-readiness:end id=g -->\n`;
    expect(() => upsertRegion(before, "g", "new", 1)).toThrow();
  });

  // B9a — the other half of the guard: the *new* content being written must
  // not itself contain marker syntax, or the next parse would nest.
  it("throws when the supplied inner itself contains a marker", () => {
    const before = "# Guide\n";
    const evil = "some text\n<!-- ai-readiness:begin id=h v=1 -->\nmore";
    expect(() => upsertRegion(before, "g", evil, 1)).toThrow();
  });

  // Ruling 1 (post-review): rawMarkerCounts only counts tokens for the
  // *target* id, so a cross-id interleave — begin(g) / AAA / begin(h) / BBB /
  // end(g) / CCC / end(h) — passes that guard. findRegion then walks past
  // h's begin marker (there is no earlier end(g) to stop at) and swallows it,
  // plus BBB, into g's "inner". An upsert would silently delete both while
  // stripRegions(before) === stripRegions(after) — the oracle reports the
  // write as clean. Refusing on the matched region's own inner content is
  // what closes this.
  it("throws when the matched region's inner content contains a marker for a different id", () => {
    const before =
      "<!-- ai-readiness:begin id=g v=1 -->\nAAA\n" +
      "<!-- ai-readiness:begin id=h v=1 -->\nBBB\n" +
      "<!-- ai-readiness:end id=g -->\nCCC\n" +
      "<!-- ai-readiness:end id=h -->\n";
    expect(() => upsertRegion(before, "g", "new", 1)).toThrow();
  });

  // Self-review gap called out in the report: rawMarkerCounts' `ends > 1`
  // branch was coded but only ever exercised alongside `begins > 1`. This
  // fixture has exactly one begin(g) and two end(g) markers, so it can only
  // pass through the ends-only branch.
  it("throws when the text contains one begin and two end markers for the same id", () => {
    const before = `${wrapped("g", "content")}\n\nstray text\n<!-- ai-readiness:end id=g -->\n`;
    expect(() => upsertRegion(before, "g", "new", 1)).toThrow();
  });

  // B9b
  it("throws on an id that is not [a-z0-9-]+", () => {
    expect(() => upsertRegion("# Guide\n", "(evil)", "x", 1)).toThrow();
  });
});

describe("id validation (B9b)", () => {
  it("REGION_BEGIN and REGION_END throw on an id that is not [a-z0-9-]+", () => {
    expect(() => REGION_BEGIN("(evil)", 1)).toThrow();
    expect(() => REGION_END("(evil)")).toThrow();
  });

  it("REGION_BEGIN and REGION_END accept a plain lowercase-and-hyphen id", () => {
    expect(REGION_BEGIN("guard-rails", 1)).toBe(
      "<!-- ai-readiness:begin id=guard-rails v=1 -->",
    );
    expect(REGION_END("guard-rails")).toBe(
      "<!-- ai-readiness:end id=guard-rails -->",
    );
  });
});

describe("listRegions", () => {
  it("lists every region in document order", () => {
    const text = `${wrapped("a", "1")}\n${wrapped("b", "2")}\n`;
    expect(listRegions(text).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("returns an empty list for text with no regions", () => {
    expect(listRegions("plain\n")).toEqual([]);
  });
});
