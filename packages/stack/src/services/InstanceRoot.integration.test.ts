import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Exit, FileSystem, Path } from "effect";
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
});
