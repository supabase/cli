import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { DateTime, Effect, FileSystem, Layer, Option, Path, PlatformError, Schema } from "effect";
import type { SavedStack } from "@supabase/stack/effect";
import { mockCommandSettings } from "../../../tests/helpers/command-mocks.ts";
import { selection } from "../../../tests/helpers/pins.ts";
import { StackTargetResolver } from "../../command-internal/stack-target.ts";
import { makeLocalLogsSession } from "./logs.local-session.ts";
import type { LogsFlags } from "./logs.session.ts";

const flags: LogsFlags = {
  local: false,
  linked: false,
  remote: Option.none(),
  projectRef: Option.none(),
  stack: Option.none(),
  stackId: Option.none(),
  service: [],
  resource: Option.none(),
  kind: Option.none(),
  level: [],
  search: Option.none(),
  since: Option.none(),
  from: Option.none(),
  to: Option.none(),
  sql: Option.none(),
  file: Option.none(),
  limit: 1,
};
const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const line = (text: string, millis = 1, launchId = 1) =>
  `${iso(millis)} stdout ${launchId} | ${text}\n`;

const fixture = Effect.fn("LogsLocalTest.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "local-log-session-" });
  const file = path.join(root, "stacks", "stack-main", "logs", "mail", "one", "0000000001.log");
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  const definition: SavedStack = {
    id: "stack-main",
    identity: { projectRoot: root, branchContext: "main", stackName: "local" },
    runtime: "native",
    lifetime: "detached",
    instances: [
      { id: "one", creation: { service: "mail", pin: selection.mail, config: {}, endpoints: {} } },
    ],
    composition: { members: [{ id: "one", activation: "eager" }], dependencies: [] },
  };
  let resolutions = 0;
  const layer = Layer.merge(
    mockCommandSettings({ workdir: root, supabaseHome: root }),
    Layer.succeed(StackTargetResolver, {
      resolve: () =>
        Effect.sync(() => {
          resolutions += 1;
          return { projectRoot: root, id: definition.id, definition, hostRunning: false };
        }),
    }),
  );
  return { fs, file, layer, resolutions: () => resolutions };
});

it.effect("loads every newer line without resurrecting initial history omitted by limit", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    yield* test.fs.writeFileString(test.file, line("latest", 5) + line("older-late", 1));
    const session = yield* makeLocalLogsSession(flags, 10).pipe(Effect.provide(test.layer));
    const rows: Array<Schema.JsonObject> = [];
    const emit = (row: Schema.JsonObject) =>
      Effect.sync(() => {
        rows.push(row);
      });
    expect(yield* session.load(10, emit)).toMatchObject({ end: iso(10) });
    expect(rows.map(({ text }) => text)).toEqual(["latest"]);
    rows.length = 0;
    yield* test.fs.writeFileString(test.file, line("new-a", 6) + line("new-b", 7), { flag: "a" });
    yield* session.load(20, emit);
    expect(rows.map(({ text }) => text)).toEqual(["new-a", "new-b"]);
    rows.length = 0;
    yield* session.load(30, emit);
    expect(rows).toEqual([]);
    expect(test.resolutions()).toBe(1);
  }).pipe(Effect.provide(BunServices.layer)),
);

it.effect(
  "defers future timestamps while emitting later positions whose timestamps are eligible",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture();
      yield* test.fs.writeFileString(test.file, line("future", 30) + line("eligible", 5));
      const session = yield* makeLocalLogsSession(flags, 10).pipe(Effect.provide(test.layer));
      const rows: Array<Schema.JsonObject> = [];
      const emit = (row: Schema.JsonObject) =>
        Effect.sync(() => {
          rows.push(row);
        });
      yield* session.load(10, emit);
      expect(rows.map(({ text }) => text)).toEqual(["eligible"]);
      rows.length = 0;
      yield* session.load(30, emit);
      expect(rows.map(({ text }) => text)).toEqual(["future"]);
      rows.length = 0;
      yield* session.load(20, emit);
      expect(rows).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
);

it.effect("retries a failed read without committing the cursor or requested window", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    yield* test.fs.writeFileString(test.file, line("initial"));
    let fail = false;
    const failingFs: FileSystem.FileSystem = {
      ...test.fs,
      open: (target, options) =>
        fail && target === test.file
          ? Effect.fail(
              new PlatformError.PlatformError(
                new PlatformError.SystemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "open",
                  pathOrDescriptor: target,
                }),
              ),
            )
          : test.fs.open(target, options),
    };
    const session = yield* makeLocalLogsSession(flags, 10).pipe(
      Effect.provide(test.layer),
      Effect.provideService(FileSystem.FileSystem, failingFs),
    );
    const rows: Array<Schema.JsonObject> = [];
    const emit = (row: Schema.JsonObject) =>
      Effect.sync(() => {
        rows.push(row);
      });
    yield* session.load(10, emit);
    rows.length = 0;
    yield* test.fs.writeFileString(test.file, line("retry", 15), { flag: "a" });
    fail = true;
    expect((yield* session.load(30, emit).pipe(Effect.exit))._tag).toBe("Failure");
    fail = false;
    expect(yield* session.load(20, emit)).toMatchObject({ end: iso(20) });
    expect(rows.map(({ text }) => text)).toEqual(["retry"]);
  }).pipe(Effect.provide(BunServices.layer)),
);

it.effect("freezes the requested lower bound and extends an explicit end on later loads", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    yield* test.fs.writeFileString(
      test.file,
      line("before", 1) + line("inside", 5) + line("after", 15),
    );
    const session = yield* makeLocalLogsSession(
      {
        ...flags,
        from: Option.some(iso(3)),
        to: Option.some(iso(10)),
      },
      20,
    ).pipe(Effect.provide(test.layer));
    const rows: Array<Schema.JsonObject> = [];
    const emit = (row: Schema.JsonObject) =>
      Effect.sync(() => {
        rows.push(row);
      });
    expect(yield* session.load(20, emit)).toEqual({
      kind: "range",
      start: iso(3),
      end: iso(10),
    });
    expect(rows.map(({ text }) => text)).toEqual(["inside"]);
    rows.length = 0;
    expect(yield* session.load(20, emit)).toMatchObject({ end: iso(20) });
    expect(rows.map(({ text }) => text)).toEqual(["after"]);
  }).pipe(Effect.provide(BunServices.layer)),
);

it.effect(
  "keeps only the latest launch initially and excludes late output from an older launch",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture();
      yield* test.fs.writeFileString(
        test.file,
        line("previous", 1, 1) + `${iso(2)} launch 2 | \n` + line("current", 3, 2),
      );
      const session = yield* makeLocalLogsSession(
        { ...flags, since: Option.some("start") },
        10,
      ).pipe(Effect.provide(test.layer));
      const rows: Array<Schema.JsonObject> = [];
      const emit = (row: Schema.JsonObject) =>
        Effect.sync(() => {
          rows.push(row);
        });
      expect(yield* session.load(10, emit)).toMatchObject({
        kind: "launch",
        end: iso(10),
      });
      expect(rows.filter(({ kind }) => kind === "stdout").map(({ text }) => text)).toEqual([
        "current",
      ]);
      rows.length = 0;
      yield* test.fs.writeFileString(
        test.file,
        line("late previous", 4, 1) + line("new current", 5, 2),
        { flag: "a" },
      );
      yield* session.load(20, emit);
      expect(rows.map(({ text }) => text)).toEqual(["new current"]);
    }).pipe(Effect.provide(BunServices.layer)),
);

it.effect("rejects excessive future records and retries with the initial history intact", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    const future = Array.from({ length: 1001 }, (_, index) => line(`future-${index}`, 30)).join("");
    yield* test.fs.writeFileString(test.file, line("initial") + future);
    const session = yield* makeLocalLogsSession(flags, 10).pipe(Effect.provide(test.layer));
    const rows: Array<Schema.JsonObject> = [];
    const emit = (row: Schema.JsonObject) =>
      Effect.sync(() => {
        rows.push(row);
      });
    const failed = yield* session.load(10, emit).pipe(Effect.flip);
    expect(failed.message).toContain("future timestamps");
    expect(rows).toEqual([]);
    yield* test.fs.writeFileString(test.file, line("initial"));
    yield* session.load(10, emit);
    expect(rows.map(({ text }) => text)).toEqual(["initial"]);
  }).pipe(Effect.provide(BunServices.layer)),
);
