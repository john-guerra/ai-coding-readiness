import { describe, it, expect } from "vitest";
import check from "../../lib/checks/ci-no-diff-can-fail-on-gate.js";
import { createFakeRepo } from "../../lib/repo.js";

/**
 * @param {string} body
 * @returns {Record<string,string>}
 */
const wf = (body) => ({ ".github/workflows/ci.yml": body });

describe("ci.no-diff-can-fail-on-gate", () => {
  it("is unknown when there are no workflows at all", async () => {
    const f = await check.run(createFakeRepo({ files: {} }));
    expect(f.status).toBe("unknown");
    expect(f.evidence).toMatch(/no workflow/i);
  });

  it("fails when `npm audit` runs on a pull_request-triggered job", async () => {
    const repo = createFakeRepo({
      files: wf(`
on:
  pull_request:
    branches: [main]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci
      - run: npm audit --omit=dev --audit-level=high
      - run: npm test
`),
    });
    const f = await check.run(repo);
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/npm audit/);
    expect(f.evidence).toMatch(/ci\.yml/);
    expect(f.fix).toBeTruthy();
    // The remediation must warn against the per-run filing pattern, since the
    // reference repo's measured complaint is issue volume.
    expect(f.fix).toMatch(/search by title|update one issue/i);
  });

  it("passes when the same step runs only on a schedule", async () => {
    const repo = createFakeRepo({
      files: wf(`
on:
  schedule:
    - cron: "0 3 * * *"
jobs:
  nightly:
    runs-on: ubuntu-latest
    steps:
      - run: npm audit --audit-level=high
`),
    });
    const f = await check.run(repo);
    expect(f.status).toBe("pass");
  });

  it("detects the shorthand `on: pull_request` form", async () => {
    const repo = createFakeRepo({
      files: wf(`
on: pull_request
jobs:
  check:
    steps:
      - run: npx snyk test
`),
    });
    const f = await check.run(repo);
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/snyk/);
  });

  it("detects the array form `on: [push, pull_request]`", async () => {
    const repo = createFakeRepo({
      files: wf(`
on: [push, pull_request]
jobs:
  check:
    steps:
      - run: pnpm audit
`),
    });
    expect((await check.run(repo)).status).toBe("fail");
  });

  it("passes a gate whose steps can only fail because of the diff", async () => {
    const repo = createFakeRepo({
      files: wf(`
on: pull_request
jobs:
  check:
    steps:
      - run: npm ci
      - run: npm test
      - run: npm run build
`),
    });
    expect((await check.run(repo)).status).toBe("pass");
  });

  it("is unknown when a workflow cannot be parsed", async () => {
    const repo = createFakeRepo({ files: wf("this: is: not: valid: yaml:\n  - [") });
    const f = await check.run(repo);
    expect(f.status).toBe("unknown");
  });
});
