import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Stream } from "effect";
import type { ServiceCreation, ServiceInstance, Stack } from "@supabase/stack/effect";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
} from "../../../../../tests/helpers/command-mocks.ts";
import { mockOutput, mockTty } from "../../../../../tests/helpers/mocks.ts";
import {
  DbConnection,
  type DbSession,
} from "../../../../command-internal/db-connection.service.ts";
import { StackCatalogSetup } from "../../../../command-internal/stack-catalog-setup.ts";
import { ExperimentalFlag, YesFlag } from "../../../../command-internal/global-flags.ts";
import { CommandPlatformApiFactory } from "../../../../auth/command-platform-api-factory.service.ts";
import { stdinLayer } from "../../../../shared/runtime/stdin.layer.ts";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { runtimeInfoLayer } from "../../../../shared/runtime/runtime-info.layer.ts";
import { StackApi, StackTargetResolver } from "../stack.shared.ts";
import { stackStart } from "./start.handler.ts";
import { StackCommandStartError } from "./start.errors.ts";

const flags = (exclude: ReadonlyArray<string> = []) => ({
  exclude,
  stack: Option.none<string>(),
  stackId: Option.none<string>(),
  runtime: "native" as const,
  preparation: "background" as const,
  eager: false,
});

const session: DbSession = {
  exec: () => Effect.void,
  execBatch: () => Effect.void,
  query: () => Effect.succeed([]),
  extensionExists: () => Effect.succeed(false),
  copyToCsv: () => Effect.succeed(new Uint8Array()),
  queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
};

const instance = (creation: ServiceCreation, id: string): ServiceInstance =>
  ({
    id,
    service: creation.service,
    start: Effect.void,
    ready: Effect.void,
    stop: Effect.void,
    restart: () => Effect.void,
    destroy: Effect.void,
    prepare: Effect.void,
    status: Effect.succeed({
      id,
      endpoints: [],
      config: creation,
      lifecycle: "stopped",
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
    credentials: () =>
      creation.service === "database"
        ? Effect.succeed({ databaseUrl: "postgresql://postgres:postgres@127.0.0.1:5432/postgres" })
        : Effect.succeed({}),
  }) as unknown as ServiceInstance;

const fakeStack = () => {
  let members: Array<ServiceInstance> = [];
  let stopped = 0;
  let composed = 0;
  const stack = {
    id: "a".repeat(64),
    services: {
      create: (creation: ServiceCreation) =>
        Effect.succeed(instance(creation, `${creation.service}-standalone`)),
      get: (id: string) => {
        const found = members.find((entry) => entry.id === id);
        return found === undefined ? Effect.die(`missing instance ${id}`) : Effect.succeed(found);
      },
      get list() {
        return Effect.succeed(members);
      },
    },
    composition: {
      describe: Effect.sync(() => ({
        members: members.map(({ id }) => ({ id, activation: "eager" as const })),
        dependencies: [],
      })),
      supabase: (creations: ReadonlyArray<ServiceCreation>) =>
        Effect.sync(() => {
          composed += 1;
          members = creations.map((creation) => instance(creation, `${creation.service}-member`));
          return members;
        }),
      configure: () => Effect.void,
      start: Effect.void,
      stop: Effect.sync(() => {
        stopped += 1;
        return [];
      }),
      restart: Effect.succeed([]),
    },
    stop: Effect.void,
    destroy: Effect.void,
    tools: { run: () => Effect.die("tool not used") },
  };
  const typedStack = stack as unknown as Stack;
  return {
    stack: typedStack,
    get members() {
      return members;
    },
    get stopped() {
      return stopped;
    },
    get composed() {
      return composed;
    },
  };
};

const layers = (root: string, fixture: ReturnType<typeof fakeStack>) => {
  const output = mockOutput();
  const telemetry = mockTelemetryStateTracked();
  const target = Layer.succeed(StackTargetResolver, {
    resolve: () => Effect.succeed({ projectRoot: root, runtime: "native" as const }),
  });
  const api = Layer.succeed(StackApi, {
    create: () => Effect.succeed(fixture.stack),
    open: () => Effect.succeed(fixture.stack),
    discover: () => Effect.succeed([]),
    resolveIdentity: () => Effect.die("identity not used"),
  } as never);
  return Layer.mergeAll(
    BunServices.layer,
    runtimeInfoLayer,
    output.layer,
    telemetry.layer,
    mockCommandSettings({ workdir: root }),
    target,
    api,
    Layer.succeed(ExperimentalFlag, false),
    Layer.succeed(CliArgs, { args: ["stack", "start"] }),
    Layer.succeed(StackCatalogSetup, { apply: () => Effect.void }),
    Layer.succeed(DbConnection, { connect: () => Effect.scoped(Effect.succeed(session)) }),
    Layer.succeed(YesFlag, false),
    Layer.succeed(CommandPlatformApiFactory, { make: Effect.die("unused") }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("unused")),
    ),
    stdinLayer.pipe(Layer.provide(mockTty({ stdinIsTty: false, stdoutIsTty: false }))),
    mockTty({ stdinIsTty: false, stdoutIsTty: false }),
  );
};

describe("experimental stack start", () => {
  it.live("rejects malformed configuration before creating a stack", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-invalid-" });
      yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
      yield* fs.writeFileString(`${root}/supabase/config.toml`, "[db]\nmajor_version = 14\n");
      let created = false;
      const fixture = fakeStack();
      const base = layers(root, fixture);
      const api = Layer.succeed(StackApi, {
        create: () =>
          Effect.sync(() => {
            created = true;
            return fixture.stack;
          }),
        open: () => Effect.succeed(fixture.stack),
        discover: () => Effect.succeed([]),
        resolveIdentity: () => Effect.die("identity not used"),
      } as never);
      const result = yield* stackStart(flags()).pipe(
        Effect.flip,
        Effect.provide(Layer.merge(base, api)),
      );
      expect(result).toMatchObject({ reason: "invalid-config" });
      expect(created).toBe(false);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("applies capability selection across repeated starts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-db-" });
      yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
      yield* fs.writeFileString(
        `${root}/supabase/config.toml`,
        'project_id = "start-test"\n[edge_runtime]\nenabled = false\n',
      );
      const fixture = fakeStack();
      const excluded = [
        "rest",
        "auth",
        "realtime",
        "storage",
        "functions",
        "studio",
        "mail",
        "analytics",
        "pooler",
      ];
      yield* stackStart(flags(excluded)).pipe(Effect.provide(layers(root, fixture)));
      expect(fixture.members.map(({ service }) => service)).toEqual(["database"]);
      expect(fixture.composed).toBe(1);
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
      expect(fixture.members.some(({ service }) => service === "rest")).toBe(true);
      expect(fixture.composed).toBe(2);
      yield* stackStart(flags(["studio"])).pipe(Effect.provide(layers(root, fixture)));
      expect(fixture.members.some(({ service }) => service === "studio")).toBe(false);
      expect(fixture.stopped).toBe(2);
      yield* stackStart(flags()).pipe(Effect.provide(layers(root, fixture)));
      expect(fixture.members.some(({ service }) => service === "studio")).toBe(true);
      expect(fixture.stopped).toBe(3);
      yield* stackStart(flags(excluded)).pipe(Effect.provide(layers(root, fixture)));
      expect(fixture.composed).toBe(5);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("rejects Studio without REST before changing the composition", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-studio-" });
      yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
      yield* fs.writeFileString(`${root}/supabase/config.toml`, 'project_id = "studio-test"\n');
      const fixture = fakeStack();
      const result = yield* stackStart(flags(["rest"])).pipe(
        Effect.flip,
        Effect.provide(layers(root, fixture)),
      );
      expect(result).toBeInstanceOf(StackCommandStartError);
      expect(result).toMatchObject({ reason: "flags" });
      expect(fixture.stopped).toBe(0);
      expect(fixture.composed).toBe(0);
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
