#!/usr/bin/env node
/**
 * The idempotency release gate.
 *
 * The single property the whole write layer rests on: running `adapt --write`
 * twice leaves the repository byte-identical to what one run left. A generator
 * that drifts on the second run cannot be re-run, which means it cannot be put
 * in CI, which means it is a one-shot scaffolder rather than a tool.
 *
 * **It commits between the two runs** (amendment B6). The obvious form —
 * `adapt --write; adapt --write; git diff --exit-code` — cannot run: the first
 * write dirties the tree and the dirty-tree rule makes the second exit 2.
 * Committing is closer to real usage anyway, and it additionally proves the
 * manifest survives a commit, which is load-bearing: an unrecorded region is
 * refused on the next run, so a manifest that did not persist would show up
 * here as a second-run refusal rather than as a silent overwrite.
 *
 * The fixture's guide uses **CRLF** line endings on purpose. Most Windows
 * contributors check out with `core.autocrlf=true`, and a region matcher that
 * hardcodes `\n` appends a brand-new region on every single run, unbounded —
 * the worst available outcome for a tool whose headline property is this one.
 * A macOS-only LF fixture would never see it.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ADAPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "adapt.mjs",
);

/**
 * @param {string} cwd
 * @param {string[]} args
 */
const git = (cwd, args) => run("git", args, { cwd });

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
async function adapt(cwd, args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [ADAPT, ...args], {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = /** @type {{code?: number, stdout?: string, stderr?: string}} */ (
      err
    );
    return {
      code: e.code ?? 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

/** CRLF, deliberately. See the module comment. */
const CRLF_GUIDE = [
  "# AGENTS.md",
  "",
  "## Commands",
  "",
  "```bash",
  "npm test",
  "```",
  "",
].join("\r\n");

/**
 * A repository that fails all three action-capable checks: a lockfile is
 * present (so `repo.hygiene` carries its action) but `.gitignore` covers only
 * node_modules, the guide states no prohibition, and there is no `.github/`.
 * @param {string} dir
 */
async function seed(dir) {
  await writeFile(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "gate-fixture", version: "0.0.0" }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(dir, "package-lock.json"), "{}\n", "utf8");
  await writeFile(join(dir, ".gitignore"), "node_modules/\n", "utf8");
  await writeFile(join(dir, "AGENTS.md"), CRLF_GUIDE, "utf8");
}

/**
 * @param {string} dir
 * @returns {Promise<string|null>} the failure, or null when the gate passes
 */
async function gate(dir) {
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.email", "gate@example.com"]);
  await git(dir, ["config", "user.name", "Idempotency Gate"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  // The fixture's CRLF guide must reach the tool as CRLF.
  await git(dir, ["config", "core.autocrlf", "false"]);
  await seed(dir);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "seed"]);

  process.stdout.write(`idempotency gate: ${dir}\n`);

  const first = await adapt(dir, ["--path", dir, "--write"]);
  if (first.code !== 0) {
    return `the first --write exited ${first.code}\n\n${first.stdout}${first.stderr}`;
  }

  const { stdout: afterFirst } = await git(dir, ["status", "--porcelain"]);
  if (afterFirst.trim() === "") {
    return (
      "the first --write changed nothing, so the second run would prove " +
      "nothing. The fixture is supposed to fail three checks that carry " +
      `actions.\n\n${first.stdout}`
    );
  }
  process.stdout.write(`  run 1 changed:\n${afterFirst}`);

  // Amendment B6: commit between the runs. Without this the second --write
  // refuses a dirty tree and the gate can never run at all.
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "adapt run 1"]);

  const second = await adapt(dir, ["--path", dir, "--write"]);
  if (second.code !== 0) {
    return `the second --write exited ${second.code}\n\n${second.stdout}${second.stderr}`;
  }
  if (!/0 changed/.test(second.stdout)) {
    return `the second --write did not report zero changes:\n\n${second.stdout}`;
  }

  // Tracked files unchanged...
  let diff = "";
  try {
    await git(dir, ["diff", "--exit-code"]);
  } catch (err) {
    diff = String(
      /** @type {{stdout?: string}} */ (err).stdout ?? "(no diff output)",
    );
  }
  // ...and nothing new appeared either. `git diff` alone is blind to an
  // untracked file, which is exactly how an unbounded second region or a stray
  // manifest copy would show up.
  const { stdout: status } = await git(dir, ["status", "--porcelain"]);
  if (diff !== "" || status.trim() !== "") {
    return (
      "the second --write was not a no-op.\n\n" +
      `git diff:\n${diff || "(clean)"}\n\n` +
      `git status --porcelain:\n${status || "(clean)"}`
    );
  }

  process.stdout.write(
    "  run 2 changed nothing · git diff clean · no untracked files\n" +
      "idempotency gate passed\n",
  );
  return null;
}

const dir = await mkdtemp(join(tmpdir(), "ai-ready-idempotent-"));
try {
  const failure = await gate(dir);
  if (failure !== null) {
    process.stderr.write(`\nidempotency gate FAILED\n\n${failure}\n`);
    process.exitCode = 1;
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
