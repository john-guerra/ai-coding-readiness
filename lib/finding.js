/**
 * The single shape every check returns, and the invariants the spec requires.
 *
 * These are enforced at runtime rather than by code review because the `fix`
 * field is the tool's liability surface: a `fail` with no remediation is the
 * failure mode the spec's binding rule exists to prevent.
 *
 * @typedef {Object} Finding
 * @property {string} id                              Dotted check id, e.g. "ci.e2e-sharded"
 * @property {0|1|2} tier                             Report vocabulary only; not an install branch
 * @property {'deterministic'|'judgment'} layer       The binary emits deterministic only
 * @property {'pass'|'fail'|'unknown'} status         `unknown` when the check could not determine
 * @property {'S'|'M'|'L'} effort                     Effort to apply the fix
 * @property {string} evidence                        What was observed, concretely
 * @property {string} why                             Why it matters, in one sentence
 * @property {string|null} precondition               Explicitly null when none applies
 * @property {string|null} fix                        Required when status is "fail"
 * @property {boolean} autoFixable                    False when the fix needs a human
 */

const STATUSES = new Set(["pass", "fail", "unknown"]);
const EFFORTS = new Set(["S", "M", "L"]);
const TIERS = new Set([0, 1, 2]);

/**
 * Validate and freeze a finding.
 * @param {Partial<Finding>} spec
 * @returns {Finding}
 */
export function makeFinding(spec) {
  const required = [
    "id",
    "tier",
    "layer",
    "status",
    "effort",
    "evidence",
    "why",
    "precondition",
    "fix",
    "autoFixable",
  ];
  for (const key of required) {
    if (!(key in spec)) {
      throw new TypeError(
        `makeFinding: missing required field "${key}". ` +
          `Fields are never optional — "precondition" and "fix" must be an ` +
          `explicit null so their absence is a deliberate statement.`,
      );
    }
  }

  if (!TIERS.has(/** @type {any} */ (spec.tier))) {
    throw new TypeError(
      `makeFinding: tier must be 0, 1 or 2 (got ${spec.tier})`,
    );
  }
  if (!STATUSES.has(/** @type {any} */ (spec.status))) {
    throw new TypeError(
      `makeFinding: status must be pass|fail|unknown (got ${spec.status})`,
    );
  }
  if (!EFFORTS.has(/** @type {any} */ (spec.effort))) {
    throw new TypeError(
      `makeFinding: effort must be S|M|L (got ${spec.effort})`,
    );
  }
  if (spec.layer !== "deterministic") {
    throw new TypeError(
      `makeFinding: layer must be "deterministic" — the audit binary must ` +
        `never emit a judgment finding, because reproducibility is the whole ` +
        `rationale for the two-layer split.`,
    );
  }
  if (spec.status === "fail" && !spec.fix) {
    throw new TypeError(
      `makeFinding: check "${spec.id}" failed without a fix. ` +
        `Every check ships with its remediation, or it doesn't ship.`,
    );
  }

  return Object.freeze(/** @type {Finding} */ ({ ...spec }));
}
