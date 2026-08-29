// oxlint-disable effecttsgo/async-function -- AsyncDisposable is the public test-resource contract.
// oxlint-disable-next-line effecttsgo/node-builtin-import -- test resource owns its exact temp directory.
import { rm } from "node:fs/promises";
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

/** Creates an isolated managed stack and destroys exactly that identity on disposal. */
export const createTestStack = async (options: CreateTestStackOptions = {}): Promise<TestStack> => {
  const projectRoot = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "supabase-stack-test-")),
  );
  let stack: PromiseStack | undefined;
  try {
    stack = await createStack({ projectRoot, name: options.name, runtime: options.runtime });
    const started = await stack.start(
      options.config === undefined
        ? undefined
        : ({ config: options.config } satisfies PromiseStartStackOptions),
    );
    if (started.lifecycle !== "running") {
      for await (const status of stack.watchStatus()) {
        if (status.lifecycle === "running") break;
      }
    }
    const resource = stack;
    return {
      ...resource,
      [Symbol.asyncDispose]: async () => {
        try {
          await resource.destroy();
        } finally {
          await resource.close();
          await rm(projectRoot, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    if (stack !== undefined) {
      try {
        await stack.destroy();
      } catch {
        // Preserve the startup failure while making a best-effort exact cleanup.
      }
      await stack.close().catch(() => undefined);
    }
    await rm(projectRoot, { recursive: true, force: true });
    throw error;
  }
};
