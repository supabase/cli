import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path, Redacted, Stream } from "effect";
import {
  StackIdSchema,
  StackPreparationError,
  StackRuntimeError,
  StackStateInvalidError,
  StackCleanupError,
  type EffectStack,
  type StackStatus,
  type StackConfig,
} from "@supabase/stack/effect";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
} from "../../../../../tests/helpers/command-mocks.ts";
import { StackApi, StackTargetResolver } from "../stack.shared.ts";
import { stackRestart } from "./restart.handler.ts";
import { stackStart } from "../start/start.handler.ts";
import { stackStop } from "../stop/stop.handler.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { ExperimentalFlag, OutputFlag } from "../../../../command-internal/global-flags.ts";
import { DbConnection } from "../../../../command-internal/db-connection.service.ts";
import { noopStackCatalogSetupLayer } from "../../../../command-internal/stack-catalog-setup.ts";

const id = StackIdSchema.make("a".repeat(64));
const project = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-restart-" });
    yield* fs.makeDirectory(path.join(root, "supabase"), { recursive: true });
    yield* fs.writeFileString(
      path.join(root, "supabase", "config.toml"),
      "[api]\nmax_rows = 1234\n",
    );
    return root;
  });
const status = (): StackStatus => ({
  id,
  lifecycle: "running",
  desiredLifecycle: "running",
  runtime: { kind: "native" },
  endpoints: {},
  versions: {},
  capabilities: [],
  artifacts: [],
});

const flags = (overrides: Partial<Parameters<typeof stackRestart>[0]> = {}) => ({
  stack: Option.none<string>(),
  stackId: Option.none<string>(),
  ...overrides,
});

const fixture = (options: {
  stop?: "ok" | "fail";
  start?: "ok" | "fail";
  format?: "text" | "json";
  config?: "valid" | "invalid";
  found?: boolean;
  unconfigured?: boolean;
  startRuntimeFailure?: boolean;
  inspectFailure?: boolean;
}) =>
  Effect.gen(function* () {
    const root = yield* project();
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (options.config === "invalid")
      yield* fs.writeFileString(
        path.join(root, "supabase", "config.toml"),
        'project_id = "unterminated\n',
      );
    const calls: string[] = [];
    let lifecycle: StackStatus["lifecycle"] = "running";
    let startedConfig: unknown;
    let selectedName: string | undefined;
    const output = mockOutput({ format: options.format });
    const telemetry = mockTelemetryStateTracked();
    const stack: EffectStack = {
      id,
      status: Effect.sync(() => ({ ...status(), lifecycle })),
      credentials: Effect.die("unused"),
      prepare: () => Effect.die("restart must not prepare explicitly"),
      resetDatabase: Effect.die("unused"),
      stop: Effect.gen(function* () {
        calls.push("stop");
        if (options.stop === "fail")
          return yield* new StackCleanupError({ message: "stop failed" });
        lifecycle = "stopped";
      }),
      start: (input) =>
        Effect.sync(() => calls.push("start")).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              startedConfig = input?.config;
            }),
          ),
          Effect.flatMap(() =>
            options.start === "fail"
              ? Effect.fail(
                  options.startRuntimeFailure === true
                    ? new StackRuntimeError({ message: "runtime failed" })
                    : new StackPreparationError({ message: "start failed" }),
                )
              : Effect.sync(() => {
                  lifecycle = "running";
                  return status();
                }),
          ),
        ),
      destroy: Effect.die("unused"),
      logs: () => Effect.die("unused"),
      followLogs: () => Stream.empty,
    };
    const layer = Layer.mergeAll(
      output.layer,
      telemetry.layer,
      mockCommandSettings({ workdir: root }),
      Layer.succeed(StackApi, {
        findStack: ({ projectRoot, name }) =>
          Effect.sync(() => {
            selectedName = name;
            return options.found === false || projectRoot !== root
              ? Option.none()
              : Option.some({
                  id,
                  projectRoot: root,
                  name: name ?? "restart-test",
                  branchContext: "default",
                  runtime: { kind: "native" as const },
                  desiredLifecycle: options.unconfigured
                    ? ("unconfigured" as const)
                    : ("running" as const),
                });
          }),
        createStack: () => Effect.die("create must not run"),
        openStack: () => Effect.succeed(stack),
        inspectStack: () =>
          options.inspectFailure
            ? Effect.fail(new StackStateInvalidError({ message: "inspect failed" }))
            : Effect.succeed({
                descriptor: {
                  id,
                  projectRoot: root,
                  name: "restart-test",
                  branchContext: "default",
                  runtime: { kind: "native" as const },
                  desiredLifecycle: options.unconfigured
                    ? ("unconfigured" as const)
                    : ("running" as const),
                },
                owner: "running" as const,
              }),
        discoverStacks: () => Effect.succeed({ stacks: [], errors: [] }),
      }),
      BunServices.layer,
    );
    return {
      root,
      calls,
      output,
      telemetry,
      layer,
      get lifecycle() {
        return lifecycle;
      },
      get startedConfig() {
        return startedConfig;
      },
      get selectedName() {
        return selectedName;
      },
    };
  }).pipe(Effect.provide(BunServices.layer));

describe("stack restart", () => {
  it.live("stops and starts the saved stack configuration", () => {
    return fixture({}).pipe(
      Effect.flatMap((setup) =>
        stackRestart(flags()).pipe(
          Effect.provide(setup.layer),
          Effect.tap(() =>
            Effect.sync(() => {
              expect(setup.calls).toEqual(["stop", "start"]);
              expect(setup.lifecycle).toBe("running");
              expect(setup.startedConfig).toBeUndefined();
              expect(setup.telemetry.flushed).toBe(true);
              expect(setup.output.stdoutText).toContain(`Stack ${id}`);
            }),
          ),
        ),
      ),
    );
  });

  it.live("does not start when stopping fails", () => {
    return fixture({ stop: "fail" }).pipe(
      Effect.flatMap((setup) =>
        stackRestart(flags()).pipe(
          Effect.provide(setup.layer),
          Effect.flip,
          Effect.tap((error) =>
            Effect.sync(() => {
              expect(error.message).toContain("stop failed");
              expect(error.reason).toBe("unknown");
              expect(error.suggestion).toContain("--debug");
              expect(error.suggestion).toContain("cleanup");
              expect(setup.calls).toEqual(["stop"]);
            }),
          ),
        ),
      ),
    );
  });

  it.live("leaves the stack stopped and recoverable when start fails", () => {
    return fixture({ start: "fail" }).pipe(
      Effect.flatMap((setup) =>
        stackRestart(flags()).pipe(
          Effect.provide(setup.layer),
          Effect.flip,
          Effect.tap((error) =>
            Effect.sync(() => {
              expect(error.message).toContain("start failed");
              expect(setup.calls).toEqual(["stop", "start"]);
              expect(setup.lifecycle).toBe("stopped");
              expect(setup.telemetry.flushed).toBe(true);
            }),
          ),
        ),
      ),
    );
  });

  it.live("reuses saved configuration for an id target", () => {
    return fixture({ format: "json", config: "invalid" }).pipe(
      Effect.flatMap((setup) =>
        stackRestart(flags({ stackId: Option.some(id) })).pipe(
          Effect.provide(setup.layer),
          Effect.tap(() =>
            Effect.sync(() => {
              expect(setup.startedConfig).toBeUndefined();
              expect(
                setup.output.messages.find(({ type }) => type === "success")?.data,
              ).toMatchObject({
                id,
                lifecycle: "running",
              });
            }),
          ),
        ),
      ),
    );
  });

  it.live("fails without lifecycle calls when no existing stack is found", () => {
    return fixture({ found: false }).pipe(
      Effect.flatMap((setup) =>
        stackRestart(flags()).pipe(
          Effect.provide(setup.layer),
          Effect.flip,
          Effect.tap((error) =>
            Effect.sync(() => {
              expect(error.reason).toBe("not-found");
              expect(setup.calls).toEqual([]);
            }),
          ),
        ),
      ),
    );
  });

  it.live("selects a named existing stack", () => {
    return fixture({}).pipe(
      Effect.flatMap((setup) =>
        stackRestart(flags({ stack: Option.some("feature-a") })).pipe(
          Effect.provide(setup.layer),
          Effect.tap(() => Effect.sync(() => expect(setup.selectedName).toBe("feature-a"))),
        ),
      ),
    );
  });

  it.live("reports an actionable error for a missing named stack", () => {
    return fixture({ found: false }).pipe(
      Effect.flatMap((setup) =>
        stackRestart(flags({ stack: Option.some("missing") })).pipe(
          Effect.provide(setup.layer),
          Effect.flip,
          Effect.tap((error) =>
            Effect.sync(() => {
              expect(setup.selectedName).toBe("missing");
              expect(error.message).toContain('No managed stack named "missing"');
              expect(error.suggestion).toContain("existing --stack name");
            }),
          ),
        ),
      ),
    );
  });

  it.live("rejects an unconfigured current stack before stopping", () => {
    return fixture({ unconfigured: true }).pipe(
      Effect.flatMap((setup) =>
        stackRestart(flags()).pipe(
          Effect.provide(setup.layer),
          Effect.flip,
          Effect.tap((error) =>
            Effect.sync(() => {
              expect(error.reason).toBe("lifecycle");
              expect(error.suggestion).toContain("Run supabase stack start");
              expect(setup.calls).toEqual([]);
            }),
          ),
        ),
      ),
    );
  });

  it.live("rejects an unconfigured id target before stopping", () => {
    return fixture({ unconfigured: true }).pipe(
      Effect.flatMap((setup) =>
        stackRestart(flags({ stackId: Option.some(id) })).pipe(
          Effect.provide(setup.layer),
          Effect.flip,
          Effect.tap((error) =>
            Effect.sync(() => {
              expect(error.reason).toBe("lifecycle");
              expect(setup.calls).toEqual([]);
            }),
          ),
        ),
      ),
    );
  });

  it.live("provides retry guidance for runtime failures", () => {
    return fixture({ start: "fail", startRuntimeFailure: true }).pipe(
      Effect.flatMap((setup) =>
        stackRestart(flags()).pipe(
          Effect.provide(setup.layer),
          Effect.flip,
          Effect.tap((error) =>
            Effect.sync(() => {
              expect(error.reason).toBe("unknown");
              expect(error.suggestion).toContain("--debug");
            }),
          ),
        ),
      ),
    );
  });

  it.live("short circuits invalid target and output flags before lifecycle", () => {
    return fixture({}).pipe(
      Effect.flatMap((setup) => {
        const invalidTarget = stackRestart(
          flags({ stack: Option.some("named"), stackId: Option.some(id) }),
        ).pipe(Effect.provide(setup.layer), Effect.flip);
        const outputRejected = stackRestart(flags()).pipe(
          Effect.provide(Layer.merge(setup.layer, Layer.succeed(OutputFlag, Option.some("json")))),
          Effect.flip,
        );
        return Effect.gen(function* () {
          expect((yield* invalidTarget).reason).toBe("flags");
          expect((yield* outputRejected).reason).toBe("flags");
          expect(setup.calls).toEqual([]);
        });
      }),
    );
  });

  it.live("short circuits an ID inspection failure before lifecycle", () => {
    return fixture({ inspectFailure: true }).pipe(
      Effect.flatMap((setup) =>
        stackRestart(flags({ stackId: Option.some(id) })).pipe(
          Effect.provide(setup.layer),
          Effect.flip,
          Effect.tap((error) =>
            Effect.sync(() => {
              expect(error.reason).toBe("invalid-config");
              expect(setup.calls).toEqual([]);
            }),
          ),
        ),
      ),
    );
  });

  it.live(
    "preserves effective start options through restart and reloads them on plain start",
    () => {
      return project().pipe(
        Effect.flatMap((root) => {
          const output = mockOutput({ format: "json" });
          const telemetry = mockTelemetryStateTracked();
          const calls: string[] = [];
          let lifecycle: StackStatus["lifecycle"] = "stopped";
          const persisted: { config?: StackConfig } = {};
          const state = () => ({
            id,
            lifecycle,
            desiredLifecycle: "running" as const,
            runtime: { kind: "native" as const },
            endpoints: {},
            versions: {},
            capabilities: [],
            artifacts: [],
          });
          const stack: EffectStack = {
            id,
            status: Effect.sync(state),
            credentials: Effect.succeed({
              database: {
                url: Redacted.make("postgresql://postgres:secret@127.0.0.1:54329/postgres"),
                password: Redacted.make("secret"),
              },
            }),
            prepare: () => Effect.die("restart must not prepare explicitly"),
            resetDatabase: Effect.die("unused"),
            stop: Effect.sync(() => {
              calls.push("stop");
              lifecycle = "stopped";
            }),
            start: (input) =>
              Effect.sync(() => {
                calls.push("start");
                if (input?.config !== undefined) persisted.config = input.config;
                lifecycle = "running";
                return state();
              }),
            destroy: Effect.die("unused"),
            logs: () => Effect.die("unused"),
            followLogs: () => Stream.empty,
          };
          const descriptor = {
            id,
            projectRoot: root,
            name: "restart-flow",
            branchContext: "default",
            runtime: { kind: "native" as const },
            desiredLifecycle: "running" as const,
          };
          const layer = Layer.mergeAll(
            output.layer,
            telemetry.layer,
            mockCommandSettings({ workdir: root }),
            Layer.succeed(StackTargetResolver, {
              resolve: ({ id: targetId }) =>
                Effect.succeed({
                  projectRoot: root,
                  ...(targetId === undefined ? {} : { id: StackIdSchema.make(targetId) }),
                }),
            }),
            Layer.succeed(StackApi, {
              findStack: () => Effect.succeed(Option.some(descriptor)),
              createStack: () => Effect.succeed(stack),
              openStack: () => Effect.succeed(stack),
              inspectStack: () => Effect.die("inspect unused"),
              discoverStacks: () => Effect.succeed({ stacks: [], errors: [] }),
            }),
            BunServices.layer,
            noopStackCatalogSetupLayer,
            Layer.succeed(ExperimentalFlag, false),
            Layer.succeed(CliArgs, { args: ["stack", "start"] }),
            Layer.succeed(DbConnection, {
              connect: () =>
                Effect.succeed({
                  exec: () => Effect.void,
                  query: () => Effect.succeed([]),
                  execBatch: () => Effect.void,
                  extensionExists: () => Effect.succeed(false),
                  copyToCsv: () => Effect.succeed(new Uint8Array()),
                  queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
                }),
            }),
          );
          const initialStart = {
            exclude: ["studio"],
            stack: Option.none<string>(),
            stackId: Option.none<string>(),
            runtime: "auto" as const,
            preparation: "on-demand" as const,
            eager: true,
          };
          const plainStart = {
            exclude: [],
            stack: Option.none<string>(),
            stackId: Option.none<string>(),
            runtime: "auto" as const,
            preparation: "background" as const,
            eager: false,
          };
          const stopFlags = {
            all: Option.none<boolean>(),
            stack: Option.none<string>(),
            stackId: Option.none<string>(),
          };
          return Effect.gen(function* () {
            yield* stackStart(initialStart);
            expect(persisted.config).toMatchObject({
              preparation: "on-demand",
              capabilities: {
                studio: { enabled: false },
                rest: { activation: "eager" },
              },
            });
            const saved = persisted.config;
            yield* stackRestart(flags());
            expect(persisted.config).toBe(saved);
            yield* stackStop(stopFlags);
            yield* stackStart(plainStart);
            expect(persisted.config).toMatchObject({
              preparation: "background",
              capabilities: {
                studio: { settings: {} },
                rest: { settings: { max_rows: 1234 } },
              },
            });
            expect(persisted.config?.capabilities?.studio?.enabled).not.toBe(false);
            expect(persisted.config?.capabilities?.rest).not.toHaveProperty("activation", "eager");
            expect(calls).toEqual(["start", "stop", "start", "stop", "start"]);
          }).pipe(Effect.provide(layer));
        }),
        Effect.provide(BunServices.layer),
      );
    },
  );
});
