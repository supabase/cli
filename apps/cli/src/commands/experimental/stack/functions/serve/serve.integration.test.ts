// oxlint-disable-next-line effecttsgo/node-builtin-import -- filesystem test fixture uses the host adapter at this boundary
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- filesystem test fixture uses the host adapter at this boundary
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, PubSub, Redacted, Stream } from "effect";
import { StackIdSchema, type EffectStack, type StackStatus } from "@supabase/stack/effect";
import { DebugFlag } from "../../../../../command-internal/global-flags.ts";
import { serveFileWatcherLayer } from "../../../../../shared/functions/serve.ts";
import {
  FileWatcher,
  type FileWatchEvent,
} from "../../../../../shared/runtime/file-watcher.service.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
} from "../../../../../../tests/helpers/command-mocks.ts";
import {
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
} from "../../../../../../tests/helpers/mocks.ts";
import { StackApi } from "../../stack.shared.ts";
import { functionsServeStack } from "./serve.handler.ts";

const id = StackIdSchema.make("f".repeat(64));
const flags: Parameters<typeof functionsServeStack>[0] = {
  noVerifyJwt: Option.none(),
  envFile: Option.none(),
  importMap: Option.none(),
  inspect: false,
  inspectMode: Option.none(),
  inspectMain: false,
  all: true,
};

const status: StackStatus = {
  id,
  lifecycle: "running",
  desiredLifecycle: "running",
  runtime: { kind: "native" },
  endpoints: {
    api: {
      protocol: "http",
      address: "127.0.0.1",
      port: 54321,
      url: "http://127.0.0.1:54321",
    },
  },
  versions: {},
  capabilities: [],
  artifacts: [],
};

describe("managed stack functions serve", () => {
  it.live("serves on the current managed stack and leaves it running on interruption", () =>
    Effect.gen(function* () {
      const projectRoot = mkdtempSync(join(tmpdir(), "supabase-stack-functions-serve-"));
      mkdirSync(join(projectRoot, "supabase", "functions", "hello"), { recursive: true });
      writeFileSync(join(projectRoot, "supabase", "config.toml"), 'project_id = "serve-test"\n');
      writeFileSync(
        join(projectRoot, "supabase", "functions", "hello", "index.ts"),
        'Deno.serve(() => new Response("hello"))\n',
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(projectRoot, { recursive: true })));
      const output = mockOutput();
      const telemetry = mockTelemetryStateTracked();
      const shutdown = yield* Deferred.make<"SIGINT">();
      const activated = yield* Deferred.make<void>();
      const servedConfigs: unknown[] = [];
      let stopCalls = 0;
      let destroyCalls = 0;
      const stack: EffectStack = {
        id,
        status: Effect.succeed(status),
        credentials: Effect.die("unused"),
        prepare: () => Effect.die("unused"),
        start: () => Effect.die("must not start"),
        serveFunctions: (options) =>
          Effect.sync(() => {
            servedConfigs.push(options?.config);
            return status;
          }),
        stop: Effect.sync(() => void stopCalls++),
        destroy: Effect.sync(() => void destroyCalls++),
        logs: () => Effect.succeed({ entries: [], cursor: { opaque: "v1_0" }, running: true }),
        followLogs: () =>
          Stream.fromEffect(Deferred.succeed(activated, undefined)).pipe(
            Stream.flatMap(() => Stream.never),
          ),
      };
      const descriptor = {
        id,
        projectRoot,
        name: "serve-test",
        branchContext: "ordinary-workspace" as const,
        runtime: { kind: "native" as const },
        desiredLifecycle: "running" as const,
      };
      const layer = Layer.mergeAll(
        output.layer,
        telemetry.layer,
        mockCommandSettings({ workdir: projectRoot }),
        mockRuntimeInfo({ cwd: projectRoot }),
        mockProcessControl({ awaitSignal: Deferred.await(shutdown) }).layer,
        serveFileWatcherLayer,
        Layer.succeed(DebugFlag, false),
        Layer.succeed(StackApi, {
          findStack: () => Effect.succeed(Option.some(descriptor)),
          openStack: () => Effect.succeed(stack),
          createStack: () => Effect.die("must not create"),
          inspectStack: () => Effect.die("must not inspect"),
          discoverStacks: () => Effect.die("must not discover"),
        }),
        BunServices.layer,
      );

      const fiber = yield* functionsServeStack(flags).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(activated);
      yield* Deferred.succeed(shutdown, "SIGINT");
      yield* Fiber.join(fiber);
      expect(servedConfigs).toHaveLength(2);
      expect(servedConfigs[0]).toBeDefined();
      expect(servedConfigs[1]).toBeUndefined();
      expect(stopCalls).toBe(0);
      expect(destroyCalls).toBe(0);
      expect(output.stdoutText).toContain("Setting up Edge Functions runtime");
      expect(output.stdoutText).toContain("http://127.0.0.1:54321/functions/v1/<function-name>");
      expect(output.stdoutText).toContain("Stopped serving supabase/functions");
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.live("guides users to start the stack when none is selected", () =>
    Effect.gen(function* () {
      const output = mockOutput();
      const telemetry = mockTelemetryStateTracked();
      const failure = yield* functionsServeStack(flags).pipe(
        Effect.provide(
          Layer.mergeAll(
            output.layer,
            telemetry.layer,
            mockCommandSettings({ workdir: "/project" }),
            mockRuntimeInfo({ cwd: "/project" }),
            mockProcessControl({ signal: "SIGINT" }).layer,
            serveFileWatcherLayer,
            Layer.succeed(DebugFlag, false),
            Layer.succeed(StackApi, {
              findStack: () => Effect.succeed(Option.none()),
              openStack: () => Effect.die("must not open"),
              createStack: () => Effect.die("must not create"),
              inspectStack: () => Effect.die("must not inspect"),
              discoverStacks: () => Effect.die("must not discover"),
            }),
            BunServices.layer,
          ),
        ),
        Effect.flip,
      );
      expect(failure.suggestion).toContain("supabase start");
      expect(telemetry.flushed).toBe(true);
    }),
  );

  it.live("reloads invocation inputs after a watched Function change", () =>
    Effect.gen(function* () {
      const projectRoot = mkdtempSync(join(tmpdir(), "supabase-stack-functions-reload-"));
      const functionsRoot = join(projectRoot, "supabase", "functions");
      mkdirSync(join(functionsRoot, "hello"), { recursive: true });
      writeFileSync(join(projectRoot, "supabase", "config.toml"), 'project_id = "serve-test"\n');
      writeFileSync(
        join(functionsRoot, "hello", "index.ts"),
        'Deno.serve(() => new Response("hello"))\n',
      );
      const envPath = join(projectRoot, "serve.env");
      writeFileSync(envPath, "MARKER=first\n");
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(projectRoot, { recursive: true })));

      const output = mockOutput();
      const telemetry = mockTelemetryStateTracked();
      const shutdown = yield* Deferred.make<"SIGINT">();
      const changes = yield* PubSub.unbounded<ReadonlyArray<FileWatchEvent>>({ replay: 1 });
      const watching = yield* Deferred.make<void>();
      const activations = yield* Deferred.make<void>();
      const servedConfigs: unknown[] = [];
      const stack: EffectStack = {
        id,
        status: Effect.succeed(status),
        credentials: Effect.die("unused"),
        prepare: () => Effect.die("unused"),
        start: () => Effect.die("must not start"),
        serveFunctions: (options) =>
          Effect.sync(() => {
            servedConfigs.push(options?.config);
            return servedConfigs.length;
          }).pipe(
            Effect.tap((count) =>
              count === 2 ? Deferred.succeed(activations, undefined) : Effect.void,
            ),
            Effect.as(status),
          ),
        stop: Effect.die("must not stop"),
        destroy: Effect.die("must not destroy"),
        logs: () => Effect.succeed({ entries: [], cursor: { opaque: "v1_0" }, running: true }),
        followLogs: () => Stream.never,
      };
      const descriptor = {
        id,
        projectRoot,
        name: "serve-test",
        branchContext: "ordinary-workspace" as const,
        runtime: { kind: "native" as const },
        desiredLifecycle: "running" as const,
      };
      const layer = Layer.mergeAll(
        output.layer,
        telemetry.layer,
        mockCommandSettings({ workdir: projectRoot }),
        mockRuntimeInfo({ cwd: projectRoot }),
        mockProcessControl({ awaitSignal: Deferred.await(shutdown) }).layer,
        Layer.succeed(DebugFlag, false),
        Layer.succeed(FileWatcher, {
          watch: () =>
            Stream.fromEffect(Deferred.succeed(watching, undefined)).pipe(
              Stream.flatMap(() => Stream.fromPubSub(changes)),
            ),
        }),
        Layer.succeed(StackApi, {
          findStack: () => Effect.succeed(Option.some(descriptor)),
          openStack: () => Effect.succeed(stack),
          createStack: () => Effect.die("must not create"),
          inspectStack: () => Effect.die("must not inspect"),
          discoverStacks: () => Effect.die("must not discover"),
        }),
        BunServices.layer,
      );

      const fiber = yield* functionsServeStack({
        ...flags,
        envFile: Option.some("serve.env"),
      }).pipe(Effect.provide(layer), Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(watching);
      writeFileSync(envPath, "MARKER=second\n");
      yield* PubSub.publish(changes, [
        { path: join(functionsRoot, "hello", "index.ts"), type: "update" },
      ]);
      yield* Deferred.await(activations);
      yield* Deferred.succeed(shutdown, "SIGINT");
      yield* Fiber.join(fiber);

      expect(servedConfigs).toHaveLength(3);
      const first = servedConfigs[0] as {
        capabilities?: {
          functions?: {
            settings?: {
              edge_runtime?: { secrets?: Record<string, Redacted.Redacted<string>> };
            };
          };
        };
      };
      const second = servedConfigs[1] as typeof first;
      const firstMarker = first.capabilities?.functions?.settings?.edge_runtime?.secrets?.MARKER;
      const secondMarker = second.capabilities?.functions?.settings?.edge_runtime?.secrets?.MARKER;
      expect(firstMarker === undefined ? undefined : Redacted.value(firstMarker)).toBe("first");
      expect(secondMarker === undefined ? undefined : Redacted.value(secondMarker)).toBe("second");
      expect(servedConfigs[2]).toBeUndefined();
      expect(output.stderrText).toContain("File change detected:");
    }).pipe(Effect.scoped),
  );
});
