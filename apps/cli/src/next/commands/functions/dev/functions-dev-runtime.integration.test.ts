import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { CliConfigSchema } from "@supabase/config";
import type { FunctionsManifest } from "@supabase/config";
import { Effect, Layer, Option, Redacted, Schema, Stream } from "effect";
import type { StackConfig, StackId, StackStatus } from "@supabase/stack/effect";
import { CAPABILITY_NAMES, StackIdSchema } from "@supabase/stack/effect";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  serveManagedFunctions,
  type ManagedFunctionsStack,
  type ServeManagedFunctionsOperations,
} from "./functions-dev-runtime.ts";

const stackId: StackId = StackIdSchema.make(
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);
const status = (lifecycle: StackStatus["lifecycle"]): StackStatus => ({
  id: stackId,
  lifecycle,
  desiredLifecycle: lifecycle === "starting" || lifecycle === "stopping" ? "running" : lifecycle,
  runtime: { kind: "container", engine: "docker" },
  endpoints:
    lifecycle === "running"
      ? {
          api: {
            protocol: "http",
            address: "127.0.0.1",
            port: 54321,
            url: "http://127.0.0.1:54321",
          },
        }
      : {},
  versions: {},
  capabilities: CAPABILITY_NAMES.map((name) => ({
    name,
    activation: name === "functions" ? "lazy" : "eager",
    state: lifecycle === "running" ? (name === "functions" ? "dormant" : "ready") : "stopped",
  })),
});

describe("managed Functions serving", () => {
  it.live("maps flags and live manifest, waits for gateway readiness, then streams logs", () => {
    let startedConfig: StackConfig | undefined;
    const stack: ManagedFunctionsStack = {
      id: stackId,
      status: () => Effect.succeed(status("running")),
      start: (options) =>
        Effect.sync(() => {
          startedConfig = options?.config;
          return status("starting");
        }),
      watchStatus: () => Stream.succeed(status("running")),
      logs: () =>
        Stream.fromIterable([
          {
            cursor: { opaque: "1" },
            timestamp: "now",
            source: "functions" as const,
            stream: "stdout" as const,
            message: "ready",
          },
        ]),
      close: () => Effect.void,
    };
    const output = mockOutput({ interactive: false });
    const manifest: FunctionsManifest = {
      hello: {
        enabled: true,
        verify_jwt: true,
        import_map: "./functions/hello/manifest-deno.json",
        entrypoint: "./functions/hello/index.ts",
        static_files: ["./functions/hello/public/*.html"],
        env: { CONFIG_TOKEN: "config-secret" },
      },
    };
    const operations: ServeManagedFunctionsOperations = {
      findStack: () => Effect.succeed(Option.none()),
      createStack: () => Effect.succeed(stack),
      openStack: () => Effect.succeed(stack),
      loadConfig: () =>
        Effect.succeed(
          Schema.decodeUnknownSync(CliConfigSchema)({
            edge_runtime: { inspector_port: 8090 },
          }),
        ),
      loadManifest: () => Effect.succeed(manifest),
      readEnvFile: () => Effect.succeed({ ENV_TOKEN: "env-secret" }),
    };
    return serveManagedFunctions(
      {
        projectRoot: "/tmp/project",
        stackName: "default",
        envFile: "flags.env",
        noVerifyJwt: true,
        importMap: "./functions/hello/custom-deno.json",
        inspectMode: "wait",
        inspectMain: true,
      },
      operations,
    ).pipe(
      Effect.provide(Layer.mergeAll(output.layer, BunServices.layer)),
      Effect.tap(() =>
        Effect.sync(() => {
          const functions = startedConfig?.capabilities?.functions;
          const functionSettings =
            functions !== undefined && "settings" in functions ? functions.settings : undefined;
          const hello = functionSettings?.functions?.hello;
          expect(functionSettings?.functions_root).toBe("supabase/functions");
          expect(functionSettings?.inspector).toEqual({ mode: "wait", main: true });
          expect(hello?.verify_jwt).toBe(false);
          expect(hello?.import_map).toBe("custom-deno.json");
          expect(hello?.entrypoint).toBe("index.ts");
          expect(hello?.static_files).toEqual(["public/*.html"]);
          const configToken = hello?.env?.CONFIG_TOKEN;
          const envToken = hello?.env?.ENV_TOKEN;
          expect(configToken).toBeDefined();
          expect(envToken).toBeDefined();
          if (configToken !== undefined) expect(Redacted.value(configToken)).toBe("config-secret");
          if (envToken !== undefined) expect(Redacted.value(envToken)).toBe("env-secret");
          expect(startedConfig?.listeners?.functionsInspector).toEqual({ port: 8090 });
          expect(output.messages).toContainEqual(
            expect.objectContaining({ message: "http://127.0.0.1:54321/functions/v1" }),
          );
          expect(output.messages.some((message) => message.message.includes("ready"))).toBe(true);
        }),
      ),
    );
  });
});
