import { describe, it, expect } from "vitest";
import { createOverlay } from "../lib/overlay.js";
import { createFakeRepo } from "../lib/repo.js";

describe("createOverlay", () => {
  it("reads a file that only the overlay has written", async () => {
    const { repo, writer } = createOverlay(createFakeRepo({ files: {} }));
    expect(await repo.readFile("NEW.md")).toBeNull();
    await writer.write("NEW.md", "hi\n");
    expect(await repo.readFile("NEW.md")).toBe("hi\n");
  });

  it("shadows a file the real repo has", async () => {
    const base = createFakeRepo({ files: { "a.md": "old\n" } });
    const { repo, writer } = createOverlay(base);
    await writer.write("a.md", "new\n");
    expect(await repo.readFile("a.md")).toBe("new\n");
    // The real repo underneath is untouched — this is a dry run.
    expect(await base.readFile("a.md")).toBe("old\n");
  });

  it("normalises the read path the way the writer does", async () => {
    const { repo, writer } = createOverlay(createFakeRepo({ files: {} }));
    await writer.write("./docs/x.md", "hi\n");
    expect(await repo.readFile("docs/x.md")).toBe("hi\n");
  });

  it("lists a written file in its directory, non-recursively", async () => {
    const { repo, writer } = createOverlay(
      createFakeRepo({ files: { ".github/ISSUE_TEMPLATE/config.yml": "x" } }),
    );
    await writer.write(".github/ISSUE_TEMPLATE/bug.md", "template\n");
    await writer.write(".github/ISSUE_TEMPLATE/deeper/no.md", "nested\n");

    const listed = await repo.listFiles(".github/ISSUE_TEMPLATE");
    expect(listed.sort()).toEqual([
      ".github/ISSUE_TEMPLATE/bug.md",
      ".github/ISSUE_TEMPLATE/config.yml",
    ]);
  });

  it("applies the writer's lexical guard, so it cannot record a refused path", async () => {
    const { writer } = createOverlay(createFakeRepo({ files: {} }));
    await expect(writer.write("../escaped.md", "x")).rejects.toThrow(
      /outside/i,
    );
    await expect(writer.write(".git/config", "x")).rejects.toThrow(/\.git/i);
  });
});
