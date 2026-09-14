// oxlint-disable-next-line effecttsgo/node-builtin-import -- filesystem fixture cleanup
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- filesystem fixture paths
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { CliOutput, Command } from "effect/unstable/cli";
import { Deferred, Effect, Fiber, Layer, Option, Schema, Sink, Stdio, Stream } from "effect";
import { StackIdSchema, StackPreparationError, type EffectStack } from "@supabase/stack/effect";
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

const makeProject = (config = 'project_id = "prepare-test"\n') => {
  const root = mkdtempSync(join(tmpdir(), "supabase-stack-prepare-"));
  mkdirSync(join(root, "supabase"));
  writeFileSync(join(root, "supabase", "config.toml"), config);
  return root;
};

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

describe("stack prepare", () => {
  it.live("uses all default capabilities and renders the text result", () => {
    const root = makeProject();
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
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.live("parses repeated capabilities into the handler and serializes JSON results", () => {
    const formats = ["json", "stream-json"] as const;
    return Effect.forEach(formats, (format) => {
      const root = makeProject();
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
      const command = stackPrepareCommand.pipe(Command.withHandler((value) => stackPrepare(value)));
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
        Effect.flatMap((line) => Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(line)),
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
                : { type: "result", data: { ...data, message: "" }, timestamp: expect.any(String) },
            );
          }),
        ),
        Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
      );
    });
  });

  it.live("opens an inspected stack and loads configuration from its project root", () => {
    const callerRoot = makeProject();
    const inspectedRoot = makeProject("[api]\nport = 55432\n");
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
    return stackPrepare(flags({ stackId: Option.some(id) })).pipe(
      Effect.provide(fixture.layer),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(inspected).toBe(true);
          expect(opened).toBe(id);
          expect(preparedConfig).toMatchObject({ listeners: { api: { port: 55432 } } });
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(callerRoot, { recursive: true, force: true });
          rmSync(inspectedRoot, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.live("rejects invalid config before creating a stack", () => {
    const root = makeProject("project_id = [\n");
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
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.live("rejects invalid targets and the legacy output flag before preparation", () => {
    const targetRoot = makeProject();
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
      Effect.provide(Layer.mergeAll(fixture.layer, Layer.succeed(OutputFlag, Option.some("json")))),
    );
    return Effect.gen(function* () {
      const targetError = yield* invalidTarget;
      expect(targetError.reason).toBe("flags");
      expect(resolved).toBe(false);
      expect(telemetry.flushed).toBe(true);
      const legacyError = yield* legacy;
      expect(legacyError.reason).toBe("flags");
      expect(output.stdoutText).toBe("");
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(targetRoot, { recursive: true, force: true }))),
    );
  });

  it.live("reports typed preparation failures through the task and flushes telemetry", () => {
    const root = makeProject();
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
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.live(
    "cancels preparation on interruption without lifecycle calls and flushes telemetry",
    () => {
      const root = makeProject();
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
      return Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.provide(stackPrepare(flags()), fixture.layer));
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        expect(canceled).toBe(true);
        expect(calls).toEqual({ start: 0, stop: 0, destroy: 0 });
        expect(telemetry.flushed).toBe(true);
      }).pipe(Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))));
    },
  );
});
