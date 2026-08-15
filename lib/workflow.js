/**
 * Shared reading of GitHub Actions workflow documents.
 *
 * "Does this workflow gate a merge, and which of its steps can fail that
 * gate?" is asked by more than one check, and the answer used to be
 * reimplemented in each of them as "the string `pull_request` appears in
 * `on:`". The two implementations then disagreed in the field — on a repo
 * gated by a merge queue, one check reported `pass` while the other correctly
 * reported `unknown`, and the one saying `pass` had never looked at the
 * repository's actual gate. This module exists so they agree by construction.
 */

/**
 * `pull_request` activity types that fire while a pull request is open and
 * somebody is waiting to merge it.
 *
 * A workflow keyed only to other types — `closed` on a post-merge close-out,
 * for instance — runs after the decision has been made and can never block a
 * change from landing. It is not a gate.
 */
export const GATING_PR_TYPES = [
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
];

/**
 * Appended to the evidence for a hit whose step or job carries an `if:`.
 *
 * Evaluating a GitHub expression is out of scope for a static read, so the
 * hit is still reported — dropping it would hide a real finding behind a
 * condition nobody looked at — but the evidence must not imply the condition
 * was checked and found true.
 */
export const IF_NOTE = "(step has an `if:` condition that was not evaluated)";

/**
 * @param {unknown} v
 * @returns {Record<string, unknown> | null}
 */
function asRecord(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? /** @type {Record<string, unknown>} */ (v)
    : null;
}

/**
 * The `on:` value of a parsed workflow document, or undefined when the
 * document is not a mapping at all.
 *
 * YAML 1.1 reads a bare `on` key as the boolean `true`. The `yaml` package
 * parses 1.2, where it stays the string "on", but workflows in the wild are
 * written for both, so both spellings are read.
 *
 * @param {unknown} doc
 * @returns {unknown}
 */
export function readTriggers(doc) {
  const rec = asRecord(doc);
  if (!rec) return undefined;
  return "on" in rec ? rec.on : rec["true"];
}

/**
 * The trigger event names in an `on:` value, in any of its three spellings:
 * `on: pull_request` | `on: [push, pull_request]` | `on: {pull_request: {...}}`
 *
 * @param {unknown} on
 * @returns {string[]}
 */
function triggerNames(on) {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.filter((n) => typeof n === "string");
  const rec = asRecord(on);
  return rec ? Object.keys(rec) : [];
}

/**
 * The `types:` filter on a `pull_request` trigger, or null when none is
 * declared (which means every type, i.e. no filter).
 *
 * @param {unknown} on
 * @returns {string[] | null}
 */
function pullRequestTypes(on) {
  const rec = asRecord(on);
  if (!rec) return null;
  const pr = asRecord(rec.pull_request);
  if (!pr || !Array.isArray(pr.types)) return null;
  return pr.types.filter((t) => typeof t === "string");
}

/**
 * Does this workflow run on the merge gate — the checks a contributor has to
 * get green before their change can land?
 *
 * Two ways in, and both count, because a repository with a merge queue has
 * its real gate there and a check that only knows about `pull_request` would
 * report green having examined nothing:
 *   - `pull_request`, when `types:` is absent or includes a type that fires
 *     while the PR is open (see GATING_PR_TYPES)
 *   - `merge_group`
 *
 * A `push` to the default branch deliberately does NOT count. That is
 * post-merge branch health — a different tier of question, answered after the
 * merge it could not have prevented.
 *
 * @param {unknown} on  the value returned by readTriggers()
 * @returns {boolean}
 */
export function gatesMerge(on) {
  const names = triggerNames(on);
  if (names.includes("merge_group")) return true;
  if (!names.includes("pull_request")) return false;

  const types = pullRequestTypes(on);
  if (types === null) return true;
  return types.some((t) => GATING_PR_TYPES.includes(t));
}

/**
 * @typedef {Object} GateStep
 * @property {string} run              The step's `run` text; "" for a `uses:` step
 * @property {boolean} unevaluatedIf   The step or its job carries an `if:`
 */

/**
 * @typedef {Object} GateJob
 * @property {string} jobName
 * @property {GateStep[]} steps
 * @property {string[]} matrixKeys     Keys of `strategy.matrix`, if any
 */

/**
 * The jobs and steps of a workflow that can actually fail a run.
 *
 * Anything carrying `continue-on-error: true` is dropped: a step or job that
 * cannot turn the run red cannot block a merge, and de-fanging an advisory
 * scan that way is the canonical thing a maintainer does about it. Reporting
 * it afterwards is the tool crying wolf about a problem already handled.
 *
 * A step carrying an `if:` is kept, flagged. See IF_NOTE.
 *
 * @param {unknown} doc  a parsed workflow document
 * @returns {GateJob[]}
 */
export function gateJobs(doc) {
  const rec = asRecord(doc);
  const jobsRec = rec ? asRecord(rec.jobs) : null;
  if (!jobsRec) return [];

  /** @type {GateJob[]} */
  const out = [];
  for (const [jobName, rawJob] of Object.entries(jobsRec)) {
    const job = asRecord(rawJob);
    if (!job) continue;
    if (job["continue-on-error"] === true) continue;
    const jobIf = job.if !== undefined;

    /** @type {GateStep[]} */
    const steps = [];
    for (const rawStep of Array.isArray(job.steps) ? job.steps : []) {
      const step = asRecord(rawStep);
      if (!step) continue;
      if (step["continue-on-error"] === true) continue;
      steps.push({
        run: typeof step.run === "string" ? step.run : "",
        unevaluatedIf: jobIf || step.if !== undefined,
      });
    }

    const strategy = asRecord(job.strategy);
    const matrix = strategy ? asRecord(strategy.matrix) : null;
    out.push({ jobName, steps, matrixKeys: matrix ? Object.keys(matrix) : [] });
  }
  return out;
}
