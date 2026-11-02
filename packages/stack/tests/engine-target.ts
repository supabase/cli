import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { resolveEngineTarget, type EngineTarget } from "../src/runtime/Container.ts";
import { testEngine } from "./test-engine.ts";

export { testEngine };

/**
 * Resolves the selected engine target once per test file, for `it.live` tests that exercise a
 * service catalog or a database against the real engine rather than a fake one.
 */
export const engineTarget: EngineTarget = await Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* resolveEngineTarget(spawner, testEngine);
}).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);
