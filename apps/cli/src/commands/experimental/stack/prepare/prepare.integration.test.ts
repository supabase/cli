import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path, Redacted, Stream } from "effect";
import {
  StackError,
  type Stack,
  type ServiceCreation,
  type ServiceInstances,
} from "@supabase/stack/effect";
import { runtimeInfoLayer } from "../../../../shared/runtime/runtime-info.layer.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
} from "../../../../../tests/helpers/command-mocks.ts";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
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

const makeFixture = (root: string, failPreparation = false) => {
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
          ? Effect.fail(new StackError({ operation: "prepareService", message: "download failed" }))
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
      cleanupError: undefined,
      exit: undefined,
      currentOperation: undefined,
      launchId: undefined,
      intentRevision: 0,
      wakeEnabled: false,
      registered: true,
    }),
    followStatus: Stream.empty,
    logs: Stream.empty,
    credentials: () => Effect.succeed({}),
    exportSnapshot: () => Effect.die("unused"),
    restoreSnapshot: () => Effect.die("unused"),
    resetData: Effect.die("unused"),
  };
  function create<Input extends ServiceCreation>(
    creation: Input,
  ): Effect.Effect<ServiceInstances[Input["service"]]>;
  function create(
    creation: ServiceCreation,
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
    composition: {
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
    stop: Effect.void,
    destroy: Effect.void,
    tools: { run: () => Effect.die("unused") },
  };
  const output = mockOutput();
  const telemetry = mockTelemetryStateTracked();
  const layer = Layer.mergeAll(
    BunServices.layer,
    runtimeInfoLayer,
    mockCommandSettings({ workdir: root, supabaseHome: root }),
    output.layer,
    telemetry.layer,
    Layer.succeed(StackTargetResolver, {
      resolve: () => Effect.succeed({ projectRoot: root }),
    }),
    Layer.succeed(StackApi, {
      create: () => Effect.succeed(stack),
      open: () => Effect.succeed(stack),
      discover: () => Effect.succeed([]),
      resolveIdentity: () => Effect.die("unused"),
    }),
  );
  return {
    layer,
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
        const fixture = makeFixture(root, true);
        return stackPrepare(flags()).pipe(
          Effect.provide(fixture.layer),
          Effect.flip,
          Effect.tap((error) =>
            Effect.sync(() => {
              expect(error.message).toContain("download failed");
              expect(error.reason).toBe("artifact");
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
