import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem } from "effect";
import type { ProvidedContext } from "vitest";

import "./helpers/integration-provided-context.ts";
import { removeManagedVolume, runDocker } from "./docker-fixture.ts";

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
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateRoot = `${root}/state`;
        // No Docker fixture can have created the volume this run owns without a reachable daemon.
        const dockerReachable = yield* runDocker(["info"]).pipe(
          Effect.map((result) => result.code === 0),
          Effect.orElseSucceed(() => false),
        );
        if (dockerReachable && (yield* fs.exists(stateRoot)))
          yield* removeManagedVolume(stateRoot).pipe(
            Effect.ensuring(fs.remove(root, { recursive: true, force: true }).pipe(Effect.orDie)),
          );
        else yield* fs.remove(root, { recursive: true, force: true });
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  };
}

export default setup;
