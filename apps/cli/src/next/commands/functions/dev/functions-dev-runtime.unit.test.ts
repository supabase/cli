import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Queue, Stream } from "effect";
import { join } from "node:path";
import {
  FileWatcher,
  type FileWatchEvent,
} from "../../../../shared/runtime/file-watcher.service.ts";
import { watchPaths } from "./functions-dev-runtime.ts";

function makeFakeFileWatcher() {
  return Effect.gen(function* () {
    const watchedPaths = yield* Queue.unbounded<string>();
    const queues = new Map<string, Queue.Queue<ReadonlyArray<FileWatchEvent>>>();

    const layer = Layer.succeed(
      FileWatcher,
      FileWatcher.of({
        watch: (path) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const queue = yield* Queue.unbounded<ReadonlyArray<FileWatchEvent>>();
              queues.set(path, queue);
              yield* Queue.offer(watchedPaths, path);
              return Stream.fromQueue(queue);
            }),
          ),
      }),
    );

    const awaitWatch = (expectedPath: string) =>
      Queue.take(watchedPaths).pipe(
        Effect.tap((path) =>
          Effect.sync(() => {
            expect(path).toBe(expectedPath);
          }),
        ),
      );

    const emit = (path: string, events: ReadonlyArray<FileWatchEvent>) =>
      Effect.gen(function* () {
        const queue = queues.get(path);
        if (queue === undefined) {
          return yield* Effect.die(new Error(`No watcher registered for ${path}`));
        }
        yield* Queue.offer(queue, events);
      });

    return { awaitWatch, emit, layer };
  });
}

describe("functions dev runtime", () => {
  it.live("emits when the supabase functions directory appears after dev starts", () => {
    const cwd = "/tmp/supabase-functions-dev-watch";

    return Effect.gen(function* () {
      const watcher = yield* makeFakeFileWatcher();
      let emitted = false;

      const fiber = yield* watchPaths([{ path: cwd, names: ["supabase"] }]).pipe(
        Stream.take(1),
        Stream.runForEach(() =>
          Effect.sync(() => {
            emitted = true;
          }),
        ),
        Effect.timeout(Duration.seconds(1)),
        Effect.provide(watcher.layer),
        Effect.forkChild({ startImmediately: true }),
      );

      yield* watcher.awaitWatch(cwd);
      yield* watcher.emit(cwd, [{ path: join(cwd, "supabase", "functions"), type: "create" }]);
      yield* Fiber.join(fiber);

      expect(emitted).toBe(true);
    });
  });

  it.live("marks config json changes as project config changes", () => {
    const cwd = "/tmp/supabase-functions-dev-watch";
    const supabaseDir = join(cwd, "supabase");

    return Effect.gen(function* () {
      const watcher = yield* makeFakeFileWatcher();

      const fiber = yield* watchPaths([
        { path: supabaseDir, names: ["functions", "config.toml", "config.json"] },
      ]).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.timeout(Duration.seconds(1)),
        Effect.provide(watcher.layer),
        Effect.forkChild({ startImmediately: true }),
      );

      yield* watcher.awaitWatch(supabaseDir);
      yield* watcher.emit(supabaseDir, [
        { path: join(supabaseDir, "config.json"), type: "create" },
      ]);
      const changes = yield* Fiber.join(fiber);

      expect(changes.at(0)?.touchesProjectConfig).toBe(true);
    });
  });
});
