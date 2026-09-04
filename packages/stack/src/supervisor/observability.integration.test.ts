import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Option, Path } from "effect";
import { InvalidLogCursorError } from "../public/Errors.ts";
import { LogStoreError, makeLogStore, readRetainedLogs, selectLogBatch } from "./LogStore.ts";

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

const errorOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

describe("observability", () => {
  it.live("retains bounded redacted records and resumes from an opaque cursor", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-logs-" });
        const store = yield* makeLogStore({
          path: path.join(root, "logs.json"),
          maxEntries: 2,
          knownSecrets: ["top-secret"],
        });
        const first = yield* store.append({
          source: "database",
          stream: "stdout",
          message: "top-secret one",
        });
        const second = yield* store.append({ source: "auth", stream: "stderr", message: "two" });
        const third = yield* store.append({
          source: "gateway",
          stream: "internal",
          message: "three",
        });
        const retained = yield* store.read();
        expect(retained.map((entry) => entry.message)).toEqual(["two", "three"]);
        expect((yield* store.read({ cursor: first.cursor })).map((entry) => entry.cursor)).toEqual([
          second.cursor,
          third.cursor,
        ]);
        const scanned = yield* store.read();
        expect(
          selectLogBatch(scanned, { capabilities: ["auth"] }).entries.map((entry) => entry.message),
        ).toEqual(["two"]);
        const invalidCursor = yield* store
          .read({ cursor: { opaque: "not-a-cursor" } })
          .pipe(Effect.exit);
        expect(errorOf(invalidCursor)).toBeInstanceOf(InvalidLogCursorError);
        expect(yield* fs.readFileString(path.join(root, "logs.json"))).not.toContain("top-secret");
        expect((yield* fs.stat(path.join(root, "logs.json"))).mode & 0o077).toBe(0);
      }),
    ),
  );

  it.live("bounds retained records by encoded size", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-log-size-" });
        const store = yield* makeLogStore({ path: path.join(root, "logs.json"), maxBytes: 300 });
        yield* store.append({ source: "database", stream: "stdout", message: "x".repeat(200) });
        expect(yield* store.read()).toEqual([]);
        expect(yield* fs.exists(path.join(root, "logs.json"))).toBe(false);
      }),
    ),
  );

  it.live("keeps reads bounded while compacting retained logs periodically", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-log-compaction-",
        });
        const logPath = path.join(root, "logs.json");
        const store = yield* makeLogStore({ path: logPath, maxEntries: 2 });
        yield* store.append({ source: "database", stream: "stdout", message: "one" });
        yield* store.append({ source: "database", stream: "stdout", message: "two" });
        yield* store.append({ source: "database", stream: "stdout", message: "three" });

        expect((yield* store.read()).map((entry) => entry.message)).toEqual(["two", "three"]);
        expect(
          (yield* readRetainedLogs(fs, logPath, { maxEntries: 2 })).map((entry) => entry.message),
        ).toEqual(["two", "three"]);
        // The third append is retained in the append-only window; compaction is deferred until
        // the bounded overshoot is exhausted.
        expect((yield* fs.readFileString(logPath)).trim().split("\n")).toHaveLength(3);

        yield* store.append({ source: "database", stream: "stdout", message: "four" });
        yield* store.append({ source: "database", stream: "stdout", message: "five" });
        expect((yield* store.read()).map((entry) => entry.message)).toEqual(["four", "five"]);
        expect((yield* fs.readFileString(logPath)).trim().split("\n")).toHaveLength(2);
      }),
    ),
  );

  it.live("drops an oversized record without evicting retained logs or reusing cursors", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-log-cursor-" });
        const logPath = path.join(root, "logs.json");
        const firstStore = yield* makeLogStore({ path: logPath, maxBytes: 300 });
        const first = yield* firstStore.append({
          source: "database",
          stream: "stdout",
          message: "retained",
        });
        const beforeOversized = yield* fs.readFileString(logPath);

        yield* firstStore.append({
          source: "database",
          stream: "stdout",
          message: "x".repeat(300),
        });

        expect(yield* fs.readFileString(logPath)).toBe(beforeOversized);
        expect((yield* firstStore.read()).map((entry) => entry.cursor)).toEqual([first.cursor]);

        const secondStore = yield* makeLogStore({ path: logPath, maxBytes: 300 });
        const second = yield* secondStore.append({
          source: "database",
          stream: "stdout",
          message: "after restart",
        });
        const followed = yield* secondStore.read({ cursor: first.cursor });

        expect(second.cursor.opaque).not.toBe(first.cursor.opaque);
        expect(followed.map((entry) => entry.cursor)).toEqual([second.cursor]);
      }),
    ),
  );

  it.live("keeps in-memory retention unchanged when compaction persistence fails", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-log-persist-failure-",
        });
        const logPath = path.join(root, "logs.json");
        const store = yield* makeLogStore({ path: logPath, maxEntries: 1 });
        yield* store.append({ source: "database", stream: "stdout", message: "one" });
        yield* store.append({ source: "database", stream: "stdout", message: "two" });
        yield* fs.chmod(root, 0o500);
        const failed = yield* store
          .append({ source: "database", stream: "stdout", message: "three" })
          .pipe(Effect.exit);
        yield* fs.chmod(root, 0o700);

        expect(Exit.isFailure(failed)).toBe(true);
        expect((yield* store.read()).map((entry) => entry.message)).toEqual(["two"]);
        expect((yield* fs.readFileString(logPath)).trim().split("\n")).toHaveLength(2);
      }),
    ),
  );

  it.live("secures a pre-existing log directory and rejects unsafe limits", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-log-permissions-",
        });
        const directory = path.join(root, "logs");
        yield* fs.makeDirectory(directory, { recursive: true, mode: 0o755 });
        yield* fs.chmod(directory, 0o755);
        const logPath = path.join(directory, "logs.json");
        yield* makeLogStore({ path: logPath });
        expect((yield* fs.stat(directory)).mode & 0o077).toBe(0);

        for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
          const invalid = yield* makeLogStore({
            path: path.join(root, `invalid-${String(value)}.json`),
            maxEntries: value,
          }).pipe(Effect.exit);
          expect(errorOf(invalid)).toBeInstanceOf(LogStoreError);
        }
        const tooSmall = yield* makeLogStore({
          path: path.join(root, "too-small.json"),
          maxBytes: 1,
        }).pipe(Effect.exit);
        expect(errorOf(tooSmall)).toBeInstanceOf(LogStoreError);
      }),
    ),
  );

  it.live("reloads retained logs and rejects malformed files", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-log-reload-" });
        const logPath = path.join(root, "logs.json");
        const first = yield* makeLogStore({ path: logPath });
        yield* first.append({ source: "supervisor", stream: "internal", message: "old-secret" });
        const second = yield* makeLogStore({ path: logPath, knownSecrets: ["old-secret"] });
        expect((yield* second.read()).map((entry) => entry.message)).toEqual(["[REDACTED]"]);
        expect(yield* fs.readFileString(logPath)).not.toContain("old-secret");
        const complete = yield* fs.readFileString(logPath);
        yield* fs.writeFileString(logPath, `${complete}{"cursor"`);
        const recovered = yield* makeLogStore({ path: logPath });
        expect((yield* recovered.read()).map((entry) => entry.message)).toEqual(["[REDACTED]"]);
        yield* fs.writeFileString(logPath, "not json");
        const malformed = yield* makeLogStore({ path: logPath }).pipe(Effect.exit);
        expect(errorOf(malformed)).toBeInstanceOf(LogStoreError);
      }),
    ),
  );
});
