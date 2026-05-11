import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Duration, Effect, Layer, Stream } from "effect";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parcelFileWatcherLayer } from "../../../../shared/runtime/parcel-file-watcher.layer.ts";
import { watchPaths } from "./functions-dev-runtime.ts";

function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), "supabase-functions-dev-watch-"));
}

describe("functions dev runtime", () => {
  it.live("emits when the supabase functions directory appears after dev starts", () => {
    const cwd = makeTempProject();

    return Effect.gen(function* () {
      let emitted = false;

      yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* Effect.sleep(Duration.millis(50));
          yield* Effect.tryPromise(() =>
            mkdir(join(cwd, "supabase", "functions"), { recursive: true }),
          );
        }),
      );

      yield* watchPaths([{ path: cwd, names: ["supabase"] }]).pipe(
        Stream.take(1),
        Stream.runForEach(() =>
          Effect.sync(() => {
            emitted = true;
          }),
        ),
        Effect.timeout(Duration.seconds(5)),
      );

      expect(emitted).toBe(true);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(cwd, { recursive: true, force: true }))),
      Effect.provide(Layer.mergeAll(BunServices.layer, parcelFileWatcherLayer)),
    );
  });

  it.live("marks config json changes as project config changes", () => {
    const cwd = makeTempProject();

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(cwd, "supabase"), { recursive: true }));

      yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* Effect.sleep(Duration.millis(50));
          yield* Effect.tryPromise(() =>
            writeFile(join(cwd, "supabase", "config.json"), JSON.stringify({ functions: {} })),
          );
        }),
      );

      const changes = yield* watchPaths([
        { path: join(cwd, "supabase"), names: ["functions", "config.toml", "config.json"] },
      ]).pipe(Stream.take(1), Stream.runCollect, Effect.timeout(Duration.seconds(5)));

      expect(changes.at(0)?.touchesProjectConfig).toBe(true);
    }).pipe(
      Effect.ensuring(Effect.tryPromise(() => rm(cwd, { recursive: true, force: true }))),
      Effect.provide(Layer.mergeAll(BunServices.layer, parcelFileWatcherLayer)),
    );
  });
});
