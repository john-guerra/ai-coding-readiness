import { createHash } from "node:crypto";

/**
 * The record of what this tool wrote, and whether a human has touched it since.
 *
 * Without it, a second run cannot tell "we generated this and nobody changed
 * it" from "a person edited this" — and a generator that cannot tell the
 * difference must either clobber edits or never update anything. Both are
 * fatal for a tool that writes into repositories it does not own.
 *
 * @typedef {{hash: string, status: "active"|"retired", writtenAt?: string}} Entry
 * @typedef {{schemaVersion: number, entries: Record<string, Entry>}} Manifest
 * @typedef {{ok: true, manifest: Manifest} | {ok: false, reason: string}} ReadManifestResult
 */

export const MANIFEST_PATH = ".ai-readiness/manifest.json";

/** @param {string} text */
export function hashContent(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/**
 * @param {string} path
 * @param {string} id
 */
const key = (path, id) => `${path}#${id}`;

/**
 * Read the manifest, distinguishing "nothing was ever written" from "we
 * cannot tell what was written."
 *
 * Those are different answers and the caller must be able to act on them
 * differently: an absent file (`ok: true`, empty entries) means no region has
 * ever been recorded, which is a perfectly good state to write into. A
 * present-but-unparseable or structurally-invalid file (`ok: false`) means we
 * genuinely do not know what regions exist — and the caller (`bin/adapt`)
 * must refuse to write rather than guess, because guessing wrong here means
 * silently overwriting every generated region in the repository (see
 * amendment B4/B5 in the milestone plan).
 *
 * @param {import('./repo.js').Repo} repo
 * @returns {Promise<ReadManifestResult>}
 */
export async function readManifest(repo) {
  const raw = await repo.readFile(MANIFEST_PATH);
  if (raw === null) {
    return { ok: true, manifest: { schemaVersion: 1, entries: {} } };
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: `${MANIFEST_PATH} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !("entries" in parsed) ||
    typeof (/** @type {{entries: unknown}} */ (parsed).entries) !== "object" ||
    /** @type {{entries: unknown}} */ (parsed).entries === null ||
    Array.isArray(/** @type {{entries: unknown}} */ (parsed).entries)
  ) {
    return {
      ok: false,
      reason: `${MANIFEST_PATH} does not have the expected shape ({schemaVersion, entries}); got ${JSON.stringify(parsed)}`,
    };
  }

  const obj =
    /** @type {{schemaVersion?: unknown, entries: Record<string, Entry>}} */ (
      parsed
    );
  return {
    ok: true,
    manifest: {
      schemaVersion:
        typeof obj.schemaVersion === "number" ? obj.schemaVersion : 1,
      entries: obj.entries,
    },
  };
}

/**
 * @param {Manifest} manifest
 * @param {string} path
 * @param {string} id
 * @param {string} currentInner
 * @returns {"absent"|"untouched"|"edited"}
 */
export function classify(manifest, path, id, currentInner) {
  const entry = manifest.entries[key(path, id)];
  // "absent" means we have no record — not the same as "safe to overwrite".
  // Whether that is refused or tolerated is the caller's decision (Task 3),
  // not this function's.
  if (!entry) return "absent";
  return entry.hash === hashContent(currentInner) ? "untouched" : "edited";
}

/**
 * @param {Manifest} manifest
 * @param {string} path
 * @param {string} id
 * @param {string} inner
 * @returns {Manifest}
 */
export function recordRegion(manifest, path, id, inner) {
  // writtenAt is informational only (for a human reading the manifest); it is
  // never compared. classify() compares hash alone, so a clock skew or a
  // re-run on the same day cannot cause a misclassification.
  return {
    schemaVersion: manifest.schemaVersion,
    entries: {
      ...manifest.entries,
      [key(path, id)]: {
        hash: hashContent(inner),
        status: /** @type {const} */ ("active"),
        writtenAt: new Date().toISOString().slice(0, 10),
      },
    },
  };
}

/**
 * Mark an entry retired without dropping it. A deleted record makes an
 * abandoned region indistinguishable from a human's own content, and then
 * nothing ever cleans it up (spec §4: "status: active | retired. When a later
 * version stops generating a region it is marked retired and removal offered
 * — otherwise abandoned regions accumulate across every adopting repo with
 * nothing knowing they are dead.").
 *
 * Nothing in this milestone calls this function — no check yet stops
 * generating a region it once wrote. It exists now so the manifest schema and
 * its "retired, not deleted" contract are settled before anything depends on
 * them.
 *
 * @param {Manifest} manifest
 * @param {string} path
 * @param {string} id
 * @returns {Manifest}
 */
export function retireRegion(manifest, path, id) {
  const existing = manifest.entries[key(path, id)];
  if (!existing) return manifest;
  return {
    schemaVersion: manifest.schemaVersion,
    entries: {
      ...manifest.entries,
      [key(path, id)]: {
        ...existing,
        status: /** @type {const} */ ("retired"),
      },
    },
  };
}
