import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("audits a real directory and exits 0 when nothing fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "audit-cli-"));
    try {
      const r = await audit(["--path", dir]);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/AI-coding readiness/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("emits well-formed JSON that is not truncated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "audit-cli-"));
    try {
      const r = await audit(["--path", dir, "--json"]);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.findings).toHaveLength(4);
      expect(parsed.summary).toHaveProperty("unknown");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
