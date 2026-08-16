import { makeFinding } from "./finding.js";

/**
 * @typedef {import('./repo.js').Repo} Repo
 * @typedef {import('./finding.js').Finding} Finding
 *
 * @typedef {Object} Check
 * @property {string} id
 * @property {0|1|2} tier         Report vocabulary; also used when the check throws
 * @property {'S'|'M'|'L'} cost   Ordering hint: cheap checks report first
 * @property {(repo: Repo) => Promise<Finding>} run
 */

/** @type {Record<string, number|undefined>} */
const COST_ORDER = { S: 0, M: 1, L: 2 };

/**
 * An unrecognized cost used to index to `undefined`, making the comparator
 * return NaN and the sort arbitrary — losing the one property this ordering
 * exists to provide. Default to the middle rather than silently unordering
 * the run.
 * @param {string} cost
 */
function costRank(cost) {
  return COST_ORDER[cost] ?? 1;
}

/**
 * Run checks cheapest-first, emitting each finding as it resolves.
 *
 * Ordering is not cosmetic. Usage data on the reference repo showed five
 * open-ended reviews abandoned mid-exploration with zero output; an audit that
 * sweeps silently and reports at the end gets interrupted before it reports.
 *
 * @param {Check[]} checks
 * @param {Repo} repo
 * @param {(f: Finding) => void} [onFinding]
 * @returns {Promise<Finding[]>}
 */
export async function runChecks(checks, repo, onFinding) {
  const ordered = [...checks].sort(
    (a, b) => costRank(a.cost) - costRank(b.cost),
  );

  const findings = [];
  for (const check of ordered) {
    let finding;
    try {
      finding = await check.run(repo);
    } catch (err) {
      // A check that throws is a bug in the check, not a verdict about the
      // repo. Report `unknown` — never `pass` — and let the rest of the run
      // continue; one broken check must not cost the user the others.
      finding = makeFinding({
        id: check.id,
        // The check's own tier. Hardcoding 1 here rendered a broken tier-2
        // check to the user as "(T1)".
        tier: check.tier,
        layer: "deterministic",
        status: "unknown",
        effort: "S",
        evidence: `check threw: ${err instanceof Error ? err.message : String(err)}`,
        why: "A check that cannot run tells you nothing about the repository.",
        precondition: null,
        fix: null,
        autoFixable: false,
        action: null,
      });
    }
    findings.push(finding);
    onFinding?.(finding);
  }
  return findings;
}
