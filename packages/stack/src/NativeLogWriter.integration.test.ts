// oxlint-disable effecttsgo/node-builtin-import -- Integration coverage uses the real platform filesystem and temporary roots.

import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Context, Effect, Exit, FileSystem, Layer, Scope, Stream } from "effect";
import { LogBuffer } from "@supabase/process-compose";
import { nativeLogRoot, nativeServiceLogPath, startNativeLogWriter } from "./NativeLogWriter.ts";

const withLogBuffer = <A, E>(
  f: (
    logBuffer: LogBuffer["Service"],
    fs: FileSystem.FileSystem,
    root: string,
    sibling: string,
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-native-logs-" });
      const sibling = yield* fs.makeTempDirectoryScoped({
        prefix: "supabase-native-logs-sibling-",
      });
      const scope = yield* Effect.scope;
      const services = yield* Layer.buildWithScope(LogBuffer.layer, scope);
      return yield* f(Context.get(services, LogBuffer), fs, root, sibling);
    }),
  ).pipe(Effect.provide(NodeFileSystem.layer));

describe("native log writer", () => {
  it.live("journals each LogBuffer entry below only its owning runtime root", () =>
    withLogBuffer((logBuffer, fs, root, sibling) =>
      Effect.gen(function* () {
        yield* startNativeLogWriter(logBuffer, root);
        const authPath = nativeServiceLogPath(root, "auth");
        const watchPull = yield* Stream.toPull(fs.watch(nativeLogRoot(root)));

        yield* logBuffer.append("auth", "stdout", "authenticated");
        yield* watchPull;

        const contents = yield* fs.readFileString(authPath);
        const [event] = contents
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(event).toMatchObject({
          service: "auth",
          stream: "stdout",
          message: "authenticated",
        });
        expect(typeof event.timestamp).toBe("number");
        expect(contents).not.toContain("postgres");
        expect(nativeLogRoot(root)).toContain(root);
        expect(yield* fs.exists(nativeLogRoot(sibling))).toBe(false);
      }),
    ),
  );

  it.live("rotates only owned segments and releases handles when its scope closes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectory({ prefix: "supabase-native-logs-" });
        const writerScope = yield* Scope.make("sequential");
        const services = yield* Layer.build(LogBuffer.layer);
        const logBuffer = Context.get(services, LogBuffer);

        yield* startNativeLogWriter(logBuffer, root).pipe(
          Effect.provideService(Scope.Scope, writerScope),
        );
        const watchPull = yield* Stream.toPull(fs.watch(nativeLogRoot(root)));
        const message = "x".repeat(30_000);
        for (let index = 0; index < 8; index += 1) {
          yield* logBuffer.append("auth", "stdout", `${index}:${message}`);
          yield* watchPull;
        }

        const paths = yield* fs.readDirectory(nativeLogRoot(root));
        expect(paths.toSorted()).toEqual(["auth.jsonl", "auth.jsonl.1", "auth.jsonl.2"]);

        yield* Scope.close(writerScope, Exit.void);
        yield* fs.remove(root, { recursive: true, force: true });
        expect(yield* fs.exists(root)).toBe(false);
      }),
    ).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
