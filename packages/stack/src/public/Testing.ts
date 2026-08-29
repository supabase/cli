// oxlint-disable effecttsgo/async-function -- AsyncDisposable is the public test-resource contract.
// oxlint-disable-next-line effecttsgo/node-builtin-import -- test resource owns its exact temp directory.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- test resource builds an isolated root.
import { join } from "node:path";
import {
  createStack,
  type PromiseStack,
  type PromiseStackConfig,
  type PromiseStartStackOptions,
} from "./PromiseStack.ts";
import type { CreateStackOptions } from "./EffectStack.ts";

export interface CreateTestStackOptions {
  readonly config?: PromiseStackConfig;
  readonly name?: string;
  readonly runtime?: CreateStackOptions["runtime"];
}

export type TestStack = PromiseStack & AsyncDisposable;

export interface TestStackOperations {
  readonly createRoot: () => Promise<string>;
  readonly createStack: (options: CreateStackOptions) => Promise<PromiseStack>;
  readonly removeRoot: (root: string) => Promise<void>;
}

const defaultOperations: TestStackOperations = {
  createRoot: () => mkdtemp(join(tmpdir(), "supabase-stack-test-")),
  createStack,
  removeRoot: (root) => rm(root, { recursive: true, force: true }),
};

const waitForReadiness = async (
  stack: PromiseStack,
  initial: Awaited<ReturnType<PromiseStack["status"]>>,
) => {
  const ready = (status: typeof initial) =>
    status.lifecycle === "running" &&
    status.endpoints.api !== undefined &&
    status.capabilities.some(
      (capability) =>
        capability.name === "functions" &&
        (capability.state === "ready" || capability.state === "dormant"),
    );
  if (ready(initial)) return;
  for await (const status of stack.watchStatus()) {
    if (ready(status)) return;
  }
  throw new Error("Stack did not reach running readiness before its status stream ended");
};

const cleanup = async (
  stack: PromiseStack | undefined,
  root: string,
  operations: TestStackOperations,
  primary?: unknown,
) => {
  let failure = primary;
  if (stack !== undefined) {
    try {
      await stack.destroy();
    } catch (error) {
      if (failure === undefined) failure = error;
    }
    try {
      await stack.close();
    } catch (error) {
      if (failure === undefined) failure = error;
    }
  }
  try {
    await operations.removeRoot(root);
  } catch (error) {
    if (failure === undefined) failure = error;
  }
  if (failure !== undefined) throw failure;
};

/** Internal seam used by integration tests; the package testing barrel exports only createTestStack. */
export const createTestStackWith = async (
  options: CreateTestStackOptions = {},
  operations: TestStackOperations = defaultOperations,
): Promise<TestStack> => {
  const projectRoot = await operations.createRoot();
  let stack: PromiseStack | undefined;
  try {
    stack = await operations.createStack({
      projectRoot,
      name: options.name,
      runtime: options.runtime,
    });
    const started = await stack.start(
      options.config === undefined
        ? undefined
        : ({ config: options.config } satisfies PromiseStartStackOptions),
    );
    await waitForReadiness(stack, started);
    const resource = stack;
    return {
      ...resource,
      [Symbol.asyncDispose]: () => cleanup(resource, projectRoot, operations),
    };
  } catch (error) {
    await cleanup(stack, projectRoot, operations, error);
    throw error;
  }
};

/** Creates an isolated managed stack and destroys exactly that identity on disposal. */
export const createTestStack = (options: CreateTestStackOptions = {}): Promise<TestStack> =>
  createTestStackWith(options);
