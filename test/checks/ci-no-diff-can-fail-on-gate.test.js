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

  // The step is where it belongs, so it is not a hit. The verdict is
  // `unknown` rather than `pass` because this repository has no merge gate
  // among its workflows at all — see the merge-queue tests below.
  it("does not flag the same step when it runs only on a schedule", async () => {
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
    expect(f.status).not.toBe("fail");
    expect(f.status).toBe("unknown");
  });

  // A merge queue IS the merge gate on repos that use one. Reporting `pass`
  // here means reporting green without ever having examined the gate.
  it("is unknown, not pass, when no workflow gates a merge at all", async () => {
    const repo = createFakeRepo({
      files: wf(`
on:
  push:
    branches: [main]
jobs:
  check:
    steps:
      - run: npm ci
      - run: npm test
`),
    });
    const f = await check.run(repo);
    expect(f.status).toBe("unknown");
    expect(f.evidence).toMatch(/no pull[- ]request/i);
    expect(f.evidence).toMatch(/merge[- _]queue|merge_group/i);
  });

  it("examines a merge_group gate, which a pull_request-only predicate missed", async () => {
    const repo = createFakeRepo({
      files: wf(`
on:
  merge_group:
  push:
    branches: [main]
jobs:
  check:
    steps:
      - run: npm audit --omit=dev --audit-level=high
      - run: npm run test:e2e
`),
    });
    const f = await check.run(repo);
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/npm audit/);
  });

  it("passes a merge_group gate whose steps can only fail because of the diff", async () => {
    const repo = createFakeRepo({
      files: wf(`
on:
  merge_group:
jobs:
  check:
    steps:
      - run: npm test
`),
    });
    expect((await check.run(repo)).status).toBe("pass");
  });

  // The canonical way a maintainer de-fangs an advisory scan they want to see
  // but not be blocked by. A step that cannot turn the run red cannot block a
  // merge, so telling them to move it is crying wolf.
  it("does not flag a volatile step marked continue-on-error", async () => {
    const repo = createFakeRepo({
      files: wf(`
on: pull_request
jobs:
  check:
    steps:
      - run: npm audit --audit-level=high
        continue-on-error: true
      - run: npm test
`),
    });
    expect((await check.run(repo)).status).toBe("pass");
  });

  it("does not flag a volatile step inside a job marked continue-on-error", async () => {
    const repo = createFakeRepo({
      files: wf(`
on: pull_request
jobs:
  advisory:
    continue-on-error: true
    steps:
      - run: npm audit --audit-level=high
  check:
    steps:
      - run: npm test
`),
    });
    expect((await check.run(repo)).status).toBe("pass");
  });

  // A close-out workflow runs after the merge landed. It gates nothing.
  it("does not treat a pull_request trigger keyed to closed as a gate", async () => {
    const repo = createFakeRepo({
      files: {
        ".github/workflows/ci.yml": `
on: pull_request
jobs:
  check:
    steps:
      - run: npm test
`,
        ".github/workflows/pr-closeout.yml": `
on:
  pull_request:
    types: [closed]
jobs:
  closeout:
    steps:
      - run: npm audit --audit-level=high
`,
      },
    });
    expect((await check.run(repo)).status).toBe("pass");
  });

  // Still reported — evaluating a GitHub expression is out of scope, and
  // dropping the step would hide a real finding behind a condition nobody
  // read — but the evidence must not imply the condition was checked.
  it("reports a conditional step and says the condition was not evaluated", async () => {
    const repo = createFakeRepo({
      files: wf(`
on: pull_request
jobs:
  check:
    steps:
      - run: npm audit --audit-level=high
        if: github.event_name == 'schedule'
`),
    });
    const f = await check.run(repo);
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/not evaluated/);
    expect(f.evidence).toMatch(/if:/);
  });

  // Parsing as YAML is not the same as being a workflow. A document that is a
  // string or a list was previously skipped without joining the unexamined
  // list, so it counted as examined without having been checked.
  it("is unknown when a workflow parses as YAML but is not a mapping", async () => {
    const repo = createFakeRepo({
      files: {
        ".github/workflows/ci.yml": `
on: pull_request
jobs:
  check:
    steps:
      - run: npm test
`,
        ".github/workflows/notes.yml": "- just\n- a\n- list\n",
      },
    });
    const f = await check.run(repo);
    expect(f.status).toBe("unknown");
    expect(f.evidence).toMatch(/notes\.yml/);
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
    const repo = createFakeRepo({
      files: wf("this: is: not: valid: yaml:\n  - ["),
    });
    const f = await check.run(repo);
    expect(f.status).toBe("unknown");
  });

  it("is unknown — not pass — when one of two workflows is broken and the other is clean", async () => {
    const repo = createFakeRepo({
      files: {
        ".github/workflows/ci.yml": `
on: pull_request
jobs:
  check:
    steps:
      - run: npm ci
      - run: npm test
`,
        ".github/workflows/broken.yml": "this: is: not: valid: yaml:\n  - [",
      },
    });
    const f = await check.run(repo);
    expect(f.status).toBe("unknown");
    expect(f.evidence).toMatch(/broken\.yml/);
    expect(f.evidence).toMatch(/1 of 2/);
  });

  it("is unknown when every workflow file is broken", async () => {
    const repo = createFakeRepo({
      files: {
        ".github/workflows/a.yml": "this: is: not: valid: yaml:\n  - [",
        ".github/workflows/b.yml": "also: not: [valid",
      },
    });
    const f = await check.run(repo);
    expect(f.status).toBe("unknown");
    expect(f.evidence).toMatch(/a\.yml/);
    expect(f.evidence).toMatch(/b\.yml/);
  });

  it("still fails on a real hit even when a sibling workflow is unparseable", async () => {
    const repo = createFakeRepo({
      files: {
        ".github/workflows/ci.yml": `
on: pull_request
jobs:
  check:
    steps:
      - run: npm audit --omit=dev --audit-level=high
`,
        ".github/workflows/broken.yml": "this: is: not: valid: yaml:\n  - [",
      },
    });
    const f = await check.run(repo);
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/npm audit/);
  });

  it("ignores a volatile command that only appears in a comment", async () => {
    const repo = createFakeRepo({
      files: wf(`
on: pull_request
jobs:
  check:
    steps:
      - run: |
          # npm audit --audit-level=high (disabled, too noisy)
          npm ci
          npm test
`),
    });
    const f = await check.run(repo);
    expect(f.status).toBe("pass");
  });

  it("still catches a genuine volatile command later in the same multi-line block", async () => {
    const repo = createFakeRepo({
      files: wf(`
on: pull_request
jobs:
  check:
    steps:
      - run: |
          # npm audit --audit-level=high (disabled, too noisy)
          npm ci
          npm audit --omit=dev --audit-level=high
          npm test
`),
    });
    const f = await check.run(repo);
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/npm audit --omit=dev --audit-level=high/);
  });

  it("reports the line that actually matched, not the first line of the block", async () => {
    const repo = createFakeRepo({
      files: wf(`
on: pull_request
jobs:
  check:
    steps:
      - run: |
          npm ci
          npm test
          npm audit --omit=dev --audit-level=high
`),
    });
    const f = await check.run(repo);
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/npm audit --omit=dev --audit-level=high/);
    expect(f.evidence).not.toMatch(/`npm ci`/);
  });
});
