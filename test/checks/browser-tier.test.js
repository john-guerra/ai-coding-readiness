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

  it("is unknown when there is no browser config to read", async () => {
    expect((await flake.run(createFakeRepo({ files: {} }))).status).toBe("unknown");
  });
});
