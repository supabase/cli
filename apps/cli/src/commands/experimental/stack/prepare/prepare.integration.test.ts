import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path, Redacted, Stream } from "effect";
import {
  StackError,
  type Stack,
  type ServiceCreationInput,
  type ServiceInstances,
} from "@supabase/stack/effect";
import { runtimeInfoLayer } from "../../../../shared/runtime/runtime-info.layer.ts";
import type { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import {
  StackRuntimeSelectionError,
  type StackRuntime,
} from "../../../../command-internal/stack-runtime.ts";
import {
  containerEngineSpawner,
  type ContainerEngineState,
} from "../../../../../tests/helpers/child-process-spawner.ts";
import { unusedGateway } from "../../../../../tests/helpers/unused-stack.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
} from "../../../../../tests/helpers/command-mocks.ts";
import { mockOutput, mockRuntimeInfo } from "../../../../../tests/helpers/mocks.ts";
import { CommandTelemetryAttributes } from "../../../../telemetry/command-telemetry-attributes.ts";
import { StackApi, StackTargetResolver } from "../stack.shared.ts";
import { stackPrepare } from "./prepare.handler.ts";
import type { StackPrepareFlags } from "./prepare.command.ts";
import { StackCommandPrepareError } from "./prepare.errors.ts";

const id = "a".repeat(64);
const flags = (overrides: Partial<StackPrepareFlags> = {}): StackPrepareFlags => ({
  stack: Option.none(),
  stackId: Option.none(),
  runtime: "native",
  capability: ["database"],
  ...overrides,
});

const makeProject = (config: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-prepare-" });
    yield* fs.makeDirectory(path.join(root, "supabase"));
    yield* fs.writeFileString(path.join(root, "supabase", "config.toml"), config);
    return root;
  });

interface FixtureOptions {
  readonly failPreparation?: boolean;
  readonly savedRuntime?: StackRuntime;
  readonly engines?: {
    readonly docker: ContainerEngineState;
    readonly podman: ContainerEngineState;
  };
  readonly runtimeInfo?: Layer.Layer<RuntimeInfo>;
}

const makeFixture = (root: string, options: FixtureOptions = {}) => {
  const { failPreparation = false } = options;
  const engines = containerEngineSpawner(
    options.engines ?? { docker: "missing", podman: "missing" },
  );
  const createdRuntimes: Array<StackRuntime> = [];
  const recordedRuntimes: Array<unknown> = [];
  let openCount = 0;
  let prepareCount = 0;
  let startCount = 0;
  let destroyCount = 0;
  const database = {
    id: "database-id",
    service: "database" as const,
    start: Effect.sync(() => {
      startCount += 1;
    }),
    ready: Effect.void,
    stop: Effect.void,
    restart: () => Effect.void,
    destroy: Effect.sync(() => {
      destroyCount += 1;
    }),
    prepare: Effect.sync(() => {
      prepareCount += 1;
    }).pipe(
      Effect.andThen(() =>
        failPreparation
          ? Effect.fail(
              new StackError({
                operation: "prepareService",
                message: "download failed",
                kind: "artifact-download",
              }),
            )
          : Effect.void,
      ),
    ),
    status: Effect.succeed({
      id: "database-id",
      endpoints: [],
      config: {
        service: "database" as const,
        config: {
          version: "17",
          databasePassword: Redacted.make("password"),
          jwtSecret: Redacted.make("jwt-secret"),
          jwtExpiry: 3600,
        },
      },
      lifecycle: "stopped" as const,
      health: undefined,
      error: undefined,
      exit: undefined,
      currentOperation: undefined,
      wakeEnabled: false,
    }),
    followStatus: Stream.empty,
    readLogs: () => Stream.empty,
    credentials: () => Effect.succeed({}),
    saveSnapshot: () => Effect.die("unused"),
    restoreSnapshot: () => Effect.die("unused"),
    resetData: Effect.die("unused"),
  };
  function create<Input extends ServiceCreationInput>(
    creation: Input,
  ): Effect.Effect<ServiceInstances[Input["service"]]>;
  function create(
    creation: ServiceCreationInput,
  ): Effect.Effect<ServiceInstances[keyof ServiceInstances]> {
    switch (creation.service) {
      case "database":
        return Effect.succeed(database);
      case "studio":
        return Effect.succeed({ ...database, service: "studio" as const });
      case "pgmeta":
        return Effect.succeed({ ...database, service: "pgmeta" as const });
      default:
        return Effect.die(`fixture does not support ${creation.service}`);
    }
  }

  const stack: Stack = {
    id,
    services: {
      create,
      get: () => Effect.succeed(database),
      list: Effect.succeed([]),
    },
    credentials: { get: Effect.die("unused") },
    composition: {
      plan: () => Effect.succeed([]),
      supabase: () => Effect.die("prepare must not change the composition"),
      configure: () => Effect.void,
      describe: Effect.succeed({
        members: [],
        dependencies: [],
      }),
      start: Effect.succeed([]),
      stop: Effect.succeed([]),
      restart: Effect.succeed([]),
    },
    startupEndpointChanges: Effect.succeed([]),
    stop: Effect.void,
    destroy: Effect.void,
    gateway: unusedGateway,
    commands: { run: () => Effect.die("unused") },
  };
  const output = mockOutput();
  const telemetry = mockTelemetryStateTracked();
  const layer = Layer.mergeAll(
    BunServices.layer,
    options.runtimeInfo ?? runtimeInfoLayer,
    engines.layer,
    mockCommandSettings({ workdir: root, supabaseHome: root }),
    output.layer,
    telemetry.layer,
    Layer.succeed(CommandTelemetryAttributes, {
      record: (values) =>
        Effect.sync(() => {
          if (values.stack_runtime !== undefined) recordedRuntimes.push(values.stack_runtime);
        }),
    }),
    Layer.succeed(StackTargetResolver, {
      resolve: (input) =>
        Effect.succeed({
          projectRoot: root,
          hostRunning: false,
          ...(options.savedRuntime === undefined
            ? input.runtime === "auto"
              ? {}
              : { runtime: input.runtime }
            : { id, runtime: options.savedRuntime }),
        }),
    }),
    Layer.succeed(StackApi, {
      create: (input) =>
        Effect.sync(() => {
          createdRuntimes.push(input.runtime);
          return stack;
        }),
      open: () =>
        Effect.sync(() => {
          openCount += 1;
          return stack;
        }),
      discover: () => Effect.succeed([]),
      find: () => Effect.die("unused"),
      findDeleted: () => Effect.die("unused"),
    }),
  );
  return {
    layer,
    get createdRuntimes() {
      return createdRuntimes;
    },
    get recordedRuntimes() {
      return recordedRuntimes;
    },
    get openCount() {
      return openCount;
    },
    get runtimeNotices() {
      return output.messages
        .filter(
          ({ type, message }) => type === "info" && message?.startsWith("Docker didn't answer"),
        )
        .map(({ message }) => message);
    },
    get probes() {
      return [...new Set(engines.spawned.map(({ command }) => command))];
    },
    get prepareCount() {
      return prepareCount;
    },
    get startCount() {
      return startCount;
    },
    get destroyCount() {
      return destroyCount;
    },
  };
};

const databaseOnlyConfig = `project_id = "prepare-test"\n\n[api]\nenabled = false\n`;

describe("stack prepare", () => {
  it.live("prepares a temporary Database without changing the composition", () =>
    makeProject(databaseOnlyConfig).pipe(
      Effect.flatMap((root) => {
        const fixture = makeFixture(root);
        return stackPrepare(flags()).pipe(
          Effect.provide(fixture.layer),
          Effect.tap((prepared) =>
            Effect.sync(() => {
              expect(prepared.length).toBeGreaterThan(0);
              expect(fixture.prepareCount).toBe(prepared.length);
              expect(fixture.startCount).toBe(0);
              expect(fixture.destroyCount).toBe(prepared.length);
            }),
          ),
        );
      }),
      Effect.provide(BunServices.layer),
    ),
  );

  it.live("prepares Studio together with its configured Pgmeta companion", () =>
    makeProject(databaseOnlyConfig).pipe(
      Effect.flatMap((root) => {
        const fixture = makeFixture(root);
        return stackPrepare(flags({ capability: ["studio"] })).pipe(
          Effect.provide(fixture.layer),
          Effect.tap((prepared) =>
            Effect.sync(() => {
              expect(prepared.map((result) => result.capability).sort()).toEqual([
                "pgmeta",
                "studio",
              ]);
              expect(prepared.every((result) => result.version !== "catalog default")).toBe(true);
              expect(fixture.prepareCount).toBe(2);
              expect(fixture.destroyCount).toBe(2);
              expect(fixture.startCount).toBe(0);
            }),
          ),
        );
      }),
      Effect.provide(BunServices.layer),
    ),
  );

  it.live("removes its temporary instance after a preparation failure", () =>
    makeProject(databaseOnlyConfig).pipe(
      Effect.flatMap((root) => {
        const fixture = makeFixture(root, { failPreparation: true });
        return stackPrepare(flags()).pipe(
          Effect.provide(fixture.layer),
          Effect.flip,
          Effect.tap((error) =>
            Effect.sync(() => {
              expect(error.message).toContain("download failed");
              expect(error.reason).toBe("stack");
              expect(fixture.destroyCount).toBe(1);
              expect(fixture.startCount).toBe(0);
            }),
          ),
        );
      }),
      Effect.provide(BunServices.layer),
    ),
  );

  it.live("rejects a disabled requested service before preparing an instance", () =>
    makeProject(databaseOnlyConfig).pipe(
      Effect.flatMap((root) => {
        const fixture = makeFixture(root);
        return stackPrepare(flags({ capability: ["rest"] })).pipe(
          Effect.provide(fixture.layer),
          Effect.flip,
          Effect.tap((error) =>
            Effect.sync(() => {
              expect(error.message).toContain("rest is disabled");
              expect(fixture.prepareCount).toBe(0);
              expect(fixture.destroyCount).toBe(0);
            }),
          ),
        );
      }),
      Effect.provide(BunServices.layer),
    ),
  );

  it.live("rejects malformed config before creating a stack", () =>
    makeProject("project_id = [\n").pipe(
      Effect.flatMap((root) => {
        const fixture = makeFixture(root);
        return stackPrepare(flags()).pipe(
          Effect.provide(fixture.layer),
          Effect.flip,
          Effect.tap((error) =>
            Effect.sync(() => {
              expect(error).toBeInstanceOf(StackCommandPrepareError);
              expect(error.reason).toBe("invalid-config");
              expect(fixture.prepareCount).toBe(0);
              expect(fixture.startCount).toBe(0);
            }),
          ),
        );
      }),
      Effect.provide(BunServices.layer),
    ),
  );
});

describe("stack prepare automatic runtime selection", () => {
  const selectRuntime = (options: FixtureOptions) =>
    makeProject(databaseOnlyConfig).pipe(
      Effect.flatMap((root) => {
        const fixture = makeFixture(root, options);
        return stackPrepare(flags({ runtime: "auto" })).pipe(
          Effect.provide(fixture.layer),
          Effect.as(fixture),
        );
      }),
      Effect.provide(BunServices.layer),
    );

  it.live("creates a Docker stack when the Docker engine answers", () =>
    selectRuntime({ engines: { docker: "running", podman: "running" } }).pipe(
      Effect.tap((fixture) =>
        Effect.sync(() => {
          expect(fixture.createdRuntimes).toEqual(["docker"]);
          expect(fixture.probes).toEqual(["docker"]);
          expect(fixture.runtimeNotices).toEqual([]);
        }),
      ),
    ),
  );

  it.live("creates a Podman stack when Docker is not installed and Podman answers", () =>
    selectRuntime({
      engines: { docker: "missing", podman: "running" },
      runtimeInfo: mockRuntimeInfo({ platform: "linux", arch: "x64" }),
    }).pipe(
      Effect.tap((fixture) =>
        Effect.sync(() => {
          expect(fixture.createdRuntimes).toEqual(["podman"]);
          expect(fixture.probes).toEqual(["docker", "podman"]);
          expect(fixture.runtimeNotices).toHaveLength(1);
          expect(fixture.runtimeNotices[0]).toContain("uses the Podman runtime");
          expect(fixture.runtimeNotices[0]).toContain("supabase stack destroy");
        }),
      ),
    ),
  );

  it.live(
    "creates a native stack on Linux when the Docker daemon is down and Podman is absent",
    () =>
      selectRuntime({
        engines: { docker: "stopped", podman: "missing" },
        runtimeInfo: mockRuntimeInfo({ platform: "linux", arch: "x64" }),
      }).pipe(
        Effect.tap((fixture) =>
          Effect.sync(() => {
            expect(fixture.createdRuntimes).toEqual(["native"]);
            expect(fixture.probes).toEqual(["docker", "podman"]);
            expect(fixture.runtimeNotices).toHaveLength(1);
            expect(fixture.runtimeNotices[0]).toContain("uses the native runtime");
          }),
        ),
      ),
  );

  for (const [platform, arch] of [
    ["win32", "x64"],
    ["darwin", "x64"],
  ] as const) {
    it.live(`fails without creating a stack when no engine answers on ${platform}/${arch}`, () =>
      makeProject(databaseOnlyConfig).pipe(
        Effect.flatMap((root) => {
          const fixture = makeFixture(root, {
            engines: { docker: "stopped", podman: "stopped" },
            runtimeInfo: mockRuntimeInfo({ platform, arch }),
          });
          return stackPrepare(flags({ runtime: "auto" })).pipe(
            Effect.provide(fixture.layer),
            Effect.flip,
            Effect.tap((error) =>
              Effect.sync(() => {
                expect(error).toBeInstanceOf(StackCommandPrepareError);
                expect(error.reason).toBe("runtime");
                expect(error.cause).toBeInstanceOf(StackRuntimeSelectionError);
                expect(error.message).toContain(`not supported on ${platform}/${arch}`);
                expect(error.suggestion).toBe("Start Docker or Podman, then rerun the command.");
                expect(fixture.createdRuntimes).toEqual([]);
              }),
            ),
          );
        }),
        Effect.provide(BunServices.layer),
      ),
    );
  }

  it.live("reuses a saved runtime without probing any engine", () =>
    selectRuntime({
      savedRuntime: "podman",
      engines: { docker: "running", podman: "running" },
    }).pipe(
      Effect.tap((fixture) =>
        Effect.sync(() => {
          expect(fixture.openCount).toBe(1);
          expect(fixture.createdRuntimes).toEqual([]);
          expect(fixture.probes).toEqual([]);
          expect(fixture.runtimeNotices).toEqual([]);
        }),
      ),
    ),
  );

  it.live("honors an explicit runtime without probing any engine and records it on telemetry", () =>
    makeProject(databaseOnlyConfig).pipe(
      Effect.flatMap((root) => {
        const fixture = makeFixture(root, { engines: { docker: "running", podman: "running" } });
        return stackPrepare(flags({ runtime: "podman" })).pipe(
          Effect.provide(fixture.layer),
          Effect.tap(() =>
            Effect.sync(() => {
              expect(fixture.createdRuntimes).toEqual(["podman"]);
              expect(fixture.recordedRuntimes).toEqual(["podman"]);
              expect(fixture.probes).toEqual([]);
              expect(fixture.runtimeNotices).toEqual([]);
            }),
          ),
        );
      }),
      Effect.provide(BunServices.layer),
    ),
  );
});
