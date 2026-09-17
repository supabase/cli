import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  FileSystem,
  Fiber,
  Layer,
  Option,
  Schema,
  Sink,
  Stdio,
  Stream,
} from "effect";
import { CliError, CliOutput, Command } from "effect/unstable/cli";
import {
  InvalidProjectRootError,
  StackIdSchema,
  ServiceInstanceIdSchema,
  StackNotFoundError,
  StackOwnershipConflictError,
  StackUpgradeRequiredError,
} from "@supabase/stack/effect";
import type {
  EffectStack,
  OpenStackError,
  StackLogBatch,
  StackLogEntry,
  StackDiscoveryError,
  StackStatus,
} from "@supabase/stack/effect";
import {
  mockCommandSettings,
  mockTelemetryStateLayer,
} from "../../../../../tests/helpers/command-mocks.ts";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { OutputFlag } from "../../../../command-internal/global-flags.ts";
import {
  ErrorActionabilityId,
  actionability,
} from "../../../../shared/telemetry/error-actionability.ts";
import { StackApi } from "../stack.shared.ts";
import { stackLogs } from "./logs.handler.ts";
import { StackCommandLogsError } from "./logs.errors.ts";
import { stackLogsCommand } from "./logs.command.ts";
import { textCliOutputFormatter } from "../../../../shared/output/text-formatter.ts";
import { streamJsonOutputLayer } from "../../../../shared/output/output.layer.ts";

const id = StackIdSchema.make("a".repeat(64));
const serviceId = ServiceInstanceIdSchema.make("b".repeat(64));
const streamResultSchema = Schema.Struct({
  type: Schema.Literal("result"),
  data: Schema.Unknown,
  timestamp: Schema.String,
});
const entries: ReadonlyArray<StackLogEntry> = [
  {
    cursor: { opaque: "1" },
    timestamp: "2026-09-08T00:00:00.000Z",
    source: "database",
    stream: "stdout",
    message: "database ready",
  },
  {
    cursor: { opaque: "2" },
    timestamp: "2026-09-08T00:00:01.000Z",
    source: "functions",
    stream: "stderr",
    message: "function failed",
  },
];
const internalEntry: StackLogEntry = {
  cursor: { opaque: "internal-1" },
  timestamp: "2026-09-08T00:00:02.000Z",
  source: "supervisor",
  stream: "internal",
  message: "stack supervisor ready",
};

const status: StackStatus = {
  id,
  lifecycle: "running",
  desiredLifecycle: "running",
  runtime: { kind: "native" },
  endpoints: {},
  versions: {},
  capabilities: [],
  artifacts: [],
  instances: [],
};

const flags = (overrides: Partial<Parameters<typeof stackLogs>[0]> = {}) => ({
  stack: Option.none<string>(),
  stackId: Option.none<string>(),
  service: Option.none<string>(),
  tail: 100,
  follow: false,
  ...overrides,
});

const parseErrorMessages = (error: CliError.CliError): ReadonlyArray<string> =>
  Schema.is(CliError.ShowHelp)(error) ? error.errors.map(({ message }) => message) : [];

function setup(opts: {
  root?: string;
  logs?: (query: unknown) => Effect.Effect<StackLogBatch, never>;
  followLogs?: (query: unknown) => Stream.Stream<StackLogEntry>;
  openFailure?: OpenStackError;
  findFailure?: StackDiscoveryError;
  noDefault?: boolean;
}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root =
      opts.root ?? (yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-logs-" }));
    const out = mockOutput();
    const calls: {
      readonly queries: unknown[];
      opened: string[];
      stopCalls: number;
      destroyCalls: number;
    } = { queries: [], opened: [], stopCalls: 0, destroyCalls: 0 };
    const stack = {
      id,
      status: Effect.succeed(status),
      credentials: Effect.die("unused"),
      prepare: () => Effect.die("unused"),
      start: () => Effect.die("must not start"),
      services: {
        create: () => Effect.die("services.create not used"),
        get: () => Effect.die("services.get not used"),
        list: Effect.succeed([]),
      },
      sleep: () => Effect.die("sleep not used"),
      stop: () => Effect.succeed(status),
      restart: () => Effect.die("restart not used"),
      destroy: () => Effect.sync(() => void calls.destroyCalls++),
      logs: (query?: unknown) => {
        calls.queries.push(query);
        return (
          opts.logs?.(query) ?? Effect.succeed({ entries, cursor: { opaque: "2" }, running: false })
        );
      },
      followStatus: Stream.empty,
      followLogs: (query?: unknown) => {
        calls.queries.push(query);
        return opts.followLogs?.(query) ?? Stream.fromIterable(entries);
      },
    } satisfies EffectStack;
    const descriptor = {
      id,
      projectRoot: root,
      name: "feature-a",
      branchContext: "ordinary-workspace",
      runtime: { kind: "native" as const },
      desiredLifecycle: "running" as const,
    };
    const layer = Layer.mergeAll(
      out.layer,
      mockCommandSettings({ workdir: root }),
      mockTelemetryStateLayer,
      Layer.succeed(StackApi, {
        createStack: () => Effect.die("must not create"),
        findStack: (query) =>
          opts.findFailure === undefined
            ? Effect.succeed(
                query.name === "missing" || (query.name === undefined && opts.noDefault)
                  ? Option.none()
                  : Option.some(descriptor),
              )
            : Effect.fail(opts.findFailure),
        discoverStacks: () => Effect.succeed({ stacks: [], errors: [] }),
        openStack: (stackId) =>
          opts.openFailure === undefined
            ? Effect.sync(() => {
                calls.opened.push(stackId);
                return stack;
              })
            : Effect.fail(opts.openFailure),
        inspectStack: () => Effect.die("must not inspect"),
      }),
      BunServices.layer,
    );
    return { layer, out, calls, root };
  }).pipe(Effect.provide(BunServices.layer));
}

function capturedStdio() {
  const stdout: string[] = [];
  const layer = Layer.succeed(
    Stdio.Stdio,
    Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.empty,
      stdout: () =>
        Sink.forEach((item: string | Uint8Array) =>
          Effect.sync(() =>
            stdout.push(typeof item === "string" ? item : new TextDecoder().decode(item)),
          ),
        ),
      stderr: () => Sink.forEach(() => Effect.void),
    }),
  );
  return { layer, stdout };
}

describe("experimental stack logs", () => {
  it.live("parses --service as a value-consuming flag", () => {
    let parsed: { service: Option.Option<string>; tail: number } | undefined;
    const command = stackLogsCommand.pipe(
      Command.withHandler((flags) =>
        Effect.sync(() => {
          parsed = { service: flags.service, tail: flags.tail };
        }),
      ),
    );
    return Effect.gen(function* () {
      yield* Command.runWith(command, { version: "0.0.0-test" })([
        "--service",
        "database",
        "--tail",
        "4",
      ]);
      expect(parsed?.service).toEqual(Option.some("database"));
      expect(parsed?.tail).toBe(4);
    }).pipe(
      Effect.provide(Layer.mergeAll(BunServices.layer, CliOutput.layer(textCliOutputFormatter()))),
    );
  });

  it.live(
    "accepts zero and maximum tail with the follow alias and rejects out-of-range tails",
    () => {
      let parsed: { tail: number; follow: boolean } | undefined;
      const command = stackLogsCommand.pipe(
        Command.withHandler((flags) =>
          Effect.sync(() => {
            parsed = { tail: flags.tail, follow: flags.follow };
          }),
        ),
      );
      const outputLayer = Layer.mergeAll(
        BunServices.layer,
        CliOutput.layer(textCliOutputFormatter()),
      );
      return Effect.gen(function* () {
        yield* Command.runWith(command, { version: "0.0.0-test" })(["--tail", "0", "-f"]);
        expect(parsed).toEqual({ tail: 0, follow: true });
        yield* Command.runWith(command, { version: "0.0.0-test" })(["--tail", "1000"]);
        expect(parsed).toEqual({ tail: 1000, follow: false });
        const belowMinimum = yield* Command.runWith(command, { version: "0.0.0-test" })([
          "--tail=-1",
        ]).pipe(Effect.flip);
        const aboveMaximum = yield* Command.runWith(command, { version: "0.0.0-test" })([
          "--tail=1001",
        ]).pipe(Effect.flip);
        expect(belowMinimum).toBeInstanceOf(CliError.ShowHelp);
        expect(aboveMaximum).toBeInstanceOf(CliError.ShowHelp);
        expect(parseErrorMessages(belowMinimum)).toContain(
          'Invalid value for flag --tail: "-1". Expected --tail between 0 and 1000, got -1',
        );
        expect(parseErrorMessages(aboveMaximum)).toContain(
          'Invalid value for flag --tail: "1001". Expected --tail between 0 and 1000, got 1001',
        );
      }).pipe(Effect.provide(outputLayer));
    },
  );

  it.live("reads a finite tail and passes the service filter without starting or stopping", () => {
    return setup({}).pipe(
      Effect.flatMap((setupResult) =>
        Effect.gen(function* () {
          yield* stackLogs(flags({ service: Option.some(serviceId), tail: 2 }));
          expect(setupResult.calls.queries).toEqual([{ services: [serviceId], tail: 2 }]);
          expect(setupResult.calls.opened).toEqual([id]);
          expect(setupResult.out.stdoutText).toContain("database ready");
          expect(setupResult.out.stdoutText).toContain("function failed");
        }).pipe(Effect.provide(setupResult.layer)),
      ),
    );
  });

  it.live("sanitizes text messages while preserving structured log content", () => {
    const message =
      "safe\u009d0;bel\u0007-red\u009d0;c1\u009c-blue\u009d0;esc\u001b\\\u009b38:2::255:0:0m-color\u009b0m\tcolumn\rnext\u0000\u000b\u0085end";
    const sanitized = "safe-red-blue-color\tcolumnnextend";
    return setup({
      logs: () =>
        Effect.succeed({
          entries: [{ ...entries[0]!, message }],
          cursor: { opaque: "1" },
          running: false,
        }),
    }).pipe(
      Effect.flatMap((setupResult) => {
        const text = mockOutput();
        const json = mockOutput({ format: "json" });
        const structured = mockOutput({ format: "stream-json" });
        return Effect.gen(function* () {
          yield* stackLogs(flags()).pipe(
            Effect.provide(Layer.mergeAll(setupResult.layer, text.layer)),
          );
          expect(text.stdoutText).toContain(sanitized);
          expect(text.stdoutText).not.toContain("\u001b");

          yield* stackLogs(flags()).pipe(
            Effect.provide(Layer.mergeAll(setupResult.layer, json.layer)),
          );
          const jsonResult = json.messages.find((entry) => entry.type === "success")?.data;
          expect(jsonResult).toEqual(
            expect.objectContaining({ entries: [expect.objectContaining({ message })] }),
          );

          yield* stackLogs(flags()).pipe(
            Effect.provide(Layer.mergeAll(setupResult.layer, structured.layer)),
          );
          const streamResult = structured.messages.find((entry) => entry.type === "success")?.data;
          expect(streamResult).toEqual(
            expect.objectContaining({ entries: [expect.objectContaining({ message })] }),
          );
        }).pipe(Effect.provide(setupResult.layer));
      }),
    );
  });

  it.live("rejects conflicting targets before resolving a stack", () => {
    return setup({}).pipe(
      Effect.flatMap((setupResult) =>
        Effect.gen(function* () {
          const failure = yield* stackLogs(
            flags({ stack: Option.some("feature-a"), stackId: Option.some(id) }),
          ).pipe(Effect.flip);
          expect(failure.reason).toBe("flags");
          expect(setupResult.calls.queries).toEqual([]);
          expect(setupResult.calls.opened).toEqual([]);
        }).pipe(Effect.provide(setupResult.layer)),
      ),
    );
  });

  it.live("distinguishes an absent default stack from a missing named stack", () => {
    return Effect.gen(function* () {
      const absent = yield* setup({ noDefault: true });
      const named = yield* setup({});
      yield* stackLogs(flags()).pipe(Effect.provide(absent.layer));
      expect(absent.out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "No managed stack found for this context.",
        }),
      );
      const absentStream = capturedStdio();
      yield* stackLogs(flags()).pipe(
        Effect.provide(
          Layer.mergeAll(
            absent.layer,
            absentStream.layer,
            streamJsonOutputLayer.pipe(Layer.provide(absentStream.layer)),
          ),
        ),
      );
      const absentResult = yield* Schema.decodeEffect(Schema.fromJsonString(streamResultSchema))(
        absentStream.stdout.join(""),
      );
      expect(absentResult).toEqual({
        type: "result",
        data: {
          found: false,
          entries: [],
          message: "No managed stack found for this context.",
        },
        timestamp: expect.any(String),
      });
      const failure = yield* stackLogs(flags({ stack: Option.some("missing") })).pipe(
        Effect.flip,
        Effect.provide(named.layer),
      );
      expect(failure.reason).toBe("flags");
      expect(failure.message).toContain("No managed stack named");
    });
  });

  it.live(
    "streams finite follow output and supports interruption without owner lifecycle calls",
    () => {
      return setup({
        logs: () =>
          Effect.succeed({ entries: [entries[0]!], cursor: { opaque: "1" }, running: true }),
        followLogs: (query) => {
          expect(query).toEqual({ cursor: { opaque: "1" } });
          return Stream.fromIterable([
            { ...entries[1]!, message: "function\u001b[2K failed\rretry" },
          ]);
        },
      }).pipe(
        Effect.flatMap((setupResult) =>
          Effect.gen(function* () {
            yield* stackLogs(flags({ follow: true }));
            expect(setupResult.out.stdoutText).toContain("function failedretry");
            const followStarted = yield* Deferred.make<void>();
            let finalized = false;
            const interrupted = yield* setup({
              root: setupResult.root,
              logs: () =>
                Effect.succeed({ entries: [entries[0]!], cursor: { opaque: "1" }, running: true }),
              followLogs: (): Stream.Stream<StackLogEntry> =>
                Stream.fromEffect(
                  Effect.as(Deferred.succeed(followStarted, undefined), undefined),
                ).pipe(
                  Stream.flatMap(() => Stream.empty),
                  Stream.concat(Stream.never),
                  Stream.ensuring(Effect.sync(() => void (finalized = true))),
                ),
            });
            const fiber = yield* Effect.forkChild(
              stackLogs(flags({ follow: true })).pipe(Effect.provide(interrupted.layer)),
            );
            yield* Deferred.await(followStarted);
            expect(interrupted.calls.opened).toEqual([id]);
            yield* Fiber.interrupt(fiber);
            expect(finalized).toBe(true);
            expect(interrupted.calls.stopCalls).toBe(0);
            expect(interrupted.calls.destroyCalls).toBe(0);
          }).pipe(Effect.provide(setupResult.layer)),
        ),
      );
    },
  );

  it.live("emits a bounded JSON result", () => {
    const output = mockOutput({ format: "json" });
    return setup({}).pipe(
      Effect.flatMap((setupResult) =>
        Effect.gen(function* () {
          yield* stackLogs(flags({ tail: 2 }));
          expect(output.messages.find((message) => message.type === "success")?.data).toEqual({
            found: true,
            id,
            entries,
            cursor: { opaque: "2" },
            running: false,
          });
        }).pipe(Effect.provide(Layer.mergeAll(setupResult.layer, output.layer))),
      ),
    );
  });

  it.live("emits one bounded stream-json result", () => {
    return setup({
      logs: () =>
        Effect.succeed({
          entries: [internalEntry],
          cursor: { opaque: "internal-1" },
          running: false,
        }),
    }).pipe(
      Effect.flatMap((setupResult) => {
        const output = capturedStdio();
        return Effect.gen(function* () {
          yield* stackLogs(flags({ tail: 2 }));
          const result = yield* Schema.decodeEffect(Schema.fromJsonString(streamResultSchema))(
            output.stdout.join(""),
          );
          expect(result).toEqual({
            type: "result",
            data: {
              found: true,
              id,
              entries: [internalEntry],
              cursor: { opaque: "internal-1" },
              running: false,
              message: "",
            },
            timestamp: expect.any(String),
          });
          expect(output.stdout.join("")).not.toContain('"type":"log-entry"');
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              setupResult.layer,
              output.layer,
              streamJsonOutputLayer.pipe(Layer.provide(output.layer)),
            ),
          ),
        );
      }),
    );
  });

  it.live("emits history and live events while following stream-json", () => {
    return setup({
      logs: () =>
        Effect.succeed({ entries: [entries[0]!], cursor: { opaque: "1" }, running: true }),
      followLogs: () => Stream.fromIterable([entries[1]!]),
    }).pipe(
      Effect.flatMap((setupResult) => {
        const output = mockOutput({ format: "stream-json" });
        return Effect.gen(function* () {
          yield* stackLogs(flags({ follow: true })).pipe(
            Effect.provide(Layer.mergeAll(setupResult.layer, output.layer)),
          );
          expect(output.events).toEqual([
            expect.objectContaining({
              type: "log-entry",
              source: "history",
              line: entries[0]!.message,
            }),
            expect.objectContaining({
              type: "log-entry",
              source: "live",
              line: entries[1]!.message,
            }),
          ]);
        });
      }),
    );
  });

  it.live("finishes follow after printing retained history when the stack is stopped", () => {
    return setup({
      logs: () =>
        Effect.succeed({ entries: [entries[0]!], cursor: { opaque: "1" }, running: false }),
      followLogs: () => Stream.die("follow must not be opened for a stopped stack"),
    }).pipe(
      Effect.flatMap((setupResult) =>
        Effect.gen(function* () {
          yield* stackLogs(flags({ follow: true }));
          expect(setupResult.out.stdoutText).toContain("database ready");
          expect(setupResult.calls.queries).toEqual([{ tail: 100 }]);
        }).pipe(Effect.provide(setupResult.layer)),
      ),
    );
  });

  it.live("rejects legacy output before selecting a stack", () => {
    return setup({}).pipe(
      Effect.flatMap((setupResult) =>
        Effect.gen(function* () {
          const failure = yield* stackLogs(flags()).pipe(Effect.flip);
          expect(failure[ErrorActionabilityId]).toEqual(actionability.provideFlags);
          expect(setupResult.calls.opened).toEqual([]);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(setupResult.layer, Layer.succeed(OutputFlag, Option.some("json"))),
          ),
        ),
      ),
    );
  });

  it.live("rejects JSON follow mode before selecting a stack", () => {
    const out = mockOutput({ format: "json" });
    return setup({}).pipe(
      Effect.flatMap((setupResult) => {
        const layer = Layer.mergeAll(setupResult.layer, out.layer);
        return Effect.gen(function* () {
          const failure = yield* stackLogs(flags({ follow: true })).pipe(Effect.flip);
          expect(failure).toBeInstanceOf(StackCommandLogsError);
          expect(failure[ErrorActionabilityId]).toEqual(actionability.provideFlags);
          expect(failure.suggestion).toContain("stream-json");
          expect(setupResult.calls.opened).toEqual([]);
        }).pipe(Effect.provide(layer));
      }),
    );
  });

  it.live("rejects invalid targets without package calls", () =>
    Effect.gen(function* () {
      const result = yield* setup({});
      const failure = yield* stackLogs(flags({ stackId: Option.some("invalid") })).pipe(
        Effect.flip,
        Effect.provide(result.layer),
      );
      expect(failure[ErrorActionabilityId]).toEqual(actionability.provideFlags);
      expect(result.calls.queries).toEqual([]);
      expect(result.calls.opened).toEqual([]);
    }),
  );

  it.live("classifies an invalid project root as invalid config", () => {
    return setup({
      findFailure: new InvalidProjectRootError({ message: "Project root is invalid" }),
    }).pipe(
      Effect.flatMap((setupResult) =>
        Effect.gen(function* () {
          const failure = yield* stackLogs(flags()).pipe(Effect.flip);
          expect(failure.reason).toBe("invalid-config");
          expect(failure[ErrorActionabilityId]).toEqual(actionability.invalidConfig);
          expect(setupResult.calls.opened).toEqual([]);
        }).pipe(Effect.provide(setupResult.layer)),
      ),
    );
  });

  it.live("gives retry guidance for busy owners and upgrade guidance for old owners", () => {
    return Effect.gen(function* () {
      const busy = yield* setup({
        openFailure: new StackOwnershipConflictError({ message: "Stack owner is busy" }),
      });
      const upgrade = yield* setup({
        openFailure: new StackUpgradeRequiredError({
          expectedRelease: "next",
          actualRelease: "current",
          message: "Stack upgrade required",
        }),
      });
      const busyFailure = yield* stackLogs(flags()).pipe(Effect.flip, Effect.provide(busy.layer));
      const upgradeFailure = yield* stackLogs(flags({ stack: Option.some("feature-a") })).pipe(
        Effect.flip,
        Effect.provide(upgrade.layer),
      );
      expect(busyFailure.suggestion).toContain("no longer running");
      expect(busyFailure.suggestion).toContain("reconcile");
      expect(upgradeFailure.suggestion).toContain("Stop and restart the selected stack");
      expect(upgradeFailure.suggestion).toContain("matches this release");
    });
  });

  it.live("suggests an explicit target when an addressed stack is missing", () => {
    return setup({
      openFailure: new StackNotFoundError({ message: "Stack state was not found" }),
    }).pipe(
      Effect.flatMap((setupResult) =>
        Effect.gen(function* () {
          const failure = yield* stackLogs(flags({ stackId: Option.some(id) })).pipe(Effect.flip);
          expect(failure.suggestion).toBe(
            "Choose an existing stack with --stack or --stack-id, or omit both to use the current project.",
          );
        }).pipe(Effect.provide(setupResult.layer)),
      ),
    );
  });
});
