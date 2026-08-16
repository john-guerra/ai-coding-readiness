import { createFakeRepo } from "../../lib/repo.js";
import { createFakeWriter } from "../../lib/writer.js";
import { applyAction } from "../../lib/actions.js";

/** @type {import('../../lib/manifest.js').Manifest} */
const EMPTY_MANIFEST = { schemaVersion: 1, entries: {} };

/**
 * Apply a finding's own action and hand back the files as they are AFTER the
 * write, so the SAME check can be re-run against them.
 *
 * This closes the loop amendment B8 requires: an action that is applied and
 * leaves its finding red is worse than no action, because the run reports
 * "applied 1 change" beside a still-failing check. Nothing but re-running the
 * check against the post-write state can prove it does not do that.
 *
 * The repo reads the PRE-write files and the writer writes into a copy, which
 * is exactly how `bin/adapt` sees a pass: reads happen against the tree as it
 * was when the check ran.
 *
 * @param {Record<string, string>} files
 * @param {import('../../lib/finding.js').Finding} finding
 * @param {import('../../lib/manifest.js').Manifest} [manifest]
 * @returns {Promise<{result: import('../../lib/actions.js').ActionResult, files: Record<string, string>}>}
 */
export async function applyFinding(files, finding, manifest = EMPTY_MANIFEST) {
  if (finding.action === null) {
    throw new Error(
      `finding ${finding.id} carries no action to apply — the test that ` +
        `called this expected one`,
    );
  }
  const writer = createFakeWriter(files);
  const result = await applyAction(
    createFakeRepo({ files }),
    writer,
    finding.action,
    manifest,
  );
  return { result, files: writer.files };
}
