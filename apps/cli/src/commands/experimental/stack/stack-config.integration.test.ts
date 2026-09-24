import { BunServices } from "@effect/platform-bun";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { Effect, Exit, Layer, Schema } from "effect";
import { ServiceCreationInput } from "../../../../../../packages/stack/src/services/Catalog.ts";
import { runtimeInfoLayer } from "../../../shared/runtime/runtime-info.layer.ts";
import { renderCliConfigTemplate } from "../../../shared/init/project-init.templates.ts";

import { loadStackConfig } from "../../../command-internal/stack-config.ts";
import { createStackConfigProject } from "../../../../tests/helpers/stack-config.ts";

const load = (projectRoot: string) =>
  loadStackConfig(projectRoot).pipe(
    Effect.provide(Layer.mergeAll(BunServices.layer, runtimeInfoLayer)),
  );

const project = (contents: string) =>
  createStackConfigProject(contents).pipe(
    Effect.provide(Layer.mergeAll(BunServices.layer, runtimeInfoLayer)),
  );

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

  it.live("rejects Auth third-party providers deferred by the stack", () =>
    Effect.gen(function* () {
      const root = yield* project(`project_id = "stack-config-auth-third-party"
[auth.third_party.firebase]
enabled = true
project_id = "firebase-project"
`);
      const exit = yield* load(root).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("auth.third_party");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("rejects signing-key files only when Auth is enabled", () =>
    Effect.gen(function* () {
      const enabled = yield* project(`project_id = "stack-config-signing-keys"
[auth]
signing_keys_path = "./keys.json"
`);
      const enabledExit = yield* load(enabled).pipe(Effect.exit);
      expect(Exit.isFailure(enabledExit)).toBe(true);
      if (Exit.isFailure(enabledExit))
        expect(String(enabledExit.cause)).toContain("auth.signing_keys_path");

      const disabled = yield* project(`project_id = "stack-config-disabled-signing-keys"
[auth]
enabled = false
signing_keys_path = "./keys.json"
`);
      const disabledExit = yield* load(disabled).pipe(Effect.exit);
      expect(Exit.isSuccess(disabledExit)).toBe(true);
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

  it.live("still rejects an unresolved auth service role key", () =>
    Effect.gen(function* () {
      const root = yield* project(`project_id = "stack-config-auth-key"
[auth]
service_role_key = "env(SUPABASE_AUTH_SERVICE_ROLE_KEY)"
`);
      const exit = yield* load(root).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("auth.service_role_key");
    }).pipe(Effect.provide(BunServices.layer)),
  );

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
