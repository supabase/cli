// oxlint-disable effecttsgo/node-builtin-import, effecttsgo/prefer-schema-over-json -- Integration coverage uses the real platform filesystem and inspects JSONL journal records.

import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Layer,
  PlatformError,
  PubSub,
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
    signal: PubSub.PubSub<string>,
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const signal = yield* PubSub.unbounded<string>();
      const fs = yield* FileSystem.FileSystem.pipe(Effect.provide(journalFileSystemLayer(signal)));
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-native-logs-" });
      const sibling = yield* fs.makeTempDirectoryScoped({
        prefix: "supabase-native-logs-sibling-",
      });
      const scope = yield* Effect.scope;
      const services = yield* Layer.buildWithScope(LogBuffer.layer, scope);
      return yield* f(Context.get(services, LogBuffer), fs, root, sibling, signal);
    }),
  ).pipe(Effect.provide(NodeFileSystem.layer));

const awaitDirectoryState = <E = never>(
  fs: FileSystem.FileSystem,
  root: string,
  expected: Readonly<Record<string, string | ((content: string) => boolean)>>,
  trigger: Effect.Effect<void, E> = Effect.void,
  signal?: PubSub.PubSub<string>,
  ready?: Deferred.Deferred<void>,
): Effect.Effect<void, PlatformError.PlatformError | Cause.TimeoutError | E, Scope.Scope> =>
  Effect.gen(function* () {
    const subscription = signal === undefined ? undefined : yield* PubSub.subscribe(signal);
    if (ready !== undefined) yield* Deferred.succeed(ready, undefined);
    yield* trigger;
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
      if (subscription === undefined) return yield* Effect.never;
      const changedPath = yield* PubSub.take(subscription);
      if (!changedPath.startsWith(`${root}/`)) continue;
    }
  }).pipe(Effect.timeout(Duration.seconds(5)));

const journalFileSystemLayer = (
  signal: PubSub.PubSub<string>,
  base: Layer.Layer<FileSystem.FileSystem, never, never> = NodeFileSystem.layer,
) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.map(
      FileSystem.FileSystem,
      (fileSystem) =>
        ({
          ...fileSystem,
          open: (path: string, options?: Parameters<typeof fileSystem.open>[1]) =>
            fileSystem.open(path, options).pipe(
              Effect.map(
                (file) =>
                  ({
                    [FileSystem.FileTypeId]: file[FileSystem.FileTypeId],
                    get stat() {
                      return file.stat;
                    },
                    seek: (offset, from) => file.seek(offset, from),
                    get sync() {
                      return file.sync;
                    },
                    read: (buffer) => file.read(buffer),
                    readAlloc: (size) => file.readAlloc(size),
                    truncate: (length) => file.truncate(length),
                    write: (buffer) => file.write(buffer),
                    writeAll: (buffer) =>
                      file.writeAll(buffer).pipe(Effect.tap(() => PubSub.publish(signal, path))),
                  }) satisfies FileSystem.File,
              ),
            ),
        }) satisfies FileSystem.FileSystem,
    ),
  ).pipe(Layer.provide(base));

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

const persistentWriteFailureFileSystem = (
  gates: Partial<{
    readonly authWriteStarted: Deferred.Deferred<void>;
    readonly authFailureDone: Deferred.Deferred<void>;
    readonly postgresWritten: Deferred.Deferred<void>;
    readonly releaseAuth: Deferred.Deferred<void>;
  }> = {},
) => {
  let failingAuthWrites = true;
  let authOpens = 0;
  let authFailures = 0;
  const layer = Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (base) => {
      return {
        ...base,
        open: (path: string, options?: Parameters<typeof base.open>[1]) =>
          base.open(path, options).pipe(
            Effect.map((file) => {
              if (path.endsWith("auth.jsonl")) authOpens += 1;
              return {
                [FileSystem.FileTypeId]: file[FileSystem.FileTypeId],
                get stat() {
                  return file.stat;
                },
                seek: (offset, from) => file.seek(offset, from),
                get sync() {
                  return file.sync;
                },
                read: (buffer) => file.read(buffer),
                readAlloc: (size) => file.readAlloc(size),
                truncate: (length) => file.truncate(length),
                write: (buffer) => file.write(buffer),
                writeAll: (buffer) =>
                  path.endsWith("auth.jsonl") && failingAuthWrites
                    ? (gates.authWriteStarted === undefined
                        ? Effect.void
                        : Deferred.succeed(gates.authWriteStarted, undefined).pipe(Effect.asVoid)
                      ).pipe(
                        Effect.andThen(
                          gates.releaseAuth === undefined
                            ? Effect.void
                            : Deferred.await(gates.releaseAuth),
                        ),
                        Effect.andThen(
                          Effect.fail(
                            PlatformError.systemError({
                              _tag: "Unknown",
                              module: "test",
                              method: "writeAll",
                              description: "injected persistent write failure",
                            }),
                          ),
                        ),
                        Effect.tapError(() =>
                          Effect.sync(() => (authFailures += 1)).pipe(
                            Effect.flatMap((count) =>
                              count >= 4 && gates.authFailureDone !== undefined
                                ? Deferred.succeed(gates.authFailureDone, undefined).pipe(
                                    Effect.asVoid,
                                  )
                                : Effect.void,
                            ),
                          ),
                        ),
                      )
                    : file
                        .writeAll(buffer)
                        .pipe(
                          Effect.tap(() =>
                            gates.postgresWritten === undefined
                              ? Effect.void
                              : Deferred.succeed(gates.postgresWritten, undefined),
                          ),
                        ),
              } satisfies FileSystem.File;
            }),
          ),
      } satisfies FileSystem.FileSystem;
    }),
  ).pipe(Layer.provide(NodeFileSystem.layer));
  return {
    layer,
    recover: () => {
      failingAuthWrites = false;
    },
    get authOpens() {
      return authOpens;
    },
    get authFailures() {
      return authFailures;
    },
  };
};

describe("native log writer", () => {
  it.live("journals each LogBuffer entry below only its owning runtime root", () =>
    withLogBuffer((logBuffer, fs, root, sibling, signal) =>
      Effect.gen(function* () {
        yield* startNativeLogWriter(logBuffer, root).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
        );
        const authPath = nativeServiceLogPath(root, "auth");

        yield* awaitDirectoryState(
          fs,
          nativeLogRoot(root),
          {
            ["auth.jsonl"]: (content) => content.includes('"message":"authenticated"'),
          },
          logBuffer.append("auth", "stdout", "authenticated"),
          signal,
        );

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
        expect(yield* fs.exists(nativeServiceLogPath(root, "postgres"))).toBe(false);
        expect(nativeLogRoot(root)).toContain(root);
        expect(yield* fs.exists(nativeLogRoot(sibling))).toBe(false);
      }),
    ),
  );

  it.live("rotates only owned segments and releases handles when its scope closes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const signal = yield* PubSub.unbounded<string>();
        const fs = yield* FileSystem.FileSystem.pipe(
          Effect.provide(journalFileSystemLayer(signal)),
        );
        const root = yield* fs.makeTempDirectory({ prefix: "supabase-native-logs-" });
        const logRoot = nativeLogRoot(root);
        yield* fs.makeDirectory(logRoot, { recursive: true });
        const sentinelPath = join(logRoot, "unrelated.sentinel");
        yield* fs.writeFileString(sentinelPath, "keep");
        const writerScope = yield* Scope.make("sequential");
        const services = yield* Layer.build(LogBuffer.layer);
        const logBuffer = Context.get(services, LogBuffer);

        yield* startNativeLogWriter(logBuffer, root).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Scope.Scope, writerScope),
        );
        const message = "x".repeat(30_000);
        for (let index = 0; index < 8; index += 1) {
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
            logBuffer.append("auth", "stdout", `${index}:${message}`),
            signal,
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
        const signal = yield* PubSub.unbounded<string>();
        const fs = yield* FileSystem.FileSystem.pipe(
          Effect.provide(journalFileSystemLayer(signal)),
        );
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-native-logs-" });
        const services = yield* Layer.build(LogBuffer.layer);
        const logBuffer = Context.get(services, LogBuffer);
        yield* startNativeLogWriter(logBuffer, root).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
        );

        const malicious = "../escaped-service";
        yield* awaitDirectoryState(
          fs,
          nativeLogRoot(root),
          {
            [`${encodeURIComponent(malicious)}.jsonl`]: (content) =>
              content.includes('"message":"contained"'),
          },
          logBuffer.append(malicious, "stderr", "contained"),
          signal,
        );
        expect(yield* fs.exists(join(root, "escaped-service.jsonl"))).toBe(false);
      }),
    ).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.live("retries a transient journal write without losing the event", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const signal = yield* PubSub.unbounded<string>();
        const fs = yield* FileSystem.FileSystem.pipe(
          Effect.provide(journalFileSystemLayer(signal, flakyWriteFileSystemLayer)),
        );
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-native-logs-" });
        const services = yield* Layer.build(LogBuffer.layer);
        const logBuffer = Context.get(services, LogBuffer);
        yield* startNativeLogWriter(logBuffer, root).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
        );
        yield* awaitDirectoryState(
          fs,
          nativeLogRoot(root),
          {
            ["auth.jsonl"]: (content) => content.includes('"message":"recovered"'),
          },
          logBuffer.append("auth", "stdout", "recovered"),
          signal,
        );
      }),
    ).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.live("drains teardown entries before direct scope disposal closes the writer", () =>
    Effect.gen(function* () {
      const signal = yield* PubSub.unbounded<string>();
      const fs = yield* FileSystem.FileSystem.pipe(Effect.provide(journalFileSystemLayer(signal)));
      const root = yield* fs.makeTempDirectory({ prefix: "supabase-native-logs-" });
      const writerScope = yield* Scope.make("sequential");
      const services = yield* Layer.build(LogBuffer.layer);
      const logBuffer = Context.get(services, LogBuffer);
      yield* startNativeLogWriter(logBuffer, root).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Scope.Scope, writerScope),
      );
      yield* Scope.addFinalizer(writerScope, logBuffer.append("auth", "stderr", "shutdown-entry"));

      yield* Scope.close(writerScope, Exit.void);

      expect(yield* fs.readFileString(nativeServiceLogPath(root, "auth"))).toContain(
        '"message":"shutdown-entry"',
      );
      yield* fs.remove(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.live("isolates a blocked journal from a healthy sibling", () =>
    Effect.gen(function* () {
      const signal = yield* PubSub.unbounded<string>();
      const authWriteStarted = yield* Deferred.make<void>();
      const authFailureDone = yield* Deferred.make<void>();
      const postgresWritten = yield* Deferred.make<void>();
      const releaseAuth = yield* Deferred.make<void>();
      const injected = persistentWriteFailureFileSystem({
        authWriteStarted,
        authFailureDone,
        postgresWritten,
        releaseAuth,
      });
      const fs = yield* FileSystem.FileSystem.pipe(
        Effect.provide(journalFileSystemLayer(signal, injected.layer)),
      );
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-native-logs-" });
      const services = yield* Layer.build(LogBuffer.layer);
      const realLogBuffer = Context.get(services, LogBuffer);
      const logBuffer = {
        ...realLogBuffer,
        subscribeAllInternal: Stream.make(
          {
            _tag: "Entry" as const,
            entry: { timestamp: 0, service: "auth", stream: "stdout" as const, line: "failed" },
          },
          {
            _tag: "Entry" as const,
            entry: {
              timestamp: 0,
              service: "postgres",
              stream: "stdout" as const,
              line: "healthy",
            },
          },
        ),
      };
      yield* startNativeLogWriter(logBuffer, root).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      );

      yield* Effect.gen(function* () {
        yield* Deferred.await(authWriteStarted);
        // The auth write is still blocked at this point, so postgres can only
        // reach this gate when per-service flushing is isolated.
        yield* Deferred.await(postgresWritten);
        yield* Deferred.succeed(releaseAuth, undefined);
        yield* Deferred.await(authFailureDone);
      }).pipe(Effect.timeout(Duration.seconds(5)));
      expect(yield* fs.readFileString(nativeServiceLogPath(root, "postgres"))).toContain(
        '"message":"healthy"',
      );
      expect(yield* fs.readFileString(nativeServiceLogPath(root, "auth"))).toBe("");
      expect(injected.authOpens).toBeGreaterThan(1);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.live("reopens a failed service after persistent write failure clears", () =>
    Effect.gen(function* () {
      const signal = yield* PubSub.unbounded<string>();
      const injected = persistentWriteFailureFileSystem();
      const fs = yield* FileSystem.FileSystem.pipe(
        Effect.provide(journalFileSystemLayer(signal, injected.layer)),
      );
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-native-logs-" });
      const services = yield* Layer.build(LogBuffer.layer);
      const logBuffer = Context.get(services, LogBuffer);
      yield* startNativeLogWriter(logBuffer, root).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      );

      yield* awaitDirectoryState(
        fs,
        nativeLogRoot(root),
        {
          ["auth.jsonl"]: () => true,
          ["postgres.jsonl"]: (content) => content.includes('"message":"healthy"'),
        },
        Effect.gen(function* () {
          yield* logBuffer.append("auth", "stdout", "failed");
          yield* logBuffer.append("postgres", "stdout", "healthy");
        }),
        signal,
      );
      injected.recover();
      yield* awaitDirectoryState(
        fs,
        nativeLogRoot(root),
        {
          ["auth.jsonl"]: (content) => content.includes('"message":"recovered"'),
          ["postgres.jsonl"]: (content) => content.includes('"message":"healthy"'),
        },
        logBuffer.append("auth", "stdout", "recovered"),
        signal,
      );
      expect(injected.authOpens).toBeGreaterThan(1);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.live("recovers rotation after one rename failure and continues journaling", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const signal = yield* PubSub.unbounded<string>();
        const fs = yield* FileSystem.FileSystem.pipe(
          Effect.provide(journalFileSystemLayer(signal, flakyRenameFileSystemLayer)),
        );
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-native-logs-" });
        const services = yield* Layer.build(LogBuffer.layer);
        const logBuffer = Context.get(services, LogBuffer);
        const writerScope = yield* Scope.make("sequential");
        yield* startNativeLogWriter(logBuffer, root).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Scope.Scope, writerScope),
        );
        const message = "r".repeat(30_000);

        for (let index = 0; index < 4; index += 1) {
          yield* awaitDirectoryState(
            fs,
            nativeLogRoot(root),
            {
              ["auth.jsonl"]: (content) => content.includes(`"message":"${index}:${message}"`),
              ...(index >= 2
                ? {
                    ["auth.jsonl.1"]: (content: string) => content.length > 0,
                  }
                : {}),
            },
            logBuffer.append("auth", "stdout", `${index}:${message}`),
            signal,
          );
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
    ).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.live("rotates active journals on restart and bounds oversized records", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const signal = yield* PubSub.unbounded<string>();
        const fs = yield* FileSystem.FileSystem.pipe(
          Effect.provide(journalFileSystemLayer(signal)),
        );
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
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Scope.Scope, writerScope),
        );
        yield* awaitDirectoryState(fs, logRoot, {
          ["auth.jsonl.1"]: seeded,
        });

        yield* awaitDirectoryState(
          fs,
          logRoot,
          {
            ["auth.jsonl"]: (content) => content.includes('"message":"after-restart-150"'),
            ["auth.jsonl.1"]: seeded,
            ["postgres.jsonl"]: (content) => content.includes('"service":"postgres"'),
          },
          Effect.gen(function* () {
            for (let index = 0; index < 151; index += 1) {
              yield* logBuffer.append("auth", "stdout", `after-restart-${index}`);
            }
            yield* logBuffer.append("postgres", "stderr", "😀".repeat(100_000));
          }),
          signal,
        );

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
        const signal = yield* PubSub.unbounded<string>();
        const fs = yield* FileSystem.FileSystem.pipe(
          Effect.provide(journalFileSystemLayer(signal)),
        );
        const firstRoot = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-native-logs-a-" });
        const secondRoot = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-native-logs-b-" });
        const firstServices = yield* Layer.build(LogBuffer.layer);
        const secondServices = yield* Layer.build(LogBuffer.layer);
        const firstBuffer = Context.get(firstServices, LogBuffer);
        const secondBuffer = Context.get(secondServices, LogBuffer);
        yield* startNativeLogWriter(firstBuffer, firstRoot).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
        );
        yield* startNativeLogWriter(secondBuffer, secondRoot).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
        );

        const firstReady = yield* Deferred.make<void>();
        const secondReady = yield* Deferred.make<void>();
        const firstWait = yield* Effect.forkChild(
          awaitDirectoryState(
            fs,
            nativeLogRoot(firstRoot),
            {
              ["auth.jsonl"]: (content) => content.includes('"message":"first-stack"'),
            },
            Effect.void,
            signal,
            firstReady,
          ),
          { startImmediately: true },
        );
        const secondWait = yield* Effect.forkChild(
          awaitDirectoryState(
            fs,
            nativeLogRoot(secondRoot),
            {
              ["auth.jsonl"]: (content) => content.includes('"message":"second-stack"'),
            },
            Effect.void,
            signal,
            secondReady,
          ),
          { startImmediately: true },
        );
        yield* Deferred.await(firstReady);
        yield* Deferred.await(secondReady);
        yield* firstBuffer.append("auth", "stdout", "first-stack");
        yield* secondBuffer.append("auth", "stdout", "second-stack");
        yield* Fiber.join(firstWait);
        yield* Fiber.join(secondWait);

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
