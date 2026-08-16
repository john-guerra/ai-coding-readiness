import { describe, it, expect } from "vitest";
import { withoutCode, onlyCode } from "../lib/markdown.js";

const FENCED = [
  "prose before",
  "```bash",
  "npm test",
  "```",
  "prose after",
].join("\n");

describe("withoutCode", () => {
  it("blanks a fenced block and an inline span, keeping prose", () => {
    const out = withoutCode("Run `npm test` now.\n");
    expect(out).not.toMatch(/npm test/);
    expect(out).toMatch(/Run/);
    expect(out).toMatch(/now\./);
  });

  it("preserves line count and index so a caller can quote the original line", () => {
    const out = withoutCode(FENCED);
    const original = FENCED.split("\n");
    const stripped = out.split("\n");
    expect(stripped).toHaveLength(original.length);
    expect(stripped[0].trim()).toBe("prose before");
    expect(stripped[2].trim()).toBe("");
    expect(stripped[4].trim()).toBe("prose after");
  });

  // The copy this replaced deleted fenced blocks outright, which could join
  // the text either side of a fence into one line and hide a token boundary.
  it("does not join the text on either side of a fence", () => {
    expect(withoutCode("foo```\nx\n```bar")).toMatch(/foo\s/);
    expect(withoutCode("foo```\nx\n```bar")).not.toMatch(/foobar/);
  });
});

describe("onlyCode", () => {
  it("keeps a fenced block's body and blanks the prose around it", () => {
    const out = onlyCode(FENCED);
    expect(out).toMatch(/npm test/);
    expect(out).not.toMatch(/prose/);
  });

  // A language tag is never a command. This is what let a `bash` test script
  // "pass" guide.commands on a fence whose body was `git status`.
  it("excludes the opening fence line, info string and all", () => {
    expect(onlyCode(FENCED)).not.toMatch(/bash/);
  });

  it("keeps an inline code span", () => {
    expect(onlyCode("Run `check` first.\n")).toMatch(/check/);
    expect(onlyCode("Run `check` first.\n")).not.toMatch(/first/);
  });

  it("does not treat a backtick inside a fence as a span boundary", () => {
    const text = "```\na ` b\n```\nprose `kept`\n";
    const out = onlyCode(text);
    expect(out).toMatch(/kept/);
    expect(out).not.toMatch(/prose/);
  });

  it("preserves line count and index", () => {
    const out = onlyCode(FENCED).split("\n");
    expect(out).toHaveLength(FENCED.split("\n").length);
    expect(out[2].trim()).toBe("npm test");
  });
});
