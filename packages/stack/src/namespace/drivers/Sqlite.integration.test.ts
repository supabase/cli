import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Scope } from "effect";
import { acquireLock, isBusy, takeLock } from "./Sqlite.ts";

const lockHolder = (lockPath: string, mode: "create" | "existing") =>
  acquireLock(lockPath, mode).pipe(Effect.flatMap(takeLock));

describe("SQLite lock driver", () => {
  it.live("two holders in one process exclude each other until the first releases", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-lock-" });
        const lockPath = `${directory}/holder.lock`;

        const firstScope = yield* Scope.make();
        yield* lockHolder(lockPath, "create").pipe(Scope.provide(firstScope));

        const refused = yield* Effect.scoped(lockHolder(lockPath, "existing")).pipe(Effect.flip);
        expect(isBusy(refused)).toBe(true);

        yield* Scope.close(firstScope, Exit.void);
        yield* Effect.scoped(lockHolder(lockPath, "existing"));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
