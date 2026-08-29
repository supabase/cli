import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { CliConfigSchema, type FunctionsManifest } from "@supabase/config";
import type { StackConfig, StackId, StackStatus } from "@supabase/stack/effect";
import { CAPABILITY_NAMES, StackIdSchema } from "@supabase/stack/effect";
import { Effect, Layer, Option, Redacted, Schema, Stream } from "effect";
import {
  mockLegacyCliSettings,
  mockLegacyTelemetryStateLayer,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import type { LegacyFunctionsServeFlags } from "./serve.handler.ts";
import {
  legacyFunctionsServe,
  type ServeManagedFunctionsOperations,
  type ManagedFunctionsStack,
} from "./serve.handler.ts";

const baseFlags = (): LegacyFunctionsServeFlags => ({
  noVerifyJwt: Option.some(true),
  envFile: Option.none(),
  importMap: Option.some("supabase/functions/deno.json"),
  inspect: false,
  inspectMode: Option.none(),
  inspectMain: false,
  all: true,
});

const stackId: StackId = StackIdSchema.make(
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
);
const status = (lifecycle: StackStatus["lifecycle"]): StackStatus => ({
  id: stackId,
  lifecycle,
  desiredLifecycle:
    lifecycle === "starting" || lifecycle === "stopping" || lifecycle === "resetting-database"
      ? "running"
      : lifecycle,
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

describe("legacy functions serve", () => {
  it.live("uses managed Functions with flags, gateway readiness, and stack logs", () => {
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
        Stream.succeed({
          cursor: { opaque: "1" },
          timestamp: "now",
          source: "functions" as const,
          stream: "stdout" as const,
          message: "ready",
        }),
      close: () => Effect.void,
    };
    const output = mockOutput({ interactive: false });
    const manifest: FunctionsManifest = {
      hello: {
        enabled: true,
        verify_jwt: true,
        import_map: "",
        entrypoint: "./functions/hello/index.ts",
        static_files: [],
        env: {},
      },
    };
    const operations: ServeManagedFunctionsOperations = {
      findStack: () => Effect.succeed(Option.none()),
      createStack: () => Effect.succeed(stack),
      openStack: () => Effect.succeed(stack),
      loadConfig: () => Effect.succeed(Schema.decodeUnknownSync(CliConfigSchema)({})),
      loadManifest: () => Effect.succeed(manifest),
    };
    return legacyFunctionsServe(baseFlags(), operations).pipe(
      Effect.provide(
        Layer.mergeAll(
          output.layer,
          BunServices.layer,
          mockLegacyCliSettings({ workdir: "/tmp/project" }),
          mockLegacyTelemetryStateLayer,
        ),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          const functions = startedConfig?.capabilities?.functions;
          const functionSettings =
            functions !== undefined && "settings" in functions ? functions.settings : undefined;
          const hello = functionSettings?.functions?.hello;
          expect(functionSettings?.functions_root).toBe("supabase/functions");
          expect(hello?.verify_jwt).toBe(false);
          expect(hello?.import_map).toBe("supabase/functions/deno.json");
          expect(output.messages).toContainEqual(
            expect.objectContaining({ message: "http://127.0.0.1:54321/functions/v1" }),
          );
          expect(output.messages.some((message) => message.message.includes("ready"))).toBe(true);
          expect(Redacted.isRedacted(hello?.env?.ANY)).toBe(false);
        }),
      ),
    );
  });
});
