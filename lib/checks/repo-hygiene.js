import { makeFinding } from "../finding.js";

const ID = "repo.hygiene";
// Declared once: the registry reads it to render a check that THREW at the
// right tier, and the check's own findings must not drift from that.
const TIER = /** @type {const} */ (0);

const LOCKFILES = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
];

/**
 * What a `.gitignore` must cover for an agent's diffs and directory listings
 * to stay readable. Each requirement lists the literal name(s) that would
 * satisfy it; an entry covers the requirement when it covers ANY of them.
 *
 * `line` is what gets appended when the requirement is unmet — the plainest
 * form that `covers()` above will credit on the next run, so applying the
 * action actually closes the gap it was emitted for. A requirement with two
 * targets is satisfied by writing either; `dist/` is the one Node tooling
 * defaults to, and a project that builds into `build/` still ends up covered
 * because `dist/` is added alongside whatever it already ignores.
 *
 * Nothing here ever names `.ai-readiness/` (amendment B10): the manifest is
 * what tells this tool's own regions apart from a human's edits, and it only
 * survives if it is committed. Ignoring it would disarm the safety mechanism
 * the whole write path rests on.
 */
const IGNORE_REQUIREMENTS = [
  { label: "node_modules", targets: ["node_modules"], line: "node_modules/" },
  {
    label: "build output (dist or build)",
    targets: ["dist", "build"],
    line: "dist/",
  },
  { label: ".env", targets: [".env"], line: ".env" },
  { label: ".DS_Store", targets: [".DS_Store"], line: ".DS_Store" },
];

/**
 * The entries a `.gitignore` actually declares: comment lines and
 * `!`-negations dropped (a commented-out mention or a negated entry does not
 * mean the path is ignored), and what remains normalized to the bare name.
 *
 * Normalization strips trailing whitespace, a leading `**​/`, a leading `/`, a
 * trailing `/**`, and a trailing `/`. All five are ways of writing the same
 * entry, and matching against the raw line rejected most of them:
 * `**​/node_modules`, `dist/**`, `**​/.DS_Store` all read as gaps, so a
 * correctly-covered file scored 4 of 4 and the fix told its maintainer to add
 * entries already sitting in it.
 * @param {string} text
 * @returns {string[]}
 */
function significantEntries(text) {
  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed !== "" && !trimmed.startsWith("#") && !trimmed.startsWith("!")
      );
    })
    .map((line) =>
      line
        .replace(/\s+$/, "")
        .replace(/^\*\*\//, "")
        .replace(/^\//, "")
        .replace(/\/\*\*$/, "")
        .replace(/\/$/, ""),
    );
}

/**
 * Does a normalized `.gitignore` entry cover the literal name `target`?
 *
 * Two rules, modelling what git does rather than what a regex is convenient
 * for:
 *
 * 1. The entry IS the name. `.env` covers `.env`.
 * 2. The entry ends with `*` and the name starts with the part before it.
 *    gitignore globs are fnmatch, where `*` matches the empty string, so
 *    `.env*` really does ignore `.env` and `dist*` really does ignore `dist`:
 *
 *        $ printf '.env*\n' > .gitignore && git check-ignore -v .env
 *        .gitignore:1:.env*	.env
 *
 *    Failing these reported a gap that did not exist and prescribed a fix
 *    that did not apply — the one thing this tool is not allowed to do.
 *
 * Nothing else. The rule is PREFIX, not substring, and a bare entry must be
 * exact — which is what keeps the look-alikes out: `.envrc` is neither equal
 * to `.env` nor a `*`-entry, and `distribution` is not `dist`. That
 * distinction is the whole reason whole-entry matching replaced substring
 * matching in the first place, and it is asserted directly by the decoy
 * fixture in the tests.
 *
 * @param {string} entry - already normalized by `significantEntries`
 * @param {string} target
 * @returns {boolean}
 */
function covers(entry, target) {
  if (entry === target) return true;
  return entry.endsWith("*") && target.startsWith(entry.slice(0, -1));
}

/**
 * A composite over two conditions an agent's working tree needs: a lockfile
 * (so an install resolves the same tree twice) and a `.gitignore` that keeps
 * dependencies, build output, environment files and OS cruft out of every
 * diff and directory listing an agent reads.
 *
 * Deliberately does NOT check for tracked secrets. That needs a recursive
 * listing of tracked files, which `Repo` does not provide, and this check
 * says so explicitly in its pass evidence rather than implying it looked.
 *
 * @param {import('../repo.js').Repo} repo
 * @returns {Promise<import('../finding.js').Finding>}
 */
async function run(repo) {
  const base = {
    id: ID,
    tier: TIER,
    layer: /** @type {const} */ ("deterministic"),
    effort: /** @type {const} */ ("S"),
    why:
      "A missing lockfile means nobody installs the same tree twice, and " +
      "untracked noise pollutes every diff and directory listing an agent reads.",
  };

  if ((await repo.readFile("package.json")) === null) {
    return makeFinding({
      ...base,
      status: "unknown",
      evidence:
        "No package.json found. This milestone ships the Node pack only, so " +
        "the project's ecosystem — and therefore its lockfile — is unknown.",
      precondition: null,
      fix: null,
      autoFixable: false,
      action: null,
    });
  }

  const gaps = [];

  let hasLock = false;
  for (const lock of LOCKFILES) {
    if ((await repo.readFile(lock)) !== null) {
      hasLock = true;
      break;
    }
  }
  if (!hasLock) {
    gaps.push(`no lockfile (looked for ${LOCKFILES.join(", ")})`);
  }

  // The lines an `append-lines` action would add — one per unmet requirement,
  // in declaration order.
  //
  // Note the coupling, because it is a trap for whoever touches this next:
  // `applyAction`'s "already present" is an exact match on the trimmed line,
  // while `covers()` here is prefix-glob-aware. They agree today ONLY because
  // this list is built exclusively from requirements `covers()` reports as
  // unmet, so the action is never handed a line the file already satisfies. If
  // this ever emits a line speculatively, the two notions will diverge and the
  // divergence will surface as a duplicated entry, not a missing one.
  /** @type {string[]} */
  const missingIgnoreLines = [];

  const ignore = await repo.readFile(".gitignore");
  if (ignore === null) {
    // Not "no .gitignore": readFile only sees the repo root, and coverage can
    // legitimately live in a nested .gitignore or .git/info/exclude that this
    // check does not read.
    gaps.push(
      ".gitignore not found at the repo root (coverage may exist in a " +
        "nested .gitignore or .git/info/exclude, which this check does not read)",
    );
    // Which is also why the action writes all four here rather than none: the
    // worst case is an entry restated that a nested file already covered, and
    // a redundant .gitignore line costs nothing. The opposite mistake —
    // leaving the root uncovered because coverage MIGHT exist somewhere this
    // check cannot see — is the one that keeps noise in every diff.
    missingIgnoreLines.push(...IGNORE_REQUIREMENTS.map((r) => r.line));
  } else {
    const entries = significantEntries(ignore);
    for (const req of IGNORE_REQUIREMENTS) {
      const covered = req.targets.some((target) =>
        entries.some((entry) => covers(entry, target)),
      );
      if (!covered) {
        gaps.push(`.gitignore does not cover ${req.label}`);
        missingIgnoreLines.push(req.line);
      }
    }
  }

  if (gaps.length === 0) {
    return makeFinding({
      ...base,
      status: "pass",
      evidence:
        "A lockfile is present and .gitignore covers node_modules, build " +
        "output, .env and .DS_Store. This check does not look for tracked " +
        "secrets or credentials, because that needs a listing of tracked " +
        "files this check does not have.",
      precondition: null,
      fix: null,
      autoFixable: false,
      action: null,
    });
  }

  // Only when the `.gitignore` is the ONLY gap. The other half of this
  // composite is `npm install --package-lock-only`, which is not one of the
  // three things this tool may do to a file — and a finding carries one
  // action, so offering the partial one would let the run report a fix
  // applied while the half that needs a person went unmentioned in the
  // summary. Withholding it keeps the finding, and its `precondition` about
  // resolving the dependency graph as it is today, in front of the reader.
  /** @type {import('../actions.js').Action|null} */
  const action =
    hasLock && missingIgnoreLines.length > 0
      ? { kind: "append-lines", path: ".gitignore", lines: missingIgnoreLines }
      : null;

  return makeFinding({
    ...base,
    status: "fail",
    evidence: `${gaps.length} hygiene gap(s):\n  ${gaps.join("\n  ")}`,
    precondition: hasLock
      ? null
      : "Generating a lockfile resolves the dependency graph as it is TODAY, " +
        "which can move transitive versions off whatever has been running. " +
        "Commit it, then confirm the suite is still green.",
    fix:
      (hasLock
        ? ""
        : "Run `npm install --package-lock-only` and commit the result. ") +
      "Add the missing `.gitignore` entries. Neither of these is a matter of " +
      "taste: an uncommitted lockfile makes every install a different tree, " +
      "and tracked build output turns every diff into noise an agent has to " +
      "read past.",
    autoFixable: action !== null,
    action,
  });
}

export default { id: ID, tier: TIER, cost: /** @type {const} */ ("S"), run };
