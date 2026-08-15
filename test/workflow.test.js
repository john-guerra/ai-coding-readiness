import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { readTriggers, gatesMerge, gateJobs, IF_NOTE } from "../lib/workflow.js";

/** @param {string} yaml */
const on = (yaml) => readTriggers(parse(yaml));

/** @param {string} yaml */
const gates = (yaml) => gatesMerge(readTriggers(parse(yaml)));

describe("readTriggers", () => {
  it("reads the ordinary `on:` key", () => {
    expect(on("on: pull_request")).toBe("pull_request");
  });

  // YAML 1.1 reads a bare `on` key as the boolean true. The `yaml` package
  // parses 1.2, where it stays a string, but workflows in the wild are
  // written for both spellings.
  it("reads the YAML-1.1 spelling where a bare `on` key became the boolean true", () => {
    expect(readTriggers({ true: "pull_request" })).toBe("pull_request");
  });

  it("returns undefined for a document that is not a mapping", () => {
    expect(readTriggers("just a string")).toBeUndefined();
    expect(readTriggers(null)).toBeUndefined();
  });
});

describe("gatesMerge", () => {
  it("counts all three spellings of a pull_request trigger", () => {
    expect(gates("on: pull_request")).toBe(true);
    expect(gates("on: [push, pull_request]")).toBe(true);
    expect(gates("on:\n  pull_request:\n    branches: [main]")).toBe(true);
  });

  // A close-out workflow runs after the merge has already happened. Nobody
  // waits on it, and it can never block a change from landing, so calling it
  // a gate produced a false `fail` on the reference repo.
  it("does not count a pull_request trigger keyed only to post-merge types", () => {
    expect(gates("on:\n  pull_request:\n    types: [closed]")).toBe(false);
  });

  it("counts a types list that includes a type firing while the PR is open", () => {
    expect(gates("on:\n  pull_request:\n    types: [opened, synchronize, closed]")).toBe(
      true
    );
    expect(gates("on:\n  pull_request:\n    types: [ready_for_review]")).toBe(true);
  });

  // A merge queue IS the merge gate on repos that use one. Treating only
  // pull_request as a gate is how one check reported `pass` on a repo whose
  // actual gate had never been examined.
  it("counts a merge_group trigger as a gate", () => {
    expect(gates("on:\n  merge_group:")).toBe(true);
    expect(gates("on: [merge_group]")).toBe(true);
  });

  it("does not count a push to the default branch, which is post-merge branch health", () => {
    expect(gates("on:\n  push:\n    branches: [main]")).toBe(false);
    expect(gates("on:\n  schedule:\n    - cron: '0 3 * * *'")).toBe(false);
    expect(gates("on:\n  push:\n    tags: ['v*']")).toBe(false);
  });
});

describe("gateJobs", () => {
  /** @param {string} yaml */
  const jobs = (yaml) => gateJobs(parse(yaml));

  it("returns each job's run steps with its name", () => {
    const found = jobs(`
jobs:
  check:
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`);
    expect(found).toHaveLength(1);
    expect(found[0].jobName).toBe("check");
    expect(found[0].steps.map((s) => s.run)).toEqual(["", "npm test"]);
  });

  // The canonical way a maintainer de-fangs an advisory scan. A step that
  // cannot turn the run red cannot block a merge, and telling someone to move
  // a step they already neutralised is the tool crying wolf.
  it("skips a step marked continue-on-error", () => {
    const found = jobs(`
jobs:
  check:
    steps:
      - run: npm audit
        continue-on-error: true
      - run: npm test
`);
    expect(found[0].steps.map((s) => s.run)).toEqual(["npm test"]);
  });

  it("skips an entire job marked continue-on-error", () => {
    const found = jobs(`
jobs:
  advisory:
    continue-on-error: true
    steps:
      - run: npm audit
  check:
    steps:
      - run: npm test
`);
    expect(found.map((j) => j.jobName)).toEqual(["check"]);
  });

  // Reported, not skipped: evaluating a GitHub expression is out of scope,
  // and dropping the step would hide a real finding behind a condition
  // nobody read. The flag exists so the evidence can say so.
  it("keeps a step carrying an if:, flagged as unevaluated", () => {
    const found = jobs(`
jobs:
  check:
    steps:
      - run: npm audit
        if: github.event_name == 'schedule'
`);
    expect(found[0].steps[0].unevaluatedIf).toBe(true);
  });

  it("flags every step of a job carrying a job-level if:", () => {
    const found = jobs(`
jobs:
  check:
    if: github.event.pull_request.draft == false
    steps:
      - run: npm audit
`);
    expect(found[0].steps[0].unevaluatedIf).toBe(true);
  });

  it("leaves an unconditional step unflagged", () => {
    const found = jobs(`
jobs:
  check:
    steps:
      - run: npm audit
`);
    expect(found[0].steps[0].unevaluatedIf).toBe(false);
  });

  it("exposes the strategy matrix keys", () => {
    const found = jobs(`
jobs:
  e2e:
    strategy:
      matrix:
        shard: [1, 2]
        node: [20]
    steps:
      - run: npm test
`);
    expect(found[0].matrixKeys.sort()).toEqual(["node", "shard"]);
  });

  it("says the condition was not evaluated rather than guessing its value", () => {
    expect(IF_NOTE).toMatch(/not evaluated/);
  });
});
