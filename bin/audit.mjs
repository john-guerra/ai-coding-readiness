#!/usr/bin/env node
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { createFsRepo } from "../lib/repo.js";
import { runChecks } from "../lib/registry.js";
import { renderMarkdown, renderJson } from "../lib/report.js";

import noDiffCanFail from "../lib/checks/ci-no-diff-can-fail-on-gate.js";
import e2eSharded from "../lib/checks/ci-e2e-sharded.js";
import flakeObservability from "../lib/checks/ci-flake-observability.js";
import prPathContention from "../lib/checks/concurrency-pr-path-contention.js";

const CHECKS = [
  noDiffCanFail,
  e2eSharded,
  flakeObservability,
  prPathContention,
];

const USAGE = `ai-coding-readiness — read-only audit

Usage:
  ai-coding-readiness [--path <dir>] [--json]

  --path <dir>  Repository to audit (default: current directory)
  --json        Emit JSON instead of markdown

Exit codes: 0 no failures · 1 at least one failure · 2 usage error
This command never writes to the audited repository.
`;

/**
 * @param {string[]} argv
 * @returns {{ path: string, json: boolean, help?: boolean }}
 */
function parseArgs(argv) {
  /** @type {{ path: string, json: boolean, help?: boolean }} */
  const opts = { path: process.cwd(), json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") opts.json = true;
    else if (argv[i] === "--path") {
      const next = argv[++i];
      if (!next) throw new Error("--path requires a directory");
      opts.path = resolve(next);
    } else if (argv[i] === "--help" || argv[i] === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }

  // A path that is not there is a usage error, not an audit. Without this a
  // typo audited nothing and printed "0 fail · 4 unknown · 0 pass" with exit
  // 0 — which in CI reads as a clean audit of a repository nobody opened.
  // Every check answers `unknown` for its own honest reason, and the run as
  // a whole is silently meaningless.
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

await main();

async function main() {
  /** @type {{ path: string, json: boolean, help?: boolean }} */
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`,
    );
    process.exitCode = 2;
    return;
  }

  if (opts.help) {
    process.stdout.write(USAGE);
    process.exitCode = 0;
    return;
  }

  const repo = createFsRepo(opts.path);

  // Stream findings as they resolve in markdown mode. JSON needs the whole set,
  // so it stays quiet until the end.
  const onFinding = opts.json
    ? undefined
    : (/** @type {import('../lib/finding.js').Finding} */ f) =>
        process.stderr.write(`  ${f.status.padEnd(7)} ${f.id}\n`);

  if (!opts.json) process.stderr.write(`Auditing ${opts.path}\n`);

  const findings = await runChecks(CHECKS, repo, onFinding);

  process.stdout.write(
    opts.json ? `${renderJson(findings)}\n` : `\n${renderMarkdown(findings)}\n`,
  );

  process.exitCode = findings.some((f) => f.status === "fail") ? 1 : 0;
}
