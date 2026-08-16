import { describe, it, expect } from "vitest";
import { createFakeRepo } from "../../lib/repo.js";
import exists from "../../lib/checks/guide-exists.js";
import commands from "../../lib/checks/guide-commands.js";
import guardrails from "../../lib/checks/guide-guardrails.js";

/**
 * @param {Record<string, string>} scripts
 */
const pkg = (scripts = { test: "vitest run" }) =>
  JSON.stringify({ name: "x", scripts });

describe("guide.exists", () => {
  it("fails when there is no agent guide at all", async () => {
    const f = await exists.run(
      createFakeRepo({ files: { "package.json": pkg() } }),
    );
    expect(f.status).toBe("fail");
    expect(f.fix).toMatch(/\/init/);
  });

  it("passes when a guide is present, regardless of its content", async () => {
    const f = await exists.run(
      createFakeRepo({
        files: { "CLAUDE.md": "# Guide\nSome prose.\n" },
      }),
    );
    expect(f.status).toBe("pass");
    expect(f.evidence).toMatch(/CLAUDE\.md/);
  });
});

describe("guide.commands", () => {
  it("is unknown when there is no guide", async () => {
    const f = await commands.run(
      createFakeRepo({ files: { "package.json": pkg() } }),
    );
    expect(f.status).toBe("unknown");
  });

  it("is unknown when there is no package.json to learn the command from", async () => {
    const f = await commands.run(
      createFakeRepo({ files: { "CLAUDE.md": "# Guide\nRun `npm test`.\n" } }),
    );
    expect(f.status).toBe("unknown");
  });

  it("is unknown when package.json cannot be parsed", async () => {
    const f = await commands.run(
      createFakeRepo({
        files: {
          "CLAUDE.md": "# Guide\nRun `npm test`.\n",
          "package.json": "{ not json",
        },
      }),
    );
    expect(f.status).toBe("unknown");
  });

  it("is unknown when package.json declares no test script", async () => {
    const f = await commands.run(
      createFakeRepo({
        files: {
          "CLAUDE.md": "# Guide\nRun `npm run build`.\n",
          "package.json": pkg({ build: "tsc" }),
        },
      }),
    );
    expect(f.status).toBe("unknown");
  });

  it("passes when the guide names the test command directly", async () => {
    const f = await commands.run(
      createFakeRepo({
        files: {
          "package.json": pkg(),
          "CLAUDE.md": "# Guide\nRun `npm test` before committing.\n",
        },
      }),
    );
    expect(f.status).toBe("pass");
    expect(f.evidence).toMatch(/CLAUDE\.md/);
  });

  it("passes on a corpus-only match: only the imported file names the command", async () => {
    const f = await commands.run(
      createFakeRepo({
        files: {
          "package.json": pkg({ test: "npm test" }),
          "CLAUDE.md": "@AGENTS.md\n\nClaude-specific notes only.\n",
          "AGENTS.md":
            "# Guide\n\n## Commands\n\n```\nnpm test\n```\n\nRun the suite before committing.\n",
        },
      }),
    );
    expect(f.status).toBe("pass");
    expect(f.evidence).toMatch(/AGENTS\.md/);
  });

  it("passes when scripts.test is turbo run test and the guide documents it correctly", async () => {
    const f = await commands.run(
      createFakeRepo({
        files: {
          "package.json": pkg({ test: "turbo run test" }),
          "CLAUDE.md": "# Guide\n\nRun `turbo run test` to run the suite.\n",
        },
      }),
    );
    expect(f.status).toBe("pass");
    expect(f.evidence).toMatch(/turbo run test/);
  });

  it("does not pass a mocha project whose guide merely mentions vitest", async () => {
    const f = await commands.run(
      createFakeRepo({
        files: {
          "package.json": pkg({ test: "mocha" }),
          "CLAUDE.md":
            "# Guide\n\nWe previously used vitest but no longer do.\n",
        },
      }),
    );
    expect(f.status).not.toBe("pass");
    expect(f.status).toBe("fail");
  });

  it("does not pass an ordinary English word used as the test command, mentioned only in prose", async () => {
    const f = await commands.run(
      createFakeRepo({
        files: {
          "package.json": pkg({ test: "check" }),
          "CLAUDE.md": "# Guide\n\nDouble check your changes.\n",
        },
      }),
    );
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/not credited/);
  });

  it("does not pass 'lint' used as the test command, mentioned only in prose", async () => {
    const f = await commands.run(
      createFakeRepo({
        files: {
          "package.json": pkg({ test: "lint" }),
          "CLAUDE.md": "# Guide\n\nWe lint on save.\n",
        },
      }),
    );
    expect(f.status).toBe("fail");
  });

  it("does not pass a multi-word script whose first word appears only in prose", async () => {
    const f = await commands.run(
      createFakeRepo({
        files: {
          "package.json": pkg({ test: "echo no tests" }),
          "CLAUDE.md": "# Guide\n\nJust echo the result.\n",
        },
      }),
    );
    expect(f.status).toBe("fail");
  });

  it("passes a bare single-word command when it appears inside backticks", async () => {
    const f = await commands.run(
      createFakeRepo({
        files: {
          "package.json": pkg({ test: "check" }),
          "CLAUDE.md": "# Guide\n\nRun `check` before committing.\n",
        },
      }),
    );
    expect(f.status).toBe("pass");
    expect(f.evidence).toMatch(/check/);
  });

  // The derived single-word token is only safe when it IS the whole script.
  // `node`, `npm`, `bash`, `pnpm` are launchers: crediting them means any
  // unrelated command in the guide satisfies the check, which is exactly the
  // false-pass class A2 closed for the fixed word list.
  it("does not pass `node --test` when the guide's only code is an unrelated node command", async () => {
    const f = await commands.run(
      createFakeRepo({
        files: {
          "package.json": pkg({ test: "node --test" }),
          "CLAUDE.md": "# Guide\n\nRun `node bin/x.mjs --path .` to audit.\n",
        },
      }),
    );
    expect(f.status).toBe("fail");
  });

  it("does not pass `npm run test:unit` when the guide's only code is `npm install`", async () => {
    const f = await commands.run(
      createFakeRepo({
        files: {
          "package.json": pkg({ test: "npm run test:unit" }),
          "CLAUDE.md": "# Guide\n\nRun `npm install` first.\n",
        },
      }),
    );
    expect(f.status).toBe("fail");
  });

  it("does not pass `bash scripts/test.sh` on a ```bash fence containing something else", async () => {
    const f = await commands.run(
      createFakeRepo({
        files: {
          "package.json": pkg({ test: "bash scripts/test.sh" }),
          "CLAUDE.md": "# Guide\n\n```bash\ngit status\n```\n",
        },
      }),
    );
    expect(f.status).toBe("fail");
    expect(f.evidence).not.toMatch(/```bash/);
  });

  // Independent of the multi-word rule above: a fence's language tag is never
  // a command, even when the script really is that single word.
  it("does not credit a code fence's language tag as the command", async () => {
    const f = await commands.run(
      createFakeRepo({
        files: {
          "package.json": pkg({ test: "bash" }),
          "CLAUDE.md": "# Guide\n\n```bash\ngit status\n```\n",
        },
      }),
    );
    expect(f.status).toBe("fail");
  });

  it("still passes a multi-word script documented literally", async () => {
    for (const script of [
      "node --test",
      "npm run test:unit",
      "turbo run test",
    ]) {
      const f = await commands.run(
        createFakeRepo({
          files: {
            "package.json": pkg({ test: script }),
            "CLAUDE.md": `# Guide\n\n\`\`\`bash\n${script}\n\`\`\`\n`,
          },
        }),
      );
      expect(f.status, script).toBe("pass");
    }
  });

  it("passes but quotes the matched line, even when the guide negates it", async () => {
    const f = await commands.run(
      createFakeRepo({
        files: {
          "package.json": pkg({ test: "npm test" }),
          "CLAUDE.md": "# Guide\n\nDo not run `npm test` — use `make check`.\n",
        },
      }),
    );
    expect(f.status).toBe("pass");
    expect(f.evidence).toMatch(/Do not run/);
  });
});

describe("guide.guardrails", () => {
  it("is unknown when there is no guide, which guide.exists already reports", async () => {
    const f = await guardrails.run(createFakeRepo({ files: {} }));
    expect(f.status).toBe("unknown");
    expect(f.evidence).toMatch(/guide\.exists/);
  });

  it("fails when neither the guide nor settings forbid anything", async () => {
    const f = await guardrails.run(
      createFakeRepo({ files: { "CLAUDE.md": "# Guide\nRun npm test.\n" } }),
    );
    expect(f.status).toBe("fail");
    expect(f.fix).toBeTruthy();
  });

  it("passes on a prohibition written in the guide", async () => {
    const f = await guardrails.run(
      createFakeRepo({
        files: { "CLAUDE.md": "Never modify the user's photo folders.\n" },
      }),
    );
    expect(f.status).toBe("pass");
    expect(f.evidence).toMatch(/Never modify/);
    expect(f.evidence).toMatch(/CLAUDE\.md/);
  });

  it("passes on a prohibition matched only in an imported file", async () => {
    const f = await guardrails.run(
      createFakeRepo({
        files: {
          "CLAUDE.md": "@AGENTS.md\n\nClaude-specific notes only.\n",
          "AGENTS.md": "# Guide\n\nNever delete user data.\n",
        },
      }),
    );
    expect(f.status).toBe("pass");
    expect(f.evidence).toMatch(/Never delete user data/);
    expect(f.evidence).toMatch(/AGENTS\.md/);
  });

  it("does not count a prohibition that appears only inside a code fence", async () => {
    const f = await guardrails.run(
      createFakeRepo({
        files: {
          "CLAUDE.md":
            "# Guide\n\nExample of a guardrail sentence:\n\n```\nNever touch production data.\n```\n\nNo guardrail is actually stated in prose here.\n",
        },
      }),
    );
    expect(f.status).toBe("fail");
  });

  it("passes on a deny list in committed settings", async () => {
    const f = await guardrails.run(
      createFakeRepo({
        files: {
          "CLAUDE.md": "# Guide\n",
          ".claude/settings.json": JSON.stringify({
            permissions: { deny: ["Bash(rm -rf *)"] },
          }),
        },
      }),
    );
    expect(f.status).toBe("pass");
    expect(f.evidence).toMatch(/settings\.json/);
  });

  it("does not treat malformed settings as a deny list", async () => {
    const f = await guardrails.run(
      createFakeRepo({
        files: {
          "CLAUDE.md": "# Guide\n",
          ".claude/settings.json": "{ not json",
        },
      }),
    );
    expect(f.status).toBe("fail");
  });
});
