import { describe, expect, test } from "vitest";
import { WORKER_RUNTIMES } from "./worker-runtimes.ts";
import {
  assertCompleteWorkerStacks,
  workerStacks,
  WorkerStacksUnavailableError,
} from "./worker-stacks.ts";

const complete = () =>
  Object.fromEntries(WORKER_RUNTIMES.map((runtime) => [runtime, { "index.mjs": "// code\n" }]));

describe("assertCompleteWorkerStacks", () => {
  test("accepts a stack for every offered runtime", () => {
    expect(() => assertCompleteWorkerStacks(complete())).not.toThrow();
  });

  // The build define is produced from this check, so each of these is a release
  // that would otherwise scaffold nothing while dev and CI stayed green.
  test("refuses an offered runtime with no starter files", () => {
    const stacks = complete();
    delete stacks[WORKER_RUNTIMES[0]];

    expect(() => assertCompleteWorkerStacks(stacks)).toThrow(WorkerStacksUnavailableError);
    expect(() => assertCompleteWorkerStacks(stacks)).toThrow(WORKER_RUNTIMES[0]);
  });

  test("refuses a stack directory no runtime offers", () => {
    expect(() => assertCompleteWorkerStacks({ ...complete(), rust: { "main.rs": "" } })).toThrow(
      /stacks\/rust/,
    );
  });

  test("refuses an empty stack directory", () => {
    expect(() => assertCompleteWorkerStacks({ ...complete(), node: {} })).toThrow(/is empty/);
  });
});

describe("workerStacks", () => {
  // Running from source, so this reads `./stacks/` — the same content the build
  // define is made from.
  test("reads a non-empty stack for every offered runtime", () => {
    const stacks = workerStacks();

    for (const runtime of WORKER_RUNTIMES) {
      const files = Object.entries(stacks[runtime]);
      expect(files.length).toBeGreaterThan(0);
      for (const [name, contents] of files) {
        expect(name).not.toMatch(/^README\.md$/);
        expect(contents.length).toBeGreaterThan(0);
      }
    }
  });

  test("does not read the directory's own README as a runtime", () => {
    expect(Object.keys(workerStacks())).toEqual([...WORKER_RUNTIMES].sort());
  });
});
