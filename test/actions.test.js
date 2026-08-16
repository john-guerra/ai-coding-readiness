import { describe, it, expect } from "vitest";
import { createFakeRepo } from "../lib/repo.js";
import { createFakeWriter } from "../lib/writer.js";
import { applyAction } from "../lib/actions.js";
import { recordRegion, classify } from "../lib/manifest.js";
import { findRegion } from "../lib/regions.js";

/** @type {import('../lib/manifest.js').Manifest} */
const EMPTY = { schemaVersion: 1, entries: {} };

describe("write-file", () => {
  it("creates a file that does not exist", async () => {
    const w = createFakeWriter();
    const r = await applyAction(
      createFakeRepo({ files: {} }),
      w,
      { kind: "write-file", path: "CODEOWNERS", content: "* @me\n" },
      EMPTY,
    );
    expect(r.changed).toBe(true);
    expect(w.files["CODEOWNERS"]).toBe("* @me\n");
  });

  // Never overwrite a file we did not author. A repo's existing CODEOWNERS is
  // theirs, and a generator that replaces it has destroyed something.
  it("does not overwrite an existing file", async () => {
    const w = createFakeWriter();
    const r = await applyAction(
      createFakeRepo({ files: { CODEOWNERS: "* @someone-else\n" } }),
      w,
      { kind: "write-file", path: "CODEOWNERS", content: "* @me\n" },
      EMPTY,
    );
    expect(r.changed).toBe(false);
    expect(r.reason).toMatch(/exists/i);
    expect(w.files["CODEOWNERS"]).toBeUndefined();
  });
});

describe("append-lines", () => {
  it("creates the file when absent", async () => {
    const w = createFakeWriter();
    await applyAction(
      createFakeRepo({ files: {} }),
      w,
      { kind: "append-lines", path: ".gitignore", lines: [".env", "dist/"] },
      EMPTY,
    );
    expect(w.files[".gitignore"]).toBe(".env\ndist/\n");
  });

  it("appends only the lines that are missing", async () => {
    const w = createFakeWriter();
    await applyAction(
      createFakeRepo({ files: { ".gitignore": "node_modules/\n.env\n" } }),
      w,
      { kind: "append-lines", path: ".gitignore", lines: [".env", "dist/"] },
      EMPTY,
    );
    expect(w.files[".gitignore"]).toBe("node_modules/\n.env\ndist/\n");
  });

  it("is a no-op when every line is already present", async () => {
    const w = createFakeWriter();
    const r = await applyAction(
      createFakeRepo({ files: { ".gitignore": ".env\ndist/\n" } }),
      w,
      { kind: "append-lines", path: ".gitignore", lines: [".env", "dist/"] },
      EMPTY,
    );
    expect(r.changed).toBe(false);
    expect(w.files[".gitignore"]).toBeUndefined();
  });

  it("adds a separating newline when the file does not end with one", async () => {
    const w = createFakeWriter();
    await applyAction(
      createFakeRepo({ files: { ".gitignore": "node_modules/" } }),
      w,
      { kind: "append-lines", path: ".gitignore", lines: [".env"] },
      EMPTY,
    );
    expect(w.files[".gitignore"]).toBe("node_modules/\n.env\n");
  });
});

describe("write-region", () => {
  /** @type {import('../lib/actions.js').Action} */
  const action = {
    kind: "write-region",
    path: "CLAUDE.md",
    id: "guardrails",
    inner: "- never touch production",
    version: 1,
  };

  it("creates the file with the region when absent", async () => {
    const w = createFakeWriter();
    const r = await applyAction(
      createFakeRepo({ files: {} }),
      w,
      action,
      EMPTY,
    );
    expect(r.changed).toBe(true);
    expect(findRegion(w.files["CLAUDE.md"], "guardrails")?.inner).toBe(
      "- never touch production",
    );
  });

  it("appends the region to an existing file without touching its prose", async () => {
    const w = createFakeWriter();
    const before = "# Guide\n\nExisting prose.\n";
    await applyAction(
      createFakeRepo({ files: { "CLAUDE.md": before } }),
      w,
      action,
      EMPTY,
    );
    expect(w.files["CLAUDE.md"].startsWith(before)).toBe(true);
  });

  it("records what it wrote in the manifest it returns", async () => {
    const w = createFakeWriter();
    const r = await applyAction(
      createFakeRepo({ files: {} }),
      w,
      action,
      EMPTY,
    );
    expect(classify(r.manifest, "CLAUDE.md", "guardrails", action.inner)).toBe(
      "untouched",
    );
    // The manifest is returned, never mutated: the caller decides when it is
    // persisted, and a refused action must not leave a stale record behind.
    expect(EMPTY.entries).toEqual({});
  });

  it("updates a region the manifest says we wrote and nobody changed", async () => {
    const w = createFakeWriter();
    const existing = `# Guide\n\n<!-- ai-readiness:begin id=guardrails v=1 -->\nold\n<!-- ai-readiness:end id=guardrails -->\n`;
    const manifest = recordRegion(EMPTY, "CLAUDE.md", "guardrails", "old");
    const r = await applyAction(
      createFakeRepo({ files: { "CLAUDE.md": existing } }),
      w,
      action,
      manifest,
    );
    expect(r.changed).toBe(true);
    expect(findRegion(w.files["CLAUDE.md"], "guardrails")?.inner).toBe(
      "- never touch production",
    );
  });

  // The manifest's reason for existing. A human edited our region; the answer
  // is to report it, not to overwrite it.
  it("refuses to overwrite a region a human has edited", async () => {
    const w = createFakeWriter();
    const edited = `<!-- ai-readiness:begin id=guardrails v=1 -->\nI changed this by hand\n<!-- ai-readiness:end id=guardrails -->\n`;
    const manifest = recordRegion(EMPTY, "CLAUDE.md", "guardrails", "old");
    const r = await applyAction(
      createFakeRepo({ files: { "CLAUDE.md": edited } }),
      w,
      action,
      manifest,
    );
    expect(r.changed).toBe(false);
    expect(r.reason).toMatch(/edited/i);
    expect(w.files["CLAUDE.md"]).toBeUndefined();
  });

  // Amendment B4. No manifest entry means the hash is UNKNOWN, which is not
  // "unchanged" — the write-side analogue of "unknown is never pass". This is
  // the state after the manifest was deleted, was unreadable, or a human
  // pasted the marker syntax into their own file.
  it("refuses a region that exists with no manifest entry", async () => {
    const w = createFakeWriter();
    const theirs = `<!-- ai-readiness:begin id=guardrails v=1 -->\nsomething\n<!-- ai-readiness:end id=guardrails -->\n`;
    const r = await applyAction(
      createFakeRepo({ files: { "CLAUDE.md": theirs } }),
      w,
      action,
      EMPTY,
    );
    expect(r.changed).toBe(false);
    expect(r.reason).toMatch(/no record/i);
    expect(w.files["CLAUDE.md"]).toBeUndefined();
  });

  it("is a no-op when the region already holds the intended content", async () => {
    const w = createFakeWriter();
    const same = `<!-- ai-readiness:begin id=guardrails v=1 -->\n- never touch production\n<!-- ai-readiness:end id=guardrails -->\n`;
    const manifest = recordRegion(
      EMPTY,
      "CLAUDE.md",
      "guardrails",
      "- never touch production",
    );
    const r = await applyAction(
      createFakeRepo({ files: { "CLAUDE.md": same } }),
      w,
      action,
      manifest,
    );
    expect(r.changed).toBe(false);
    expect(w.files["CLAUDE.md"]).toBeUndefined();
  });

  // Amendment B9. Short-circuiting on identical content alone freezes the `v=`
  // marker at whatever it was when the content last changed, so a future
  // migration keyed on the version never fires on exactly the files that need
  // it.
  it("rewrites the region when only the version changed", async () => {
    const w = createFakeWriter();
    const same = `<!-- ai-readiness:begin id=guardrails v=1 -->\n- never touch production\n<!-- ai-readiness:end id=guardrails -->\n`;
    const manifest = recordRegion(
      EMPTY,
      "CLAUDE.md",
      "guardrails",
      "- never touch production",
    );
    const r = await applyAction(
      createFakeRepo({ files: { "CLAUDE.md": same } }),
      w,
      { ...action, version: 2 },
      manifest,
    );
    expect(r.changed).toBe(true);
    expect(findRegion(w.files["CLAUDE.md"], "guardrails")?.version).toBe(2);
  });

  // Amendment B9: `upsertRegion` throws on an ambiguous document. That is a
  // refusal to report, not a crash mid-run — a throw reaching the CLI with
  // regions already written on disk is the failure mode the per-action
  // manifest persistence exists to avoid.
  it("reports a refusal instead of throwing when the document is ambiguous", async () => {
    const w = createFakeWriter();
    const dup =
      `<!-- ai-readiness:begin id=guardrails v=1 -->\nold\n<!-- ai-readiness:end id=guardrails -->\n\n` +
      `<!-- ai-readiness:begin id=guardrails v=1 -->\nold\n<!-- ai-readiness:end id=guardrails -->\n`;
    const manifest = recordRegion(EMPTY, "CLAUDE.md", "guardrails", "old");
    const r = await applyAction(
      createFakeRepo({ files: { "CLAUDE.md": dup } }),
      w,
      action,
      manifest,
    );
    expect(r.changed).toBe(false);
    expect(r.reason).toMatch(/duplicate|nested/i);
    expect(w.files["CLAUDE.md"]).toBeUndefined();
  });
});
