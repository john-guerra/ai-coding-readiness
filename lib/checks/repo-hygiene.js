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
 * to stay readable. Each pattern is anchored to a WHOLE entry line — matched
 * after comments and `!`-negations are stripped by `significantLines` — so a
 * comment that merely mentions the name ("# never commit .DS_Store"), or an
 * unrelated entry that happens to contain the substring (`distribution/` for
 * `dist`, `.envrc` for `.env`), does not count as coverage.
 */
const IGNORE_REQUIREMENTS = [
  { label: "node_modules", pattern: /^\/?node_modules\/?$/m },
  { label: "build output (dist or build)", pattern: /^\/?(dist|build)\/?$/m },
  { label: ".env", pattern: /^\/?\.env(\/|$)/m },
  { label: ".DS_Store", pattern: /^\/?\.DS_Store$/m },
];

/**
 * Drop comment lines and `!`-negations, then normalize what is left, before
 * matching against `IGNORE_REQUIREMENTS`. A commented-out mention or a negated
 * entry does not mean the pattern is actually ignored.
 *
 * Normalization strips a leading `**​/`, a trailing `/**`, and trailing
 * whitespace. Anchoring the requirement patterns to a whole entry line is what
 * killed the `distribution/` decoy, but without this it also rejected the
 * commonest ways people write these very entries — `**​/node_modules`,
 * `dist/**`, `**​/.DS_Store` — so a fully-covered `.gitignore` scored 4 of 4
 * gaps and the fix told the maintainer to add entries already sitting in the
 * file. A remediation that does not apply is the one failure mode this tool is
 * not allowed to have.
 *
 * Only these three forms are normalized. Any other glob (`.env*`, `dist/**​/*`)
 * still has to match a requirement literally, which keeps the whole-entry
 * anchor doing its job against look-alikes.
 * @param {string} text
 * @returns {string}
 */
function significantLines(text) {
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
        .replace(/\/\*\*$/, ""),
    )
    .join("\n");
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

  const ignore = await repo.readFile(".gitignore");
  if (ignore === null) {
    // Not "no .gitignore": readFile only sees the repo root, and coverage can
    // legitimately live in a nested .gitignore or .git/info/exclude that this
    // check does not read.
    gaps.push(
      ".gitignore not found at the repo root (coverage may exist in a " +
        "nested .gitignore or .git/info/exclude, which this check does not read)",
    );
  } else {
    const significant = significantLines(ignore);
    for (const req of IGNORE_REQUIREMENTS) {
      if (!req.pattern.test(significant)) {
        gaps.push(`.gitignore does not cover ${req.label}`);
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
    });
  }

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
    autoFixable: true,
  });
}

export default { id: ID, tier: TIER, cost: /** @type {const} */ ("S"), run };
