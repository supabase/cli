import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import {
  Clock,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Ref,
  Schema,
  Stream,
} from "effect";
import {
  streamStackLogs,
  type LogRecord,
  type ReadLogsOptions,
  type SavedStack,
  type ServiceInstance,
} from "@supabase/stack/effect";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
} from "../../../../../tests/helpers/command-mocks.ts";
import { StackApi, stackApiLayer, stackTargetResolverLayer } from "../stack.shared.ts";
import type { StackLogsFlags } from "./logs.command.ts";
import { stackLogs } from "./logs.handler.ts";

const live = Layer.provideMerge(stackApiLayer, BunServices.layer);

type SavedInstance = SavedStack["instances"][number];
const mail = (id: string): SavedInstance => ({
  id,
  creation: { service: "mail", config: {}, endpoints: {} },
});
const database = (id: string): SavedInstance => ({
  id,
  creation: {
    service: "database",
    config: {
      version: "17",
      databasePassword: Redacted.make("stack-logs-test"),
      jwtSecret: Redacted.make("stack-logs-test-jwt-secret"),
      jwtExpiry: 3600,
    },
    endpoints: {},
  },
});

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const line = (millis: number, kind: "stdout" | "stderr", text: string, launchId = 1) =>
  `${iso(millis)} ${kind} ${launchId} | ${text}`;
const launch = (millis: number, launchId = 1) => `${iso(millis)} launch ${launchId} | `;
const lost = (millis: number, count: number, launchId = 1) =>
  `${iso(millis)} lost ${launchId} | ${count} stdout`;

const baseFlags = (stackId: string): StackLogsFlags => ({
  stack: Option.none(),
  stackId: Option.some(stackId),
  service: [],
  follow: false,
  tail: 200,
  since: Option.none(),
});

const followingMail = (
  id: string,
  readLogs: (options?: ReadLogsOptions) => Stream.Stream<LogRecord, never>,
): ServiceInstance<"mail"> => ({
  id,
  service: "mail",
  start: Effect.die("unused"),
  ready: Effect.die("unused"),
  stop: Effect.die("unused"),
  restart: () => Effect.die("unused"),
  destroy: Effect.die("unused"),
  prepare: Effect.die("unused"),
  status: Effect.die("unused"),
  followStatus: Stream.die("unused"),
  readLogs,
  credentials: () => Effect.die("unused"),
});

/** A saved stack with fixed definitions, a fake owner, and log segments written to disk. */
const fixture = Effect.fn("StackLogsTest.fixture")(function* (options: {
  readonly instances: ReadonlyArray<SavedInstance>;
  readonly members: ReadonlyArray<string>;
  readonly running?: boolean;
  readonly handles?: (stack: {
    readonly stateRoot: string;
    readonly stackId: string;
  }) => ReadonlyArray<ServiceInstance<"mail">>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-logs-" });
  const api = yield* StackApi;
  const stateRoot = path.join(root, "stacks");
  const stack = yield* api.create({
    stateRoot,
    cacheRoot: path.join(root, "cache"),
    projectRoot: root,
    runtime: "native",
  });
  const found = yield* api.find({ stateRoot, id: stack.id });
  if (Option.isNone(found)) return yield* Effect.die("created stack missing");
  const definition: SavedStack = {
    ...found.value.definition,
    instances: options.instances,
    composition: {
      members: options.members.map((id) => ({ id, activation: "eager" as const })),
      dependencies: [],
    },
  };
  const opened = yield* Ref.make(0);
  const fakeApi = Layer.succeed(
    StackApi,
    StackApi.of({
      ...api,
      find: () =>
        Effect.succeed(
          Option.some({
            definition,
            host:
              options.running === true
                ? {
                    stackId: stack.id,
                    identity: definition.identity,
                    pid: 1,
                    port: 1,
                    release: "test",
                  }
                : undefined,
          }),
        ),
      open: () =>
        Ref.update(opened, (count) => count + 1).pipe(
          Effect.as({
            ...stack,
            services: {
              ...stack.services,
              list: Effect.succeed(options.handles?.({ stateRoot, stackId: stack.id }) ?? []),
            },
          }),
        ),
    }),
  );
  const settings = mockCommandSettings({ workdir: root, supabaseHome: root });
  const writeSegment = (service: string, instanceId: string, records: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const directory = path.join(stateRoot, stack.id, "logs", service, instanceId);
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(
        path.join(directory, "0000000001.log"),
        records.map((record) => `${record}\n`).join(""),
      );
    });
  const run = (flags: Partial<StackLogsFlags>, format: "text" | "stream-json" | "json" = "text") =>
    Effect.gen(function* () {
      const output = mockOutput({ format, interactive: false });
      const telemetry = mockTelemetryStateTracked();
      const layer = Layer.mergeAll(
        output.layer,
        telemetry.layer,
        Layer.provideMerge(stackTargetResolverLayer, Layer.merge(settings, fakeApi)),
      );
      const exit = yield* stackLogs({ ...baseFlags(stack.id), ...flags }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      return { exit, output, telemetry };
    });
  return { stackId: stack.id, stateRoot, opened, writeSegment, run };
});

const failure = <E>(exit: Exit.Exit<void, E>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit)) : undefined;
const lines = (text: string) => text.split("\n").filter((value) => value.length > 0);
const eventLines = (events: ReadonlyArray<{ readonly type: string; readonly line?: unknown }>) =>
  events.filter(({ type }) => type === "log-entry").map(({ line: text }) => text);

describe("stack logs", () => {
  const t0 = Date.parse("2026-09-29T10:00:00.000Z");

  it.live("prints the newest lines across services with aligned labels, offline", () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        instances: [mail("mail-a"), database("db-a")],
        members: ["mail-a", "db-a"],
      });
      yield* f.writeSegment("mail", "mail-a", [
        launch(t0 - 1),
        ...Array.from({ length: 149 }, (_, index) =>
          line(t0 + index * 2, "stdout", `mail line ${index}`),
        ),
        line(t0 + 149 * 2, "stderr", "\u001b[31mwarning\u001b[0m"),
      ]);
      yield* f.writeSegment("database", "db-a", [
        launch(t0 - 1),
        ...Array.from({ length: 100 }, (_, index) =>
          line(t0 + index * 2 + 1, "stdout", `database line ${index}`),
        ),
      ]);

      const { exit, output, telemetry } = yield* f.run({});

      expect(Exit.isSuccess(exit)).toBe(true);
      const printed = lines(output.stdoutText);
      expect(printed).toHaveLength(200);
      expect(printed[0]).toMatch(/^mail {5}\| \d{2}:\d{2}:\d{2}\.\d{3} mail line 25$/u);
      expect(printed[1]).toMatch(/^database \| \d{2}:\d{2}:\d{2}\.\d{3} database line 25$/u);
      expect(printed.at(-1)).toMatch(/^mail {5}\| \S+ warning$/u);
      expect(output.stdoutText).not.toContain("\u001b");
      expect(output.stderrText).toBe("showing last 200 of 250 lines, use --tail/--since\n");
      expect(yield* Ref.get(f.opened)).toBe(0);
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(live)),
  );

  it.live("selects history with --tail, --since, and repeated --service", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const minutes = (count: number) => now - count * 60_000;
      const f = yield* fixture({
        instances: [mail("mail-a"), mail("mail-b"), mail("mail-c"), database("db-a")],
        members: ["mail-a", "db-a"],
      });
      yield* f.writeSegment("mail", "mail-a", [
        launch(minutes(180)),
        line(minutes(120), "stdout", "a old"),
        launch(minutes(30), 2),
        line(minutes(20), "stdout", "a new", 2),
      ]);
      yield* f.writeSegment("database", "db-a", [
        launch(minutes(10)),
        line(minutes(5), "stdout", "d recent"),
      ]);
      yield* f.writeSegment("mail", "mail-b", [
        launch(minutes(3)),
        line(minutes(1), "stdout", "b standalone"),
      ]);
      // Retention removed this instance's launch record along with its oldest segment.
      yield* f.writeSegment("mail", "mail-c", [line(minutes(2), "stdout", "c retained")]);
      const read = (flags: Partial<StackLogsFlags>) =>
        f.run(flags, "stream-json").pipe(Effect.map(({ output }) => eventLines(output.events)));

      expect(yield* read({})).toEqual(["a old", "a new", "d recent"]);
      expect(yield* read({ since: Option.some("1h") })).toEqual(["a new", "d recent"]);
      expect(yield* read({ since: Option.some(iso(minutes(25))) })).toEqual(["a new", "d recent"]);
      expect(yield* read({ since: Option.some("start") })).toEqual(["a new", "d recent"]);
      expect(yield* read({ service: ["mail-c"], since: Option.some("start") })).toEqual([
        "c retained",
      ]);
      expect(yield* read({ service: ["mail"], tail: 1 })).toEqual(["b standalone"]);
      expect(yield* read({ service: ["mail-b", "database"] })).toEqual([
        "d recent",
        "b standalone",
      ]);
      const truncated = yield* f.run({ service: ["mail"], tail: 1 });
      expect(truncated.output.stderrText).toBe("showing last 1 of 4 lines, use --tail/--since\n");
      const unknown = yield* f.run({ service: ["mail", "missing"] });
      expect(failure(unknown.exit)).toMatchObject({
        reason: "flags",
        message: "No service matches missing.",
      });
      const invalid = yield* f.run({ since: Option.some("soon") });
      expect(failure(invalid.exit)).toMatchObject({ reason: "flags" });
      expect(invalid.output.stdoutText).toBe("");
    }).pipe(Effect.scoped, Effect.provide(live)),
  );

  it.live("starts --since start at each instance's saved launch, even before it logged", () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        instances: [
          { ...mail("mail-a"), launchId: 3 },
          { ...mail("mail-b"), launchId: 2 },
        ],
        members: ["mail-a", "mail-b"],
      });
      yield* f.writeSegment("mail", "mail-a", [
        launch(t0, 2),
        line(t0 + 1, "stdout", "a previous launch", 2),
      ]);
      yield* f.writeSegment("mail", "mail-b", [
        launch(t0 + 2, 1),
        line(t0 + 3, "stdout", "b previous launch", 1),
        launch(t0 + 4, 2),
        line(t0 + 5, "stdout", "b current launch", 2),
      ]);

      const { output } = yield* f.run({ since: Option.some("start") }, "stream-json");

      expect(
        output.events.map(({ instance_id, kind, line: text }) => [instance_id, kind ?? text]),
      ).toEqual([
        ["mail-b", "launch"],
        ["mail-b", "b current launch"],
      ]);
    }).pipe(Effect.scoped, Effect.provide(live)),
  );

  it.live("tails by record time when an older partial line was flushed last", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ instances: [mail("mail-a")], members: ["mail-a"] });
      yield* f.writeSegment("mail", "mail-a", [
        launch(t0),
        line(t0 + 10, "stdout", "newer"),
        line(t0 + 5, "stderr", "late older"),
      ]);

      const { output } = yield* f.run({ tail: 1 }, "stream-json");

      expect(eventLines(output.events)).toEqual(["newer"]);
    }).pipe(Effect.scoped, Effect.provide(live)),
  );

  it.live("keeps the log-entry fields and reports markers in every output mode", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ instances: [mail("mail-a")], members: ["mail-a"] });
      yield* f.writeSegment("mail", "mail-a", [
        launch(t0),
        line(t0 + 1, "stdout", "hello"),
        line(t0 + 2, "stderr", "oops"),
        lost(t0 + 3, 3),
      ]);
      const subject = { service: "mail", instance_id: "mail-a", source: "history" };
      const expected = [
        { type: "log-marker", timestamp: iso(t0), ...subject, kind: "launch" },
        {
          type: "log-entry",
          timestamp: iso(t0 + 1),
          ...subject,
          stream: "stdout",
          line: "hello",
        },
        { type: "log-entry", timestamp: iso(t0 + 2), ...subject, stream: "stderr", line: "oops" },
        {
          type: "log-marker",
          timestamp: iso(t0 + 3),
          ...subject,
          kind: "lost",
          stream: "stdout",
          count: 3,
        },
      ];

      const streamed = yield* f.run({}, "stream-json");
      const finite = yield* f.run({}, "json");
      const text = yield* f.run({});

      expect(streamed.output.events).toEqual(expected);
      expect(
        yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(finite.output.stdoutText),
      ).toEqual(expected);
      expect(
        lines(text.output.stdoutText).map((value) => value.replace(/\d{2}:\S+ /u, "")),
      ).toEqual([
        "mail | --- launch 1 ---",
        "mail | hello",
        "mail | oops",
        "mail | --- 3 stdout chunks lost ---",
      ]);
    }).pipe(Effect.scoped, Effect.provide(live)),
  );

  it.live("fails --follow without a running owner before printing anything", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ instances: [mail("mail-a")], members: ["mail-a"] });
      yield* f.writeSegment("mail", "mail-a", [launch(t0), line(t0 + 1, "stdout", "retained")]);

      const followed = yield* f.run({ follow: true });
      const finite = yield* f.run({ follow: true }, "json");

      expect(failure(followed.exit)).toMatchObject({
        reason: "lifecycle",
        suggestion:
          "Run supabase stack logs without --follow to read retained logs, or supabase stack start first.",
      });
      expect(followed.output.stdoutText).toBe("");
      expect(followed.output.stderrText).toBe("");
      expect(followed.telemetry.flushed).toBe(true);
      expect(failure(finite.exit)).toMatchObject({
        reason: "flags",
        suggestion: "Use --output-format stream-json, or omit --follow.",
      });
      expect(yield* Ref.get(f.opened)).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(live)),
  );

  it.live("follows each service after its printed history without repeating it", () =>
    Effect.gen(function* () {
      // Serves the history like an owner, from `from` inclusive or none for `tail: 0`, then one new record.
      const owner =
        (stack: { readonly stateRoot: string; readonly stackId: string }) =>
        (id: string, text: string) =>
          followingMail(id, (options) =>
            streamStackLogs({ ...stack, instances: [id] }).pipe(
              Stream.orDie,
              Stream.filter(
                ({ position }) =>
                  options?.tail !== 0 &&
                  (options?.from === undefined ||
                    (position !== undefined && position.byteOffset >= options.from.byteOffset)),
              ),
              Stream.concat(
                Stream.make({
                  kind: "stdout" as const,
                  timestamp: iso(t0 + 100),
                  launchId: 1,
                  text,
                  position: { generation: 1, byteOffset: 1_000_000 },
                }),
              ),
              Stream.provide(BunServices.layer),
            ),
          );
      const f = yield* fixture({
        instances: [mail("mail-a"), mail("mail-b")],
        members: ["mail-a", "mail-b"],
        running: true,
        handles: (stack) => [owner(stack)("mail-a", "a live"), owner(stack)("mail-b", "b live")],
      });
      yield* f.writeSegment("mail", "mail-a", [
        launch(t0),
        line(t0 + 1, "stdout", "a first"),
        line(t0 + 2, "stdout", "a second"),
      ]);

      const { exit, output } = yield* f.run({ follow: true }, "stream-json");

      expect(Exit.isSuccess(exit)).toBe(true);
      const entries = output.events.filter(({ type }) => type === "log-entry");
      expect(entries.map(({ line: text, source }) => [text, source])).toEqual(
        expect.arrayContaining([
          ["a first", "history"],
          ["a second", "history"],
          ["a live", "live"],
          ["b live", "live"],
        ]),
      );
      expect(entries).toHaveLength(4);
      expect(entries.slice(0, 2).map(({ line: text }) => text)).toEqual(["a first", "a second"]);
      expect(yield* Ref.get(f.opened)).toBe(1);

      const liveOnly = yield* f.run({ follow: true, tail: 0 });

      expect(Exit.isSuccess(liveOnly.exit)).toBe(true);
      expect(
        lines(liveOnly.output.stdoutText)
          .map((value) => value.replace(/^\S+\s+\| \S+ /u, ""))
          .toSorted(),
      ).toEqual(["a live", "b live"]);
      expect(liveOnly.output.stderrText).toBe("");
    }).pipe(Effect.scoped, Effect.provide(live)),
  );

  it.live("follows --since start without delayed records of an earlier launch", () =>
    Effect.gen(function* () {
      const record = (offset: number, launchId: number, text: string): LogRecord => ({
        kind: "stdout",
        timestamp: iso(t0 + offset),
        launchId,
        text,
        position: { generation: 1, byteOffset: offset },
      });
      const f = yield* fixture({
        instances: [{ ...mail("mail-a"), launchId: 3 }],
        members: ["mail-a"],
        running: true,
        handles: () => [
          followingMail("mail-a", () =>
            Stream.make(
              record(0, 3, "current launch"),
              record(1, 2, "delayed earlier launch"),
              record(2, 4, "newer launch"),
            ),
          ),
        ],
      });

      const { exit, output } = yield* f.run(
        { follow: true, since: Option.some("start") },
        "stream-json",
      );

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(eventLines(output.events)).toEqual(["current launch", "newer launch"]);
    }).pipe(Effect.scoped, Effect.provide(live)),
  );

  it.live("follows the services the running stack serves and names the others", () =>
    Effect.gen(function* () {
      const served = (text: string) =>
        Stream.make({
          kind: "stdout" as const,
          timestamp: iso(t0),
          launchId: 1,
          text,
          position: { generation: 1, byteOffset: 0 },
        });
      const f = yield* fixture({
        instances: [mail("mail-a"), mail("mail-b")],
        members: ["mail-a", "mail-b"],
        running: true,
        handles: () => [followingMail("mail-a", () => served("a live"))],
      });

      const { exit, output } = yield* f.run({ follow: true, tail: 0 }, "stream-json");

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(eventLines(output.events)).toEqual(["a live"]);
      expect(output.messages).toContainEqual({
        type: "warn",
        message: "Not following mail (mail-b), which the running stack does not serve.",
      });
    }).pipe(Effect.scoped, Effect.provide(live)),
  );

  it.live("fails --follow when the running stack serves none of the selected services", () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        instances: [mail("mail-a")],
        members: ["mail-a"],
        running: true,
        handles: () => [],
      });

      const { exit } = yield* f.run({ follow: true, tail: 0 });

      expect(failure(exit)).toMatchObject({
        reason: "lifecycle",
        message:
          "The running stack serves none of the selected services, so there are no new lines to follow.",
      });
    }).pipe(Effect.scoped, Effect.provide(live)),
  );

  it.live("interrupts a follow and releases its subscriptions", () =>
    Effect.gen(function* () {
      const subscribed = yield* Deferred.make<void>();
      const released = yield* Ref.make(false);
      const f = yield* fixture({
        instances: [mail("mail-a")],
        members: ["mail-a"],
        running: true,
        handles: () => [
          followingMail("mail-a", () =>
            Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
              Stream.drain,
              Stream.concat(Stream.never),
              Stream.ensuring(Ref.set(released, true)),
            ),
          ),
        ],
      });

      const fiber = yield* f.run({ follow: true }).pipe(Effect.forkChild);
      yield* Deferred.await(subscribed);
      yield* Fiber.interrupt(fiber);

      expect(yield* Ref.get(released)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(live)),
  );
});
