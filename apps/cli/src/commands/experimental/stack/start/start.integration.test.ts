// oxlint-disable-next-line effecttsgo/node-builtin-import -- filesystem test fixture uses the host adapter at this boundary
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- filesystem test fixture uses the host adapter at this boundary
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Stream } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import {
  ContainerEngineError,
  ContainerPullError,
  StackIdSchema,
  StackRuntimeError,
  StackStateInvalidError,
} from "@supabase/stack/effect";
import type { EffectStack, StackStartError, StackStatus } from "@supabase/stack/effect";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { mockLegacyCliSettings } from "../../../../../tests/helpers/legacy-mocks.ts";
import {
  legacyExperimentalStackApiLayer,
  LegacyExperimentalStackTargetError,
  LegacyExperimentalStackTargetResolver,
  legacyExperimentalStackTargetResolverLayer,
  LegacyExperimentalStackApi,
} from "../stack.shared.ts";
import {
  legacyExperimentalStackStart,
  legacyValidateExperimentalStackStartTarget,
} from "./start.handler.ts";
import { LegacyExperimentalStackStartError } from "./start.errors.ts";
import { legacyExperimentalStackStartCommand } from "./start.command.ts";
import { textCliOutputFormatter } from "../../../../shared/output/text-formatter.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import {
  actionability,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

const project = (): string => {
  const root = mkdtempSync(join(tmpdir(), "supabase-experimental-stack-start-"));
  mkdirSync(join(root, "supabase"), { recursive: true });
  writeFileSync(join(root, "supabase", "config.toml"), 'project_id = "start-test"\n');
  return root;
};

const resolverLayer = legacyExperimentalStackTargetResolverLayer.pipe(
  Layer.provideMerge(legacyExperimentalStackApiLayer),
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
  start: (config: unknown) => Effect.Effect<StackStatus, StackStartError>,
) {
  return {
    id: StackIdSchema.make(id),
    status: () => Effect.succeed(status(id)),
    credentials: () => Effect.die("credentials not used in start test"),
    prepare: () => Effect.die("prepare not used in start test"),
    start,
    stop: () => Effect.void,
    destroy: () => Effect.die("destroy not used in start test"),
    logs: () => Effect.die("logs not used in start test"),
    followLogs: () => Stream.empty,
  } satisfies EffectStack;
}

const flags = (overrides: Partial<Parameters<typeof legacyExperimentalStackStart>[0]> = {}) => ({
  stack: Option.none<string>(),
  stackId: Option.none<string>(),
  runtime: "auto" as const,
  preparation: "background" as const,
  eager: false,
  ...overrides,
});

function handlerLayer(opts: {
  root: string;
  target: { projectRoot: string; name?: string; id?: string; runtime?: { kind: "native" } };
  stack: EffectStack;
  onCreate?: (options: unknown) => void;
  onOpen?: () => void;
}) {
  const out = mockOutput();
  const { id, ...targetWithoutId } = opts.target;
  const targetLayer = Layer.succeed(LegacyExperimentalStackTargetResolver, {
    resolve: () =>
      Effect.succeed(
        id === undefined ? targetWithoutId : { ...targetWithoutId, id: StackIdSchema.make(id) },
      ),
  });
  const apiLayer = Layer.succeed(LegacyExperimentalStackApi, {
    createStack: (options) => {
      opts.onCreate?.(options);
      return Effect.succeed(opts.stack);
    },
    findStack: () => Effect.succeed(Option.none()),
    openStack: () => {
      opts.onOpen?.();
      return Effect.succeed(opts.stack);
    },
    inspectStack: () => Effect.die("inspect not used in handler test"),
  });
  return {
    out,
    layer: Layer.mergeAll(
      out.layer,
      mockLegacyCliSettings({ workdir: opts.root }),
      targetLayer,
      apiLayer,
      BunServices.layer,
    ),
  };
}

describe("experimental stack start targeting", () => {
  it.effect("resolves the current project target", () => {
    const root = project();
    return Effect.gen(function* () {
      const resolver = yield* LegacyExperimentalStackTargetResolver;
      const target = yield* resolver.resolve({
        projectRoot: root,
        runtime: "auto",
      });
      expect(target.projectRoot).toBe(root);
      expect(target.id).toBeUndefined();
      expect(target.name).toBeUndefined();
      expect(target.runtime).toBeUndefined();
    }).pipe(
      Effect.provide(resolverLayer),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.effect("keeps a named native stack target distinct", () => {
    const root = project();
    return Effect.gen(function* () {
      const resolver = yield* LegacyExperimentalStackTargetResolver;
      const target = yield* resolver.resolve({
        projectRoot: root,
        name: "feature-a",
        runtime: "native",
      });
      expect(target.name).toBe("feature-a");
      expect(target.runtime).toEqual({ kind: "native" });
    }).pipe(
      Effect.provide(resolverLayer),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.effect("rejects a malformed stack id before loading project configuration", () =>
    Effect.gen(function* () {
      const resolver = yield* LegacyExperimentalStackTargetResolver;
      const failure = yield* resolver
        .resolve({ projectRoot: "/does/not/exist", id: "invalid", runtime: "auto" })
        .pipe(Effect.flip);
      expect(failure).toBeInstanceOf(LegacyExperimentalStackTargetError);
      expect(failure.message).toContain("lowercase SHA-256");
      expect(failure[ErrorActionabilityId]).toEqual(actionability.provideFlags);
    }).pipe(Effect.provide(resolverLayer)),
  );

  it.effect("classifies an existing stack runtime mismatch as provided flags", () => {
    const api = Layer.succeed(LegacyExperimentalStackApi, {
      createStack: () => Effect.die("unused"),
      findStack: () => Effect.succeed(Option.none()),
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
    });
    return Effect.gen(function* () {
      const resolver = yield* LegacyExperimentalStackTargetResolver;
      const failure = yield* resolver
        .resolve({ projectRoot: "/tmp/project", id: "b".repeat(64), runtime: "docker" })
        .pipe(Effect.flip);
      expect(failure[ErrorActionabilityId]).toEqual(actionability.provideFlags);
    }).pipe(
      Effect.provide(
        legacyExperimentalStackTargetResolverLayer.pipe(
          Layer.provideMerge(api),
          Layer.provide(BunServices.layer),
        ),
      ),
    );
  });

  it.effect("rejects mutually exclusive stack targets", () =>
    legacyValidateExperimentalStackStartTarget({
      stack: Option.some("feature-a"),
      stackId: Option.some("a".repeat(64)),
    }).pipe(
      Effect.flip,
      Effect.tap((failure) =>
        Effect.sync(() => expect(failure.message).toContain("cannot be used together")),
      ),
    ),
  );

  it.live("creates a named native stack with eager on-demand configuration", () => {
    const root = project();
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
    return Effect.gen(function* () {
      yield* legacyExperimentalStackStart(
        flags({
          stack: Option.some("feature-a"),
          runtime: "native",
          preparation: "on-demand",
          eager: true,
        }),
      );
      expect(createOptions).toEqual({
        projectRoot: root,
        name: "feature-a",
        runtime: { kind: "native" },
      });
      expect(startConfig).toMatchObject({ config: { preparation: "on-demand" } });
      expect(startConfig).toMatchObject({
        config: { capabilities: { rest: { activation: "eager" } } },
      });
      expect(setup.out.stdoutText).toContain("Stack");
    }).pipe(
      Effect.provide(setup.layer),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.live("opens an addressed existing stack using its own project root", () => {
    const settingsRoot = project();
    const targetRoot = project();
    writeFileSync(
      join(targetRoot, "supabase", "config.toml"),
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
    return Effect.gen(function* () {
      yield* legacyExperimentalStackStart(flags({ stackId: Option.some("b".repeat(64)) }));
      expect(opened).toBe(true);
      expect(startConfig).toMatchObject({ config: { listeners: { api: { port: 55421 } } } });
    }).pipe(
      Effect.provide(setup.layer),
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(settingsRoot, { recursive: true, force: true });
          rmSync(targetRoot, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.live("reports a typed runtime failure without success output or cleanup calls", () => {
    const root = project();
    let stopped = false;
    let destroyed = false;
    const stack = {
      ...fakeStack("c".repeat(64), () =>
        Effect.fail(new ContainerEngineError({ message: "Docker is unavailable" })),
      ),
      stop: () => {
        stopped = true;
        return Effect.void;
      },
      destroy: () =>
        Effect.sync(() => {
          destroyed = true;
        }),
    } satisfies EffectStack;
    const setup = handlerLayer({ root, target: { projectRoot: root }, stack });
    return Effect.gen(function* () {
      const failure = yield* legacyExperimentalStackStart(flags()).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(LegacyExperimentalStackStartError);
      if (failure instanceof LegacyExperimentalStackStartError) {
        expect(failure.reason).toBe("runtime");
        expect(failure.suggestion).toContain("container engine");
        expect(failure[ErrorActionabilityId]).toEqual(actionability.dockerNotRunning);
      }
      expect(stopped).toBe(false);
      expect(destroyed).toBe(false);
      expect(setup.out.messages.filter((message) => message.type === "success")).toHaveLength(0);
    }).pipe(
      Effect.provide(setup.layer),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.live("does not clean up a stack after a successful start", () => {
    const root = project();
    let stopped = false;
    let destroyed = false;
    const stack = {
      ...fakeStack("f".repeat(64), () => Effect.succeed(status("f".repeat(64)))),
      stop: () => {
        stopped = true;
        return Effect.void;
      },
      destroy: () =>
        Effect.sync(() => {
          destroyed = true;
        }),
    } satisfies EffectStack;
    const setup = handlerLayer({ root, target: { projectRoot: root }, stack });
    return Effect.gen(function* () {
      yield* legacyExperimentalStackStart(flags());
      expect(stopped).toBe(false);
      expect(destroyed).toBe(false);
    }).pipe(
      Effect.provide(setup.layer),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.live("classifies registry pull failures separately from engine failures", () => {
    const root = project();
    const stack = fakeStack("8".repeat(64), () =>
      Effect.fail(
        new ContainerPullError({
          message: "registry refused the workload image",
          image: "example.test/workload:dev",
        }),
      ),
    );
    const setup = handlerLayer({ root, target: { projectRoot: root }, stack });
    return Effect.gen(function* () {
      const failure = yield* legacyExperimentalStackStart(flags()).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(LegacyExperimentalStackStartError);
      if (failure instanceof LegacyExperimentalStackStartError) {
        expect(failure.reason).toBe("registry");
        expect(failure.suggestion).toContain("registry connectivity");
        expect(failure[ErrorActionabilityId]).toEqual(actionability.externalNetwork);
      }
    }).pipe(
      Effect.provide(setup.layer),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.live("reports runtime start failures with operational guidance", () => {
    const root = project();
    const stack = fakeStack("b".repeat(64), () =>
      Effect.fail(new StackRuntimeError({ message: "runtime crashed" })),
    );
    const setup = handlerLayer({ root, target: { projectRoot: root }, stack });
    return Effect.gen(function* () {
      const failure = yield* legacyExperimentalStackStart(flags()).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(LegacyExperimentalStackStartError);
      if (failure instanceof LegacyExperimentalStackStartError) {
        expect(failure.reason).toBe("unknown");
        expect(failure.suggestion).toContain("runtime diagnostics");
        expect(failure[ErrorActionabilityId]).toEqual(actionability.unknown);
      }
    }).pipe(
      Effect.provide(setup.layer),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.live("classifies persisted state failures with recovery guidance", () => {
    const root = project();
    const stack = fakeStack("c".repeat(64), () =>
      Effect.fail(new StackStateInvalidError({ message: "persisted state is invalid" })),
    );
    const setup = handlerLayer({ root, target: { projectRoot: root }, stack });
    return Effect.gen(function* () {
      const failure = yield* legacyExperimentalStackStart(flags()).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(LegacyExperimentalStackStartError);
      if (failure instanceof LegacyExperimentalStackStartError) {
        expect(failure.reason).toBe("invalid-config");
        expect(failure.suggestion).toContain("restore a valid state record");
        expect(failure[ErrorActionabilityId]).toEqual(actionability.invalidConfig);
      }
    }).pipe(
      Effect.provide(setup.layer),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.live("classifies a missing project configuration as invalid config", () => {
    const root = mkdtempSync(join(tmpdir(), "supabase-experimental-stack-start-invalid-"));
    const stack = fakeStack("9".repeat(64), () => Effect.succeed(status("9".repeat(64))));
    const setup = handlerLayer({ root, target: { projectRoot: root }, stack });
    return Effect.gen(function* () {
      const failure = yield* legacyExperimentalStackStart(flags()).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(LegacyExperimentalStackStartError);
      if (failure instanceof LegacyExperimentalStackStartError) {
        expect(failure.reason).toBe("invalid-config");
        expect(failure[ErrorActionabilityId]).toEqual(actionability.invalidConfig);
      }
    }).pipe(
      Effect.provide(setup.layer),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.live("keeps ownership with the package when the CLI caller is interrupted", () => {
    const root = project();
    return Effect.gen(function* () {
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
        stop: () => {
          stopped = true;
          return Effect.void;
        },
        destroy: () =>
          Effect.sync(() => {
            destroyed = true;
          }),
      } satisfies EffectStack;
      const setup = handlerLayer({ root, target: { projectRoot: root }, stack });
      const fiber = yield* Effect.forkChild(
        Effect.provide(legacyExperimentalStackStart(flags()), setup.layer),
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(stopped).toBe(false);
      expect(destroyed).toBe(false);
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))));
  });

  it.live("rejects invalid target flags before resolving or mutating a stack", () => {
    const root = project();
    let resolved = false;
    let created = false;
    const setup = handlerLayer({
      root,
      target: { projectRoot: root },
      stack: fakeStack("d".repeat(64), () => Effect.succeed(status("d".repeat(64)))),
    });
    const layer = Layer.mergeAll(
      setup.out.layer,
      mockLegacyCliSettings({ workdir: root }),
      Layer.succeed(LegacyExperimentalStackTargetResolver, {
        resolve: () => {
          resolved = true;
          return Effect.die("resolver should not run");
        },
      }),
      Layer.succeed(LegacyExperimentalStackApi, {
        createStack: () => {
          created = true;
          return Effect.die("create should not run");
        },
        findStack: () => Effect.succeed(Option.none()),
        openStack: () => Effect.die("open should not run"),
        inspectStack: () => Effect.die("inspect should not run"),
      }),
      BunServices.layer,
    );
    return Effect.gen(function* () {
      const failure = yield* legacyExperimentalStackStart(
        flags({ stack: Option.some("feature"), stackId: Option.some("e".repeat(64)) }),
      ).pipe(Effect.flip);
      expect(failure.message).toContain("cannot be used together");
      expect(resolved).toBe(false);
      expect(created).toBe(false);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });
});

describe("experimental stack start parser", () => {
  it.live("parses --stack and --runtime through the command", () => {
    let parsed: { stack: Option.Option<string>; runtime: string } | undefined;
    const command = legacyExperimentalStackStartCommand.pipe(
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

  it.live("rejects a root legacy output value before resolving the stack target", () => {
    const root = project();
    let resolved = false;
    const setup = handlerLayer({
      root,
      target: { projectRoot: root },
      stack: fakeStack("a".repeat(64), () => Effect.succeed(status("a".repeat(64)))),
    });
    const target = Layer.succeed(LegacyExperimentalStackTargetResolver, {
      resolve: () =>
        Effect.sync(() => {
          resolved = true;
          return { projectRoot: root };
        }),
    });
    return Effect.gen(function* () {
      const failure = yield* legacyExperimentalStackStart(flags()).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(LegacyExperimentalStackStartError);
      if (failure instanceof LegacyExperimentalStackStartError) {
        expect(failure.reason).toBe("flags");
        expect(failure[ErrorActionabilityId]).toEqual(actionability.provideFlags);
      }
      expect(resolved).toBe(false);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(setup.layer, target, Layer.succeed(LegacyOutputFlag, Option.some("json"))),
      ),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });
});
