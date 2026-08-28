import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Redacted } from "effect";
import { canonicalize, compileStack } from "./Compiler.ts";

const layer = NodeServices.layer;
const compile = (
  config: Parameters<typeof compileStack>[0]["config"],
  runtime: Parameters<typeof compileStack>[0]["runtime"] = { kind: "native" },
  previous?: Parameters<typeof compileStack>[1],
) =>
  compileStack({ projectRoot: "/tmp/supabase-project", runtime, config }, previous).pipe(
    Effect.provide(layer),
  );

describe("closed capability compiler", () => {
  it.live("materializes a non-default database setting", () =>
    Effect.gen(function* () {
      const result = yield* compile({
        capabilities: { database: { settings: { health_timeout: "5m" } } },
      });
      expect(result.definition.capabilities.database.settings).toMatchObject({
        health_timeout: "5m",
      });
    }),
  );

  it.live("materializes a non-default rest setting", () =>
    Effect.gen(function* () {
      const result = yield* compile({
        capabilities: { rest: { settings: { schemas: ["private"] } } },
      });
      expect(result.definition.capabilities.rest.settings).toMatchObject({ schemas: ["private"] });
      expect(result.definition.capabilities.rest.settings.schemas).toEqual(["private"]);
    }),
  );

  it.live("materializes a non-default auth setting", () =>
    Effect.gen(function* () {
      const result = yield* compile({
        capabilities: {
          auth: {
            settings: {
              site_url: "https://example.test",
              secret_key: Redacted.make("secret-value"),
            },
          },
        },
      });
      expect(result.definition.capabilities.auth.settings).toMatchObject({
        site_url: "https://example.test",
      });
      expect(canonicalize(result.definition)).not.toContain("secret-value");
    }),
  );

  it.live("materializes a non-default realtime setting", () =>
    Effect.gen(function* () {
      const result = yield* compile({
        capabilities: { realtime: { settings: { ip_version: "IPv6" } } },
      });
      expect(result.definition.capabilities.realtime.settings).toMatchObject({
        ip_version: "IPv6",
      });
    }),
  );

  it.live("materializes a non-default storage bucket", () =>
    Effect.gen(function* () {
      const result = yield* compile({
        capabilities: { storage: { settings: { buckets: { avatars: { public: true } } } } },
      });
      expect(result.definition.capabilities.storage.settings).toMatchObject({
        buckets: { avatars: { public: true } },
      });
    }),
  );

  it.live("normalizes the functions root and preserves a function override", () =>
    Effect.gen(function* () {
      const result = yield* compile({
        capabilities: {
          functions: {
            settings: {
              functions_root: "./supabase/functions",
              functions: { hello: { verify_jwt: false } },
            },
          },
        },
      });
      expect(result.definition.capabilities.functions.settings).toMatchObject({
        functions_root: "/tmp/supabase-project/supabase/functions",
        functions: { hello: { verify_jwt: false } },
      });
    }),
  );

  it.live("materializes a non-default studio setting", () =>
    Effect.gen(function* () {
      const result = yield* compile({
        capabilities: { studio: { settings: { api_url: "http://localhost:9999" } } },
      });
      expect(result.definition.capabilities.studio.settings).toMatchObject({
        api_url: "http://localhost:9999",
      });
    }),
  );

  it.live("materializes a non-default mail setting", () =>
    Effect.gen(function* () {
      const result = yield* compile({
        capabilities: { mail: { settings: { sender_name: "Tests" } } },
      });
      expect(result.definition.capabilities.mail.settings).toMatchObject({ sender_name: "Tests" });
    }),
  );

  it.live("materializes a non-default analytics setting", () =>
    Effect.gen(function* () {
      const result = yield* compile({
        capabilities: { analytics: { settings: { backend: "bigquery" } } },
      });
      expect(result.definition.capabilities.analytics.settings).toMatchObject({
        backend: "bigquery",
      });
    }),
  );

  it.live("materializes a non-default pooler setting", () =>
    Effect.gen(function* () {
      const result = yield* compile({
        capabilities: { pooler: { enabled: true, settings: { mode: "session" } } },
      });
      expect(result.definition.capabilities.pooler.settings).toMatchObject({ mode: "session" });
      expect(result.definition.capabilities.pooler.enabled).toBe(true);
    }),
  );

  it.live("persists every capability and optional absence as null", () =>
    Effect.gen(function* () {
      const result = yield* compile({});
      expect(Object.keys(result.definition.capabilities)).toHaveLength(10);
      expect(result.definition.capabilities.rest.settings).toMatchObject({ external_url: null });
      expect(result.definition.capabilities.functions.settings).toMatchObject({
        edge_runtime: { secrets: {} },
        functions: {},
      });
    }),
  );

  it.live("rejects unknown fields at the public compiler boundary", () =>
    Effect.gen(function* () {
      const exit = yield* compile({
        capabilities: { rest: { settings: { typo: true } } },
      } as never).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(exit.cause).toBeDefined();
    }),
  );

  it.live("keeps record key insertion order out of fingerprints", () =>
    Effect.gen(function* () {
      const one = yield* compile({
        capabilities: {
          storage: { settings: { buckets: { a: { public: true }, b: { public: false } } } },
        },
      });
      const two = yield* compile({
        capabilities: {
          storage: { settings: { buckets: { b: { public: false }, a: { public: true } } } },
        },
      });
      expect(one.inputFingerprint).toBe(two.inputFingerprint);
    }),
  );

  it.live("preserves omitted versus explicit capability selection", () =>
    Effect.gen(function* () {
      const omitted = yield* compile({});
      const explicit = yield* compile({ capabilities: { rest: { enabled: true } } });
      expect(omitted.inputFingerprint).not.toBe(explicit.inputFingerprint);
    }),
  );

  it.live("reuses the exact previous definition for an identical fingerprint", () =>
    Effect.gen(function* () {
      const first = yield* compile({
        capabilities: { rest: { settings: { schemas: ["private"] } } },
      });
      const second = yield* compile({
        capabilities: { rest: { settings: { schemas: ["private"] } } },
      });
      const reused = yield* compile(
        { capabilities: { rest: { settings: { schemas: ["private"] } } } },
        { kind: "native" },
        first,
      );
      expect(first.inputFingerprint).toBe(second.inputFingerprint);
      expect(reused.definition).toBe(first.definition);
    }),
  );

  it.live("rejects an unsupported database version before output", () =>
    Effect.gen(function* () {
      const result = yield* compile({ capabilities: { database: { version: "99" } } }).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) expect(result.cause).toBeDefined();
    }),
  );

  it.live("keeps both native and container artifacts while selecting one runtime", () =>
    Effect.gen(function* () {
      const native = yield* compile({}, { kind: "native" });
      const container = yield* compile({}, { kind: "container", engine: "docker" });
      expect(native.executionPlan.workloads[0]?.artifacts.native.kind).toBe("native");
      expect(native.executionPlan.workloads[0]?.artifacts.container.kind).toBe("container");
      expect(container.executionPlan.workloads[0]?.selected.kind).toBe("container");
    }),
  );

  it.live("rejects a functions root that escapes the project", () =>
    Effect.gen(function* () {
      const result = yield* compile({
        capabilities: { functions: { settings: { functions_root: "../outside" } } },
      }).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) expect(result.cause).toBeDefined();
    }),
  );

  it.live("reports dependency closure errors", () =>
    Effect.gen(function* () {
      const result = yield* compile({
        capabilities: { rest: { enabled: false }, studio: { enabled: true } },
      }).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
    }),
  );
});
