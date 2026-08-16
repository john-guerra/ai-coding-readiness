#!/usr/bin/env node
import { statSync } from "node:fs";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { createFsRepo } from "../lib/repo.js";
import { createFsWriter } from "../lib/writer.js";
import { runChecks } from "../lib/registry.js";
import { renderMarkdown, renderJson } from "../lib/report.js";
import { applyAction } from "../lib/actions.js";
import { MANIFEST_PATH, readManifest } from "../lib/manifest.js";

import noDiffCanFail from "../lib/checks/ci-no-diff-can-fail-on-gate.js";
import e2eSharded from "../lib/checks/ci-e2e-sharded.js";
import flakeObservability from "../lib/checks/ci-flake-observability.js";
import prPathContention from "../lib/checks/concurrency-pr-path-contention.js";
import guideExists from "../lib/checks/guide-exists.js";
import guideCommands from "../lib/checks/guide-commands.js";
import guideGuardrails from "../lib/checks/guide-guardrails.js";
import guideContextBudget from "../lib/checks/guide-context-budget.js";
import repoHygiene from "../lib/checks/repo-hygiene.js";
import contributionScaffold from "../lib/checks/github-contribution-scaffold.js";

const exec = promisify(execFile);

/** Every check, run once at the end so the summary describes the repository. */
const CHECKS = [
  guideExists,
  guideCommands,
  guideGuardrails,
  guideContextBudget,
  repoHygiene,
  contributionScaffold,
  noDiffCanFail,
  e2eSharded,
  flakeObservability,
  prPathContention,
];

/**
 * The checks whose findings can carry an action, and therefore the only ones
 * worth re-running inside the convergence loop.
 *
 * Running all ten per pass would mean up to five `gh pr list` invocations from
 * `concurrency.pr-path-contention` — five trips over this tool's single
 * permitted network path, to answer a question no action can change. The loop
 * exists to find out whether the last write opened up another one; only these
 * three can answer that.
 *
 * Kept as an explicit list rather than derived, because "does this check ever
 * emit an action" is not something a check declares. `main` re-checks the
 * assumption against the full set at the end and adds a loud note if a fourth
 * check ever starts carrying one, rather than silently applying nothing while
 * the dry run keeps advertising it.
 */
const ACTION_CAPABLE = [repoHygiene, guideGuardrails, contributionScaffold];
const ACTION_CAPABLE_IDS = new Set(ACTION_CAPABLE.map((c) => c.id));

/**
 * Passes are cheap and bounded. Three is what a repository failing all three
 * action-capable checks actually takes: pass 1 applies one action per finding,
 * pass 2 applies `github.contribution-scaffold`'s second template (a finding
 * carries one action, so that check converges in two), pass 3 confirms nothing
 * is left. Hitting the cap is therefore a bug — an action that reports a
 * change without changing anything — not a big repository, and the run says so.
 */
const MAX_PASSES = 5;
const EXPECTED_PASSES = 3;

const USAGE = `ai-ready-adapt — apply the fixes the audit found

Usage:
  ai-ready-adapt [--path <dir>] [--write] [--allow-dirty] [--json]

  --path <dir>   Repository to adapt (default: current directory)
  --write        Actually write. Without it this is a dry run.
  --allow-dirty  Write into a tree that already has uncommitted changes
  --json         Emit JSON instead of markdown

Dry run is the default: without --write nothing is written and the output is
a description of what would be. Read it first.

This never commits and never opens a pull request — the diff is yours to
review. It only ever creates a file it did not find, appends lines to
.gitignore, or rewrites a marked region it has a record of writing; a region a
human edited is left alone.

Commit .ai-readiness/manifest.json. It is the record of which regions this
tool wrote, and without it a later run cannot tell its own output from your
edits — so it refuses to touch them.

Exit codes: 0 completed · 1 an action failed · 2 usage error, a refused dirty
tree, or an unreadable manifest.
`;

/**
 * @typedef {{path: string, write: boolean, allowDirty: boolean, json: boolean, help?: boolean}} Options
 */

/**
 * @param {string[]} argv
 * @returns {Options}
 */
function parseArgs(argv) {
  /** @type {Options} */
  const opts = {
    path: process.cwd(),
    write: false,
    allowDirty: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") opts.json = true;
    else if (argv[i] === "--write") opts.write = true;
    else if (argv[i] === "--allow-dirty") opts.allowDirty = true;
    else if (argv[i] === "--path") {
      const next = argv[++i];
      if (!next) throw new Error("--path requires a directory");
      opts.path = resolve(next);
    } else if (argv[i] === "--help" || argv[i] === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }

  // Same reasoning as the audit: a mistyped path that silently adapts nothing
  // is worse than an error, because it reads as a completed run.
  if (!opts.help) {
    let stats;
    try {
      stats = statSync(opts.path);
    } catch {
      throw new Error(`--path does not exist: ${opts.path}`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`--path is not a directory: ${opts.path}`);
    }
  }

  return opts;
}

/**
 * Is this a git working tree, and is the part of it we are about to write into
 * clean?
 *
 * Scoped to `--path` with a `.` pathspec, not to the enclosing repository:
 * uncommitted work in a sibling package is none of this run's business, and
 * refusing on it would make the tool unusable inside any monorepo.
 * `--porcelain` reports untracked files as `??`, which count — a tree full of
 * untracked work is exactly as hard to review a generated diff out of as one
 * full of modifications.
 *
 * `git` is invoked with an argument array, never a shell string.
 *
 * @param {string} path
 * @returns {Promise<{isRepo: boolean, why?: string, dirty: string[]}>}
 */
async function inspectTree(path) {
  try {
    const { stdout } = await exec(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      {
        cwd: path,
      },
    );
    if (stdout.trim() !== "true") {
      return {
        isRepo: false,
        why: `${path} is not a git working tree`,
        dirty: [],
      };
    }
  } catch (err) {
    // "git is not installed" and "this is not a repository" both land here and
    // they are different things to do about it. Reporting the second when the
    // first is true sends the reader off to run `git init` in a directory that
    // is already a repository.
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? String(err.code)
        : "";
    return {
      isRepo: false,
      why:
        code === "ENOENT"
          ? "git is not installed, so this run cannot tell whether there is a diff to review"
          : `${path} is not a git repository`,
      dirty: [],
    };
  }
  const { stdout } = await exec("git", ["status", "--porcelain", "--", "."], {
    cwd: path,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { isRepo: true, dirty: stdout.split("\n").filter((l) => l !== "") };
}

/**
 * One entry in the run log: what was attempted, and what came of it.
 *
 * @typedef {Object} LogEntry
 * @property {number} pass
 * @property {string} id
 * @property {string} kind
 * @property {string} path
 * @property {string|null} precondition
 * @property {"changed"|"skipped"|"failed"} outcome
 * @property {string} detail
 */

/**
 * @param {import('../lib/finding.js').Finding} f
 */
function describeAction(f) {
  const a = f.action;
  if (a === null) return "";
  if (a.kind === "write-file") return `create \`${a.path}\``;
  if (a.kind === "append-lines") {
    return `append ${a.lines.length} line(s) to \`${a.path}\``;
  }
  return `write the \`${a.id}\` region in \`${a.path}\``;
}

/** @param {unknown} err */
const messageOf = (err) => (err instanceof Error ? err.message : String(err));

await main();

async function main() {
  /** @type {Options} */
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${messageOf(err)}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  if (opts.help) {
    process.stdout.write(USAGE);
    process.exitCode = 0;
    return;
  }

  /** Things the reader has to know that are not findings. */
  /** @type {string[]} */
  const notes = [];

  if (opts.write) {
    const tree = await inspectTree(opts.path);
    // Not a git repository: refuse, and `--allow-dirty` does not override it.
    // That flag is about a tree with uncommitted work in it; this is about
    // there being no diff to read, no review to hold, and no way to undo what
    // this writes. Those are different problems and only one of them has a
    // flag.
    if (!tree.isRepo) {
      process.stderr.write(
        `refusing to write: ${tree.why ?? `${opts.path} is not a git repository`}.\n\n` +
          `The value of this tool is a diff a human reads before keeping it. ` +
          `Without version control there is no diff, no review, and no undo. ` +
          `Run \`git init\` and commit first, or run without --write to see ` +
          `what it would do.\n`,
      );
      process.exitCode = 2;
      return;
    }
    if (tree.dirty.length > 0) {
      const listing = tree.dirty.map((l) => `  ${l}`).join("\n");
      if (!opts.allowDirty) {
        process.stderr.write(
          `refusing to write: ${opts.path} has ${tree.dirty.length} ` +
            `uncommitted change(s).\n\n${listing}\n\n` +
            `Generated edits are only reviewable as their own diff. Commit or ` +
            `stash the above first, or pass --allow-dirty to write anyway and ` +
            `sort the diff out by hand.\n`,
        );
        process.exitCode = 2;
        return;
      }
      notes.push(
        `**--allow-dirty**: writing into a tree that already has ` +
          `${tree.dirty.length} uncommitted change(s), so the generated edits ` +
          `will be mixed in with them. What it is being written on top of:\n\n` +
          `\`\`\`\n${listing}\n\`\`\``,
      );
    }
  }

  const repo = createFsRepo(opts.path);

  // The manifest is what tells this tool's own output from a human's edits.
  // "Unreadable" is not "empty": treating it as empty would classify every
  // recorded region as `absent`, and `applyAction` refuses those — so a
  // corrupt byte would either stall every region or, before amendment B4,
  // silently overwrite all of them. Refuse instead, and say what to fix.
  const read = await readManifest(repo);
  if (!read.ok) {
    if (opts.write) {
      process.stderr.write(
        `refusing to write: ${read.reason}\n\n` +
          `That file is the record of which regions this tool wrote. While it ` +
          `cannot be read, a generated region is indistinguishable from ` +
          `something you wrote by hand, and overwriting on a guess is the one ` +
          `thing this tool must not do. Restore it from git, or delete it — an ` +
          `absent manifest is a valid starting state; an unreadable one is not.\n`,
      );
      process.exitCode = 2;
      return;
    }
    notes.push(
      `⚠️ ${read.reason}\n\nThat file records which regions this tool wrote. ` +
        `\`--write\` will refuse until it is restored from git or deleted (an ` +
        `absent manifest is a valid starting state; an unreadable one is not).`,
    );
  }
  /** @type {import('../lib/manifest.js').Manifest} */
  let manifest = read.ok ? read.manifest : { schemaVersion: 1, entries: {} };

  /** @type {LogEntry[]} */
  const log = [];
  let passes = 0;
  let capHit = false;

  if (opts.write) {
    const writer = createFsWriter(opts.path);
    // Ids whose action was attempted and changed nothing. Every "no change"
    // reason this layer produces is deterministic — the file is already there,
    // the region was edited by hand, the document has duplicate markers, the
    // writer refused the path — so re-attempting it next pass would print the
    // same line again and could never terminate on its own. Recording them
    // makes the loop strictly progress-driven, independently of the cap.
    /** @type {Set<string>} */
    const settled = new Set();

    for (;;) {
      if (passes >= MAX_PASSES) {
        capHit = true;
        break;
      }
      passes++;

      const found = await runChecks(ACTION_CAPABLE, repo);
      const todo = found.filter((f) => f.action !== null && !settled.has(f.id));
      if (todo.length === 0) break;

      let changedThisPass = false;
      for (const f of todo) {
        const action = /** @type {import('../lib/actions.js').Action} */ (
          f.action
        );
        const base = {
          pass: passes,
          id: f.id,
          kind: action.kind,
          path: action.path,
          precondition: f.precondition,
        };
        if (!opts.json && f.precondition) {
          process.stderr.write(`  before ${f.id}: ${f.precondition}\n`);
        }
        try {
          const result = await applyAction(repo, writer, action, manifest);
          if (result.changed) {
            changedThisPass = true;
            // Persist per successful action, not once at the end. A later
            // action that throws would otherwise leave regions on disk with no
            // manifest entry — and an unrecorded region is refused on the next
            // run, so the user would be stuck with output this tool will no
            // longer touch. The manifest write is inside this try on purpose:
            // if it fails, the region really is unrecorded and that is a
            // failure worth reporting as one.
            if (result.manifest !== manifest) {
              manifest = result.manifest;
              await writer.write(
                MANIFEST_PATH,
                `${JSON.stringify(manifest, null, 2)}\n`,
              );
            }
            log.push({ ...base, outcome: "changed", detail: result.reason });
          } else {
            settled.add(f.id);
            log.push({ ...base, outcome: "skipped", detail: result.reason });
          }
        } catch (err) {
          // `applyAction` lets the writer's containment refusals through
          // deliberately: a path that escapes the root, names `.git`, or is a
          // symlink means something reached us that should never have been
          // constructed. It stops this action, not the run.
          settled.add(f.id);
          log.push({ ...base, outcome: "failed", detail: messageOf(err) });
        }
        if (!opts.json) {
          const last = log[log.length - 1];
          process.stderr.write(`  ${last.outcome.padEnd(7)} ${last.id}\n`);
        }
      }
      if (!changedThisPass) break;
    }
  }

  const findings = await runChecks(CHECKS, repo);

  // The convergence loop only runs `ACTION_CAPABLE`. If a fourth check ever
  // starts carrying an action, the loop would silently stop applying it while
  // the dry run kept advertising it. Say so rather than diverge quietly.
  const stray = findings.filter(
    (f) => f.action !== null && !ACTION_CAPABLE_IDS.has(f.id),
  );
  if (stray.length > 0) {
    notes.push(
      `⚠️ ${stray.map((f) => `\`${f.id}\``).join(", ")} now carr${stray.length === 1 ? "ies" : "y"} an action, ` +
        `but ${stray.length === 1 ? "it is" : "they are"} not in this command's convergence loop and ` +
        `${stray.length === 1 ? "was" : "were"} not applied. Add ${stray.length === 1 ? "it" : "them"} to ACTION_CAPABLE in bin/adapt.mjs.`,
    );
  }

  const outstanding = findings.filter((f) => f.action !== null);
  const failed = log.filter((e) => e.outcome === "failed");

  if (opts.json) {
    // Reuse the audit's summary rather than recomputing it: two definitions of
    // "how many failed" is exactly the kind of drift this codebase keeps
    // finding.
    const base = JSON.parse(renderJson(findings));
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: opts.write ? "write" : "dry-run",
          path: opts.path,
          passes,
          capHit,
          notes,
          planned: outstanding.map((f) => ({
            id: f.id,
            kind: /** @type {import('../lib/actions.js').Action} */ (f.action)
              .kind,
            path: /** @type {import('../lib/actions.js').Action} */ (f.action)
              .path,
            precondition: f.precondition,
          })),
          applied: log,
          ...base,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(
      `${renderRun({ opts, notes, log, findings, outstanding, passes, capHit })}\n`,
    );
  }

  // An action that threw is the only thing that makes this run a failure. A
  // skip is a repository state to report (a file already there, a region a
  // human edited); a remaining `fail` finding with no action is a person's
  // job, and neither is this command failing at what it was asked to do.
  process.exitCode = failed.length > 0 ? 1 : 0;
}

/**
 * @param {Object} args
 * @param {Options} args.opts
 * @param {string[]} args.notes
 * @param {LogEntry[]} args.log
 * @param {import('../lib/finding.js').Finding[]} args.findings
 * @param {import('../lib/finding.js').Finding[]} args.outstanding
 * @param {number} args.passes
 * @param {boolean} args.capHit
 * @returns {string}
 */
function renderRun({
  opts,
  notes,
  log,
  findings,
  outstanding,
  passes,
  capHit,
}) {
  const out = [`# Adapting ${opts.path}`, ""];

  for (const note of notes) {
    out.push(note, "");
  }

  if (!opts.write) {
    out.push(
      "**Dry run — nothing was written.** Read this, then re-run with " +
        "`--write` to apply it.",
      "",
    );
    if (outstanding.length === 0) {
      out.push("No finding carries an automatic fix. Nothing to apply.", "");
    } else {
      out.push(`${outstanding.length} finding(s) carry an automatic fix.`, "");
      for (const f of outstanding) {
        out.push(`### \`${f.id}\` — ${describeAction(f)}`, "");
        const action = /** @type {import('../lib/actions.js').Action} */ (
          f.action
        );
        if (action.kind === "append-lines") {
          out.push("```", ...action.lines, "```", "");
        }
        // Printed before anything is applied, in both modes. A tool that
        // applies a fix while suppressing the caveat attached to that fix is
        // worse than one that does not apply it.
        if (f.precondition) {
          out.push(`**Before applying.** ${f.precondition}`, "");
        }
      }
    }
  } else {
    const changed = log.filter((e) => e.outcome === "changed").length;
    const skipped = log.filter((e) => e.outcome === "skipped").length;
    const failed = log.filter((e) => e.outcome === "failed").length;

    out.push("## What it did", "");
    if (log.length === 0) {
      out.push("Nothing to apply — no finding carried an action.", "");
    }
    for (let pass = 1; pass <= passes; pass++) {
      const entries = log.filter((e) => e.pass === pass);
      if (entries.length === 0) continue;
      out.push(`### Pass ${pass}`, "");
      for (const e of entries) {
        if (e.precondition) {
          out.push(`- **Before applying \`${e.id}\`.** ${e.precondition}`);
        }
        const icon =
          e.outcome === "changed" ? "✓" : e.outcome === "skipped" ? "–" : "✗";
        out.push(`- ${icon} \`${e.id}\` — ${e.detail}`);
      }
      out.push("");
    }

    out.push(
      capHit
        ? `**The pass cap was reached** — stopped after ${passes} pass(es) ` +
            `without settling. ${EXPECTED_PASSES} is what a repository failing ` +
            `every action-capable check should take, so this is a bug in an ` +
            `action (one that reports a change without making one), not a ` +
            `large repository. Please report it.`
        : `Converged after ${passes} pass(es).`,
      "",
      `${changed} changed · ${skipped} skipped · ${failed} failed.`,
      "",
      "Nothing was committed and no pull request was opened. Read the diff " +
        "(`git diff`), then commit it yourself — including " +
        "`.ai-readiness/manifest.json`, which is what lets a later run tell " +
        "its own output from your edits.",
      "",
    );
  }

  out.push("---", "", renderMarkdown(findings));
  return out.join("\n");
}
