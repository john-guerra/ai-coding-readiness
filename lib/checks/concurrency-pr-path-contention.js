import { makeFinding } from "../finding.js";

const ID = "concurrency.pr-path-contention";

const SAMPLE = 50;
const CONTENDED_SHARE = 0.5; // half of merged PRs touch it
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
 * Rank files by the share of merged PRs that touch them.
 *
 * A ranked profile rather than a boolean over a threshold: on a real repo a
 * 70% cut finds only the files everyone already knows about, and misses the
 * 4,000-line module that 27% of PRs touch — which is the more dangerous one,
 * for concurrency and for quality both.
 *
 * @param {string[][]} fileLists  one entry per merged PR
 * @param {Record<string, number>} sizes  path -> line count, where known
 * @returns {Array<{path:string,count:number,share:number,lines:number|null,kind:'metadata'|'source'}>}
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
      kind: METADATA.some((re) => re.test(path))
        ? /** @type {const} */ ("metadata")
        : /** @type {const} */ ("source"),
    }))
    .sort((a, b) => b.share - a.share || a.path.localeCompare(b.path));
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

  const candidates = profile(lists, {}).filter((r) => r.share >= CONTENDED_SHARE);

  // Only measure the size of files that are actually contended — reading every
  // file in the repo to answer a question about a handful is wasteful.
  /** @type {Record<string, number>} */
  const sizes = {};
  for (const row of candidates) {
    const text = await repo.readFile(row.path);
    if (text !== null) sizes[row.path] = text.split("\n").length;
  }
  const rows = profile(lists, sizes).filter((r) => r.share >= CONTENDED_SHARE);

  if (rows.length === 0) {
    return makeFinding({
      ...base,
      status: "pass",
      evidence: `No file appears in ${Math.round(CONTENDED_SHARE * 100)}% or more of the last ${lists.length} merged PRs.`,
      fix: null,
      autoFixable: false,
    });
  }

  const metadata = rows.filter((r) => r.kind === "metadata");
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

  return makeFinding({
    ...base,
    status: "fail",
    evidence: `Contention profile over the last ${lists.length} merged PRs:\n  ${lines.join("\n  ")}`,
    fix: fixes.join("\n\n"),
    autoFixable: metadata.length > 0 && godFiles.length === 0,
  });
}

export default { id: ID, cost: /** @type {const} */ ("L"), run };
