import { makeFinding } from "../finding.js";

const ID = "concurrency.pr-path-contention";

const SAMPLE = 50;
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
    dropped > 0 ? `\n  (+${dropped} more not shown, capped at ${ATTENTION_CAP})` : "";
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
    tier: /** @type {const} */ (2),
    layer: /** @type {const} */ ("deterministic"),
    effort: /** @type {const} */ ("M"),
    why:
      "A file in most pull requests is where two concurrent contributors " +
      "collide. Metadata files can stop being shared; large source files are " +
      "the decay signal of a module nobody dares split.",
    precondition: null,
  };

  const lists = await repo.mergedPrFileLists(SAMPLE);
  if (lists.length === 0) {
    return makeFinding({
      ...base,
      status: "unknown",
      evidence:
        "No merge commits found. A squash-merge or rebase workflow leaves no " +
        "merge commits to profile.",
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
    (r) => r.kind === "source" && r.share >= ATTENTION_SHARE && r.share < CONTENDED_SHARE
  );

  /** @type {Record<string, number>} */
  const sizes = {};
  const toMeasure = new Set(
    [...contendedCandidates, ...attentionCandidates].map((r) => r.path)
  );
  for (const path of toMeasure) {
    const text = await repo.readFile(path);
    if (text !== null) sizes[path] = text.split("\n").length;
  }

  const full = profile(lists, sizes);
  const rows = full.filter((r) => r.share >= CONTENDED_SHARE);

  const attentionPool = full
    .filter(
      (r) =>
        r.kind === "source" &&
        r.share >= ATTENTION_SHARE &&
        r.share < CONTENDED_SHARE &&
        (r.lines ?? 0) >= BIG_FILE_LINES
    )
    .sort((a, b) => b.share * (b.lines ?? 0) - a.share * (a.lines ?? 0));
  const attentionShown = attentionPool.slice(0, ATTENTION_CAP);
  const attentionDropped = attentionPool.length - attentionShown.length;
  const attentionText = formatAttention(attentionShown, attentionDropped, lists.length);

  if (rows.length === 0) {
    let evidence = `No file appears in ${Math.round(CONTENDED_SHARE * 100)}% or more of the last ${lists.length} merged PRs.`;
    if (attentionText) evidence += `\n\n${attentionText}`;
    return makeFinding({
      ...base,
      status: "pass",
      evidence,
      fix: null,
      autoFixable: false,
    });
  }

  const metadata = rows.filter((r) => r.kind === "metadata");
  const generated = rows.filter((r) => r.kind === "generated");
  const godFiles = rows.filter(
    (r) => r.kind === "source" && (r.lines ?? 0) >= BIG_FILE_LINES
  );

  const lines = rows.map((r) => {
    const pct = Math.round(r.share * 100);
    const size = r.lines ? `, ${r.lines} lines` : "";
    return `${r.path} — ${r.count}/${lists.length} PRs (${pct}%${size}) [${r.kind}]`;
  });

  const fixes = [];
  if (metadata.length > 0) {
    fixes.push(
      `Metadata (${metadata.map((r) => r.path).join(", ")}): adopt per-PR ` +
        `fragments — changesets for Node, towncrier for Python — so each PR ` +
        `writes a NEW file and CI assembles the version and changelog at ` +
        `release. Add .gitattributes as a backstop.`
    );
  }
  if (generated.length > 0) {
    fixes.push(
      `Machine-generated (${generated.map((r) => r.path).join(", ")}): ` +
        `contention here is expected and is not a design problem. If merge ` +
        `conflicts are frequent, resolve by regenerating the file rather than ` +
        `hand-merging, and consider a merge driver.`
    );
  }
  if (godFiles.length > 0) {
    fixes.push(
      `Large source files (${godFiles.map((r) => r.path).join(", ")}): ` +
        `there is no automatic fix. Set a size budget and extract ` +
        `framework-free logic into testable modules. Reported because it is ` +
        `real, not because it can be automated.`
    );
  }
  if (fixes.length === 0) {
    fixes.push(
      "Contended files are neither metadata nor large. Review whether the " +
        "shared write is necessary; there is no automatic fix."
    );
  }

  let evidence = `Contention profile over the last ${lists.length} merged PRs:\n  ${lines.join("\n  ")}`;
  if (attentionText) evidence += `\n\n${attentionText}`;

  return makeFinding({
    ...base,
    status: "fail",
    evidence,
    fix: fixes.join("\n\n"),
    autoFixable: rows.every((r) => r.kind === "metadata"),
  });
}

export default { id: ID, cost: /** @type {const} */ ("L"), run };
