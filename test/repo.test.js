import { describe, it, expect } from "vitest";
import { createFakeRepo } from "../lib/repo.js";

describe("createFakeRepo", () => {
  it("reads a file that exists", async () => {
    const repo = createFakeRepo({ files: { "a.txt": "hello" } });
    expect(await repo.readFile("a.txt")).toBe("hello");
  });

  // Absence is a finding, not an exception. Every check relies on this.
  it("returns null for a missing file rather than throwing", async () => {
    const repo = createFakeRepo({ files: {} });
    expect(await repo.readFile("nope.txt")).toBeNull();
  });

  it("lists files in a directory, non-recursively", async () => {
    const repo = createFakeRepo({
      files: {
        ".github/workflows/ci.yml": "",
        ".github/workflows/release.yml": "",
        ".github/dependabot.yml": "",
      },
    });
    const found = await repo.listFiles(".github/workflows");
    expect(found.sort()).toEqual([
      ".github/workflows/ci.yml",
      ".github/workflows/release.yml",
    ]);
  });

  it("returns an empty list for a missing directory", async () => {
    const repo = createFakeRepo({ files: {} });
    expect(await repo.listFiles(".github/workflows")).toEqual([]);
  });

  it("returns merge file lists newest first", async () => {
    const repo = createFakeRepo({
      mergedPrFileLists: [["a.js"], ["b.js", "CHANGELOG.md"]],
    });
    expect(await repo.mergedPrFileLists(10)).toEqual([
      ["a.js"],
      ["b.js", "CHANGELOG.md"],
    ]);
  });

  it("truncates merge file lists to the requested count", async () => {
    const repo = createFakeRepo({
      mergedPrFileLists: [["a"], ["b"], ["c"]],
    });
    expect(await repo.mergedPrFileLists(2)).toEqual([["a"], ["b"]]);
  });
});
