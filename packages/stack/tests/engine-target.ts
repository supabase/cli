import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { resolveEngineTarget, type EngineTarget } from "../src/runtime/Container.ts";

/**
 * Resolves the real docker engine target once per test file, for `it.live` tests that exercise a
 * service catalog or a database against the real daemon rather than a fake one.
 */
export const dockerEngineTarget: EngineTarget = await Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* resolveEngineTarget(spawner);
}).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);
