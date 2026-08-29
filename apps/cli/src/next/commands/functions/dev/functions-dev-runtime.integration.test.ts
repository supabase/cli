import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option, Redacted, Schema, Stream } from "effect";
import { CliConfigSchema } from "@supabase/config";
import type { EffectStack } from "@supabase/stack/effect";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { serveManagedFunctions } from "./functions-dev-runtime.ts";

const fakeStatus = {
  lifecycle: "running",
  desiredLifecycle: "running",
  runtime: { kind: "container", engine: "docker" },
  endpoints: {},
  versions: {},
  capabilities: [],
};

describe("managed Functions serving", () => {
  it.live("starts the Functions capability with the live functions root and streams logs", () => {
    let startedConfig: unknown;
    const stack = {
      id: "stack-test",
      start: (options?: { config?: unknown }) =>
        Effect.sync(() => {
          startedConfig = options?.config;
          return fakeStatus;
        }),
      logs: () =>
        Stream.fromIterable([
          {
            cursor: { opaque: "1" },
            timestamp: "now",
            source: "functions",
            stream: "stdout",
            message: "ready",
          },
        ]),
      close: () => Effect.void,
    } as unknown as EffectStack;
    const out = mockOutput({ interactive: false });
    const operations = {
      findStack: () => Effect.succeed(Option.none()),
      createStack: () => Effect.succeed(stack),
      openStack: () => Effect.succeed(stack),
      loadConfig: () =>
        Effect.succeed(
          Schema.decodeUnknownSync(CliConfigSchema)({
            project_id: "demo",
            api: { schemas: ["private"] },
            auth: { jwt_secret: "jwt-secret-for-tests" },
            db: { vault: { DB_PASSWORD: "vault-secret" } },
            edge_runtime: { secrets: { EDGE_TOKEN: "edge-secret" } },
          }),
        ),
    } as const;
    return Effect.scoped(
      serveManagedFunctions({ projectRoot: "/tmp/project", stackName: "default" }, operations),
    ).pipe(
      Effect.provide(Layer.mergeAll(out.layer, BunServices.layer)),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(startedConfig).toMatchObject({
            capabilities: {
              functions: { settings: { functions_root: "/tmp/project/supabase/functions" } },
            },
          });
          const config = startedConfig as {
            capabilities: {
              rest: { settings: { schemas: string[] } };
              auth: { settings: { jwt_secret: Redacted.Redacted<string> } };
              database: { settings: { vault: { DB_PASSWORD: Redacted.Redacted<string> } } };
            };
          };
          expect(config.capabilities.rest.settings.schemas).toEqual(["private"]);
          expect(Redacted.value(config.capabilities.auth.settings.jwt_secret)).toBe(
            "jwt-secret-for-tests",
          );
          expect(Redacted.value(config.capabilities.database.settings.vault.DB_PASSWORD)).toBe(
            "vault-secret",
          );
          expect(out.messages.some((message) => message.message.includes("ready"))).toBe(true);
        }),
      ),
    );
  });
});
