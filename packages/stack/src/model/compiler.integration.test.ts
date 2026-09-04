import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option, Redacted } from "effect";
import { InvalidStackConfigError, StackVersionUnsupportedError } from "../public/Errors.ts";
import { canonicalize, compileStack, rebuildExecutionPlan, sameDefinition } from "./Compiler.ts";
import { resolveThirdPartyIssuer } from "./capabilities/auth-third-party.ts";
import { DEFAULT_DATABASE_HEALTH_TIMEOUT } from "./capabilities/database.ts";
import { parseFileSize } from "./capabilities/storage.ts";
import { catalogEntryFor } from "./WorkloadCatalog.ts";

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
  it.live("normalizes storage byte limits and rejects invalid sizes", () =>
    Effect.gen(function* () {
      expect(parseFileSize("50MiB")).toBe("52428800");
      expect(parseFileSize("1.5KB")).toBe("1500");
      expect(parseFileSize("2 GiB")).toBe("2147483648");
      expect(parseFileSize(-1)).toBeUndefined();
      expect(parseFileSize("not-a-size")).toBeUndefined();
      expect(parseFileSize("999999999999999999TiB")).toBeUndefined();
      for (const value of ["not-a-size", "-1", "1.1B"]) {
        const result = yield* compile({
          capabilities: { storage: { settings: { file_size_limit: value } } },
        }).pipe(Effect.exit);
        expect(failureOf(result)).toBeInstanceOf(InvalidStackConfigError);
      }
    }),
  );
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

  it.live("materializes the default database health timeout", () =>
    Effect.gen(function* () {
      const result = yield* compile({});
      expect(result.definition.capabilities.database.settings.health_timeout).toBe(
        DEFAULT_DATABASE_HEALTH_TIMEOUT,
      );
    }),
  );

  it.live("defaults only the database capability to eager activation", () =>
    Effect.gen(function* () {
      const result = yield* compile({});
      expect(result.executionPlan.activation).toEqual({
        database: "eager",
        rest: "lazy",
        auth: "lazy",
        realtime: "lazy",
        storage: "lazy",
        functions: "lazy",
        studio: "lazy",
        mail: "lazy",
        analytics: "lazy",
        pooler: "lazy",
      });
      expect(result.definition.capabilities.pooler).toMatchObject({
        enabled: true,
        activation: "lazy",
      });
      expect(result.definition.listeners.pooler.enabled).toBe(true);
      const disabledPooler = yield* compile({ capabilities: { pooler: { enabled: false } } });
      expect(disabledPooler.definition.capabilities.pooler.enabled).toBe(false);
      expect(disabledPooler.definition.listeners.pooler.enabled).toBe(true);
    }),
  );

  it.live("rejects an invalid database health timeout during compilation", () =>
    Effect.gen(function* () {
      const result = yield* compile({
        capabilities: { database: { settings: { health_timeout: "not-a-duration" } } },
      }).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      expect(failureOf(result)).toBeInstanceOf(InvalidStackConfigError);
      const zero = yield* compile({
        capabilities: { database: { settings: { health_timeout: "0" } } },
      }).pipe(Effect.exit);
      expect(failureOf(zero)).toBeInstanceOf(InvalidStackConfigError);
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

  it.live("persists defaults consumed by workload runtimes", () =>
    Effect.gen(function* () {
      const result = yield* compile({});
      expect(result.definition.capabilities.rest.settings).toMatchObject({
        schemas: ["public", "graphql_public"],
        extra_search_path: ["public", "extensions"],
        max_rows: 1000,
      });
      expect(result.definition.capabilities.auth.settings).toMatchObject({
        site_url: "http://127.0.0.1:3000",
        jwt_expiry: 3600,
      });
      expect(result.definition.capabilities.mail.settings).toEqual({
        admin_email: "admin@email.com",
        sender_name: "Admin",
      });
      expect(result.definition.capabilities.analytics.settings).toMatchObject({
        backend: "postgres",
        gcp_project_id: "local",
        gcp_project_number: "0",
      });
      expect(result.definition.capabilities.realtime.settings).toMatchObject({
        max_header_length: 4096,
      });
      expect(result.definition.capabilities.functions.settings).toMatchObject({
        functions_root: "/tmp/supabase-project/supabase/functions",
        edge_runtime: { policy: "per_worker", deno_version: 2 },
      });
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
      expect(canonicalize(result.executionPlan)).not.toContain("secret-value");
      const supplied = result.secrets.find(
        (entry) => entry.slot === "secret:auth.settings.secret_key",
      );
      expect(supplied?.policy).toBe("managed");
      expect(Redacted.isRedacted(supplied?.value)).toBe(true);
      for (const slot of [
        "secret:database.internal.password",
        "secret:auth.settings.publishable_key",
        "secret:auth.settings.jwt_secret",
        "secret:auth.settings.anon_key",
        "secret:auth.settings.service_role_key",
      ]) {
        expect(result.secrets.find((entry) => entry.slot === slot)?.policy).toBe("managed");
      }
      expect(canonicalize(result.executionPlan)).not.toContain("secret-value");
    }),
  );

  it.live("persists the closed storage S3 defaults", () =>
    Effect.gen(function* () {
      const result = yield* compile({});
      expect(result.definition.capabilities.storage.settings.s3_protocol).toEqual({
        enabled: true,
        region: "local",
        access_key_id: "625729a08b95bf1b7ff351a663f3a23c",
        secret_access_key: { slot: "secret:storage.settings.s3_protocol.secret_access_key" },
      });
      expect(result.secrets).toContainEqual(
        expect.objectContaining({
          slot: "secret:storage.settings.s3_protocol.secret_access_key",
          policy: "managed",
        }),
      );
      expect(
        result.secrets.some(
          (entry) => entry.slot === "secret:storage.settings.s3_protocol.access_key_id",
        ),
      ).toBe(false);
    }),
  );

  it.live("uses one canonical JWT secret slot for symmetric signing", () =>
    Effect.gen(function* () {
      const result = yield* compile({});
      expect(result.definition.security.jwt.signing).toEqual({
        kind: "symmetric",
        secret: { slot: "secret:auth.settings.jwt_secret" },
      });
      expect(result.secrets.filter((entry) => entry.slot.includes("jwt"))).toEqual([
        expect.objectContaining({ slot: "secret:auth.settings.jwt_secret", policy: "managed" }),
      ]);
    }),
  );

  it.live("accepts either symmetric JWT secret spelling and deduplicates the slot", () =>
    Effect.gen(function* () {
      const fromAuth = yield* compile({
        capabilities: { auth: { settings: { jwt_secret: Redacted.make("auth-secret") } } },
      });
      expect(fromAuth.definition.security.jwt.signing).toEqual({
        kind: "symmetric",
        secret: { slot: "secret:auth.settings.jwt_secret" },
      });
      expect(fromAuth.secrets.filter((entry) => entry.slot.includes("jwt"))).toEqual([
        expect.objectContaining({
          slot: "secret:auth.settings.jwt_secret",
          policy: "managed",
          value: Redacted.make("auth-secret"),
        }),
      ]);

      const fromSecurity = yield* compile({
        security: { jwt: { signing: { kind: "symmetric", secret: Redacted.make("top-secret") } } },
      });
      expect(fromSecurity.definition.capabilities.auth.settings.jwt_secret).toEqual({
        slot: "secret:auth.settings.jwt_secret",
      });
      expect(fromSecurity.secrets.filter((entry) => entry.slot.includes("jwt"))).toEqual([
        expect.objectContaining({
          slot: "secret:auth.settings.jwt_secret",
          policy: "managed",
          value: Redacted.make("top-secret"),
        }),
      ]);

      const equal = yield* compile({
        capabilities: { auth: { settings: { jwt_secret: Redacted.make("equal-secret") } } },
        security: {
          jwt: { signing: { kind: "symmetric", secret: Redacted.make("equal-secret") } },
        },
      });
      expect(equal.secrets.filter((entry) => entry.slot.includes("jwt"))).toHaveLength(1);
    }),
  );

  it.live("rejects conflicting symmetric JWT secret spellings without leaking values", () =>
    Effect.gen(function* () {
      const exit = yield* compile({
        capabilities: { auth: { settings: { jwt_secret: Redacted.make("auth-secret") } } },
        security: {
          jwt: { signing: { kind: "symmetric", secret: Redacted.make("top-secret") } },
        },
      }).pipe(Effect.exit);
      const error = failureOf(exit);
      expect(error).toBeInstanceOf(InvalidStackConfigError);
      expect(String(error)).not.toContain("auth-secret");
      expect(String(error)).not.toContain("top-secret");
    }),
  );

  it.live("retains Auth's local JWT secret when signing uses a JWKS file", () =>
    Effect.gen(function* () {
      const result = yield* compile({
        security: { jwt: { signing: { kind: "jwks-file", path: "jwt.json" } } },
      });
      expect(result.definition.security.jwt.signing).toEqual({
        kind: "jwks-file",
        path: "jwt.json",
      });
      expect(result.secrets.filter((entry) => entry.slot.includes("jwt"))).toEqual([
        expect.objectContaining({ slot: "secret:auth.settings.jwt_secret", policy: "managed" }),
      ]);
      expect(
        result.secrets.find((entry) => entry.slot === "secret:auth.settings.anon_key")?.generator,
      ).toEqual({
        kind: "jwt-token",
        role: "anon",
        signing: {
          kind: "jwks-file",
          projectRoot: "/tmp/supabase-project",
          path: "jwt.json",
        },
      });
    }),
  );

  it.live("derives each supported third-party issuer and rejects invalid combinations", () =>
    Effect.gen(function* () {
      const cases = [
        [
          { firebase: { enabled: true, project_id: "project-42" } },
          "https://securetoken.google.com/project-42",
        ],
        [
          { auth0: { enabled: true, tenant: "tenant", tenant_region: "eu" } },
          "https://tenant.eu.auth0.com",
        ],
        [
          {
            aws_cognito: { enabled: true, user_pool_id: "eu_pool", user_pool_region: "eu-west-1" },
          },
          "https://cognito-idp.eu-west-1.amazonaws.com/eu_pool",
        ],
        [
          { clerk: { enabled: true, domain: "example.clerk.accounts.dev" } },
          "https://example.clerk.accounts.dev",
        ],
        [
          { workos: { enabled: true, issuer_url: "https://login.example.test" } },
          "https://login.example.test",
        ],
      ] as const;
      for (const [settings, issuer] of cases) {
        const result = resolveThirdPartyIssuer(settings);
        expect(result).toEqual({ ok: true, value: expect.objectContaining({ issuer }) });
      }
      const invalid = yield* compile({
        capabilities: {
          auth: {
            settings: {
              third_party: {
                firebase: { enabled: true, project_id: "project-42" },
                auth0: { enabled: true, tenant: "tenant" },
              },
            },
          },
        },
      }).pipe(Effect.exit);
      expect(failureOf(invalid)).toBeInstanceOf(InvalidStackConfigError);
      expect(resolveThirdPartyIssuer({ firebase: { enabled: true } })).toMatchObject({
        ok: false,
        provider: "firebase",
      });
      expect(
        resolveThirdPartyIssuer({ clerk: { enabled: true, domain: "not-a-clerk-domain" } }),
      ).toMatchObject({ ok: false, provider: "clerk" });
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

  it.live("creates a managed Analytics access key when omitted", () =>
    Effect.gen(function* () {
      const result = yield* compile({});
      expect(result.definition.capabilities.analytics.settings).toMatchObject({
        api_key: { slot: "secret:analytics.settings.api_key" },
      });
      expect(result.secrets).toContainEqual({
        slot: "secret:analytics.settings.api_key",
        policy: "managed",
        generator: { kind: "random-base64url", bytes: 32 },
      });
    }),
  );

  it.live("manages a supplied Analytics access key", () =>
    Effect.gen(function* () {
      const result = yield* compile({
        capabilities: { analytics: { settings: { api_key: Redacted.make("custom-api-key") } } },
      });
      expect(result.secrets).toContainEqual({
        slot: "secret:analytics.settings.api_key",
        policy: "managed",
        value: Redacted.make("custom-api-key"),
        generator: { kind: "random-base64url", bytes: 32 },
      });
      expect(result.definition.capabilities.analytics.settings.api_key).toEqual({
        slot: "secret:analytics.settings.api_key",
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

  it.live("attaches artifact-compatible generators for managed pooler keys", () =>
    Effect.gen(function* () {
      const result = yield* compile({ capabilities: { pooler: { enabled: true } } });
      expect(result.secrets).toContainEqual({
        slot: "secret:pooler.settings.encryption_key",
        policy: "managed",
        generator: { kind: "random-base64url", bytes: 24 },
      });
      expect(result.secrets).toContainEqual({
        slot: "secret:pooler.settings.secret_key_base",
        policy: "managed",
        generator: { kind: "random-base64url", bytes: 48 },
      });
    }),
  );

  it.live("rejects pooler key values that violate the artifact contract", () =>
    Effect.gen(function* () {
      const invalidEncryption = yield* compile({
        capabilities: {
          pooler: {
            enabled: true,
            settings: { encryption_key: Redacted.make("too-short") },
          },
        },
      }).pipe(Effect.exit);
      expect(failureOf(invalidEncryption)).toBeInstanceOf(InvalidStackConfigError);
      expect(failureOf(invalidEncryption)?.setting).toBe(
        "capabilities.pooler.settings.encryption_key",
      );

      const invalidSecretBase = yield* compile({
        capabilities: {
          pooler: {
            enabled: true,
            settings: { secret_key_base: Redacted.make("!".repeat(63)) },
          },
        },
      }).pipe(Effect.exit);
      expect(failureOf(invalidSecretBase)).toBeInstanceOf(InvalidStackConfigError);
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

  it.live("persists and reuses the managed database password slot", () =>
    Effect.gen(function* () {
      const first = yield* compile({});
      const initial = first.secrets.filter(
        (entry) => entry.slot === "secret:database.internal.password",
      );
      expect(initial).toHaveLength(1);
      const second = yield* compile(
        {},
        { kind: "native" },
        {
          definition: first.definition,
        },
      );
      expect(
        second.secrets.filter((entry) => entry.slot === "secret:database.internal.password"),
      ).toHaveLength(1);
      expect(second.secrets[0]?.slot).toBe(initial[0]?.slot);
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

  it.live("keeps record key insertion order out of materialized definitions", () =>
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
      expect(sameDefinition(one.definition, two.definition)).toBe(true);
    }),
  );

  it.live("materializes omitted and explicit defaults identically", () =>
    Effect.gen(function* () {
      const omitted = yield* compile({});
      const explicit = yield* compile({ capabilities: { rest: { enabled: true } } });
      expect(sameDefinition(omitted.definition, explicit.definition)).toBe(true);
    }),
  );

  it.live("accepts an equivalent materialized definition from a previous compilation", () =>
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
      expect(sameDefinition(first.definition, second.definition)).toBe(true);
      expect(sameDefinition(reused.definition, first.definition)).toBe(true);
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

  it.live("compiles database bootstrap as a marker on the database workload", () =>
    Effect.gen(function* () {
      const result = yield* compile({});
      const database = result.executionPlan.workloads.filter((w) => w.capability === "database");
      expect(database).toHaveLength(1);
      expect(database[0]?.id).toBe("database:database");
      expect(database[0]?.bootstrap).toBe("database");
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

  it.live("resolves the supported database major to its supported release", () =>
    Effect.gen(function* () {
      for (const [release, image] of Object.entries(
        catalogEntryFor("database:database").releases,
      )) {
        const major = release.split(".")[0];
        const result = yield* compile({ capabilities: { database: { version: major } } });
        expect(result.definition.capabilities.database.version).toBe(release);
        expect(
          result.executionPlan.workloads.find((w) => w.id === "database:database")?.artifacts,
        ).toEqual({
          native: { kind: "native", release },
          container: {
            kind: "container",
            image,
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

  it.live("rejects unsupported historical database releases", () =>
    Effect.gen(function* () {
      for (const version of ["13", "13.3.0", "14"]) {
        const result = yield* compile({ capabilities: { database: { version } } }).pipe(
          Effect.exit,
        );
        expect(failureOf(result)).toBeInstanceOf(StackVersionUnsupportedError);
      }
    }),
  );

  it.live("rejects an empty non-database release", () =>
    Effect.gen(function* () {
      const result = yield* compile({ capabilities: { rest: { version: "" } } }).pipe(Effect.exit);
      expect(failureOf(result)).toBeInstanceOf(StackVersionUnsupportedError);
    }),
  );

  it.live("compiles supplied configuration against persisted release pins", () =>
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
      const compiled = yield* compile(
        { capabilities: { rest: { settings: { schemas: ["current"] } } } },
        { kind: "native" },
        { definition: persisted },
      );
      expect(compiled.definition.capabilities.rest.settings.schemas).toEqual(["current"]);
      expect(compiled.definition.capabilities.rest.version).toBe(
        persisted.capabilities.rest.version,
      );
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
      const result = yield* rebuildExecutionPlan({ kind: "native" }, persisted).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
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
