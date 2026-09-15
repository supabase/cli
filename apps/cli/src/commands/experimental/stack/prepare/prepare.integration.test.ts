import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { CliOutput, Command } from "effect/unstable/cli";
import {
  Cause,
  Deferred,
  Effect,
  FileSystem,
  Exit,
  Fiber,
  Layer,
  Option,
  Path,
  Result,
  Schema,
  Sink,
  Stdio,
  Stream,
} from "effect";
import {
  InvalidStackConfigError,
  StackIdSchema,
  StackPreparationError,
  StackRuntimeMismatchError,
  type EffectStack,
} from "@supabase/stack/effect";
import { OutputFlag } from "../../../../command-internal/global-flags.ts";
import { mockOutput, processEnvLayer } from "../../../../../tests/helpers/mocks.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
} from "../../../../../tests/helpers/command-mocks.ts";
import { StackApi, StackTargetResolver, stackTargetResolverLayer } from "../stack.shared.ts";
import { stackPrepare } from "./prepare.handler.ts";
import { stackPrepareCommand, type StackPrepareFlags } from "./prepare.command.ts";
import { StackCommandPrepareError } from "./prepare.errors.ts";
import { jsonOutputLayer, streamJsonOutputLayer } from "../../../../shared/output/output.layer.ts";
import { textCliOutputFormatter } from "../../../../shared/output/text-formatter.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import {
  actionability,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

const makeProject = (config = 'project_id = "prepare-test"\n') =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-prepare-" });
    yield* fs.makeDirectory(path.join(root, "supabase"));
    yield* fs.writeFileString(path.join(root, "supabase", "config.toml"), config);
    return root;
  }).pipe(Effect.provide(BunServices.layer));

const makeStack = (
  id: string,
  prepare: EffectStack["prepare"],
  calls: { start: number; stop: number; destroy: number } = { start: 0, stop: 0, destroy: 0 },
): EffectStack => ({
  id: StackIdSchema.make(id),
  status: Effect.die("unused"),
  credentials: Effect.die("unused"),
  prepare,
  start: () =>
    Effect.sync(() => {
      calls.start += 1;
    }).pipe(Effect.flatMap(() => Effect.die("start should not be called"))),
  stop: Effect.sync(() => {
    calls.stop += 1;
  }),
  destroy: Effect.sync(() => {
    calls.destroy += 1;
  }),
  logs: () => Effect.die("unused"),
  followLogs: () => Stream.empty,
});

const flags = (overrides: Partial<StackPrepareFlags> = {}): StackPrepareFlags => ({
  stack: Option.none(),
  stackId: Option.none(),
  runtime: "auto",
  capability: [],
  ...overrides,
});

const handlerLayer = (opts: {
  readonly root: string;
  readonly stack: EffectStack;
  readonly output?: ReturnType<typeof mockOutput>;
  readonly telemetry?: ReturnType<typeof mockTelemetryStateTracked>;
  readonly resolver?: Layer.Layer<StackTargetResolver>;
  readonly api?: Layer.Layer<StackApi>;
}) => {
  const output = opts.output ?? mockOutput();
  const telemetry = opts.telemetry ?? mockTelemetryStateTracked();
  return {
    output,
    telemetry,
    layer: Layer.mergeAll(
      BunServices.layer,
      output.layer,
      telemetry.layer,
      mockCommandSettings({ workdir: opts.root }),
      processEnvLayer({}),
      opts.resolver ??
        Layer.succeed(StackTargetResolver, {
          resolve: () => Effect.succeed({ projectRoot: opts.root }),
        }),
      opts.api ??
        Layer.succeed(StackApi, {
          findStack: () => Effect.die("unused"),
          discoverStacks: () => Effect.die("unused"),
          inspectStack: () => Effect.die("unused"),
          openStack: () => Effect.die("unused"),
          createStack: () => Effect.succeed(opts.stack),
        }),
    ),
  };
};

const captureStdio = (stdout: string[], stderr: string[]) => {
  const capture = (target: string[]) =>
    Sink.forEach((chunk: string | Uint8Array) =>
      Effect.sync(() => {
        target.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      }),
    );
  return Layer.succeed(
    Stdio.Stdio,
    Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.empty,
      stdout: () => capture(stdout),
      stderr: () => capture(stderr),
    }),
  );
};

const statefulTaskOutput = () => {
  const state = { active: false, settled: false, failed: false, canceled: false, cleared: false };
  const layer = Layer.succeed(
    Output,
    Output.of({
      format: "text" as const,
      interactive: false,
      intro: () => Effect.void,
      outro: () => Effect.void,
      info: () => Effect.void,
      warn: () => Effect.void,
      error: () => Effect.void,
      event: () => Effect.void,
      task: () =>
        Effect.sync(() => {
          state.active = true;
          return {
            message: () => Effect.void,
            succeed: () =>
              Effect.sync(() => {
                state.settled = true;
              }),
            fail: () =>
              Effect.sync(() => {
                state.failed = true;
                state.settled = true;
              }),
            info: () => Effect.void,
            cancel: () =>
              Effect.sync(() => {
                state.canceled = true;
                state.settled = true;
              }),
            clear: () =>
              Effect.sync(() => {
                state.cleared = true;
                state.settled = true;
              }),
          };
        }),
      promptText: () => Effect.die("unused"),
      promptPassword: () => Effect.die("unused"),
      promptConfirm: () => Effect.die("unused"),
      promptSelect: () => Effect.die("unused"),
      promptMultiSelect: () => Effect.die("unused"),
      progress: () => Effect.die("unused"),
      result: () => Effect.void,
      success: () => Effect.void,
      fail: () => Effect.void,
      raw: () => Effect.void,
      rawBytes: () => Effect.void,
    }),
  );
  return { layer, state };
};

describe("stack prepare", () => {
  it.live("uses all default capabilities and renders the text result", () => {
    return makeProject().pipe(
      Effect.flatMap((root) => {
        let options: Parameters<NonNullable<EffectStack["prepare"]>>[0];
        const id = "a".repeat(64);
        const stack = makeStack(id, (value) =>
          Effect.sync(() => {
            options = value;
            return {
              capabilities: [
                { capability: "database", version: "1", outcome: "cached" as const },
                { capability: "rest", version: "1", outcome: "cached" as const },
              ],
            };
          }),
        );
        const fixture = handlerLayer({ root, stack });
        return stackPrepare(flags()).pipe(
          Effect.provide(fixture.layer),
          Effect.tap(() =>
            Effect.sync(() => {
              expect(options).toMatchObject({ config: expect.anything() });
              expect(options).not.toHaveProperty("capabilities");
              expect(fixture.output.stdoutText).toContain(`Stack ${id} prepared.`);
              expect(fixture.output.stdoutText).toContain("database 1 (cached)");
              expect(fixture.telemetry.flushed).toBe(true);
            }),
          ),
        );
      }),
    );
  });

  it.live("maps a package config error for a disabled capability", () => {
    return makeProject("[studio]\nenabled = false\n").pipe(
      Effect.flatMap((root) => {
        let created = false;
        let prepared = false;
        let receivedConfig: unknown;
        const calls = { start: 0, stop: 0, destroy: 0 };
        const stack = makeStack(
          "2".repeat(64),
          (options) => {
            prepared = true;
            receivedConfig = options?.config;
            return Effect.fail(
              new InvalidStackConfigError({
                message: "Capability studio is disabled",
                capability: "studio",
              }),
            );
          },
          calls,
        );
        const telemetry = mockTelemetryStateTracked();
        const fixture = handlerLayer({
          root,
          stack,
          telemetry,
          api: Layer.succeed(StackApi, {
            findStack: () => Effect.die("unused"),
            discoverStacks: () => Effect.die("unused"),
            inspectStack: () => Effect.die("unused"),
            openStack: () => Effect.die("unused"),
            createStack: () => {
              created = true;
              return Effect.succeed(stack);
            },
          }),
        });
        return stackPrepare(flags({ capability: ["studio"] })).pipe(
          Effect.flip,
          Effect.provide(fixture.layer),
          Effect.tap((error) =>
            Effect.sync(() => {
              expect(error).toBeInstanceOf(StackCommandPrepareError);
              expect(error.reason).toBe("invalid-config");
              expect(error[ErrorActionabilityId]).toEqual(actionability.invalidConfig);
              expect(error.message).toContain("Capability studio is disabled");
              expect(error.suggestion).toBeUndefined();
              expect(receivedConfig).toMatchObject({
                capabilities: { studio: { enabled: false } },
              });
              expect(created).toBe(true);
              expect(prepared).toBe(true);
              expect(calls).toEqual({ start: 0, stop: 0, destroy: 0 });
              expect(telemetry.flushed).toBe(true);
            }),
          ),
        );
      }),
    );
  });

  it.live("parses repeated capabilities into the handler and serializes JSON results", () => {
    const formats = ["json", "stream-json"] as const;
    return Effect.forEach(formats, (format) => {
      return makeProject().pipe(
        Effect.flatMap((root) => {
          const stdout: string[] = [];
          let options: Parameters<NonNullable<EffectStack["prepare"]>>[0];
          const id = "b".repeat(64);
          const stack = makeStack(id, (value) =>
            Effect.sync(() => {
              options = value;
              return {
                capabilities: [
                  { capability: "rest", version: "1", outcome: "downloaded" as const },
                  { capability: "auth", version: "2", outcome: "cached" as const },
                ],
              };
            }),
          );
          const telemetry = mockTelemetryStateTracked();
          const machineOutput = (format === "json" ? jsonOutputLayer : streamJsonOutputLayer).pipe(
            Layer.provide(captureStdio(stdout, [])),
          );
          const command = stackPrepareCommand.pipe(
            Command.withHandler((value) => stackPrepare(value)),
          );
          const layer = Layer.mergeAll(
            BunServices.layer,
            CliOutput.layer(textCliOutputFormatter()),
            machineOutput,
            telemetry.layer,
            mockCommandSettings({ workdir: root }),
            processEnvLayer({}),
            Layer.succeed(StackTargetResolver, {
              resolve: () => Effect.succeed({ projectRoot: root }),
            }),
            Layer.succeed(StackApi, {
              findStack: () => Effect.die("unused"),
              discoverStacks: () => Effect.die("unused"),
              inspectStack: () => Effect.die("unused"),
              openStack: () => Effect.die("unused"),
              createStack: () => Effect.succeed(stack),
            }),
          );
          return Command.runWith(command, { version: "0.0.0-test" })([
            "--capability",
            "rest",
            "--capability",
            "auth",
          ]).pipe(
            Effect.provide(layer),
            Effect.tap(() =>
              Effect.sync(() => {
                expect(options).toMatchObject({ capabilities: ["rest", "auth"] });
                expect(telemetry.flushed).toBe(true);
              }),
            ),
            Effect.flatMap(() =>
              Effect.sync(() => {
                if (stdout.length === 0) throw new Error("no stdout");
                return stdout.at(-1)!.trim();
              }),
            ),
            Effect.flatMap((line) =>
              Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(line),
            ),
            Effect.tap((result) =>
              Effect.sync(() => {
                const data = {
                  id,
                  capabilities: [
                    { capability: "rest", version: "1", outcome: "downloaded" },
                    { capability: "auth", version: "2", outcome: "cached" },
                  ],
                };
                expect(result).toEqual(
                  format === "json"
                    ? { ...data, message: "" }
                    : {
                        type: "result",
                        data: { ...data, message: "" },
                        timestamp: expect.any(String),
                      },
                );
              }),
            ),
          );
        }),
      );
    });
  });

  it.live("opens an inspected stack and loads configuration from its project root", () => {
    return Effect.gen(function* () {
      const callerRoot = yield* makeProject();
      const inspectedRoot = yield* makeProject("[api]\nport = 55432\n");
      const id = "c".repeat(64);
      let inspected = false;
      let opened: string | undefined;
      let preparedConfig: unknown;
      const stack = makeStack(id, (value) =>
        Effect.sync(() => {
          preparedConfig = value?.config;
          return { capabilities: [] };
        }),
      );
      const api = Layer.succeed(StackApi, {
        findStack: () => Effect.die("unused"),
        discoverStacks: () => Effect.die("unused"),
        inspectStack: () =>
          Effect.sync(() => {
            inspected = true;
            return {
              descriptor: {
                id: StackIdSchema.make(id),
                projectRoot: inspectedRoot,
                name: "existing",
                branchContext: "existing-branch",
                runtime: { kind: "native" as const },
                desiredLifecycle: "stopped" as const,
              },
              owner: "absent" as const,
            };
          }),
        openStack: (stackId) =>
          Effect.sync(() => {
            opened = stackId;
            return stack;
          }),
        createStack: () => Effect.die("must not create an existing stack"),
      });
      const fixture = handlerLayer({
        root: callerRoot,
        stack,
        resolver: stackTargetResolverLayer,
        api,
      });
      return yield* stackPrepare(flags({ stackId: Option.some(id) })).pipe(
        Effect.provide(fixture.layer),
        Effect.tap(() =>
          Effect.sync(() => {
            expect(inspected).toBe(true);
            expect(opened).toBe(id);
            expect(preparedConfig).toMatchObject({ listeners: { api: { port: 55432 } } });
          }),
        ),
      );
    });
  });

  it.live("rejects invalid config before creating a stack", () => {
    return makeProject("project_id = [\n").pipe(
      Effect.flatMap((root) => {
        let created = false;
        const stack = makeStack("d".repeat(64), () => Effect.die("must not prepare"));
        const fixture = handlerLayer({
          root,
          stack,
          api: Layer.succeed(StackApi, {
            findStack: () => Effect.die("unused"),
            discoverStacks: () => Effect.die("unused"),
            inspectStack: () => Effect.die("unused"),
            openStack: () => Effect.die("unused"),
            createStack: () => {
              created = true;
              return Effect.succeed(stack);
            },
          }),
        });
        return stackPrepare(flags()).pipe(
          Effect.flip,
          Effect.provide(fixture.layer),
          Effect.tap((error) =>
            Effect.sync(() => {
              expect(error.reason).toBe("invalid-config");
              expect(created).toBe(false);
              expect(fixture.telemetry.flushed).toBe(true);
            }),
          ),
        );
      }),
    );
  });

  it.live("rejects invalid targets and the legacy output flag before preparation", () => {
    return makeProject().pipe(
      Effect.flatMap((targetRoot) => {
        let resolved = false;
        const stack = makeStack("e".repeat(64), () => Effect.die("must not prepare"));
        const telemetry = mockTelemetryStateTracked();
        const output = mockOutput();
        const fixture = handlerLayer({
          root: targetRoot,
          stack,
          telemetry,
          output,
          resolver: Layer.succeed(StackTargetResolver, {
            resolve: () => {
              resolved = true;
              return Effect.die("must not resolve invalid flags");
            },
          }),
        });
        const invalidTarget = stackPrepare(
          flags({ stack: Option.some("feature"), stackId: Option.some("e".repeat(64)) }),
        ).pipe(Effect.flip, Effect.provide(fixture.layer));
        const legacy = stackPrepare(flags()).pipe(
          Effect.flip,
          Effect.provide(
            Layer.mergeAll(fixture.layer, Layer.succeed(OutputFlag, Option.some("json"))),
          ),
        );
        return Effect.gen(function* () {
          const targetError = yield* invalidTarget;
          expect(targetError.reason).toBe("flags");
          expect(resolved).toBe(false);
          expect(telemetry.flushed).toBe(true);
          const legacyError = yield* legacy;
          expect(legacyError.reason).toBe("flags");
          expect(output.stdoutText).toBe("");
        });
      }),
    );
  });

  it.live("reports typed preparation failures through the task and flushes telemetry", () => {
    return makeProject().pipe(
      Effect.flatMap((root) => {
        const telemetry = mockTelemetryStateTracked();
        const output = mockOutput();
        const stack = makeStack("f".repeat(64), () =>
          Effect.fail(new StackPreparationError({ message: "artifact failed" })),
        );
        const fixture = handlerLayer({ root, stack, output, telemetry });
        return stackPrepare(flags()).pipe(
          Effect.flip,
          Effect.provide(fixture.layer),
          Effect.tap((error) =>
            Effect.sync(() => {
              expect(error).toBeInstanceOf(StackCommandPrepareError);
              expect(error.reason).toBe("artifact");
              expect(output.messages).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({ type: "error", message: "artifact failed" }),
                ]),
              );
              expect(telemetry.flushed).toBe(true);
            }),
          ),
        );
      }),
    );
  });

  it.live("suggests omitting runtime when a named stack has a runtime mismatch", () => {
    return makeProject().pipe(
      Effect.flatMap((root) => {
        const stack = makeStack("0".repeat(64), () => Effect.die("must not prepare"));
        const telemetry = mockTelemetryStateTracked();
        const fixture = handlerLayer({
          root,
          stack,
          telemetry,
          resolver: Layer.succeed(StackTargetResolver, {
            resolve: () =>
              Effect.succeed({ projectRoot: root, name: "feature", runtime: { kind: "native" } }),
          }),
          api: Layer.succeed(StackApi, {
            findStack: () => Effect.die("unused"),
            discoverStacks: () => Effect.die("unused"),
            inspectStack: () => Effect.die("unused"),
            openStack: () => Effect.die("unused"),
            createStack: () =>
              Effect.fail(new StackRuntimeMismatchError({ message: "runtime mismatch" })),
          }),
        });
        return stackPrepare(flags({ stack: Option.some("feature"), runtime: "native" })).pipe(
          Effect.flip,
          Effect.provide(fixture.layer),
          Effect.tap((error) =>
            Effect.sync(() => {
              expect(error.reason).toBe("flags");
              expect(error.suggestion).toBe(
                "Omit --runtime to reuse the existing runtime, or choose a different --stack name.",
              );
              expect(telemetry.flushed).toBe(true);
            }),
          ),
        );
      }),
    );
  });

  it.live(
    "cancels preparation on interruption without lifecycle calls and flushes telemetry",
    () => {
      return makeProject().pipe(
        Effect.flatMap((root) => {
          const started = Deferred.makeUnsafe<void>();
          const calls = { start: 0, stop: 0, destroy: 0 };
          let canceled = false;
          const telemetry = mockTelemetryStateTracked();
          const stack = makeStack(
            "1".repeat(64),
            () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined);
                return yield* Effect.never.pipe(Effect.as({ capabilities: [] }));
              }).pipe(Effect.ensuring(Effect.sync(() => (canceled = true)))),
            calls,
          );
          const fixture = handlerLayer({ root, stack, telemetry });
          const taskOutput = statefulTaskOutput();
          return Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(
              Effect.provide(
                stackPrepare(flags()),
                Layer.mergeAll(fixture.layer, taskOutput.layer),
              ),
            );
            yield* Deferred.await(started);
            yield* Fiber.interrupt(fiber);
            expect(canceled).toBe(true);
            expect(taskOutput.state.active).toBe(true);
            expect(taskOutput.state.settled).toBe(true);
            expect(taskOutput.state.failed).toBe(false);
            expect(taskOutput.state.canceled || taskOutput.state.cleared).toBe(true);
            expect(calls).toEqual({ start: 0, stop: 0, destroy: 0 });
            expect(telemetry.flushed).toBe(true);
          });
        }),
      );
    },
  );

  it.live("settles the task on a preparation defect while preserving the defect", () => {
    return makeProject().pipe(
      Effect.flatMap((root) => {
        const stack = makeStack("3".repeat(64), () => Effect.die("preparation defect"));
        const fixture = handlerLayer({ root, stack });
        const taskOutput = statefulTaskOutput();
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(
            Effect.provide(stackPrepare(flags()), Layer.mergeAll(fixture.layer, taskOutput.layer)),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const defect = Cause.findDefect(exit.cause);
            expect(Result.isSuccess(defect)).toBe(true);
            if (Result.isSuccess(defect)) expect(defect.success).toBe("preparation defect");
          }
          expect(taskOutput.state.settled).toBe(true);
          expect(taskOutput.state.canceled).toBe(false);
          expect(taskOutput.state.failed).toBe(true);
        });
      }),
    );
  });
});
