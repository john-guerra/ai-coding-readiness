import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const BIN = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "audit.mjs",
);

/**
 * Seed a directory so the deterministic Tier-0 checks all `pass` (or, for
 * the CI/concurrency checks that need workflow files or merge history this
 * fixture deliberately omits, honestly `unknown` — never `fail`). This is
 * what a minimally "ready" repository looks like from this tool's own point
 * of view: a guide that names its test command and states a guardrail, a
 * lockfile, a `.gitignore` covering the four required entries, and a
 * `.github/` contribution scaffold.
 * @param {string} dir
 */
async function seedReadyRepo(dir) {
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify(
      { name: "fixture", version: "0.0.0", scripts: { test: "npm test" } },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(join(dir, "package-lock.json"), "{}\n", "utf8");
  await writeFile(
    join(dir, ".gitignore"),
    "node_modules/\ndist/\n.env\n.DS_Store\n",
    "utf8",
  );
  await writeFile(
    join(dir, "AGENTS.md"),
    [
      "# AGENTS.md",
      "",
      "## Commands",
      "",
      "```bash",
      "npm test",
      "```",
      "",
      "## Guardrails",
      "",
      "Never commit secrets or credentials.",
      "",
    ].join("\n"),
    "utf8",
  );

  await mkdir(join(dir, ".github", "ISSUE_TEMPLATE"), { recursive: true });
  await writeFile(
    join(dir, ".github", "ISSUE_TEMPLATE", "bug.md"),
    "---\nname: Bug report\n---\n\nRepro steps, expected, actual.\n",
    "utf8",
  );
  await writeFile(
    join(dir, ".github", "PULL_REQUEST_TEMPLATE.md"),
    "## What changed\n\n## Why\n",
    "utf8",
  );
  await writeFile(join(dir, ".github", "CODEOWNERS"), "* @example\n", "utf8");
}

/**
 * The CLI reports failures through its exit code, so a non-zero exit is a
 * normal result here rather than an error.
 * @param {string[]} args
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
async function audit(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args]);
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

describe("bin/audit.mjs", () => {
  // A mistyped path used to audit nothing and report "0 fail · 4 unknown ·
  // 0 pass" with exit 0 — which in CI reads as a clean audit of a repository
  // that was never opened.
  it("exits 2 with a usage error when --path does not exist", async () => {
    const r = await audit(["--path", "/does/not/exist"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/\/does\/not\/exist/);
    expect(r.stdout).not.toMatch(/unknown/);
  });

  it("exits 2 when --path is a file rather than a directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "audit-cli-"));
    const file = join(dir, "README.md");
    await writeFile(file, "not a repo\n", "utf8");
    try {
      const r = await audit(["--path", file]);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/director/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("audits a real, seeded-ready directory and exits 0 when nothing fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "audit-cli-"));
    try {
      await seedReadyRepo(dir);
      const r = await audit(["--path", dir]);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/AI-coding readiness/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Repo-controlled content must not make the audit read, count, or quote a
  // file outside the directory it was pointed at.
  it("never reads or quotes a file outside --path", async () => {
    const parent = await mkdtemp(join(tmpdir(), "audit-escape-"));
    const dir = join(parent, "repo");
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(parent, "secret.md"),
        "AWS_SECRET=never-share-this-value\n",
        "utf8",
      );
      await writeFile(
        join(dir, "CLAUDE.md"),
        "# Guide\n\n@../secret.md\n\n## Guardrails\n\nNever touch production.\n",
        "utf8",
      );
      const r = await audit(["--path", dir, "--json"]);
      expect(r.stdout).not.toMatch(/AWS_SECRET/);
      expect(r.stdout).not.toMatch(/never-share-this-value/);
      expect(r.stdout).not.toMatch(/secret\.md/);
      expect(r.stderr).not.toMatch(/AWS_SECRET/);
      const budget = JSON.parse(r.stdout).findings.find(
        (/** @type {any} */ f) => f.id === "guide.context-budget",
      );
      expect(budget.evidence).not.toMatch(/secret/);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("emits well-formed JSON that is not truncated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "audit-cli-"));
    try {
      await seedReadyRepo(dir);
      const r = await audit(["--path", dir, "--json"]);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.findings).toHaveLength(10);
      expect(parsed.summary).toHaveProperty("unknown");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
