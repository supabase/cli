import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, PlatformError } from "effect";

import { legacyMakeDir } from "./legacy-make-dir.ts";

const DIR = "/home/user/project/supabase/migrations";

type SystemReason = Parameters<typeof PlatformError.systemError>[0]["_tag"];

/** A FileSystem whose `makeDirectory` always fails with the given system reason. */
function failingFs(reason: SystemReason) {
  const calls: Array<{ readonly path: string; readonly recursive?: boolean }> = [];
  return {
    calls,
    layer: Layer.succeed(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        makeDirectory: (path, opts) =>
          Effect.suspend(() => {
            calls.push({ path, recursive: opts?.recursive });
            return Effect.fail(
              PlatformError.systemError({
                _tag: reason,
                module: "FileSystem",
                method: "makeDirectory",
                description: reason,
                pathOrDescriptor: path,
              }),
            );
          }),
      }),
    ),
  };
}

const run = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* legacyMakeDir(fs, dir);
  });

describe("legacyMakeDir", () => {
  it.effect("creates the directory recursively, matching os.MkdirAll", () => {
    const calls: Array<{ readonly path: string; readonly recursive?: boolean }> = [];
    const layer = Layer.succeed(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        makeDirectory: (path, opts) =>
          Effect.sync(() => {
            calls.push({ path, recursive: opts?.recursive });
          }),
      }),
    );
    return run(DIR).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(calls).toEqual([{ path: DIR, recursive: true }]);
        }),
      ),
      Effect.provide(layer),
    );
  });

  it.effect("treats an already-existing directory as success (CLI-1849)", () => {
    const fs = failingFs("AlreadyExists");
    return run(DIR).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isSuccess(exit)).toBe(true);
          expect(fs.calls).toEqual([{ path: DIR, recursive: true }]);
        }),
      ),
      Effect.provide(fs.layer),
    );
  });

  it.effect("propagates every other filesystem error", () => {
    const fs = failingFs("PermissionDenied");
    return run(DIR).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("PermissionDenied");
          }
        }),
      ),
      Effect.provide(fs.layer),
    );
  });
});
