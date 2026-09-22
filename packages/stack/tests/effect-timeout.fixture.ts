import { afterAll, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Config, Effect, Option, Path } from "effect";
import { existsSync, watch, writeFileSync } from "node:fs"; // oxlint-disable-line effecttsgo/node-builtin-import -- synchronous watcher subscription and marker writes are the fixture boundary.

const environment = (name: string) => Effect.runSync(Config.option(Config.string(name)));
const marker = environment("SUPABASE_TIMEOUT_MARKER");
const defectMarker = environment("SUPABASE_TIMEOUT_DEFECT_MARKER");
const doubleFailure = environment("SUPABASE_TIMEOUT_DOUBLE_FAILURE");

if (Option.isSome(marker)) {
  const markerPath = marker.value;
  const started = `${markerPath}.started`;
  const release = `${markerPath}.release`;

  it.live(
    "waits for an asynchronous finalizer after Vitest times out",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const path = yield* Path.Path;
          yield* Effect.addFinalizer(() =>
            Effect.callback<void, never>((resume) => {
              const watcher = watch(path.dirname(release), (_event, filename) => {
                if (filename !== path.basename(release)) return;
                watcher.close();
                writeFileSync(markerPath, "released");
                resume(Effect.void);
              });
              writeFileSync(started, "started");
              return Effect.sync(() => watcher.close());
            }),
          );
          return yield* Effect.never;
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    100,
  );

  afterAll(() => {
    writeFileSync(
      `${markerPath}.after-all`,
      existsSync(markerPath) ? "released-present" : "released-missing",
    );
  });
}

if (Option.isSome(defectMarker)) {
  const markerPath = defectMarker.value;
  it.live(
    "retains a cleanup defect after Vitest times out",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => writeFileSync(markerPath, "cleanup-defect-sentinel")).pipe(
              Effect.andThen(Effect.die("cleanup-defect")),
            ),
          );
          return yield* Effect.never;
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    100,
  );
}

if (Option.isSome(doubleFailure)) {
  it.live(
    "retains body and cleanup defects together",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.die("cleanup-defect"));
          return yield* Effect.die("body-defect");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    5_000,
  );
}
