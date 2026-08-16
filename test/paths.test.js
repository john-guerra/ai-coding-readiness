import { describe, it, expect } from "vitest";
import {
  insideRoot,
  hasGitComponent,
  assertWritableRelative,
} from "../lib/paths.js";

// The predicate is shared by the read side (lib/repo.js) and the write side
// (lib/writer.js), so it is tested on its own as well as through both. The
// cases below are the ones a second copy already got wrong.
describe("insideRoot", () => {
  it("accepts a path under the root", () => {
    expect(insideRoot("/a/root", "sub/file.md")).toBe(true);
  });

  it("rejects a traversal and an absolute path", () => {
    expect(insideRoot("/a/root", "../secret.md")).toBe(false);
    expect(insideRoot("/a/root", "/etc/passwd")).toBe(false);
  });

  it("does not treat a sibling with the root as a prefix as contained", () => {
    expect(insideRoot("/a/root", "../root-evil/x.md")).toBe(false);
  });

  it("works when the root already ends with a separator", () => {
    // The naive form builds "//" here and refuses everything, including a root
    // of "/" — which is how a copy of this predicate diverged from the original.
    expect(insideRoot("/a/root/", "sub/file.md")).toBe(true);
    expect(insideRoot("/", "etc/hosts")).toBe(true);
  });
});

describe("hasGitComponent", () => {
  it("matches at any depth and in any case", () => {
    expect(hasGitComponent(".git/config")).toBe(true);
    expect(hasGitComponent(".GIT/config")).toBe(true);
    expect(hasGitComponent("vendor/sub/.Git/hooks/pre-commit")).toBe(true);
    expect(hasGitComponent("docs/.git")).toBe(true);
  });

  it("does not match names that merely start with .git", () => {
    expect(hasGitComponent(".gitignore")).toBe(false);
    expect(hasGitComponent(".github/workflows/ci.yml")).toBe(false);
    expect(hasGitComponent("gitignore")).toBe(false);
  });
});

describe("assertWritableRelative", () => {
  it("returns the path relative to the root", () => {
    expect(assertWritableRelative("/a/root", "sub/file.md")).toBe(
      "sub/file.md",
    );
  });

  it("is not off by one when the root ends with a separator", () => {
    // `target.slice(base.length + 1)` returns "gitignore" here, which then
    // reads as an ordinary file — and ".git/config" reads as "git/config".
    expect(assertWritableRelative("/a/root/", ".gitignore")).toBe(".gitignore");
    expect(() => assertWritableRelative("/a/root/", ".git/config")).toThrow(
      /\.git/i,
    );
  });

  it("refuses the root itself", () => {
    expect(() => assertWritableRelative("/a/root", ".")).toThrow(/refusing/i);
  });

  it("refuses traversal, absolute paths and .git", () => {
    expect(() => assertWritableRelative("/a/root", "../x")).toThrow(/outside/i);
    expect(() => assertWritableRelative("/a/root", "/etc/passwd")).toThrow(
      /outside/i,
    );
    expect(() => assertWritableRelative("/a/root", ".GIT/config")).toThrow(
      /\.git/i,
    );
  });
});
