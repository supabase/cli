// oxlint-disable effecttsgo/node-builtin-import, effecttsgo/prefer-schema-over-json -- Integration coverage uses the real platform filesystem and inspects JSONL journal records.

import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import {
  Cause,
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  PlatformError,
  Pull,
  Scope,
  Stream,
} from "effect";
import { LogBuffer } from "@supabase/process-compose";
import { join } from "node:path";
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

const awaitDirectoryState = (
  fs: FileSystem.FileSystem,
  root: string,
  expected: Readonly<Record<string, string | ((content: string) => boolean)>>,
): Effect.Effect<void, PlatformError.PlatformError | Cause.TimeoutError, Scope.Scope> =>
  Effect.gen(function* () {
    const pull = yield* Stream.toPull(fs.watch(root));
    const expectedNames = Object.keys(expected).toSorted();
    while (true) {
      const names = (yield* fs.readDirectory(root)).toSorted();
      if (
        names.length === expectedNames.length &&
        names.every((name, index) => name === expectedNames[index])
      ) {
        const contents = yield* Effect.forEach(expectedNames, (name) =>
          fs.readFileString(join(root, name)).pipe(Effect.orElseSucceed(() => undefined)),
        );
        if (
          contents.every((content, index) => {
            if (content === undefined) return false;
            const name = expectedNames[index];
            if (name === undefined) return false;
            const expectedContent = expected[name];
            return typeof expectedContent === "function"
              ? expectedContent(content)
              : content === expectedContent;
          })
        ) {
          return;
        }
      }
      yield* pull.pipe(Pull.catchDone(() => Effect.never));
    }
  }).pipe(Effect.timeout(Duration.seconds(5)));

const flakyWriteFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.map(FileSystem.FileSystem, (base) => {
    let failNextOpen = true;
    return {
      ...base,
      open: (path: string, options?: Parameters<typeof base.open>[1]) =>
        failNextOpen
          ? Effect.sync(() => {
              failNextOpen = false;
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  PlatformError.systemError({
                    _tag: "Unknown",
                    module: "test",
                    method: "open",
                    description: "injected transient open failure",
                  }),
                ),
              ),
            )
          : base.open(path, options),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeFileSystem.layer));

const flakyRenameFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.map(FileSystem.FileSystem, (base) => {
    let failNextRename = true;
    return {
      ...base,
      rename: (from: string, to: string) =>
        failNextRename
          ? Effect.sync(() => {
              failNextRename = false;
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  PlatformError.systemError({
                    _tag: "Unknown",
                    module: "test",
                    method: "rename",
                    description: "injected transient rename failure",
                  }),
                ),
              ),
            )
          : base.rename(from, to),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeFileSystem.layer));

describe("native log writer", () => {
  it.live("journals each LogBuffer entry below only its owning runtime root", () =>
    withLogBuffer((logBuffer, fs, root, sibling) =>
      Effect.gen(function* () {
        yield* startNativeLogWriter(logBuffer, root);
        const authPath = nativeServiceLogPath(root, "auth");

        yield* logBuffer.append("auth", "stdout", "authenticated");
        yield* awaitDirectoryState(fs, nativeLogRoot(root), {
          ["auth.jsonl"]: (content) => content.includes('"message":"authenticated"'),
        });

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
        const logRoot = nativeLogRoot(root);
        yield* fs.makeDirectory(logRoot, { recursive: true });
        const sentinelPath = join(logRoot, "unrelated.sentinel");
        yield* fs.writeFileString(sentinelPath, "keep");
        const writerScope = yield* Scope.make("sequential");
        const services = yield* Layer.build(LogBuffer.layer);
        const logBuffer = Context.get(services, LogBuffer);

        yield* startNativeLogWriter(logBuffer, root).pipe(
          Effect.provideService(Scope.Scope, writerScope),
        );
        const message = "x".repeat(30_000);
        for (let index = 0; index < 8; index += 1) {
          yield* logBuffer.append("auth", "stdout", `${index}:${message}`);
          const names =
            index < 2
              ? ["unrelated.sentinel", "auth.jsonl"]
              : index < 4
                ? ["unrelated.sentinel", "auth.jsonl", "auth.jsonl.1"]
                : ["unrelated.sentinel", "auth.jsonl", "auth.jsonl.1", "auth.jsonl.2"];
          yield* awaitDirectoryState(
            fs,
            nativeLogRoot(root),
            Object.fromEntries(
              names.map((name) => [
                name,
                name === "unrelated.sentinel"
                  ? "keep"
                  : name === "auth.jsonl"
                    ? (content: string) => content.includes(`"message":"${index}:${message}"`)
                    : (content: string) => content.split("\n").filter(Boolean).length >= 1,
              ]),
            ),
          );
        }

        const paths = yield* fs.readDirectory(nativeLogRoot(root));
        expect(paths.toSorted()).toEqual([
          "auth.jsonl",
          "auth.jsonl.1",
          "auth.jsonl.2",
          "unrelated.sentinel",
        ]);
        for (const path of paths) {
          if (path === "unrelated.sentinel") continue;
          const contents = yield* fs.readFileString(join(nativeLogRoot(root), path));
          const lines = contents.trim().split("\n").filter(Boolean);
          expect(lines.length).toBeLessThanOrEqual(1_000);
          expect(new TextEncoder().encode(contents).byteLength).toBeLessThanOrEqual(64 * 1024);
          for (const line of lines) {
            expect(JSON.parse(line)).toMatchObject({ service: "auth", stream: "stdout" });
          }
        }
        expect(yield* fs.readFileString(sentinelPath)).toBe("keep");

        yield* Scope.close(writerScope, Exit.void);
        const beforeCloseAppend = yield* fs.readFileString(nativeServiceLogPath(root, "auth"));
        yield* logBuffer.append("auth", "stdout", "after-close");
        expect(yield* fs.readFileString(nativeServiceLogPath(root, "auth"))).toBe(
          beforeCloseAppend,
        );
        yield* fs.rename(
          nativeServiceLogPath(root, "auth"),
          nativeServiceLogPath(root, "auth") + ".closed",
        );
        yield* fs.remove(root, { recursive: true, force: true });
        expect(yield* fs.exists(root)).toBe(false);
      }),
    ).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.live("keeps arbitrary service names inside the owning log root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-native-logs-" });
        const services = yield* Layer.build(LogBuffer.layer);
        const logBuffer = Context.get(services, LogBuffer);
        yield* startNativeLogWriter(logBuffer, root);

        const malicious = "../escaped-service";
        yield* logBuffer.append(malicious, "stderr", "contained");
        yield* awaitDirectoryState(fs, nativeLogRoot(root), {
          [`${encodeURIComponent(malicious)}.jsonl`]: (content) =>
            content.includes('"message":"contained"'),
        });
        expect(yield* fs.exists(join(root, "escaped-service.jsonl"))).toBe(false);
      }),
    ).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.live("retries a transient journal write without losing the event", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-native-logs-" });
        const services = yield* Layer.build(LogBuffer.layer);
        const logBuffer = Context.get(services, LogBuffer);
        yield* startNativeLogWriter(logBuffer, root);
        yield* logBuffer.append("auth", "stdout", "recovered");
        yield* awaitDirectoryState(fs, nativeLogRoot(root), {
          ["auth.jsonl"]: (content) => content.includes('"message":"recovered"'),
        });
      }),
    ).pipe(Effect.provide(flakyWriteFileSystemLayer)),
  );

  it.live("recovers rotation after one rename failure and continues journaling", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-native-logs-" });
        const services = yield* Layer.build(LogBuffer.layer);
        const logBuffer = Context.get(services, LogBuffer);
        const writerScope = yield* Scope.make("sequential");
        yield* startNativeLogWriter(logBuffer, root).pipe(
          Effect.provideService(Scope.Scope, writerScope),
        );
        const message = "r".repeat(30_000);

        for (let index = 0; index < 4; index += 1) {
          yield* logBuffer.append("auth", "stdout", `${index}:${message}`);
          yield* awaitDirectoryState(fs, nativeLogRoot(root), {
            ["auth.jsonl"]: (content) => content.includes(`"message":"${index}:${message}"`),
            ...(index >= 2
              ? {
                  ["auth.jsonl.1"]: (content: string) => content.length > 0,
                }
              : {}),
          });
        }

        const paths = yield* fs.readDirectory(nativeLogRoot(root));
        expect(paths.toSorted()).toEqual(["auth.jsonl", "auth.jsonl.1"]);
        const records = [];
        for (const path of paths) {
          const contents = yield* fs.readFileString(join(nativeLogRoot(root), path));
          expect(new TextEncoder().encode(contents).byteLength).toBeLessThanOrEqual(64 * 1024);
          expect(contents.split("\n").filter(Boolean).length).toBeLessThanOrEqual(1_000);
          records.push(
            ...contents
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line)),
          );
        }
        expect(records.filter((record) => record.service === "auth")).toHaveLength(4);
        for (let index = 0; index < 4; index += 1) {
          expect(records.filter((record) => record.message === `${index}:${message}`)).toHaveLength(
            1,
          );
        }
        yield* Scope.close(writerScope, Exit.void);
        const activePath = nativeServiceLogPath(root, "auth");
        const beforeCloseAppend = yield* fs.readFileString(activePath);
        yield* logBuffer.append("auth", "stdout", "after-close");
        expect(yield* fs.readFileString(activePath)).toBe(beforeCloseAppend);
        yield* fs.rename(activePath, `${activePath}.closed`);
      }),
    ).pipe(Effect.provide(flakyRenameFileSystemLayer)),
  );

  it.live("rotates active journals on restart and bounds oversized records", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-native-logs-" });
        const logRoot = nativeLogRoot(root);
        yield* fs.makeDirectory(logRoot, { recursive: true });
        const authPath = nativeServiceLogPath(root, "auth");
        const seededLines = Array.from({ length: 850 }, (_, index) =>
          JSON.stringify({
            timestamp: index,
            service: "auth",
            stream: "stdout",
            message: `seed-${index}`,
          }),
        ).join("\n");
        const seeded = `${seededLines}\n`;
        yield* fs.writeFileString(authPath, seeded);

        const writerScope = yield* Scope.make("sequential");
        const services = yield* Layer.build(LogBuffer.layer);
        const logBuffer = Context.get(services, LogBuffer);
        yield* startNativeLogWriter(logBuffer, root).pipe(
          Effect.provideService(Scope.Scope, writerScope),
        );
        yield* awaitDirectoryState(fs, logRoot, {
          ["auth.jsonl.1"]: seeded,
        });

        for (let index = 0; index < 151; index += 1) {
          yield* logBuffer.append("auth", "stdout", `after-restart-${index}`);
        }
        yield* logBuffer.append("postgres", "stderr", "😀".repeat(100_000));
        yield* awaitDirectoryState(fs, logRoot, {
          ["auth.jsonl"]: (content) => content.includes('"message":"after-restart-150"'),
          ["auth.jsonl.1"]: seeded,
          ["postgres.jsonl"]: (content) => content.includes('"service":"postgres"'),
        });

        const rotated = yield* fs.readFileString(join(logRoot, "auth.jsonl.1"));
        expect(rotated.split("\n").filter(Boolean)).toHaveLength(850);
        expect(new TextEncoder().encode(rotated).byteLength).toBeLessThanOrEqual(64 * 1024);
        const active = yield* fs.readFileString(authPath);
        expect(active.split("\n").filter(Boolean)).toHaveLength(151);
        expect(
          active
            .split("\n")
            .filter(Boolean)
            .every((line) => line.includes('"service":"auth"')),
        ).toBe(true);
        const oversized = yield* fs.readFileString(join(logRoot, "postgres.jsonl"));
        expect(new TextEncoder().encode(oversized).byteLength).toBeLessThanOrEqual(64 * 1024);
        const oversizedEvent = JSON.parse(oversized.trim());
        expect(oversizedEvent).toMatchObject({ service: "postgres", stream: "stderr" });
        expect(oversizedEvent.message).not.toHaveLength(100_000);

        yield* Scope.close(writerScope, Exit.void);
      }),
    ).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.live("keeps concurrent real buffers isolated to their distinct runtime roots", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const firstRoot = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-native-logs-a-" });
        const secondRoot = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-native-logs-b-" });
        const firstServices = yield* Layer.build(LogBuffer.layer);
        const secondServices = yield* Layer.build(LogBuffer.layer);
        const firstBuffer = Context.get(firstServices, LogBuffer);
        const secondBuffer = Context.get(secondServices, LogBuffer);
        yield* startNativeLogWriter(firstBuffer, firstRoot);
        yield* startNativeLogWriter(secondBuffer, secondRoot);

        yield* firstBuffer.append("auth", "stdout", "first-stack");
        yield* secondBuffer.append("auth", "stdout", "second-stack");
        yield* awaitDirectoryState(fs, nativeLogRoot(firstRoot), {
          ["auth.jsonl"]: (content) => content.includes('"message":"first-stack"'),
        });
        yield* awaitDirectoryState(fs, nativeLogRoot(secondRoot), {
          ["auth.jsonl"]: (content) => content.includes('"message":"second-stack"'),
        });

        expect(yield* fs.readFileString(nativeServiceLogPath(firstRoot, "auth"))).not.toContain(
          "second-stack",
        );
        expect(yield* fs.readFileString(nativeServiceLogPath(secondRoot, "auth"))).not.toContain(
          "first-stack",
        );
      }),
    ).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
