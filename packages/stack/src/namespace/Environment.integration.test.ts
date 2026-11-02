import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { confine, EnvironmentSymlinkError } from "./Environment.ts";

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

describe("native environment confinement", () => {
  it.live("creates every confined directory under a fresh root", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "environment-confine-" });
        const environment = yield* confine(fs, path, root);
        expect(yield* fs.exists(environment.values.XDG_CACHE_HOME)).toBe(true);
      }),
    ),
  );

  it.live(
    "refuses to confine on restart when a reused component is a symlink planted by the step-down user, and creates nothing outside",
    () =>
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "environment-confine-symlink-",
          });
          // First launch creates the confined layout normally.
          yield* confine(fs, path, root);
          const outside = yield* fs.makeTempDirectoryScoped({
            prefix: "environment-confine-outside-",
          });
          const sentinel = path.join(outside, "sentinel");
          yield* fs.writeFileString(sentinel, "do not create here");
          // After handover, the step-down user that now owns `root` swaps `.cache` for a symlink
          // to outside before the stack restarts.
          const cache = path.join(root, ".cache");
          yield* fs.remove(cache, { recursive: true });
          yield* fs.symlink(outside, cache);
          const failure = yield* confine(fs, path, root).pipe(Effect.flip);
          if (!Schema.is(EnvironmentSymlinkError)(failure))
            return yield* Effect.die(`Expected an EnvironmentSymlinkError, got ${failure}`);
          expect(failure.path).toBe(cache);
          expect(yield* fs.readDirectory(outside)).toEqual(["sentinel"]);
        }),
      ),
  );
});
