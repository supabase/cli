import { BunPath } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Stream } from "effect";

import { FileWatcher } from "../runtime/file-watcher.service.ts";
import { serveFileWatcherLayer } from "./serve.ts";

describe("serveFileWatcherLayer", () => {
  it.effect("resolves relative events and rechecks rename paths before classifying them", () => {
    const fileSystem = FileSystem.makeNoop({
      watch: () =>
        Stream.fromIterable([
          { _tag: "Create", path: "new.ts" },
          { _tag: "Update", path: "changed.ts" },
          { _tag: "Remove", path: "renamed.ts" },
        ]),
      exists: (path) => Effect.succeed(path === "/project/supabase/functions/renamed.ts"),
    });

    return Effect.gen(function* () {
      const watcher = yield* FileWatcher;
      const chunks = yield* Stream.runCollect(
        watcher.watch("/project/supabase/functions", { recursive: true }),
      );
      const events = chunks.flatMap((chunk) => chunk);

      expect(events).toEqual([
        { path: "/project/supabase/functions/new.ts", type: "delete" },
        { path: "/project/supabase/functions/changed.ts", type: "update" },
        { path: "/project/supabase/functions/renamed.ts", type: "create" },
      ]);
    }).pipe(
      Effect.provide(serveFileWatcherLayer),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provide(Layer.mergeAll(BunPath.layer)),
    );
  });
});
