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
 * @property {import('./actions.js').Action|null} action  The machine-applicable fix, iff autoFixable
 */

const STATUSES = new Set(["pass", "fail", "unknown"]);
const EFFORTS = new Set(["S", "M", "L"]);
const TIERS = new Set([0, 1, 2]);

/**
 * The kinds `applyAction` knows how to perform. Kept as a literal set here
 * rather than imported from `lib/actions.js`, because that module reaches the
 * write layer and `bin/audit.mjs` must have no path to it, transitive or
 * otherwise — the audit never writes to the repository it audits. The `Action`
 * type above is an erased JSDoc reference and costs nothing at runtime; a real
 * import would cost the guarantee.
 *
 * Exported so `test/read-only-guarantee.test.js` can assert this copy still
 * agrees with the `Action` union in `lib/actions.js`. Drift here is silent:
 * `makeFinding` throws on an unrecognised kind, `runChecks` catches the throw,
 * and a real `fail` verdict renders to the user as `unknown`.
 * @type {ReadonlySet<string>}
 */
export const ACTION_KINDS = new Set([
  "write-file",
  "append-lines",
  "write-region",
]);

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
    "action",
  ];
  for (const key of required) {
    if (!(key in spec)) {
      throw new TypeError(
        `makeFinding: missing required field "${key}". ` +
          `Fields are never optional — "precondition", "fix" and "action" ` +
          `must be an explicit null so their absence is a deliberate statement.`,
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

  if (spec.action !== null) {
    // Cast for the same reason as `tier`/`status` above: `spec` is a Partial,
    // so `action` may be undefined here even though `"action" in spec` held —
    // and `undefined` is exactly one of the values this must reject rather
    // than a type error to be argued away.
    const kind = /** @type {any} */ (spec.action)?.kind;
    if (!ACTION_KINDS.has(kind)) {
      throw new TypeError(
        `makeFinding: check "${spec.id}" carries an action of unknown kind ` +
          `"${kind}". Allowed: ${[...ACTION_KINDS].join(", ")}. Use one of ` +
          `those, or set action to null and leave the fix to a person.`,
      );
    }
  }

  // `autoFixable` used to be a comment: nothing checked that a check claiming
  // an automatic fix shipped anything a machine could apply. It is now true if
  // and only if the finding carries a structured action, in both directions.
  if (spec.autoFixable && spec.action === null) {
    throw new TypeError(
      `makeFinding: check "${spec.id}" claims autoFixable but carries no ` +
        `action. Attach one, or set autoFixable to false and say in "fix" ` +
        `what the person has to do.`,
    );
  }
  if (!spec.autoFixable && spec.action !== null) {
    throw new TypeError(
      `makeFinding: check "${spec.id}" carries an action but claims it is ` +
        `not auto-fixable. One of the two is wrong — set autoFixable to true ` +
        `if the action is safe to apply, or drop the action.`,
    );
  }

  return Object.freeze(/** @type {Finding} */ ({ ...spec }));
}
