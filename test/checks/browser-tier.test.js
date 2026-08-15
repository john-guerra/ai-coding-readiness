import { describe, it, expect } from "vitest";
import sharded from "../../lib/checks/ci-e2e-sharded.js";
import flake from "../../lib/checks/ci-flake-observability.js";
import { createFakeRepo } from "../../lib/repo.js";

const PW_CONFIG = "playwright.config.js";

describe("ci.e2e-sharded", () => {
  it("is unknown when no browser tier is configured", async () => {
    const f = await sharded.run(createFakeRepo({ files: {} }));
    expect(f.status).toBe("unknown");
  });

  it("fails when a pull-request job runs the browser tier unsharded", async () => {
    const repo = createFakeRepo({
      files: {
        [PW_CONFIG]: "export default { workers: 1 };",
        ".github/workflows/ci.yml": `
on: [pull_request]
jobs:
  e2e:
    steps:
      - run: npx playwright install --with-deps chromium
      - run: npm run test:e2e
`,
      },
    });
    const f = await sharded.run(repo);
    expect(f.status).toBe("fail");
    expect(f.fix).toMatch(/shard/i);
    // The precondition is the whole point: sharding splits by FILE, so wall
    // clock becomes max(file), not total/N.
    expect(f.precondition).toMatch(/dominat/i);
  });

  it("passes when the job shards", async () => {
    const repo = createFakeRepo({
      files: {
        [PW_CONFIG]: "export default {};",
        ".github/workflows/ci.yml": `
on: [pull_request]
jobs:
  e2e:
    strategy:
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      - run: npx playwright test --shard=\${{ matrix.shard }}/4
`,
      },
    });
    expect((await sharded.run(repo)).status).toBe("pass");
  });

  it("passes when sharding is detected only via a matrix key, with no literal --shard in the command", async () => {
    const repo = createFakeRepo({
      files: {
        [PW_CONFIG]: "export default {};",
        ".github/workflows/ci.yml": `
on: [pull_request]
jobs:
  e2e:
    strategy:
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      - run: SHARD=\${{ matrix.shard }} npm run test:e2e
`,
      },
    });
    // Deleting the matrixKeys.some(...) branch and keeping only the
    // /--shard/ literal check would fail this test, since the command text
    // above never contains the substring "--shard".
    expect((await sharded.run(repo)).status).toBe("pass");
  });

  it("is unknown, not pass, when a genuinely unsharded PR-gate job could be hiding in a file that failed to parse", async () => {
    const repo = createFakeRepo({
      files: {
        [PW_CONFIG]: "export default {};",
        // Sharded and fine on its own.
        ".github/workflows/ci.yml": `
on: [pull_request]
jobs:
  e2e:
    strategy:
      matrix:
        shard: [1, 2]
    steps:
      - run: npx playwright test --shard=\${{ matrix.shard }}/2
`,
        // Malformed YAML (unbalanced flow map) — this file could genuinely
        // contain an unsharded PR-gate e2e job, and the check must not
        // silently drop it out of the count that decides `pass`.
        ".github/workflows/nightly-e2e.yml": "on: [pull_request]\njobs: {\n",
      },
    });
    const f = await sharded.run(repo);
    expect(f.status).toBe("unknown");
    expect(f.evidence).toMatch(/nightly-e2e\.yml/);
  });
});

describe("ci.flake-observability", () => {
  it("fails when the browser config declares no retries", async () => {
    const repo = createFakeRepo({
      files: { [PW_CONFIG]: "export default { workers: 1, testDir: './e2e' };" },
    });
    const f = await flake.run(repo);
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/retries/);
    expect(f.fix).toMatch(/retries/);
  });

  it("passes when retries are configured", async () => {
    const repo = createFakeRepo({
      files: { [PW_CONFIG]: "export default { retries: process.env.CI ? 1 : 0 };" },
    });
    expect((await flake.run(repo)).status).toBe("pass");
  });

  // `retries: 0` is behaviourally identical to no retries key at all: no retry
  // happens, so Playwright never classifies a test as `flaky`, so the flake
  // rate this check exists to make measurable stays unmeasurable. Reporting
  // `pass` on it is a false green on the exact condition being detected.
  it("fails when retries is the literal 0, which is identical to leaving it unset", async () => {
    const repo = createFakeRepo({
      files: { [PW_CONFIG]: "export default { retries: 0, workers: 1 };" },
    });
    const f = await flake.run(repo);
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/retries.*\b0\b/);
    expect(f.fix).toMatch(/retries/);
  });

  it("fails when the literal 0 is the last entry before the closing brace", async () => {
    const repo = createFakeRepo({
      files: {
        [PW_CONFIG]: `export default {
  workers: 1,
  retries: 0
};`,
      },
    });
    expect((await flake.run(repo)).status).toBe("fail");
  });

  // Only a bare literal 0 is a finding. Anything this textual read cannot
  // evaluate — a ternary on CI, a variable, a helper call — may well be
  // non-zero at run time, and a `fail` there would be a confidently wrong
  // remediation.
  it("passes when a 0 appears only inside an expression that was not evaluated", async () => {
    const repo = createFakeRepo({
      files: {
        [PW_CONFIG]: "export default { retries: process.env.CI ? 2 : 0, workers: 1 };",
      },
    });
    expect((await flake.run(repo)).status).toBe("pass");
  });

  it("passes when retries is read off a variable rather than written literally", async () => {
    const repo = createFakeRepo({
      files: { [PW_CONFIG]: "export default { retries: RETRY_COUNT, workers: 1 };" },
    });
    expect((await flake.run(repo)).status).toBe("pass");
  });

  it("fails, not passes, when retries is only mentioned in a comment", async () => {
    const repo = createFakeRepo({
      files: { [PW_CONFIG]: "// retries: not set on purpose" },
    });
    expect((await flake.run(repo)).status).toBe("fail");
  });

  it("fails, not passes, when retries is only mentioned inside a quoted string", async () => {
    const repo = createFakeRepo({
      files: { [PW_CONFIG]: 'export default { reporter: "retries: none" };' },
    });
    expect((await flake.run(repo)).status).toBe("fail");
  });

  it("passes when the retries key is double-quoted", async () => {
    const repo = createFakeRepo({
      files: { [PW_CONFIG]: 'export default { "retries": 1 };' },
    });
    expect((await flake.run(repo)).status).toBe("pass");
  });

  it("passes when the retries key is single-quoted", async () => {
    const repo = createFakeRepo({
      files: { [PW_CONFIG]: "export default { 'retries': 1 };" },
    });
    expect((await flake.run(repo)).status).toBe("pass");
  });

  it("passes when a quoted retries key sits on its own line in a multiline config", async () => {
    const repo = createFakeRepo({
      files: {
        [PW_CONFIG]: `export default {
  "retries": 2,
  workers: 1,
};`,
      },
    });
    expect((await flake.run(repo)).status).toBe("pass");
  });

  it("fails, not passes, when retries only appears inside a block comment", async () => {
    const repo = createFakeRepo({
      files: {
        [PW_CONFIG]: `export default {
/*
  retries: 1,
*/
  workers: 1,
};`,
      },
    });
    expect((await flake.run(repo)).status).toBe("fail");
  });

  it("is unknown when there is no browser config to read", async () => {
    expect((await flake.run(createFakeRepo({ files: {} }))).status).toBe("unknown");
  });
});
