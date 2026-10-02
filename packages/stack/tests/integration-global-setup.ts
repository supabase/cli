import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem } from "effect";
import type { ProvidedContext } from "vitest";

import "./helpers/integration-provided-context.ts";

type IntegrationSetupContext = {
  provide: <K extends keyof ProvidedContext>(key: K, value: ProvidedContext[K]) => void;
};

/**
 * One state root per suite run, shared by every test that binds real listeners on automatically
 * allocated public ports; a concurrent run from another checkout on the same host uses its own
 * root and is outside the supported one-state-root-per-host topology.
 */
// oxlint-disable-next-line effecttsgo/async-function -- Vitest's globalSetup contract is Promise-based.
export async function setup({ provide }: IntegrationSetupContext): Promise<() => Promise<void>> {
  const root = await Effect.runPromise(
    FileSystem.FileSystem.pipe(
      Effect.flatMap((fs) => fs.makeTempDirectory({ prefix: "supabase-stack-integration-" })),
      Effect.provide(NodeServices.layer),
    ),
  );
  provide("stackStateRoot", `${root}/state`);
  // oxlint-disable-next-line effecttsgo/async-function -- Vitest awaits this teardown function directly.
  return async () => {
    await Effect.runPromise(
      FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.remove(root, { recursive: true, force: true })),
        Effect.provide(NodeServices.layer),
      ),
    );
  };
}

export default setup;
