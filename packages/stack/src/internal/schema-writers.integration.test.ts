import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, FileSystem, Path, Scope } from "effect";
import { TestClock } from "effect/testing";
import { holdSchemaWriter, type SchemaWriterService } from "./schema-writers.ts";

const databaseRoot = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "schema-writers-" });
});

const selecting = (instanceRoot: string, service: SchemaWriterService, version: string) => ({
  stackId: "schema-writers-test",
  instanceRoot,
  service,
  version,
});

it.effect("holds one writer per service and database until its migration ends", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const instanceRoot = yield* databaseRoot;
    const first = yield* Scope.make();
    yield* holdSchemaWriter(fs, path, selecting(instanceRoot, "auth", "v2.197.0")).pipe(
      Scope.provide(first),
    );

    yield* holdSchemaWriter(fs, path, selecting(instanceRoot, "storage", "v1.0.0")).pipe(
      Effect.scoped,
    );
    const waiting = yield* holdSchemaWriter(
      fs,
      path,
      selecting(instanceRoot, "auth", "v2.197.0"),
    ).pipe(Effect.scoped, Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("61 seconds");
    expect((yield* Fiber.join(waiting)).message).toContain("locked by another operation");

    yield* Scope.close(first, Exit.void);
    yield* holdSchemaWriter(fs, path, selecting(instanceRoot, "auth", "v2.197.0")).pipe(
      Effect.scoped,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
