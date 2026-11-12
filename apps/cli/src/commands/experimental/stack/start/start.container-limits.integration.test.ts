import { BunCrypto, BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { FetchHttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
} from "../../../../../tests/helpers/command-mocks.ts";
import { cliConfigValuesTestLayer } from "../../../../../tests/helpers/config-values-layer.ts";
import { mockOutput, mockTty } from "../../../../../tests/helpers/mocks.ts";
import { destroyTestStacks } from "../../../../../tests/helpers/stack-cleanup.ts";
import { CommandPlatformApiFactory } from "../../../../auth/command-platform-api-factory.service.ts";
import { containerCliOutput } from "../../../../command-internal/container-cli.ts";
import { dbConnectionLayer } from "../../../../command-internal/db-connection.sql-pg.layer.ts";
import { DebugFlag, ExperimentalFlag, YesFlag } from "../../../../command-internal/global-flags.ts";
import { stackCatalogSetupLayer } from "../../../../command-internal/stack-catalog-setup.ts";
import {
  StackApi,
  stackApiLayer,
  stackTargetResolverLayer,
} from "../../../../command-internal/stack-target.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import type { Output } from "../../../../shared/output/output.service.ts";
import { runtimeInfoLayer } from "../../../../shared/runtime/runtime-info.layer.ts";
import { stdinLayer } from "../../../../shared/runtime/stdin.layer.ts";
import { stackStatus } from "../status/status.handler.ts";
import { stackStart } from "./start.handler.ts";

const excluded = [
  "rest",
  "realtime",
  "storage",
  "functions",
  "studio",
  "mail",
  "analytics",
  "pooler",
];
const flags = {
  exclude: excluded,
  stack: Option.none<string>(),
  stackId: Option.none<string>(),
  runtime: "docker" as const,
  preparation: "on-demand" as const,
  frozen: false,
  eager: true,
};

const config = (database: string, auth: string) => `
project_id = "stack-start-container-limits"

[api]
enabled = true

[auth]
enabled = true

[realtime]
enabled = false

[storage]
enabled = false

[edge_runtime]
enabled = false

[studio]
enabled = false

[analytics]
enabled = false

[db.pooler]
enabled = false

[local_smtp]
enabled = false

[local.services.database.container]
${database}

[local.services.auth.container]
${auth}
`;

const liveStackApi = stackApiLayer.pipe(Layer.provide(BunServices.layer));

const makeLayer = (root: string, output: Layer.Layer<Output> = mockOutput().layer) => {
  const settings = mockCommandSettings({ workdir: root, supabaseHome: root });
  const resolver = stackTargetResolverLayer.pipe(
    Layer.provide(Layer.mergeAll(BunServices.layer, settings, liveStackApi)),
  );
  const tty = mockTty({ stdinIsTty: false, stdoutIsTty: false });
  return Layer.mergeAll(
    cliConfigValuesTestLayer,
    FetchHttpClient.layer,
    runtimeInfoLayer,
    settings,
    liveStackApi,
    resolver,
    output,
    mockTelemetryStateTracked().layer,
    stackCatalogSetupLayer,
    dbConnectionLayer,
    Layer.succeed(ExperimentalFlag, false),
    Layer.succeed(DebugFlag, false),
    Layer.succeed(YesFlag, false),
    Layer.succeed(CliArgs, { args: ["stack", "start"] }),
    Layer.succeed(CommandPlatformApiFactory, { make: Effect.die("unused") }),
    stdinLayer.pipe(Layer.provide(tty)),
    tty,
  ).pipe(Layer.provideMerge(BunServices.layer));
};

const mib = 1024 * 1024;

/** Reads the limits Docker recorded for one service container of the given stack. */
const serviceLimits = Effect.fn("StartContainerLimitsTest.serviceLimits")(function* (
  stackId: string,
  service: string,
) {
  const spawner = yield* ChildProcessSpawner;
  const listed = yield* containerCliOutput(spawner, [
    "container",
    "ls",
    "--all",
    "--quiet",
    "--filter",
    `label=com.supabase.stack=${stackId}`,
    "--filter",
    `label=com.supabase.service=${service}`,
  ]);
  const ids = listed.stdout.split("\n").filter((line) => line !== "");
  expect(ids).toHaveLength(1);
  const inspected = yield* containerCliOutput(spawner, [
    "container",
    "inspect",
    "--format",
    "{{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.NanoCpus}}",
    ...ids,
  ]);
  const [memory, memorySwap, nanoCpus] = inspected.stdout.trim().split(" ").map(Number);
  return { memory, memorySwap, nanoCpus };
});

const limits = (memoryMiB: number, cpus: number) => ({
  memory: memoryMiB * mib,
  memorySwap: memoryMiB * mib,
  nanoCpus: cpus * 1_000_000_000,
});

describe("experimental stack start container limits", () => {
  it.live(
    "applies configured limits to each service, keeps them across restarts, and reports edits as drift",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-start-limits-" });
        const configPath = path.join(root, "supabase", "config.toml");
        yield* fs.makeDirectory(path.join(root, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          configPath,
          config('memory = "768MiB"\ncpus = 1.5', 'memory = "256MiB"\ncpus = 0.5'),
        );
        const stateRoot = path.join(root, "stacks");
        const cacheRoot = path.join(root, "cache");
        yield* Effect.ensuring(
          Effect.gen(function* () {
            const api = yield* StackApi;
            // Each CLI invocation loads config.toml in a fresh process, so each command gets fresh layers.
            const start = Effect.suspend(() => stackStart(flags)).pipe(
              Effect.scoped,
              Effect.provide(makeLayer(root)),
            );
            const drift = Effect.gen(function* () {
              const out = mockOutput({ format: "json" });
              yield* stackStatus({
                stack: Option.none(),
                stackId: Option.none(),
                env: false,
                overrideName: [],
              }).pipe(Effect.scoped, Effect.provide(makeLayer(root, out.layer)));
              return out.messages.find((message) => message.type === "success")?.data;
            });
            const stop = (id: string) =>
              api.open({ id, stateRoot, cacheRoot }).pipe(
                Effect.flatMap((stack) => stack.stop),
                Effect.scoped,
              );

            const stackId = yield* start;
            expect(yield* serviceLimits(stackId, "database")).toEqual(limits(768, 1.5));
            expect(yield* serviceLimits(stackId, "auth")).toEqual(limits(256, 0.5));

            yield* stop(stackId);
            expect(yield* start).toBe(stackId);
            expect(yield* serviceLimits(stackId, "database")).toEqual(limits(768, 1.5));
            expect(yield* serviceLimits(stackId, "auth")).toEqual(limits(256, 0.5));

            yield* fs.writeFileString(
              configPath,
              config('memory = "1GiB"\ncpus = 2', 'memory = "512MiB"\ncpus = 1'),
            );
            expect(yield* drift).toMatchObject({
              config_drift: {
                status: "changed",
                paths: expect.arrayContaining([
                  "services.database.container.memoryBytes",
                  "services.database.container.cpus",
                  "services.auth.container.memoryBytes",
                  "services.auth.container.cpus",
                ]),
              },
            });

            yield* stop(stackId);
            expect(yield* start).toBe(stackId);
            expect(yield* serviceLimits(stackId, "database")).toEqual(limits(1024, 2));
            expect(yield* serviceLimits(stackId, "auth")).toEqual(limits(512, 1));
            expect(yield* drift).toMatchObject({ config_drift: { status: "unchanged" } });
          }),
          Effect.gen(function* () {
            const api = yield* StackApi;
            yield* destroyTestStacks(api, stateRoot, cacheRoot);
          }),
        ).pipe(Effect.provide(makeLayer(root)));
      }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
    { timeout: 300_000 },
  );
});
