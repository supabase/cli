import { BunServices } from "@effect/platform-bun";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { DEFAULT_SIGNING_KEY } from "@supabase/stack/defaults";
import { Effect, Exit, FileSystem, Layer, Path, Schema } from "effect";
import { importJWK, jwtVerify } from "jose";
import { ServiceCreationInput } from "../../../../../../packages/stack/src/services/Catalog.ts";
import { runtimeInfoLayer } from "../../../shared/runtime/runtime-info.layer.ts";
import { renderCliConfigTemplate } from "../../../shared/init/project-init.templates.ts";

import { loadStackConfig } from "../../../command-internal/stack-config.ts";
import { createStackConfigProject } from "../../../../tests/helpers/stack-config.ts";

const load = (projectRoot: string) =>
  loadStackConfig(projectRoot).pipe(
    Effect.provide(Layer.mergeAll(BunServices.layer, runtimeInfoLayer)),
  );

const project = (contents: string, options: Parameters<typeof createStackConfigProject>[1] = {}) =>
  createStackConfigProject(contents, options).pipe(
    Effect.provide(Layer.mergeAll(BunServices.layer, runtimeInfoLayer)),
  );

const publicJwkSchema = Schema.Struct({
  kty: Schema.Literal("EC"),
  kid: Schema.String,
  crv: Schema.Literal("P-256"),
  x: Schema.String,
  y: Schema.String,
});

const remoteJwkSchema = Schema.Struct({
  kty: Schema.String,
  kid: Schema.String,
  n: Schema.String,
  e: Schema.String,
});

const byService = (services: ReadonlyArray<Schema.Schema.Type<typeof ServiceCreationInput>>) =>
  new Map(services.map((service) => [service.service, service]));

describe("loadStackConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.live("decodes the default recipe and leaves listeners automatic", () =>
    Effect.gen(function* () {
      const root = yield* project(`project_id = "stack-config-defaults"
[edge_runtime]
enabled = true
`);
      const config = yield* load(root);
      const services = yield* config.creations("stack-defaults");
      for (const service of services) yield* Schema.decodeEffect(ServiceCreationInput)(service);

      const recipes = byService(services);
      const keys = yield* config.keys;
      expect(keys.anonKey).toBeUndefined();
      expect(keys.serviceRoleKey).toBeUndefined();
      expect(keys.gotrueJwtKeys).toBeUndefined();
      expect(keys.publicSigningKeys).toBeUndefined();
      const database = recipes.get("database");
      expect(
        database?.service === "database" ? database.config.rootKey : undefined,
      ).toBeUndefined();
      expect(
        database?.service === "database" ? database.config.jwtSecret : undefined,
      ).toBeUndefined();
      expect(
        database?.service === "database" ? database.config.databasePassword : undefined,
      ).toBeUndefined();
      expect(recipes.get("database")?.endpoints).toEqual({ sql: { port: "auto" } });
      expect(recipes.get("rest")?.endpoints).toEqual({ http: { port: "auto" } });
      expect(recipes.get("analytics")?.endpoints).toEqual({ http: { port: "auto" } });
      const storage = recipes.get("storage");
      expect(storage?.service === "storage" && storage.config.fileSizeLimit).toBe("52428800");
      expect(recipes.has("vector")).toBe(true);
      expect(recipes.has("functions")).toBe(true);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("preserves explicit listener ports while translating every enabled service", () =>
    Effect.gen(function* () {
      const root = yield* project(`project_id = "stack-config-ports"
[api]
port = 55421
[db]
port = 55422
[db.pooler]
enabled = true
port = 55423
[analytics]
port = 55424
[studio]
enabled = true
port = 55425
[local_smtp]
enabled = true
port = 55426
smtp_port = 55427
pop3_port = 55428
[storage.image_transformation]
enabled = true
`);
      const config = yield* load(root);
      const services = yield* config.creations("stack-ports");
      const recipes = byService(services);
      expect(recipes.get("database")?.endpoints).toEqual({ sql: { port: 55422 } });
      expect(recipes.get("rest")?.endpoints).toEqual({ http: { port: 55421 } });
      expect(recipes.get("analytics")?.endpoints).toEqual({ http: { port: 55424 } });
      expect(recipes.get("pooler")?.endpoints).toEqual({
        http: { port: "auto" },
        sql: { port: 55423 },
      });
      expect(recipes.get("studio")?.endpoints).toEqual({ http: { port: 55425 } });
      expect(recipes.get("mail")?.endpoints).toEqual({
        http: { port: 55426 },
        smtp: { port: 55427 },
        pop3: { port: 55428 },
      });
      expect(recipes.has("pgmeta")).toBe(true);
      expect(recipes.has("imgproxy")).toBe(true);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("leaves stack-opt-in init listeners automatic except disabled pooler", () =>
    Effect.gen(function* () {
      const root = yield* project(renderCliConfigTemplate("stack-config-init", false, true));
      const config = yield* load(root);
      const services = byService(yield* config.creations("stack-config-init"));
      expect(services.get("database")?.endpoints).toEqual({ sql: { port: "auto" } });
      expect(services.get("rest")?.endpoints).toEqual({ http: { port: "auto" } });
      expect(services.get("pooler")).toBeUndefined();
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("keeps the shared API port when REST is disabled", () =>
    Effect.gen(function* () {
      const root = yield* project(`project_id = "stack-config-auth-port"
[api]
enabled = false
port = 55431
`);
      const config = yield* load(root);
      const recipes = byService(yield* config.creations("stack-auth-port"));
      expect(recipes.has("rest")).toBe(false);
      expect(recipes.get("auth")?.endpoints).toEqual({ http: { port: 55431 } });
      expect(recipes.get("storage")?.endpoints).toEqual({ http: { port: 55431 } });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("rejects Auth email template content paths deferred by the stack", () =>
    Effect.gen(function* () {
      const root = yield* project(`project_id = "stack-config-auth-template"
[auth.email.template.invite]
content_path = "./templates/invite.html"
`);
      const exit = yield* load(root).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("auth.email");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("validates enabled Auth third-party providers", () =>
    Effect.gen(function* () {
      const root = yield* project(`project_id = "stack-config-auth-third-party"
[auth.third_party.firebase]
enabled = true
project_id = ""
`);
      const exit = yield* load(root).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("auth.third_party");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("loads an empty signing-key file and skips it when Auth is disabled", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const enabled = yield* project(`project_id = "stack-config-signing-keys"
[auth]
signing_keys_path = "./keys.json"
`);
      yield* fs.writeFileString(path.join(enabled, "supabase", "keys.json"), "[]");
      const enabledConfig = yield* load(enabled);
      const keys = yield* enabledConfig.keys;
      expect(keys.gotrueJwtKeys).toBe("[]");
      expect(keys.publicSigningKeys).toBe("[]");

      const disabled = yield* project(`project_id = "stack-config-disabled-signing-keys"
[auth]
enabled = false
signing_keys_path = "./missing-keys.json"
`);
      const disabledConfig = yield* load(disabled);
      const disabledKeys = yield* disabledConfig.keys;
      const jwks = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(publicJwkSchema)))(
        disabledKeys.publicSigningKeys ?? "[]",
      );
      expect(jwks).toHaveLength(1);
      expect(jwks[0]?.kid).toBe(DEFAULT_SIGNING_KEY.kid);
      expect(disabledKeys.publicSigningKeys).not.toContain('"d"');
      const publicJwk = jwks[0];
      if (publicJwk === undefined) return yield* Effect.die("The default public JWK is missing.");
      const publicKey = yield* Effect.promise(() => importJWK(publicJwk, "ES256"));
      for (const [token, role] of [
        [disabledKeys.anonKey, "anon"],
        [disabledKeys.serviceRoleKey, "service_role"],
      ] as const) {
        expect(token).toBeDefined();
        const verified = yield* Effect.promise(() =>
          jwtVerify(token ?? "", publicKey, { algorithms: ["ES256"] }),
        );
        expect(verified.payload.role).toBe(role);
      }

      const envDisabled = yield* project(
        `project_id = "stack-config-env-disabled-signing-keys"\n[auth]\nenabled = false\n`,
        { supabaseEnv: "SUPABASE_AUTH_SIGNING_KEYS_PATH=./missing-keys.json\n" },
      );
      const envKeys = yield* (yield* load(envDisabled)).keys;
      expect(envKeys.publicSigningKeys).toBe(disabledKeys.publicSigningKeys);
      expect(envKeys.anonKey).toBeDefined();
      expect(envKeys.serviceRoleKey).toBeDefined();
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fetches third-party JWKS while Auth is disabled", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const remoteKey = { kty: "RSA", kid: "remote-key", n: "Ag", e: "AQAB" };
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            port: 0,
            fetch(request) {
              const url = new URL(request.url);
              paths.push(url.pathname);
              if (url.pathname === "/.well-known/openid-configuration")
                return Response.json({ jwks_uri: `${url.origin}/jwks` });
              if (url.pathname === "/jwks") return Response.json({ keys: [remoteKey] });
              return new Response(null, { status: 404 });
            },
          }),
        ),
        (server) => Effect.promise(() => server.stop(true)),
      );
      if (server.port === undefined) return yield* Effect.die("The JWKS server has no TCP port.");
      const root = yield* project(
        `project_id = "stack-config-disabled-third-party"\n[auth]\nenabled = false\n`,
        {
          supabaseEnv: `SUPABASE_AUTH_THIRD_PARTY_WORKOS_ENABLED=true\nSUPABASE_AUTH_THIRD_PARTY_WORKOS_ISSUER_URL=http://127.0.0.1:${server.port}\n`,
        },
      );
      const config = yield* load(root);
      const keys = yield* config.keys;
      const remoteJwks = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.Array(remoteJwkSchema)),
      )(keys.remoteJwks ?? "[]");
      expect(remoteJwks).toEqual([remoteKey]);
      expect(paths).toEqual(["/.well-known/openid-configuration", "/jwks"]);

      const emptyIssuer = yield* project(`project_id = "stack-config-disabled-empty-issuer"
[auth]
enabled = false
[auth.third_party.workos]
enabled = true
issuer_url = ""
`);
      const emptyIssuerKeys = yield* (yield* load(emptyIssuer)).keys;
      expect(emptyIssuerKeys.remoteJwks).toBeUndefined();
      expect(paths).toEqual(["/.well-known/openid-configuration", "/jwks"]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("rejects an analytics backend the stack cannot represent", () =>
    Effect.gen(function* () {
      const root = yield* project(`project_id = "stack-config-analytics"
[analytics]
enabled = true
backend = "bigquery"
`);
      const exit = yield* load(root).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(String(exit.cause)).toContain("analytics.backend must be postgres");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("rejects unsupported database versions before creating recipes", () =>
    Effect.gen(function* () {
      const root = yield* project(`project_id = "stack-config-db-version"
[db]
major_version = 14
`);
      const exit = yield* load(root).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(String(exit.cause)).toContain("db.major_version must be 15 or 17");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("ignores unresolved experimental S3 env placeholders", () => {
    for (const name of ["s3_host", "S3_REGION", "S3_ACCESS_KEY", "S3_SECRET_KEY"])
      vi.stubEnv(name, "");
    return Effect.gen(function* () {
      const root = yield* project(`project_id = "stack-config-s3-placeholder"
[experimental]
s3_host = "env(s3_host)"
s3_region = "env(S3_REGION)"
s3_access_key = "env(S3_ACCESS_KEY)"
s3_secret_key = "env(S3_SECRET_KEY)"
`);
      const config = yield* load(root);
      const services = yield* config.creations("stack-s3-placeholder");
      expect(services.some((service) => service.service === "database")).toBe(true);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.live("rejects OrioleDB and ignores its inactive S3 settings", () =>
    Effect.gen(function* () {
      const orioledb = yield* project(`project_id = "stack-config-orioledb"
[experimental]
orioledb_version = "15.1.1.14"
`);
      const orioledbExit = yield* load(orioledb).pipe(Effect.exit);
      expect(Exit.isFailure(orioledbExit)).toBe(true);
      if (Exit.isFailure(orioledbExit))
        expect(String(orioledbExit.cause)).toContain("experimental.orioledb_version");

      const s3 = yield* project(`project_id = "stack-config-experimental-s3"
[experimental]
s3_host = "s3.example.test"
`);
      const s3Config = yield* load(s3);
      expect(s3Config.source.experimental.s3_host).toBe("s3.example.test");
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
