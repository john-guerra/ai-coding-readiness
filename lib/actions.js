import { upsertRegion, findRegion } from "./regions.js";
import { classify, recordRegion } from "./manifest.js";

/**
 * The three things this tool is allowed to do to a file, and nothing else.
 *
 * Anything that would rewrite existing prose or YAML — a CI workflow,
 * package.json — is deliberately absent. Those remediations stay
 * `autoFixable: false` until a milestone gives them the review they need.
 *
 * @typedef {{kind: "write-file", path: string, content: string}} WriteFile
 * @typedef {{kind: "append-lines", path: string, lines: string[]}} AppendLines
 * @typedef {{kind: "write-region", path: string, id: string, inner: string, version: number}} WriteRegion
 * @typedef {WriteFile|AppendLines|WriteRegion} Action
 *
 * @typedef {{changed: boolean, reason: string, manifest: import('./manifest.js').Manifest}} ActionResult
 */

/**
 * Apply one action, or explain why it was not applied.
 *
 * Two invariants hold for every kind:
 *
 * - **A no-op returns `changed: false` and writes nothing.** That is what makes
 *   a second run byte-identical to the first, which is what makes the
 *   idempotency gate mean anything.
 * - **The manifest is returned, never mutated.** The caller decides when it is
 *   persisted (per successful action, so a later failure cannot leave regions
 *   on disk with no record of them).
 *
 * A refusal the *repository* caused (an edited region, a file already there,
 * an ambiguous document) comes back as `changed: false` with a reason, because
 * it is something to report in the run's summary. A refusal the *writer* makes
 * — a path that escapes the root or names `.git` — is left to throw: it means
 * a path reached us that should never have been constructed, and it should
 * stop the run rather than be summarised alongside ordinary skips.
 *
 * @param {import('./repo.js').Repo} repo
 * @param {import('./writer.js').Writer} writer
 * @param {Action} action
 * @param {import('./manifest.js').Manifest} manifest
 * @returns {Promise<ActionResult>}
 */
export async function applyAction(repo, writer, action, manifest) {
  const existing = await repo.readFile(action.path);

  if (action.kind === "write-file") {
    if (existing !== null) {
      return {
        changed: false,
        reason: `exists — ${action.path} is already there and is not ours to replace`,
        manifest,
      };
    }
    await writer.write(action.path, action.content);
    return { changed: true, reason: `created ${action.path}`, manifest };
  }

  if (action.kind === "append-lines") {
    const current = existing ?? "";
    // "Already present" here is an exact, trimmed, whole-line match. Note the
    // coupling: `repo.hygiene` decides whether a .gitignore covers a path with
    // a glob-aware `covers()`, so it can consider `dist/` covered by `*` while
    // this considers it missing. The consequence is a redundant line, never a
    // lost one — but if that check's matching is ever loosened further, this
    // is where the divergence will show up.
    const present = new Set(
      current
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    );
    const missing = action.lines.filter((l) => !present.has(l.trim()));
    if (missing.length === 0) {
      return { changed: false, reason: `every line already present`, manifest };
    }
    const separator = current === "" || current.endsWith("\n") ? "" : "\n";
    await writer.write(
      action.path,
      `${current}${separator}${missing.join("\n")}\n`,
    );
    return {
      changed: true,
      reason: `appended ${missing.length} line(s) to ${action.path}`,
      manifest,
    };
  }

  // write-region
  const current = existing ?? "";
  const found = findRegion(current, action.id);
  if (found) {
    const state = classify(manifest, action.path, action.id, found.inner);
    if (state === "edited") {
      return {
        changed: false,
        reason: `edited — the ${action.id} region in ${action.path} was changed by hand; not overwriting`,
        manifest,
      };
    }
    // "absent" means the region is physically there and the manifest has no
    // entry for it: the hash is UNKNOWN, which is not "unchanged". That is the
    // state after the manifest was deleted or was unreadable, or after a human
    // copied our marker syntax into their own file. Overwriting on unknown is
    // the write-side version of reporting `pass` because we could not look —
    // the one thing this codebase's rules forbid outright.
    if (state === "absent") {
      return {
        changed: false,
        reason: `no record — the ${action.id} region already exists in ${action.path} but the manifest has no record of us writing it; not overwriting`,
        manifest,
      };
    }
    // Compare the version as well as the content. Short-circuiting on content
    // alone freezes the `v=` marker at whatever it was when the content last
    // changed, so a future migration keyed on the version never fires on
    // exactly the files that still carry the old one.
    if (found.version === action.version && found.inner === action.inner) {
      return { changed: false, reason: `already current`, manifest };
    }
  }

  // `upsertRegion` throws on a document it cannot parse unambiguously (a
  // duplicate or nested marker for this id) or on content that would nest a
  // marker. Caught, not propagated: the trigger in production is repository
  // content a human introduced, which puts it in the same category as
  // "edited" — something to report in the run's summary, not a crash. A throw
  // escaping here would abort the CLI mid-loop with earlier regions already
  // written to disk, which is precisely the half-applied state the per-action
  // manifest persistence exists to prevent.
  //
  // The other thing upsertRegion throws on — an id that is not `[a-z0-9-]+` —
  // is ours, not the repository's, and it is NOT caught here: `findRegion`
  // above validates the same id and throws first, so a malformed id stops the
  // run loudly, which is what a programming error should do.
  let next;
  try {
    next = upsertRegion(current, action.id, action.inner, action.version);
  } catch (err) {
    return {
      changed: false,
      reason: `cannot write the ${action.id} region in ${action.path}: ${err instanceof Error ? err.message : String(err)}`,
      manifest,
    };
  }

  await writer.write(action.path, next);
  return {
    changed: true,
    reason: found
      ? `updated the ${action.id} region in ${action.path}`
      : `added the ${action.id} region to ${action.path}`,
    manifest: recordRegion(manifest, action.path, action.id, action.inner),
  };
}
