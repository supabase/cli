import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Schema } from "effect";
import { ServiceCreation } from "../../../../../../packages/stack/src/services/Catalog.ts";
import { runtimeInfoLayer } from "../../../shared/runtime/runtime-info.layer.ts";

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

const byService = (services: ReadonlyArray<Schema.Schema.Type<typeof ServiceCreation>>) =>
  new Map(services.map((service) => [service.service, service]));

describe("loadStackConfig", () => {
  it.live("decodes the default recipe and leaves listeners automatic", () =>
    Effect.gen(function* () {
      const root = yield* project(`project_id = "stack-config-defaults"
[edge_runtime]
enabled = true
`);
      const config = yield* load(root);
      const services = yield* config.creations("stack-defaults");
      for (const service of services) yield* Schema.decodeEffect(ServiceCreation)(service);

      const recipes = byService(services);
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

  it.live("rejects unsupported function settings before creating recipes", () =>
    Effect.gen(function* () {
      const root = yield* project(`project_id = "stack-config-functions"
[edge_runtime]
enabled = true
[functions.hello]
entrypoint = "./hello/main.ts"
`);
      const exit = yield* load(root).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(String(exit.cause)).toContain(
          "functions.hello.entrypoint is unsupported by the experimental stack",
        );
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

  it.live("rejects unsupported effective auth hooks and accepts an explicit disabled hook", () =>
    Effect.gen(function* () {
      const unsupported = yield* project(`project_id = "stack-config-auth-hook"
[auth.hook.custom_access_token]
enabled = true
uri = "pg-functions://custom-access-token"
`);
      const exit = yield* load(unsupported).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("auth.hook");

      const disabled = yield* project(`project_id = "stack-config-auth-hook-disabled"
[auth.hook.custom_access_token]
enabled = false
`);
      yield* load(disabled);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("rejects unsupported function JWT settings and edge secrets", () =>
    Effect.gen(function* () {
      const functionRoot = yield* project(`project_id = "stack-config-function-jwt"
[functions.hello]
verify_jwt = false
`);
      const functionExit = yield* load(functionRoot).pipe(Effect.exit);
      expect(Exit.isFailure(functionExit)).toBe(true);
      if (Exit.isFailure(functionExit))
        expect(String(functionExit.cause)).toContain("functions.hello.verify_jwt");

      const secretRoot = yield* project(`project_id = "stack-config-edge-secret"
[edge_runtime.secrets]
EXAMPLE = "secret"
`);
      const secretExit = yield* load(secretRoot).pipe(Effect.exit);
      expect(Exit.isFailure(secretExit)).toBe(true);
      if (Exit.isFailure(secretExit))
        expect(String(secretExit.cause)).toContain("edge_runtime.secrets");

      const authDisabledRoot = yield* project(`project_id = "stack-config-edge-secret-auth-disabled"
[auth]
enabled = false
[edge_runtime.secrets]
EXAMPLE = "secret"
`);
      const authDisabledExit = yield* load(authDisabledRoot).pipe(Effect.exit);
      expect(Exit.isFailure(authDisabledExit)).toBe(true);
      if (Exit.isFailure(authDisabledExit))
        expect(String(authDisabledExit.cause)).toContain("edge_runtime.secrets");
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

  it.live("accepts disabled storage vector settings but rejects custom vector limits", () =>
    Effect.gen(function* () {
      const disabled = yield* project(`project_id = "stack-config-vector-disabled"
[storage.vector]
enabled = false
`);
      yield* load(disabled);

      const custom = yield* project(`project_id = "stack-config-vector-custom"
[storage.vector]
max_buckets = 11
`);
      const exit = yield* load(custom).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("storage.vector");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("rejects unsupported OrioleDB and experimental S3 settings", () =>
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
      const s3Exit = yield* load(s3).pipe(Effect.exit);
      expect(Exit.isFailure(s3Exit)).toBe(true);
      if (Exit.isFailure(s3Exit)) expect(String(s3Exit.cause)).toContain("experimental.s3_host");
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
