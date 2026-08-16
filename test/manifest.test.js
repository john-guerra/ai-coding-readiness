import { describe, it, expect } from "vitest";
import { createFakeRepo } from "../lib/repo.js";
import {
  MANIFEST_PATH,
  hashContent,
  readManifest,
  classify,
  recordRegion,
  retireRegion,
} from "../lib/manifest.js";

describe("readManifest", () => {
  it("returns ok:true with an empty manifest when the file is absent", async () => {
    const result = await readManifest(createFakeRepo({ files: {} }));
    expect(result).toEqual({
      ok: true,
      manifest: { schemaVersion: 1, entries: {} },
    });
  });

  // Unparseable is not the same as absent: an absent file means "nothing was
  // ever written" (safe), while a corrupt file means "we don't know what was
  // written" (unsafe to assume anything). The caller (bin/adapt) must refuse
  // to write when this is ok:false, rather than treating it as empty.
  it("returns ok:false with a specific reason when the file will not parse", async () => {
    const result = await readManifest(
      createFakeRepo({ files: { [MANIFEST_PATH]: "{ not json" } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(MANIFEST_PATH);
      expect(result.reason.toLowerCase()).toMatch(/json/);
    }
  });

  it("returns ok:false when the JSON is valid but the wrong shape (array)", async () => {
    const result = await readManifest(
      createFakeRepo({ files: { [MANIFEST_PATH]: JSON.stringify([]) } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(MANIFEST_PATH);
    }
  });

  it("returns ok:false when entries is not an object (valid JSON, wrong shape)", async () => {
    const result = await readManifest(
      createFakeRepo({
        files: {
          [MANIFEST_PATH]: JSON.stringify({ schemaVersion: 1, entries: 5 }),
        },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("reads recorded entries", async () => {
    const result = await readManifest(
      createFakeRepo({
        files: {
          [MANIFEST_PATH]: JSON.stringify({
            schemaVersion: 1,
            entries: { "a.md#x": { hash: "deadbeef", status: "active" } },
          }),
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.entries["a.md#x"].hash).toBe("deadbeef");
    }
  });
});

describe("classify", () => {
  const inner = "generated content";
  const base = recordRegion(
    { schemaVersion: 1, entries: {} },
    "a.md",
    "x",
    inner,
  );

  it("reports absent when nothing was ever recorded", () => {
    expect(
      classify({ schemaVersion: 1, entries: {} }, "a.md", "x", inner),
    ).toBe("absent");
  });

  it("reports untouched when the content still hashes to what we wrote", () => {
    expect(classify(base, "a.md", "x", inner)).toBe("untouched");
  });

  // This is the whole point of the manifest: telling "we wrote this and
  // nobody changed it" apart from "a human edited this", so the second case
  // can be a diff rather than an overwrite.
  it("reports edited when the content has changed since we wrote it", () => {
    expect(classify(base, "a.md", "x", "a human rewrote this")).toBe("edited");
  });
});

describe("recordRegion / retireRegion", () => {
  it("records an entry as active with its hash and a writtenAt date", () => {
    const m = recordRegion(
      { schemaVersion: 1, entries: {} },
      "a.md",
      "x",
      "hi",
    );
    expect(m.entries["a.md#x"].status).toBe("active");
    expect(m.entries["a.md#x"].hash).toBe(hashContent("hi"));
    expect(typeof m.entries["a.md#x"].writtenAt).toBe("string");
    expect(m.entries["a.md#x"].writtenAt?.length).toBeGreaterThan(0);
  });

  it("does not mutate the manifest it was given", () => {
    const before = { schemaVersion: 1, entries: {} };
    recordRegion(before, "a.md", "x", "hi");
    expect(before.entries).toEqual({});
  });

  it("retires an entry without deleting it, so an orphan stays discoverable", () => {
    const active = recordRegion(
      { schemaVersion: 1, entries: {} },
      "a.md",
      "x",
      "hi",
    );
    const retired = retireRegion(active, "a.md", "x");
    expect(retired.entries["a.md#x"].status).toBe("retired");
    expect(retired.entries["a.md#x"].hash).toBe(active.entries["a.md#x"].hash);
  });

  it("retiring an unknown entry is a no-op rather than an error", () => {
    const m = { schemaVersion: 1, entries: {} };
    expect(retireRegion(m, "a.md", "nope").entries).toEqual({});
  });

  it("retireRegion does not mutate the manifest it was given", () => {
    const active = recordRegion(
      { schemaVersion: 1, entries: {} },
      "a.md",
      "x",
      "hi",
    );
    retireRegion(active, "a.md", "x");
    expect(active.entries["a.md#x"].status).toBe("active");
  });
});
