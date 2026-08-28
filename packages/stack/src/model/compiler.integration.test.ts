import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option, Redacted } from "effect";
import { InvalidStackConfigError, StackVersionUnsupportedError } from "../public/Errors.ts";
import { canonicalize, compileStack } from "./Compiler.ts";
import { RestModule } from "./capabilities/rest.ts";

const layer = NodeServices.layer;
const compile = (
  config: Parameters<typeof compileStack>[0]["config"],
  runtime: Parameters<typeof compileStack>[0]["runtime"] = { kind: "native" },
  previous?: Parameters<typeof compileStack>[1],
) =>
  compileStack({ projectRoot: "/tmp/supabase-project", runtime, config }, previous).pipe(
    Effect.provide(layer),
  );

const failureOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

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
      expect(canonicalize(result.inputFingerprint)).not.toContain("secret-value");
      expect(canonicalize(result.executionPlan)).not.toContain("secret-value");
      expect(result.secrets).toHaveLength(1);
      expect(Redacted.isRedacted(result.secrets[0]?.value)).toBe(true);
      expect(canonicalize(result.executionPlan)).not.toContain("secret-value");
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
        capabilities: { pooler: { enabled: true, settings: { pool_mode: "session" } } },
      });
      expect(result.definition.capabilities.pooler.settings).toMatchObject({
        pool_mode: "session",
      });
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
      expect(failureOf(exit)).toBeInstanceOf(InvalidStackConfigError);
      const edgeEnabled = yield* compile({
        capabilities: { functions: { settings: { edge_runtime: { enabled: false } } } },
      } as never).pipe(Effect.exit);
      expect(failureOf(edgeEnabled)).toBeInstanceOf(InvalidStackConfigError);
      const inspectorPort = yield* compile({
        capabilities: { functions: { settings: { edge_runtime: { inspector_port: 8083 } } } },
      } as never).pipe(Effect.exit);
      expect(failureOf(inspectorPort)).toBeInstanceOf(InvalidStackConfigError);
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
      expect(failureOf(result)).toBeInstanceOf(StackVersionUnsupportedError);
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
      expect(failureOf(result)).toBeInstanceOf(InvalidStackConfigError);
    }),
  );

  it.live("reports dependency closure errors", () =>
    Effect.gen(function* () {
      const result = yield* compile({
        capabilities: { rest: { enabled: false }, studio: { enabled: true } },
      }).pipe(Effect.exit);
      expect(failureOf(result)).toBeInstanceOf(InvalidStackConfigError);
    }),
  );

  it.live("resolves each supported database major to its supported release", () =>
    Effect.gen(function* () {
      const expected = {
        13: "15.8.1.085",
        14: "14.1.0.89",
        15: "15.8.1.085",
        17: "17.6.1.165",
      } as const;
      for (const [major, release] of Object.entries(expected)) {
        const result = yield* compile({ capabilities: { database: { version: major } } });
        expect(result.definition.capabilities.database.version).toBe(release);
        expect(
          result.executionPlan.workloads.find((w) => w.id === "database:database")?.artifacts,
        ).toEqual({
          native: { kind: "native", service: "database", release },
          container: {
            kind: "container",
            service: "database",
            image: `supabase/postgres:${release}`,
          },
        });
      }
    }),
  );

  it.live("rejects an unknown non-database release", () =>
    Effect.gen(function* () {
      const result = yield* compile({ capabilities: { rest: { version: "not-real" } } }).pipe(
        Effect.exit,
      );
      expect(failureOf(result)).toBeInstanceOf(StackVersionUnsupportedError);
    }),
  );

  it.live("rejects an empty non-database release", () =>
    Effect.gen(function* () {
      const result = yield* compile({ capabilities: { rest: { version: "" } } }).pipe(Effect.exit);
      expect(failureOf(result)).toBeInstanceOf(StackVersionUnsupportedError);
    }),
  );

  it.live("rebuilds a plan from an identical persisted definition", () =>
    Effect.gen(function* () {
      const first = yield* compile({
        capabilities: { rest: { settings: { schemas: ["current"] } } },
      });
      const persisted = {
        ...first.definition,
        capabilities: {
          ...first.definition.capabilities,
          rest: {
            ...first.definition.capabilities.rest,
            settings: { ...first.definition.capabilities.rest.settings, schemas: ["persisted"] },
          },
        },
      };
      const reused = yield* compile(
        { capabilities: { rest: { settings: { schemas: ["current"] } } } },
        { kind: "native" },
        { definition: persisted, inputFingerprint: first.inputFingerprint },
      );
      expect(reused.definition).toBe(persisted);
      const previousHash = first.executionPlan.workloads.find(
        (w) => w.id === "rest:rest",
      )?.specHash;
      const freshHash = reused.executionPlan.workloads.find((w) => w.id === "rest:rest")?.specHash;
      expect(freshHash).not.toBe(previousHash);
    }),
  );

  it.live("reuses persisted state before evaluating current module defaults", () =>
    Effect.gen(function* () {
      const first = yield* compile({});
      const defaultVersion = RestModule.defaultVersion;
      Reflect.set(RestModule, "defaultVersion", "not-real");
      try {
        const reused = yield* compile({}, { kind: "native" }, first);
        expect(reused.definition).toBe(first.definition);
      } finally {
        Reflect.set(RestModule, "defaultVersion", defaultVersion);
      }
    }),
  );

  it.live("rejects a persisted definition whose release is no longer supported", () =>
    Effect.gen(function* () {
      const first = yield* compile({});
      const persisted = {
        ...first.definition,
        capabilities: {
          ...first.definition.capabilities,
          rest: { ...first.definition.capabilities.rest, version: "not-real" },
        },
      };
      const result = yield* compile(
        {},
        { kind: "native" },
        {
          definition: persisted,
          inputFingerprint: first.inputFingerprint,
        },
      ).pipe(Effect.exit);
      expect(failureOf(result)).toBeInstanceOf(StackVersionUnsupportedError);
    }),
  );

  it.live("validates persisted capability closure before rebuilding its plan", () =>
    Effect.gen(function* () {
      const first = yield* compile({});
      const persisted = {
        ...first.definition,
        capabilities: {
          ...first.definition.capabilities,
          rest: { ...first.definition.capabilities.rest, enabled: false },
        },
      };
      const result = yield* compile(
        {},
        { kind: "native" },
        { definition: persisted, inputFingerprint: first.inputFingerprint },
      ).pipe(Effect.exit);
      expect(failureOf(result)).toBeInstanceOf(InvalidStackConfigError);
    }),
  );

  it.live("materializes defaults for supplied records", () =>
    Effect.gen(function* () {
      const result = yield* compile({
        capabilities: {
          storage: { settings: { buckets: { avatars: { public: true } } } },
          functions: { settings: { functions: { hello: { verify_jwt: false } } } },
        },
      });
      expect(result.definition.capabilities.storage.settings.buckets).toEqual({
        avatars: {
          public: true,
          file_size_limit: "50MiB",
          allowed_mime_types: [],
          objects_path: "",
        },
      });
      expect(result.definition.capabilities.functions.settings.functions).toEqual({
        hello: {
          enabled: true,
          verify_jwt: false,
          import_map: "",
          entrypoint: "",
          static_files: [],
          env: {},
        },
      });
    }),
  );

  it.live("uses pool_mode and rejects the old mode spelling", () =>
    Effect.gen(function* () {
      const result = yield* compile({
        capabilities: { pooler: { settings: { pool_mode: "session" } } },
      });
      expect(result.definition.capabilities.pooler.settings.pool_mode).toBe("session");
      const invalid = yield* compile({
        capabilities: { pooler: { settings: { mode: "session" } } },
      } as never).pipe(Effect.exit);
      expect(failureOf(invalid)).toBeInstanceOf(InvalidStackConfigError);
    }),
  );

  it.live("rejects invalid function slugs and environment names", () =>
    Effect.gen(function* () {
      const invalidSlug = yield* compile({
        capabilities: { functions: { settings: { functions: { "bad.slug": {} } } } },
      } as never).pipe(Effect.exit);
      expect(failureOf(invalidSlug)).toBeInstanceOf(InvalidStackConfigError);
      const invalidEnv = yield* compile({
        capabilities: {
          functions: {
            settings: { functions: { hello: { env: { "bad-name": Redacted.make("x") } } } },
          },
        },
      } as never).pipe(Effect.exit);
      expect(failureOf(invalidEnv)).toBeInstanceOf(InvalidStackConfigError);
    }),
  );

  it.live("enforces network port bounds", () =>
    Effect.gen(function* () {
      for (const port of [0, -1, 1.5, 65536]) {
        const invalid = yield* compile({ listeners: { api: { port } } } as never).pipe(Effect.exit);
        expect(failureOf(invalid)).toBeInstanceOf(InvalidStackConfigError);
      }
      for (const port of [1, 65535]) {
        const valid = yield* compile({ listeners: { api: { port } } });
        expect(valid.definition.listeners.api.port).toBe(port);
      }
    }),
  );
});
