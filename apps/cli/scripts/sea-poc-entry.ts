/**
 * PoC entrypoint for Node SEA experiment.
 *
 * Mirrors the shape of `apps/cli/src/shared/cli/run.ts` (Stdio.args + FileSystem),
 * but uses `@effect/platform-node`'s `NodeServices.layer` instead of `BunServices.layer`.
 *
 * The goal is to prove an Effect program — using the same primitives the CLI uses —
 * can be bundled and packaged as a Node Single Executable Application.
 */
import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Stdio } from "effect";

const program = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const fs = yield* FileSystem.FileSystem;

  const args = yield* stdio.args;
  yield* Effect.log(`sea-poc args: ${JSON.stringify(args)}`);

  const cwd = process.cwd();
  const entries = yield* fs.readDirectory(cwd);
  yield* Effect.log(`cwd has ${entries.length} entries (first 3: ${entries.slice(0, 3).join(", ")})`);

  yield* Effect.log("sea-poc ok");
});

// Wrapped in an IIFE because SEA requires CJS output, which forbids top-level await.
void (async () => {
  await Effect.runPromise(program.pipe(Effect.provide(NodeServices.layer)));
})();
