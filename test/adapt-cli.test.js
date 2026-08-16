import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPT = join(HERE, "..", "bin", "adapt.mjs");

/**
 * @param {string} dir
 * @param {string[]} args
 */
function git(dir, args) {
  return run("git", args, { cwd: dir });
}

/**
 * A real git repository, configured locally so the test does not depend on
 * whatever `user.name` the machine happens to have (and does not fail on a
 * machine that has none).
 * @param {string} dir
 */
async function initRepo(dir) {
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
}

/**
 * @param {string} dir
 * @param {string} message
 */
async function commitAll(dir, message) {
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", message]);
}

/** @param {string} dir */
async function porcelain(dir) {
  const { stdout } = await git(dir, ["status", "--porcelain"]);
  return stdout;
}

/**
 * Seed a directory so exactly the three action-capable checks fail:
 *
 * - `repo.hygiene` — a lockfile is present (so the finding carries its
 *   `append-lines` action) but `.gitignore` covers only node_modules.
 * - `guide.guardrails` — a guide exists with no prohibition anywhere in it.
 * - `github.contribution-scaffold` — no `.github/` at all.
 *
 * The guide deliberately contains no "never", "do not", "don't" or "must
 * not": any one of them makes `guide.guardrails` pass and removes the
 * write-region action this fixture exists to exercise.
 *
 * @param {string} dir
 */
async function seedFixableRepo(dir) {
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify(
      { name: "fixture", version: "0.0.0", scripts: { test: "npm test" } },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await writeFile(join(dir, "package-lock.json"), "{}\n", "utf8");
  await writeFile(join(dir, ".gitignore"), "node_modules/\n", "utf8");
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
    ].join("\n"),
    "utf8",
  );
}

/**
 * @param {string[]} args
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
async function adapt(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [ADAPT, ...args]);
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

/**
 * @param {(dir: string) => Promise<void>} body
 * @param {{git?: boolean, seed?: (dir: string) => Promise<void>}} [opts]
 */
async function withRepo(
  body,
  { git: asGit = true, seed = seedFixableRepo } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "adapt-cli-"));
  try {
    if (asGit) await initRepo(dir);
    await seed(dir);
    if (asGit) await commitAll(dir, "seed");
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * @param {string} dir
 * @param {string} rel
 */
async function readMaybe(dir, rel) {
  try {
    return await readFile(join(dir, rel), "utf8");
  } catch {
    return null;
  }
}

describe("bin/adapt.mjs — usage", () => {
  it("exits 2 when --path does not exist", async () => {
    const r = await adapt(["--path", "/does/not/exist"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/\/does\/not\/exist/);
  });

  it("exits 2 on an unknown argument", async () => {
    const r = await adapt(["--nope"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--nope/);
  });

  it("prints usage for --help and exits 0", async () => {
    const r = await adapt(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/--write/);
    expect(r.stdout).toMatch(/dry run/i);
  });
});

describe("bin/adapt.mjs — dry run", () => {
  it("writes nothing and names every action it would take", async () => {
    await withRepo(async (dir) => {
      const before = await porcelain(dir);
      const r = await adapt(["--path", dir]);
      expect(r.code).toBe(0);
      // Named, per action.
      expect(r.stdout).toMatch(/repo\.hygiene/);
      expect(r.stdout).toMatch(/\.gitignore/);
      expect(r.stdout).toMatch(/guide\.guardrails/);
      expect(r.stdout).toMatch(/AGENTS\.md/);
      expect(r.stdout).toMatch(/github\.contribution-scaffold/);
      expect(r.stdout).toMatch(/\.github\/ISSUE_TEMPLATE\/bug\.md/);
      // And it says plainly that it wrote nothing.
      expect(r.stdout).toMatch(/dry run|--write/i);
      // Nothing on disk moved.
      expect(await porcelain(dir)).toBe(before);
      expect(await readMaybe(dir, ".github/ISSUE_TEMPLATE/bug.md")).toBeNull();
      expect(await readMaybe(dir, ".ai-readiness/manifest.json")).toBeNull();
      expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe(
        "node_modules/\n",
      );
    });
  });

  // Amendment B9: a tool that applies a fix while suppressing the caveat
  // attached to that fix is worse than one that does not apply it.
  it("prints each action's precondition", async () => {
    await withRepo(async (dir) => {
      const r = await adapt(["--path", dir]);
      // guide.guardrails' precondition.
      expect(r.stdout).toMatch(/generic starting point/i);
      // github.contribution-scaffold's precondition.
      expect(r.stdout).toMatch(/starting point, not a description of/i);
      expect(r.stdout).toMatch(/before applying/i);
    });
  });

  it("does not need a git repository", async () => {
    await withRepo(
      async (dir) => {
        const r = await adapt(["--path", dir]);
        expect(r.code).toBe(0);
        expect(r.stdout).toMatch(/repo\.hygiene/);
      },
      { git: false },
    );
  });

  it("emits well-formed JSON that is not truncated when piped", async () => {
    await withRepo(async (dir) => {
      const r = await adapt(["--path", dir, "--json"]);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.mode).toBe("dry-run");
      expect(parsed.findings).toHaveLength(10);
      expect(parsed.planned.map((/** @type {any} */ p) => p.id).sort()).toEqual(
        ["github.contribution-scaffold", "guide.guardrails", "repo.hygiene"],
      );
      // The caveat travels with the plan in machine-readable output too.
      const guardrails = parsed.planned.find(
        (/** @type {any} */ p) => p.id === "guide.guardrails",
      );
      expect(guardrails.precondition).toMatch(/generic starting point/i);
    });
  });
});

describe("bin/adapt.mjs — --write", () => {
  it("applies every action and converges in 3 passes", async () => {
    await withRepo(async (dir) => {
      const r = await adapt(["--path", dir, "--write"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/3 pass/);
      expect(r.stdout).not.toMatch(/cap/i);

      const ignore = await readFile(join(dir, ".gitignore"), "utf8");
      expect(ignore).toMatch(/node_modules\//);
      expect(ignore).toMatch(/dist\//);
      expect(ignore).toMatch(/\.env/);
      expect(ignore).toMatch(/\.DS_Store/);

      const guide = await readFile(join(dir, "AGENTS.md"), "utf8");
      expect(guide).toMatch(/<!-- ai-readiness:begin id=guardrails v=1 -->/);
      expect(guide).toMatch(/<!-- ai-readiness:end id=guardrails -->/);
      // The original content is untouched.
      expect(guide).toMatch(/## Commands/);

      expect(
        await readMaybe(dir, ".github/ISSUE_TEMPLATE/bug.md"),
      ).not.toBeNull();
      expect(
        await readMaybe(dir, ".github/PULL_REQUEST_TEMPLATE.md"),
      ).not.toBeNull();
      // Amendment B7: CODEOWNERS stays a human step.
      expect(await readMaybe(dir, ".github/CODEOWNERS")).toBeNull();

      const manifest = await readMaybe(dir, ".ai-readiness/manifest.json");
      expect(manifest).not.toBeNull();
      const parsed = JSON.parse(/** @type {string} */ (manifest));
      expect(Object.keys(parsed.entries)).toContain("AGENTS.md#guardrails");
    });
  });

  // The point of the whole write layer: the checks that emitted the actions
  // pass afterwards (amendment B8), so the run does not report "applied 4
  // changes" beside a still-red check.
  it("leaves the checks it fixed passing", async () => {
    await withRepo(async (dir) => {
      await adapt(["--path", dir, "--write"]);
      await commitAll(dir, "adapt");
      const r = await adapt(["--path", dir, "--json"]);
      /** @type {Record<string, string>} */
      const byId = {};
      for (const f of JSON.parse(r.stdout).findings) byId[f.id] = f.status;
      expect(byId["repo.hygiene"]).toBe("pass");
      expect(byId["guide.guardrails"]).toBe("pass");
      // Still failing, honestly: CODEOWNERS is not generated.
      expect(byId["github.contribution-scaffold"]).toBe("fail");
    });
  });

  // The idempotency gate, in miniature. The commit between runs is amendment
  // B6: without it the second --write refuses a dirty tree.
  it("is idempotent — a second run changes nothing", async () => {
    await withRepo(async (dir) => {
      await adapt(["--path", dir, "--write"]);
      await commitAll(dir, "adapt run 1");
      const before = await readFile(join(dir, "AGENTS.md"), "utf8");

      const r = await adapt(["--path", dir, "--write"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/0 change/);
      expect(await porcelain(dir)).toBe("");
      expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe(before);
    });
  });

  it("persists the manifest per successful action, not once at the end", async () => {
    await withRepo(async (dir) => {
      await adapt(["--path", dir, "--write"]);
      const manifest = JSON.parse(
        /** @type {string} */ (
          await readMaybe(dir, ".ai-readiness/manifest.json")
        ),
      );
      const entry = manifest.entries["AGENTS.md#guardrails"];
      expect(entry.status).toBe("active");
      expect(entry.hash).toMatch(/^[0-9a-f]{16}$/);
      expect(entry.writtenAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});

describe("bin/adapt.mjs — the dirty-tree rule", () => {
  it("refuses --write on a tree with modified tracked files, and writes nothing", async () => {
    await withRepo(async (dir) => {
      await writeFile(join(dir, "package.json"), "{}\n", "utf8");
      const r = await adapt(["--path", dir, "--write"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/uncommitted|dirty/i);
      expect(r.stderr).toMatch(/--allow-dirty/);
      expect(await readMaybe(dir, ".github/ISSUE_TEMPLATE/bug.md")).toBeNull();
    });
  });

  // Untracked files count. A tree full of untracked work is exactly as hard to
  // review a generated diff out of as one full of modifications.
  it("counts untracked files as dirty", async () => {
    await withRepo(async (dir) => {
      await writeFile(join(dir, "scratch.txt"), "wip\n", "utf8");
      const r = await adapt(["--path", dir, "--write"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/scratch\.txt/);
    });
  });

  it("--allow-dirty proceeds and prints what it is overriding", async () => {
    await withRepo(async (dir) => {
      await writeFile(join(dir, "scratch.txt"), "wip\n", "utf8");
      const r = await adapt(["--path", dir, "--write", "--allow-dirty"]);
      expect(r.code).toBe(0);
      expect(r.stdout + r.stderr).toMatch(/scratch\.txt/);
      expect(r.stdout + r.stderr).toMatch(/--allow-dirty/);
      expect(
        await readMaybe(dir, ".github/ISSUE_TEMPLATE/bug.md"),
      ).not.toBeNull();
    });
  });

  // No diff, no review, no undo. `--allow-dirty` is about a dirty tree, not
  // about the absence of version control, so it does not override this.
  it("refuses --write outside a git repository, even with --allow-dirty", async () => {
    await withRepo(
      async (dir) => {
        const r = await adapt(["--path", dir, "--write"]);
        expect(r.code).toBe(2);
        expect(r.stderr).toMatch(/not a git repository/i);
        expect(
          await readMaybe(dir, ".github/ISSUE_TEMPLATE/bug.md"),
        ).toBeNull();

        const forced = await adapt(["--path", dir, "--write", "--allow-dirty"]);
        expect(forced.code).toBe(2);
        expect(
          await readMaybe(dir, ".github/ISSUE_TEMPLATE/bug.md"),
        ).toBeNull();
      },
      { git: false },
    );
  });

  // Scoped to the audited path, not the enclosing repository: uncommitted work
  // in a sibling directory is none of this run's business.
  it("scopes the dirty check to --path, not the whole repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "adapt-scope-"));
    try {
      await initRepo(root);
      const sub = join(root, "package");
      const sibling = join(root, "elsewhere");
      await mkdir(sub, { recursive: true });
      await mkdir(sibling, { recursive: true });
      await seedFixableRepo(sub);
      await writeFile(join(sibling, "keep.txt"), "tracked\n", "utf8");
      await commitAll(root, "seed");

      // Dirty, but outside --path.
      await writeFile(join(sibling, "keep.txt"), "modified\n", "utf8");
      await writeFile(join(sibling, "untracked.txt"), "wip\n", "utf8");

      const r = await adapt(["--path", sub, "--write"]);
      expect(r.code).toBe(0);
      expect(
        await readMaybe(sub, ".github/ISSUE_TEMPLATE/bug.md"),
      ).not.toBeNull();
      // And it did not touch the sibling.
      expect(await readFile(join(sibling, "keep.txt"), "utf8")).toBe(
        "modified\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("bin/adapt.mjs — the corrupt-manifest refusal", () => {
  // Amendment B5. Without this, one corrupt byte overwrites every generated
  // region in the repository, because `applyAction` cannot tell "never
  // written" from "unreadable".
  it("refuses --write when the manifest is unreadable, and writes nothing", async () => {
    await withRepo(async (dir) => {
      await mkdir(join(dir, ".ai-readiness"), { recursive: true });
      await writeFile(
        join(dir, ".ai-readiness", "manifest.json"),
        "{ this is not json",
        "utf8",
      );
      await commitAll(dir, "corrupt manifest");

      const r = await adapt(["--path", dir, "--write"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/manifest/i);
      expect(r.stderr).toMatch(/not valid JSON/i);
      expect(await readMaybe(dir, ".github/ISSUE_TEMPLATE/bug.md")).toBeNull();
      expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe(
        "node_modules/\n",
      );
    });
  });

  it("refuses --write when the manifest has the wrong shape", async () => {
    await withRepo(async (dir) => {
      await mkdir(join(dir, ".ai-readiness"), { recursive: true });
      await writeFile(
        join(dir, ".ai-readiness", "manifest.json"),
        JSON.stringify(["not", "an", "object"]),
        "utf8",
      );
      await commitAll(dir, "corrupt manifest");
      const r = await adapt(["--path", dir, "--write"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/expected shape/i);
    });
  });

  // A dry run does not write, so it cannot destroy anything — but it must not
  // pretend the manifest is fine either.
  it("warns rather than refuses in a dry run", async () => {
    await withRepo(async (dir) => {
      await mkdir(join(dir, ".ai-readiness"), { recursive: true });
      await writeFile(
        join(dir, ".ai-readiness", "manifest.json"),
        "{ this is not json",
        "utf8",
      );
      const r = await adapt(["--path", dir]);
      expect(r.code).toBe(0);
      expect(r.stdout + r.stderr).toMatch(/manifest/i);
      expect(r.stdout + r.stderr).toMatch(/--write/);
    });
  });
});

describe("bin/adapt.mjs — a failing action", () => {
  // `applyAction` lets the writer's containment refusals propagate. They are
  // programming-level refusals, not repository states to summarise, so the CLI
  // must catch, report, and exit 1 rather than crash with a stack trace.
  it("reports a writer refusal and exits 1", async () => {
    await withRepo(
      async (dir) => {
        const r = await adapt(["--path", dir, "--write"]);
        expect(r.code).toBe(1);
        expect(r.stdout + r.stderr).toMatch(/symlink/i);
        expect(r.stdout).toMatch(/1 failed/);
        // The other actions still landed — one refusal does not cost the run.
        expect(
          await readMaybe(dir, ".github/ISSUE_TEMPLATE/bug.md"),
        ).not.toBeNull();
        const ignore = await readFile(join(dir, ".gitignore"), "utf8");
        expect(ignore).toMatch(/dist\//);
      },
      {
        // The guide is a symlink. The writer refuses to write through one,
        // because following it would write somewhere it was not pointed at.
        async seed(dir) {
          await seedFixableRepo(dir);
          await writeFile(
            join(dir, "guide-real.md"),
            "# Guide\n\n## Commands\n\n```bash\nnpm test\n```\n",
            "utf8",
          );
          await rm(join(dir, "AGENTS.md"));
          await symlink("guide-real.md", join(dir, "AGENTS.md"));
        },
      },
    );
  });
});
