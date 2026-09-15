import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, FileSystem, Fiber, Layer, Option, Path, Schema, Stream } from "effect";
import { runtimeInfoLayer } from "../../../../shared/runtime/runtime-info.layer.ts";
import { CliOutput, Command } from "effect/unstable/cli";
import {
  ContainerEngineError,
  ContainerPullError,
  StackConfigSchema,
  StackIdSchema,
  StackRuntimeError,
  StackStateInvalidError,
} from "@supabase/stack/effect";
import type {
  EffectStack,
  StackStartError as ApiStackStartError,
  StackStatus,
} from "@supabase/stack/effect";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
} from "../../../../../tests/helpers/command-mocks.ts";
import { mockContextualAnalytics, mockProcessControl } from "../../../../../tests/helpers/mocks.ts";
import {
  stackApiLayer,
  StackTargetError,
  StackTargetResolver,
  stackTargetResolverLayer,
  StackApi,
} from "../stack.shared.ts";
import { stackStart } from "./start.handler.ts";
import { compileStack } from "../../../../../../../packages/stack/src/model/Compiler.ts";
import { StackCommandStartError } from "./start.errors.ts";
import { stackStartCommand } from "./start.command.ts";
import { textCliOutputFormatter } from "../../../../shared/output/text-formatter.ts";
import { commandRuntimeLayer } from "../../../../shared/runtime/command-runtime.layer.ts";
import { OutputFlag } from "../../../../command-internal/global-flags.ts";
import {
  actionability,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

const project = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "supabase-experimental-stack-start-",
    });
    yield* fs.makeDirectory(path.join(root, "supabase"), { recursive: true });
    yield* fs.writeFileString(
      path.join(root, "supabase", "config.toml"),
      'project_id = "start-test"\n',
    );
    return root;
  }).pipe(Effect.provide(BunServices.layer));

const emptyProject = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectoryScoped({
      prefix: "supabase-experimental-stack-start-empty-",
    });
  }).pipe(Effect.provide(BunServices.layer));

const resolverLayer = stackTargetResolverLayer.pipe(
  Layer.provideMerge(stackApiLayer),
  Layer.provide(BunServices.layer),
);

const status = (id: string, runtime: "native" | "container" = "native") =>
  ({
    id: StackIdSchema.make(id),
    lifecycle: "running",
    desiredLifecycle: "running",
    runtime: runtime === "native" ? { kind: "native" } : { kind: "container", engine: "docker" },
    endpoints: {},
    versions: {},
    capabilities: (
      [
        "database",
        "rest",
        "auth",
        "realtime",
        "storage",
        "functions",
        "studio",
        "mail",
        "analytics",
        "pooler",
      ] as const
    ).map((name) => ({
      name,
      activation: name === "database" ? ("eager" as const) : ("lazy" as const),
      state: "ready" as const,
    })),
    artifacts: [],
  }) satisfies StackStatus;

function fakeStack(
  id: string,
  start: (config?: { readonly config?: unknown }) => Effect.Effect<StackStatus, ApiStackStartError>,
) {
  return {
    id: StackIdSchema.make(id),
    status: Effect.succeed(status(id)),
    credentials: Effect.die("credentials not used in start test"),
    prepare: () => Effect.die("prepare not used in start test"),
    start,
    stop: Effect.void,
    destroy: Effect.die("destroy not used in start test"),
    logs: () => Effect.die("logs not used in start test"),
    followLogs: () => Stream.empty,
  } satisfies EffectStack;
}

const flags = (
  overrides: Partial<Parameters<typeof stackStart>[0]> = {},
): Parameters<typeof stackStart>[0] => ({
  exclude: [],
  stack: Option.none<string>(),
  stackId: Option.none<string>(),
  runtime: "auto" as const,
  preparation: "background" as const,
  eager: false,
  ...overrides,
});

function handlerLayer(opts: {
  root: string;
  target: {
    projectRoot: string;
    name?: string;
    id?: string;
    runtime?: { kind: "native" } | { kind: "container"; engine: "docker" };
  };
  stack: EffectStack;
  onCreate?: (options: unknown) => void;
  onOpen?: () => void;
}) {
  const out = mockOutput();
  const telemetry = mockTelemetryStateTracked();
  const { id, ...targetWithoutId } = opts.target;
  const targetLayer = Layer.succeed(StackTargetResolver, {
    resolve: () =>
      Effect.succeed(
        id === undefined ? targetWithoutId : { ...targetWithoutId, id: StackIdSchema.make(id) },
      ),
  });
  const apiLayer = Layer.succeed(StackApi, {
    findStack: () => Effect.succeed(Option.none()),
    createStack: (options) => {
      opts.onCreate?.(options);
      return Effect.succeed(opts.stack);
    },
    openStack: () => {
      opts.onOpen?.();
      return Effect.succeed(opts.stack);
    },
    inspectStack: () => Effect.die("inspect not used in handler test"),
    discoverStacks: () => Effect.succeed({ stacks: [], errors: [] }),
  });
  return {
    out,
    telemetry,
    layer: Layer.mergeAll(
      out.layer,
      telemetry.layer,
      mockCommandSettings({ workdir: opts.root }),
      targetLayer,
      apiLayer,
      BunServices.layer,
      runtimeInfoLayer,
    ),
  };
}

describe("stack start targeting", () => {
  for (const exclusion of ["rest", "analytics"] as const) {
    it.live(`compiles ${exclusion} exclusion and dependent Studio`, () => {
      return project().pipe(
        Effect.flatMap((root) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const configBefore = yield* fs.readFileString(
              path.join(root, "supabase", "config.toml"),
            );
            const stack = fakeStack("c".repeat(64), (input) =>
              Effect.gen(function* () {
                const stackConfig = yield* Schema.decodeUnknownEffect(StackConfigSchema)(
                  input?.config,
                ).pipe(
                  Effect.mapError(
                    (error) => new StackStateInvalidError({ message: error.message }),
                  ),
                );
                const compiled = yield* compileStack({
                  projectRoot: root,
                  runtime: { kind: "native" },
                  config: stackConfig,
                }).pipe(
                  Effect.mapError(
                    (error) => new StackStateInvalidError({ message: error.message }),
                  ),
                  Effect.provide(Layer.mergeAll(BunServices.layer, runtimeInfoLayer)),
                );
                expect(compiled.definition.capabilities[exclusion].enabled).toBe(false);
                expect(compiled.definition.capabilities.studio.enabled).toBe(false);
                expect(compiled.definition.capabilities.auth.enabled).toBe(true);
                return status("c".repeat(64));
              }),
            );
            const setup = handlerLayer({ root, target: { projectRoot: root }, stack });
            for (const eager of [false, true])
              yield* stackStart(flags({ exclude: [exclusion], eager })).pipe(
                Effect.provide(setup.layer),
              );
            expect(yield* fs.readFileString(path.join(root, "supabase", "config.toml"))).toBe(
              configBefore,
            );
          }),
        ),
        Effect.provide(BunServices.layer),
      );
    });
  }

  it.live("applies exclusions to the effective config without changing the project file", () => {
    return project().pipe(
      Effect.flatMap((root) => {
        return Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const configBefore = yield* fs.readFileString(path.join(root, "supabase", "config.toml"));
          let startedConfig: unknown;
          const stack = fakeStack("e".repeat(64), (config) =>
            Effect.gen(function* () {
              startedConfig = config;
              yield* Schema.decodeUnknownEffect(StackConfigSchema)(config?.config, {
                onExcessProperty: "error",
              }).pipe(
                Effect.mapError((error) => new StackStateInvalidError({ message: error.message })),
              );
              return status("e".repeat(64));
            }),
          );
          const setup = handlerLayer({ root, target: { projectRoot: root }, stack });
          yield* stackStart(flags({ exclude: ["studio", "analytics"] })).pipe(
            Effect.provide(setup.layer),
          );
          expect(startedConfig).toEqual(
            expect.objectContaining({
              config: expect.objectContaining({
                capabilities: expect.objectContaining({
                  studio: { enabled: false },
                  analytics: { enabled: false },
                }),
              }),
            }),
          );
          expect(yield* fs.readFileString(path.join(root, "supabase", "config.toml"))).toBe(
            configBefore,
          );
        });
      }),
      Effect.provide(BunServices.layer),
    );
  });

  it.live(
    "leaves listener configuration to the compiled runtime when capabilities are excluded",
    () => {
      return project().pipe(
        Effect.flatMap((root) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            yield* fs.writeFileString(
              path.join(root, "supabase", "config.toml"),
              'project_id = "start-test"\n[api]\nport = 55421\n',
            );
            let startedConfig: unknown;
            const stack = fakeStack("7".repeat(64), (config) =>
              Effect.sync(() => {
                startedConfig = config;
                return status("7".repeat(64));
              }),
            );
            const setup = handlerLayer({ root, target: { projectRoot: root }, stack });
            yield* stackStart(
              flags({ exclude: ["rest", "auth", "realtime", "storage", "functions", "analytics"] }),
            ).pipe(Effect.provide(setup.layer));
            expect(startedConfig).toEqual(
              expect.objectContaining({
                config: expect.objectContaining({
                  listeners: expect.objectContaining({ api: { port: 55421 } }),
                }),
              }),
            );
          }),
        ),
        Effect.provide(BunServices.layer),
      );
    },
  );

  it.live("preserves the configured API listener on partial gateway exclusion", () => {
    return project().pipe(
      Effect.flatMap((root) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fs.writeFileString(
            path.join(root, "supabase", "config.toml"),
            'project_id = "start-test"\n[api]\nport = 55421\n',
          );
          let startedConfig: unknown;
          const stack = fakeStack("8".repeat(64), (config) =>
            Effect.sync(() => {
              startedConfig = config;
              return status("8".repeat(64));
            }),
          );
          const setup = handlerLayer({ root, target: { projectRoot: root }, stack });
          yield* stackStart(flags({ exclude: ["rest"] })).pipe(Effect.provide(setup.layer));
          expect(startedConfig).toEqual(
            expect.objectContaining({
              config: expect.objectContaining({
                listeners: expect.objectContaining({ api: { port: 55421 } }),
              }),
            }),
          );
        }),
      ),
      Effect.provide(BunServices.layer),
    );
  });

  it.live("does not rewrite listeners for configured-disabled capabilities", () => {
    return project().pipe(
      Effect.flatMap((root) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fs.writeFileString(
            path.join(root, "supabase", "config.toml"),
            `project_id = "start-test"
[api]
port = 55421
[auth]
enabled = false
[realtime]
enabled = false
[storage]
enabled = false
[edge_runtime]
enabled = false
[analytics]
enabled = false
`,
          );
          let startedConfig: unknown;
          const stack = fakeStack("9".repeat(64), (config) =>
            Effect.sync(() => {
              startedConfig = config;
              return status("9".repeat(64));
            }),
          );
          const setup = handlerLayer({ root, target: { projectRoot: root }, stack });
          yield* stackStart(flags({ exclude: ["rest"] })).pipe(Effect.provide(setup.layer));
          expect(startedConfig).toEqual(
            expect.objectContaining({
              config: expect.objectContaining({
                listeners: expect.objectContaining({ api: { port: 55421 } }),
              }),
            }),
          );
        }),
      ),
      Effect.provide(BunServices.layer),
    );
  });

  it.live("leaves auto runtime selection to the package for a new stack", () => {
    return Effect.gen(function* () {
      const root = yield* project();
      let createOptions: unknown;
      const stack = fakeStack("f".repeat(64), () => Effect.succeed(status("f".repeat(64))));
      const setup = handlerLayer({
        root,
        target: { projectRoot: root },
        stack,
        onCreate: (options) => {
          createOptions = options;
        },
      });
      yield* stackStart(flags({ runtime: "auto" })).pipe(Effect.provide(setup.layer));
      expect(createOptions).toEqual({ projectRoot: root });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.live("forwards an explicit Docker runtime to the package", () => {
    return Effect.gen(function* () {
      const root = yield* project();
      let createOptions: unknown;
      const stack = fakeStack("d".repeat(64), () => Effect.succeed(status("d".repeat(64))));
      const setup = handlerLayer({
        root,
        target: {
          projectRoot: root,
          name: "feature-docker",
          runtime: { kind: "container", engine: "docker" },
        },
        stack,
        onCreate: (options) => {
          createOptions = options;
        },
      });
      yield* stackStart(flags({ stack: Option.some("feature-docker"), runtime: "docker" })).pipe(
        Effect.provide(setup.layer),
      );
      expect(createOptions).toEqual({
        projectRoot: root,
        name: "feature-docker",
        runtime: { kind: "container", engine: "docker" },
      });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("resolves the current project target", () => {
    return Effect.gen(function* () {
      const root = yield* project();
      const resolver = yield* StackTargetResolver;
      const target = yield* resolver.resolve({
        projectRoot: root,
        runtime: "auto",
      });
      expect(target.projectRoot).toBe(root);
      expect(target.id).toBeUndefined();
      expect(target.name).toBeUndefined();
      expect(target.runtime).toBeUndefined();
    }).pipe(Effect.provide(resolverLayer));
  });

  it.effect("keeps a named native stack target distinct", () => {
    return Effect.gen(function* () {
      const root = yield* project();
      const resolver = yield* StackTargetResolver;
      const target = yield* resolver.resolve({
        projectRoot: root,
        name: "feature-a",
        runtime: "native",
      });
      expect(target.name).toBe("feature-a");
      expect(target.runtime).toEqual({ kind: "native" });
    }).pipe(Effect.provide(resolverLayer));
  });

  it.effect("rejects a malformed stack id before loading project configuration", () =>
    Effect.gen(function* () {
      const resolver = yield* StackTargetResolver;
      const failure = yield* resolver
        .resolve({ projectRoot: "/does/not/exist", id: "invalid", runtime: "auto" })
        .pipe(Effect.flip);
      expect(failure).toBeInstanceOf(StackTargetError);
      expect(failure.message).toContain("lowercase SHA-256");
      expect(failure[ErrorActionabilityId]).toEqual(actionability.provideFlags);
    }).pipe(Effect.provide(resolverLayer)),
  );

  it.effect("classifies an existing stack runtime mismatch as provided flags", () => {
    const api = Layer.succeed(StackApi, {
      findStack: () => Effect.succeed(Option.none()),
      createStack: () => Effect.die("unused"),
      openStack: () => Effect.die("unused"),
      inspectStack: () =>
        Effect.succeed({
          descriptor: {
            id: StackIdSchema.make("b".repeat(64)),
            projectRoot: "/tmp/existing-stack",
            name: "existing",
            branchContext: "ordinary-workspace",
            runtime: { kind: "native" },
            desiredLifecycle: "running",
          },
          owner: "running",
        }),
      discoverStacks: () => Effect.succeed({ stacks: [], errors: [] }),
    });
    return Effect.gen(function* () {
      const resolver = yield* StackTargetResolver;
      const failure = yield* resolver
        .resolve({ projectRoot: "/tmp/project", id: "b".repeat(64), runtime: "docker" })
        .pipe(Effect.flip);
      expect(failure[ErrorActionabilityId]).toEqual(actionability.provideFlags);
    }).pipe(
      Effect.provide(
        stackTargetResolverLayer.pipe(Layer.provideMerge(api), Layer.provide(BunServices.layer)),
      ),
    );
  });

  it.live("creates a named native stack with eager on-demand configuration", () => {
    return Effect.gen(function* () {
      const root = yield* project();
      let createOptions: unknown;
      let startConfig: unknown;
      const stack = fakeStack("a".repeat(64), (config) => {
        startConfig = config;
        return Effect.succeed(status("a".repeat(64)));
      });
      const setup = handlerLayer({
        root,
        target: { projectRoot: root, name: "feature-a", runtime: { kind: "native" } },
        stack,
        onCreate: (options) => {
          createOptions = options;
        },
      });
      yield* stackStart(
        flags({
          stack: Option.some("feature-a"),
          runtime: "native",
          preparation: "on-demand",
          eager: true,
          exclude: ["studio"],
        }),
      ).pipe(Effect.provide(setup.layer));
      expect(createOptions).toEqual({
        projectRoot: root,
        name: "feature-a",
        runtime: { kind: "native" },
      });
      expect(startConfig).toMatchObject({ config: { preparation: "on-demand" } });
      expect(startConfig).toEqual(
        expect.objectContaining({
          config: expect.objectContaining({
            capabilities: expect.objectContaining({
              rest: expect.objectContaining({ activation: "eager" }),
              studio: { enabled: false },
            }),
          }),
        }),
      );
      expect(setup.out.stdoutText).toContain("Stack");
      expect(setup.telemetry.flushed).toBe(true);
    });
  });

  it.live("opens an addressed existing stack using its own project root", () => {
    return Effect.gen(function* () {
      const settingsRoot = yield* project();
      const targetRoot = yield* project();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(
        path.join(targetRoot, "supabase", "config.toml"),
        'project_id = "target"\n[api]\nport = 55421\n',
      );
      let opened = false;
      let startConfig: unknown;
      const stack = fakeStack("b".repeat(64), (config) => {
        startConfig = config;
        return Effect.succeed(status("b".repeat(64)));
      });
      const setup = handlerLayer({
        root: settingsRoot,
        target: { projectRoot: targetRoot, id: "b".repeat(64) },
        stack,
        onOpen: () => {
          opened = true;
        },
      });
      yield* stackStart(flags({ stackId: Option.some("b".repeat(64)) })).pipe(
        Effect.provide(setup.layer),
      );
      expect(opened).toBe(true);
      expect(startConfig).toMatchObject({ config: { listeners: { api: { port: 55421 } } } });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.live("reports a typed runtime failure without success output or cleanup calls", () => {
    return Effect.gen(function* () {
      const root = yield* project();
      let stopped = false;
      let destroyed = false;
      const stack = {
        ...fakeStack("c".repeat(64), () =>
          Effect.fail(new ContainerEngineError({ message: "Docker is unavailable" })),
        ),
        stop: Effect.sync(() => {
          stopped = true;
        }),
        destroy: Effect.sync(() => {
          destroyed = true;
        }),
      } satisfies EffectStack;
      const setup = handlerLayer({ root, target: { projectRoot: root }, stack });
      const failure = yield* stackStart(flags()).pipe(Effect.flip, Effect.provide(setup.layer));
      expect(failure).toBeInstanceOf(StackCommandStartError);
      if (failure instanceof StackCommandStartError) {
        expect(failure.reason).toBe("runtime");
        expect(failure.suggestion).toContain("container engine is installed");
        expect(failure.suggestion).toContain("daemon is running");
        expect(failure[ErrorActionabilityId]).toEqual(actionability.dockerNotRunning);
      }
      expect(stopped).toBe(false);
      expect(destroyed).toBe(false);
      expect(setup.out.messages.filter((message) => message.type === "success")).toHaveLength(0);
      expect(setup.telemetry.flushed).toBe(true);
    });
  });

  it.live("does not clean up a stack after a successful start", () => {
    return Effect.gen(function* () {
      const root = yield* project();
      let stopped = false;
      let destroyed = false;
      const stack = {
        ...fakeStack("f".repeat(64), () => Effect.succeed(status("f".repeat(64)))),
        stop: Effect.sync(() => {
          stopped = true;
        }),
        destroy: Effect.sync(() => {
          destroyed = true;
        }),
      } satisfies EffectStack;
      const setup = handlerLayer({ root, target: { projectRoot: root }, stack });
      yield* stackStart(flags()).pipe(Effect.provide(setup.layer));
      expect(stopped).toBe(false);
      expect(destroyed).toBe(false);
    });
  });

  it.live("classifies registry pull failures separately from engine failures", () => {
    return Effect.gen(function* () {
      const root = yield* project();
      const stack = fakeStack("8".repeat(64), () =>
        Effect.fail(
          new ContainerPullError({
            message: "registry refused the workload image",
            image: "example.test/workload:dev",
          }),
        ),
      );
      const setup = handlerLayer({ root, target: { projectRoot: root }, stack });
      const failure = yield* stackStart(flags()).pipe(Effect.flip, Effect.provide(setup.layer));
      expect(failure).toBeInstanceOf(StackCommandStartError);
      if (failure instanceof StackCommandStartError) {
        expect(failure.reason).toBe("registry");
        expect(failure.suggestion).toContain("registry connectivity");
        expect(failure[ErrorActionabilityId]).toEqual(actionability.externalNetwork);
      }
    });
  });

  it.live("reports runtime start failures with operational guidance", () => {
    return Effect.gen(function* () {
      const root = yield* project();
      const stack = fakeStack("b".repeat(64), () =>
        Effect.fail(new StackRuntimeError({ message: "runtime crashed" })),
      );
      const setup = handlerLayer({ root, target: { projectRoot: root }, stack });
      const failure = yield* stackStart(flags()).pipe(Effect.flip, Effect.provide(setup.layer));
      expect(failure).toBeInstanceOf(StackCommandStartError);
      if (failure instanceof StackCommandStartError) {
        expect(failure.reason).toBe("unknown");
        expect(failure.suggestion).toContain("runtime diagnostics");
        expect(failure[ErrorActionabilityId]).toEqual(actionability.unknown);
      }
    });
  });

  it.live("classifies persisted state failures with recovery guidance", () => {
    return Effect.gen(function* () {
      const root = yield* project();
      const stack = fakeStack("c".repeat(64), () =>
        Effect.fail(new StackStateInvalidError({ message: "persisted state is invalid" })),
      );
      const setup = handlerLayer({ root, target: { projectRoot: root }, stack });
      const failure = yield* stackStart(flags()).pipe(Effect.flip, Effect.provide(setup.layer));
      expect(failure).toBeInstanceOf(StackCommandStartError);
      if (failure instanceof StackCommandStartError) {
        expect(failure.reason).toBe("invalid-config");
        expect(failure.suggestion).toContain("restore a valid state record");
        expect(failure[ErrorActionabilityId]).toEqual(actionability.invalidConfig);
      }
    });
  });

  it.live("starts with default configuration when no project config exists", () => {
    return Effect.gen(function* () {
      const root = yield* emptyProject();
      let started = false;
      const stack = fakeStack("9".repeat(64), (config) => {
        started = true;
        expect(config).toMatchObject({
          config: { capabilities: { database: { settings: { health_timeout: "2m" } } } },
        });
        return Effect.succeed(status("9".repeat(64)));
      });
      const setup = handlerLayer({ root, target: { projectRoot: root }, stack });
      yield* stackStart(flags()).pipe(Effect.provide(setup.layer));
      expect(started).toBe(true);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      expect(yield* fs.exists(path.join(root, "supabase", "config.toml"))).toBe(false);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.live("keeps ownership with the package when the CLI caller is interrupted", () => {
    return Effect.gen(function* () {
      const root = yield* project();
      const started = yield* Deferred.make<void>();
      let stopped = false;
      let destroyed = false;
      const stack = {
        ...fakeStack("7".repeat(64), () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never.pipe(Effect.as(status("7".repeat(64))));
          }),
        ),
        stop: Effect.sync(() => {
          stopped = true;
        }),
        destroy: Effect.sync(() => {
          destroyed = true;
        }),
      } satisfies EffectStack;
      const setup = handlerLayer({ root, target: { projectRoot: root }, stack });
      const fiber = yield* Effect.forkChild(Effect.provide(stackStart(flags()), setup.layer));
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(stopped).toBe(false);
      expect(destroyed).toBe(false);
    });
  });

  it.live("rejects invalid target flags before resolving or mutating a stack", () => {
    return Effect.gen(function* () {
      const root = yield* project();
      let resolved = false;
      let created = false;
      const setup = handlerLayer({
        root,
        target: { projectRoot: root },
        stack: fakeStack("d".repeat(64), () => Effect.succeed(status("d".repeat(64)))),
      });
      const layer = Layer.mergeAll(
        setup.out.layer,
        setup.telemetry.layer,
        mockCommandSettings({ workdir: root }),
        Layer.succeed(StackTargetResolver, {
          resolve: () => {
            resolved = true;
            return Effect.die("resolver should not run");
          },
        }),
        Layer.succeed(StackApi, {
          findStack: () => Effect.succeed(Option.none()),
          createStack: () => {
            created = true;
            return Effect.die("create should not run");
          },
          openStack: () => Effect.die("open should not run"),
          inspectStack: () => Effect.die("inspect should not run"),
          discoverStacks: () => Effect.succeed({ stacks: [], errors: [] }),
        }),
        BunServices.layer,
        runtimeInfoLayer,
      );
      const failure = yield* stackStart(
        flags({ stack: Option.some("feature"), stackId: Option.some("e".repeat(64)) }),
      ).pipe(Effect.flip, Effect.provide(layer));
      expect(failure.message).toContain("cannot be used together");
      expect(resolved).toBe(false);
      expect(created).toBe(false);
      expect(setup.telemetry.flushed).toBe(true);
    });
  });
});

describe("stack start parser", () => {
  it.live("records the wired command identity with a fresh run id per invocation", () => {
    return Effect.gen(function* () {
      const root = yield* project();
      const analytics = mockContextualAnalytics();
      const processControl = mockProcessControl();
      const output = mockOutput();
      const stack = fakeStack("e".repeat(64), () => Effect.succeed(status("e".repeat(64))));
      const setup = handlerLayer({ root, target: { projectRoot: root }, stack });
      const command = stackStartCommand.pipe(
        Command.provide(commandRuntimeLayer(["stack", "start"])),
        Command.provide(
          Layer.mergeAll(setup.layer, output.layer, analytics.layer, processControl.layer),
        ),
      );
      const run = Command.runWith(command, { version: "0.0.0-test" })([]);
      const runtime = Layer.mergeAll(BunServices.layer, CliOutput.layer(textCliOutputFormatter()));

      yield* run.pipe(Effect.provide(runtime));
      yield* run.pipe(Effect.provide(runtime));
      const events = analytics.captured.filter((event) => event.event === "cli_command_executed");
      expect(events).toHaveLength(2);
      expect(events[0]?.properties.command).toBe("stack start");
      expect(events[1]?.properties.command).toBe("stack start");
      expect(events[0]?.properties.command_run_id).toBeDefined();
      expect(events[1]?.properties.command_run_id).toBeDefined();
      expect(events[0]?.properties.command_run_id).not.toBe(events[1]?.properties.command_run_id);
    });
  });

  it.live("parses --stack and --runtime through the command", () => {
    let parsed: { stack: Option.Option<string>; runtime: string } | undefined;
    const command = stackStartCommand.pipe(
      Command.withHandler((flags) =>
        Effect.sync(() => {
          parsed = { stack: flags.stack, runtime: flags.runtime };
        }),
      ),
    );
    return Effect.gen(function* () {
      yield* Command.runWith(command, { version: "0.0.0-test" })([
        "--stack",
        "feature-a",
        "--runtime",
        "native",
      ]);
      expect(parsed?.stack).toEqual(Option.some("feature-a"));
      expect(parsed?.runtime).toBe("native");
    }).pipe(
      Effect.provide(Layer.mergeAll(BunServices.layer, CliOutput.layer(textCliOutputFormatter()))),
    );
  });

  it.live("parses repeated, comma-separated, and short exclusion flags", () => {
    let parsed: ReadonlyArray<string> | undefined;
    const command = stackStartCommand.pipe(
      Command.withHandler((flags) => Effect.sync(() => void (parsed = flags.exclude))),
    );
    return Effect.gen(function* () {
      yield* Command.runWith(command, { version: "0.0.0-test" })([
        "--exclude",
        "studio,analytics",
        "-x",
        "mail",
      ]);
      expect(parsed).toEqual(["studio", "analytics", "mail"]);
    }).pipe(
      Effect.provide(Layer.mergeAll(BunServices.layer, CliOutput.layer(textCliOutputFormatter()))),
    );
  });

  it.live("rejects a root legacy output value before resolving the stack target", () => {
    return Effect.gen(function* () {
      const root = yield* project();
      let resolved = false;
      const setup = handlerLayer({
        root,
        target: { projectRoot: root },
        stack: fakeStack("a".repeat(64), () => Effect.succeed(status("a".repeat(64)))),
      });
      const target = Layer.succeed(StackTargetResolver, {
        resolve: () =>
          Effect.sync(() => {
            resolved = true;
            return { projectRoot: root };
          }),
      });
      const failure = yield* stackStart(flags({ exclude: ["bogus"] })).pipe(
        Effect.flip,
        Effect.provide(
          Layer.mergeAll(setup.layer, target, Layer.succeed(OutputFlag, Option.some("json"))),
        ),
      );
      expect(failure.message).toContain("--output");
      expect(failure.message).not.toContain("Unknown stack capabilities");
      expect(failure).toBeInstanceOf(StackCommandStartError);
      if (failure instanceof StackCommandStartError) {
        expect(failure.reason).toBe("flags");
        expect(failure[ErrorActionabilityId]).toEqual(actionability.provideFlags);
      }
      expect(resolved).toBe(false);
      expect(setup.telemetry.flushed).toBe(true);
    });
  });

  it.live("rejects unknown and database exclusions before resolving the target", () => {
    return Effect.gen(function* () {
      const root = yield* project();
      let resolved = false;
      const setup = handlerLayer({
        root,
        target: { projectRoot: root },
        stack: fakeStack("b".repeat(64), () => Effect.succeed(status("b".repeat(64)))),
      });
      const target = Layer.succeed(StackTargetResolver, {
        resolve: () =>
          Effect.sync(() => {
            resolved = true;
            return { projectRoot: root };
          }),
      });
      for (const { exclusion, message } of [
        { exclusion: "", message: 'Unknown stack capabilities in --exclude: ""' },
        {
          exclusion: " analytics",
          message: 'Unknown stack capabilities in --exclude: " analytics"',
        },
        { exclusion: "unknown", message: 'Unknown stack capabilities in --exclude: "unknown"' },
        { exclusion: "database", message: "database capability cannot be excluded" },
      ]) {
        const failure = yield* stackStart(flags({ exclude: [exclusion] })).pipe(
          Effect.flip,
          Effect.provide(Layer.mergeAll(setup.layer, target)),
        );
        expect(failure).toBeInstanceOf(StackCommandStartError);
        expect(failure.reason).toBe("flags");
        expect(failure.message).toContain(message);
      }
      expect(resolved).toBe(false);
    });
  });
});
