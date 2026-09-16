import { BunServices } from "@effect/platform-bun";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Option, Path } from "effect";
import { expect } from "vitest";
import { ComputeStacksValidationError, loadComputeStacks } from "./compute-stacks.macro.ts";

function stackFixture(stacks: Readonly<Record<string, Readonly<Record<string, string>>>>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-compute-stacks-" });

    for (const [runtime, files] of Object.entries(stacks)) {
      const runtimePath = path.join(root, runtime);
      yield* fs.makeDirectory(runtimePath, { recursive: true });
      for (const [name, contents] of Object.entries(files)) {
        yield* fs.writeFileString(path.join(runtimePath, name), contents);
      }
    }

    return root;
  });
}

function expectValidationFailure<A, E>(exit: Exit.Exit<A, E>, message: string): void {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isSuccess(exit)) {
    return;
  }

  const failure = Cause.findErrorOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  if (Option.isNone(failure)) {
    return;
  }
  expect(failure.value).toBeInstanceOf(ComputeStacksValidationError);
  if (!(failure.value instanceof ComputeStacksValidationError)) {
    return;
  }
  expect(failure.value.message).toContain(message);
}

it.live("reports offered runtimes without starter directories", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* stackFixture({
        deno: { "main.ts": "export default {};" },
        node: { "index.mjs": "export default {};" },
      });
      const exit = yield* loadComputeStacks(root).pipe(Effect.exit);

      expectValidationFailure(exit, "no starter files for dockerfile");
    }),
  ).pipe(Effect.provide(BunServices.layer)),
);

it.live("reports directories without offered runtimes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* stackFixture({
        deno: { "main.ts": "export default {};" },
        dockerfile: { Dockerfile: "FROM node:22-alpine\n" },
        node: { "index.mjs": "export default {};" },
        unknown: { "main.ts": "export default {};" },
      });
      const exit = yield* loadComputeStacks(root).pipe(Effect.exit);

      expectValidationFailure(exit, "stacks/unknown has no matching entry");
    }),
  ).pipe(Effect.provide(BunServices.layer)),
);

it.live("reports an offered runtime with no starter files", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* stackFixture({
        deno: { "main.ts": "export default {};" },
        dockerfile: { Dockerfile: "FROM node:22-alpine\n" },
        node: {},
      });
      const exit = yield* loadComputeStacks(root).pipe(Effect.exit);

      expectValidationFailure(exit, "stacks/node is empty");
    }),
  ).pipe(Effect.provide(BunServices.layer)),
);
