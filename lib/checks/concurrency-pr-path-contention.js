import { makeFinding } from "../finding.js";
import { countLines } from "../text.js";

const ID = "concurrency.pr-path-contention";
// Declared once: the registry reads it to render a check that THREW at the
// right tier, and the check's own findings must not drift from that.
const TIER = /** @type {const} */ (2);

const SAMPLE = 50;
/**
 * Below this many merge commits the profile is not a measurement.
 *
 * `share >= CONTENDED_SHARE` is trivially satisfied on a tiny sample: at one
 * merge commit every file it touched sits at 100% and clears the threshold by
 * construction, so the "profile" reports the sample size rather than anything
 * about the repository. The standing method rule applies — establish that the
 * instrument can produce a non-trivial result before reporting its number.
 */
const MIN_MERGE_COMMITS = 10;
const CONTENDED_SHARE = 0.5; // half of merged PRs touch it -> fail trigger
const ATTENTION_SHARE = 0.15; // below fail threshold, still worth surfacing
const ATTENTION_CAP = 5;
const BIG_FILE_LINES = 1500;

/**
 * Files whose contention is solved by removing the shared write, not by
 * refactoring: per-PR fragments make them conflict-free by construction.
 */
const METADATA = [
  /(^|\/)CHANGELOG(\.md)?$/i,
  /(^|\/)package\.json$/,
  /(^|\/)pyproject\.toml$/,
  /(^|\/)Cargo\.toml$/,
  /(^|\/)version(\.txt|\.json)?$/i,
];

/**
 * Machine-generated files. They are supposed to change on nearly every PR
 * that touches a dependency, so contention there is expected, not a design
 * problem — checked before METADATA/source so a lockfile never lands in the
 * "refactor this" bucket.
 */
const GENERATED = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)bun\.lockb$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)go\.sum$/,
  /(^|\/)composer\.lock$/,
];

/**
 * Rank files by the share of merged PRs that touch them.
 *
 * A ranked profile rather than a boolean over a threshold: on a real repo a
 * 70% cut finds only the files everyone already knows about, and misses the
 * 4,000-line module that 27% of PRs touch — which is the more dangerous one,
 * for concurrency and for quality both.
 *
 * @param {string[][]} fileLists  one entry per merged PR
 * @param {Record<string, number>} sizes  path -> line count, where known
 * @returns {Array<{path:string,count:number,share:number,lines:number|null,kind:'metadata'|'generated'|'source'}>}
 */
export function profile(fileLists, sizes) {
  const counts = new Map();
  for (const list of fileLists) {
    for (const path of new Set(list)) {
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  const total = fileLists.length || 1;
  return [...counts.entries()]
    .map(([path, count]) => ({
      path,
      count,
      share: count / total,
      lines: sizes[path] ?? null,
      kind: GENERATED.some((re) => re.test(path))
        ? /** @type {const} */ ("generated")
        : METADATA.some((re) => re.test(path))
          ? /** @type {const} */ ("metadata")
          : /** @type {const} */ ("source"),
    }))
    .sort((a, b) => b.share - a.share || a.path.localeCompare(b.path));
}

/**
 * Format the "large and contended, but under the fail threshold" section.
 * Appears regardless of overall status — this is the section that exists
 * specifically to surface files a 50% cut would miss.
 *
 * @param {Array<{path:string,count:number,share:number,lines:number|null}>} shown
 * @param {number} dropped
 * @param {number} totalPrs
 */
function formatAttention(shown, dropped, totalPrs) {
  if (shown.length === 0) return "";
  const lines = shown.map((r) => {
    const pct = Math.round(r.share * 100);
    return `${r.path} — ${r.count}/${totalPrs} PRs (${pct}%, ${r.lines} lines)`;
  });
  const capNote =
    dropped > 0
      ? `\n  (+${dropped} more not shown, capped at ${ATTENTION_CAP})`
      : "";
  return (
    `Also worth attention (large and contended, but below the ` +
    `${Math.round(CONTENDED_SHARE * 100)}% fail threshold):\n  ${lines.join("\n  ")}${capNote}`
  );
}

/**
 * @param {import('../repo.js').Repo} repo
 * @returns {Promise<import('../finding.js').Finding>}
 */
async function run(repo) {
  const base = {
    id: ID,
    tier: TIER,
    layer: /** @type {const} */ ("deterministic"),
    effort: /** @type {const} */ ("M"),
    why:
      "A file in most pull requests is where two concurrent contributors " +
      "collide. Metadata files can stop being shared; large source files are " +
      "the decay signal of a module nobody dares split.",
    precondition: null,
  };

  const { source, reason, lists, truncated } =
    await repo.mergedPrFileLists(SAMPLE);

  // How the sample was obtained belongs in the evidence. "Profiled over 50
  // merged PRs" means the same thing from either source, but a reader deciding
  // whether to trust a number is entitled to know which one produced it.
  // Name what was actually counted. "merge commit" and "merged pull request"
  // are the same quantity from different instruments, and a reader deciding
  // whether to trust a share is entitled to know which one produced it.
  const counted =
    source === "github-api" ? "merged pull request(s)" : "merge commit(s)";
  // State the instrument, not a cause. `source === "github-api"` means the API
  // saw MORE merged work than local git did — it does NOT imply the repository
  // has no merge commits, and asserting that would be exactly the unchecked
  // explanation this check refuses to make elsewhere.
  const apiNote = source === "github-api" ? ", read from the GitHub API" : "";

  // A list that came back at the API's per-PR cap was cut, so every share
  // derived from it is a floor rather than a measurement.
  const capNote =
    truncated > 0
      ? ` ${truncated} of them returned the GitHub API's maximum of 100 files ` +
        `and were truncated, so the shares below are lower bounds — the real ` +
        `figures can only be higher.`
      : "";

  if (lists.length === 0) {
    return makeFinding({
      ...base,
      status: "unknown",
      // Report what was actually observed. Every distinct cause now arrives
      // with its own sentence from the accessor rather than being flattened
      // into one shrug that names a cause nobody verified.
      evidence:
        `There is no merged-PR history to profile here: ${reason ?? "no merge commits and no merged pull requests were found"}.` +
        (source === "none" && /not installed|authenticated/.test(reason ?? "")
          ? " Authenticating the GitHub CLI would let this check profile a repository that squash-merges."
          : ""),
      fix: null,
      autoFixable: false,
    });
  }

  if (lists.length < MIN_MERGE_COMMITS) {
    return makeFinding({
      ...base,
      status: "unknown",
      evidence:
        `Only ${lists.length} ${counted} found${apiNote}; ` +
        `${MIN_MERGE_COMMITS} are needed before a contention share means ` +
        `anything. At this sample size a file touched by a single one sits ` +
        `at ${Math.round((1 / lists.length) * 100)}% and clears the ` +
        `${Math.round(CONTENDED_SHARE * 100)}% threshold by construction, so ` +
        `a profile would report the sample size rather than the repository.`,
      fix: null,
      autoFixable: false,
    });
  }

  // Kind is path-only, so it's already correct in this sizeless pass. Use it
  // to decide what's worth reading: every contended file (any kind — metadata
  // files show their size too), and only *source* files in the attention band
  // (metadata/generated below the fail threshold aren't the signal that
  // section exists for).
  const noSizes = profile(lists, {});
  const contendedCandidates = noSizes.filter((r) => r.share >= CONTENDED_SHARE);
  const attentionCandidates = noSizes.filter(
    (r) =>
      r.kind === "source" &&
      r.share >= ATTENTION_SHARE &&
      r.share < CONTENDED_SHARE,
  );

  /** @type {Record<string, number>} */
  const sizes = {};
  const toMeasure = new Set(
    [...contendedCandidates, ...attentionCandidates].map((r) => r.path),
  );
  for (const path of toMeasure) {
    const text = await repo.readFile(path);
    if (text !== null) sizes[path] = countLines(text);
  }

  const full = profile(lists, sizes);
  const rows = full.filter((r) => r.share >= CONTENDED_SHARE);
  // Machine-generated files are SUPPOSED to change on every PR that touches a
  // dependency, so they are reported for context but never trigger the fail.
  // Failing on them produced a `fail` whose own remediation said the
  // contention was expected and not a design problem — a finding arguing
  // against itself, on the single most common shape in Node.
  const triggering = rows.filter((r) => r.kind !== "generated");

  const attentionPool = full
    .filter(
      (r) =>
        r.kind === "source" &&
        r.share >= ATTENTION_SHARE &&
        r.share < CONTENDED_SHARE &&
        (r.lines ?? 0) >= BIG_FILE_LINES,
    )
    .sort((a, b) => b.share * (b.lines ?? 0) - a.share * (a.lines ?? 0));
  const attentionShown = attentionPool.slice(0, ATTENTION_CAP);
  const attentionDropped = attentionPool.length - attentionShown.length;
  const attentionText = formatAttention(
    attentionShown,
    attentionDropped,
    lists.length,
  );

  /** @param {typeof rows[number]} r */
  const describe = (r) => {
    const pct = Math.round(r.share * 100);
    const size = r.lines ? `, ${r.lines} lines` : "";
    return `${r.path} — ${r.count}/${lists.length} PRs (${pct}%${size}) [${r.kind}]`;
  };

  const metadata = rows.filter((r) => r.kind === "metadata");
  const generated = rows.filter((r) => r.kind === "generated");
  const godFiles = rows.filter(
    (r) => r.kind === "source" && (r.lines ?? 0) >= BIG_FILE_LINES,
  );

  if (triggering.length === 0) {
    let evidence = `No file appears in ${Math.round(CONTENDED_SHARE * 100)}% or more of the last ${lists.length} merged PRs${apiNote}.`;
    if (generated.length > 0) {
      // Reported, not counted against the repo: whoever reads the profile
      // should still see which files churn, and why that is fine.
      evidence =
        `No file other than machine-generated ones appears in ` +
        `${Math.round(CONTENDED_SHARE * 100)}% or more of the last ` +
        `${lists.length} merged PRs. Above the threshold and expected:\n  ` +
        `${generated.map(describe).join("\n  ")}`;
    }
    if (attentionText) evidence += `\n\n${attentionText}`;

    // "Nothing is contended" is a claim a truncated sample cannot support: the
    // paths the cap dropped are exactly the ones whose shares we never counted.
    // A real hit still outranks incomplete coverage (see the fail branch); an
    // absence of hits does not.
    if (truncated > 0) {
      return makeFinding({
        ...base,
        status: "unknown",
        evidence:
          `No file crossed the ${Math.round(CONTENDED_SHARE * 100)}% threshold ` +
          `in the last ${lists.length} merged PRs${apiNote} — but${capNote} ` +
          `A file this sample never saw could be contended, so "nothing is ` +
          `contended" is not something these numbers can establish.`,
        fix: null,
        autoFixable: false,
      });
    }

    return makeFinding({
      ...base,
      status: "pass",
      evidence,
      fix: null,
      autoFixable: false,
    });
  }

  const lines = rows.map(describe);

  const fixes = [];
  if (metadata.length > 0) {
    fixes.push(
      `Metadata (${metadata.map((r) => r.path).join(", ")}): adopt per-PR ` +
        `fragments — changesets for Node, towncrier for Python — so each PR ` +
        `writes a NEW file and CI assembles the version and changelog at ` +
        `release. Add .gitattributes as a backstop.`,
    );
  }
  if (generated.length > 0) {
    fixes.push(
      `Machine-generated (${generated.map((r) => r.path).join(", ")}): ` +
        `contention here is expected and is not a design problem. If merge ` +
        `conflicts are frequent, resolve by regenerating the file rather than ` +
        `hand-merging, and consider a merge driver.`,
    );
  }
  if (godFiles.length > 0) {
    // Cite the measurement. Generic advice to "set a size budget and extract
    // framework-free logic" is available anywhere; the number just measured
    // is the one thing this finding has that a blog post does not, and
    // leaving it out of the remediation threw it away.
    const cited = godFiles.map((r) => {
      const pct = Math.round(r.share * 100);
      const size = (r.lines ?? 0).toLocaleString("en-US");
      return (
        `\`${r.path}\` is ${size} lines and appears in ${pct}% of merged PRs; ` +
        `set the budget at its current size so it cannot grow, and extract ` +
        `the largest framework-free block first.`
      );
    });
    fixes.push(
      `Large source files: there is no automatic fix. ${cited.join(" ")} ` +
        `Reported because it is real, not because it can be automated.`,
    );
  }
  if (fixes.length === 0) {
    fixes.push(
      "Contended files are neither metadata nor large. Review whether the " +
        "shared write is necessary; there is no automatic fix.",
    );
  }

  let evidence = `Contention profile over the last ${lists.length} merged PRs${apiNote}.${capNote}\n  ${lines.join("\n  ")}`;
  if (attentionText) evidence += `\n\n${attentionText}`;

  return makeFinding({
    ...base,
    status: "fail",
    evidence,
    fix: fixes.join("\n\n"),
    // Auto-fixable when there is a metadata half to fix and nothing contended
    // that a person has to decide about. A machine-generated row is NOT such
    // an obstacle — it has no work in it, only an explanation — and treating
    // it as one is what made the flagship demo print the changesets
    // remediation and then deny it had one. A contended SOURCE file still is
    // an obstacle, at any size: the fix text above addresses the metadata and
    // says nothing that an adapter could apply to the source file.
    autoFixable: metadata.length > 0 && rows.every((r) => r.kind !== "source"),
  });
}

export default { id: ID, tier: TIER, cost: /** @type {const} */ ("L"), run };
