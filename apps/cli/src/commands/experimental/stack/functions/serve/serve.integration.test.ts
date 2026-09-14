// oxlint-disable-next-line effecttsgo/node-builtin-import -- filesystem test fixture uses the host adapter at this boundary
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- filesystem test fixture uses the host adapter at this boundary
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";
import { StackIdSchema, type EffectStack, type StackStatus } from "@supabase/stack/effect";
import { DebugFlag } from "../../../../../command-internal/global-flags.ts";
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
      let servedConfig: unknown;
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
            servedConfig = options?.config;
            return status;
          }),
        stop: Effect.sync(() => void stopCalls++),
        destroy: Effect.sync(() => void destroyCalls++),
        logs: () =>
          Effect.succeed({ entries: [], cursor: { opaque: "v1_0" }, running: true }),
        followLogs: () =>
          Stream.make({
            cursor: { opaque: "v1_1" },
            timestamp: "2026-01-01T00:00:00.000Z",
            source: "functions",
            stream: "stdout",
            message: "Functions ready",
          }),
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
        mockProcessControl({ signal: "SIGINT" }).layer,
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

      yield* functionsServeStack(flags).pipe(Effect.provide(layer));
      expect(servedConfig).toBeDefined();
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
});
