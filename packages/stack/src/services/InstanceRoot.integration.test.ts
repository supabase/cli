import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Data, Effect, Exit, FileSystem, Option, Path, PlatformError } from "effect";
import { ensureOwnedInstanceRoot, type OwnedInstanceRootParams } from "./InstanceRoot.ts";

class TestInstanceRootError extends Data.TaggedError("TestInstanceRootError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

const onError = (operation: string, cause: unknown) =>
  new TestInstanceRootError({ operation, cause });

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

describe("InstanceRoot", () => {
  it.live("lets concurrent first claims of a fresh root all succeed", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parentRoot = yield* fs.makeTempDirectoryScoped({ prefix: "instance-root-race-" });
        const params: OwnedInstanceRootParams = {
          fs,
          path,
          parentRoot,
          stackId: "stack",
          instanceId: "instance",
          ownerFileName: ".supabase-instance-owner.json",
          label: "Instance root",
        };
        const results = yield* Effect.all(
          Array.from({ length: 10 }, () => Effect.exit(ensureOwnedInstanceRoot(params, onError))),
          { concurrency: "unbounded" },
        );
        expect(results.every(Exit.isSuccess)).toBe(true);
        const marker = yield* fs.readFileString(
          path.join(parentRoot, "instance", ".supabase-instance-owner.json"),
        );
        expect(marker).toBe('{"stackId":"stack","instanceId":"instance"}');
      }),
    ),
  );

  it.live("lets exactly one of concurrent conflicting claims of a fresh root win", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parentRoot = yield* fs.makeTempDirectoryScoped({ prefix: "instance-root-conflict-" });
        const ownerFileName = ".supabase-instance-owner.json";
        const paramsFor = (stackId: string): OwnedInstanceRootParams => ({
          fs,
          path,
          parentRoot,
          stackId,
          instanceId: "instance",
          ownerFileName,
          label: "Instance root",
        });
        const stackIds = Array.from({ length: 10 }, (_, i) => `stack-${i}`);
        const results = yield* Effect.all(
          stackIds.map((stackId) =>
            Effect.exit(ensureOwnedInstanceRoot(paramsFor(stackId), onError)),
          ),
          { concurrency: "unbounded" },
        );
        const failures = results.filter(Exit.isFailure);
        expect(results.filter(Exit.isSuccess)).toHaveLength(1);
        expect(failures).toHaveLength(9);
        for (const failure of failures)
          expect(Option.getOrUndefined(Cause.findErrorOption(failure.cause))?.cause).toBe(
            "Instance root belongs to another instance",
          );
        const marker = yield* fs.readFileString(path.join(parentRoot, "instance", ownerFileName));
        expect(
          stackIds.map((stackId) => JSON.stringify({ stackId, instanceId: "instance" })),
        ).toContain(marker);
      }),
    ),
  );

  it.live("ignores an orphaned staging file when claiming a fresh root", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parentRoot = yield* fs.makeTempDirectoryScoped({ prefix: "instance-root-orphan-" });
        const ownerFileName = ".supabase-instance-owner.json";
        const root = path.join(parentRoot, "instance");
        yield* fs.makeDirectory(root, { recursive: true });
        yield* fs.writeFileString(path.join(root, `.${ownerFileName}.orphan.tmp`), "leftover");
        const params: OwnedInstanceRootParams = {
          fs,
          path,
          parentRoot,
          stackId: "stack",
          instanceId: "instance",
          ownerFileName,
          label: "Instance root",
        };
        yield* ensureOwnedInstanceRoot(params, onError);
        const marker = yield* fs.readFileString(path.join(root, ownerFileName));
        expect(marker).toBe('{"stackId":"stack","instanceId":"instance"}');
      }),
    ),
  );

  it.live("falls back to an exclusive create when hard links are unsupported", () =>
    run(
      Effect.gen(function* () {
        const realFs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parentRoot = yield* realFs.makeTempDirectoryScoped({
          prefix: "instance-root-fallback-",
        });
        const ownerFileName = ".supabase-instance-owner.json";
        const fs: FileSystem.FileSystem = {
          ...realFs,
          link: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method: "link",
                description: "injected unsupported-link failure",
                cause: Object.assign(new Error("Operation not supported"), { code: "EPERM" }),
              }),
            ),
        };
        const params: OwnedInstanceRootParams = {
          fs,
          path,
          parentRoot,
          stackId: "stack",
          instanceId: "instance",
          ownerFileName,
          label: "Instance root",
        };
        yield* ensureOwnedInstanceRoot(params, onError);
        const root = path.join(parentRoot, "instance");
        const marker = yield* realFs.readFileString(path.join(root, ownerFileName));
        expect(marker).toBe('{"stackId":"stack","instanceId":"instance"}');
        expect(yield* realFs.readDirectory(root)).toEqual([ownerFileName]);
      }),
    ),
  );
});
