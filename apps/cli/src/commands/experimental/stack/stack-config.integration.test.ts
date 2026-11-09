import { BunCrypto, BunServices } from "@effect/platform-bun";
import { orioledbVersions } from "@supabase/stack/internal/artifacts";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { DEFAULT_SIGNING_KEY } from "@supabase/stack/defaults";
import { Effect, Exit, FileSystem, Layer, Path, Ref, Schema } from "effect";
import { importJWK, jwtVerify } from "jose";
import { ServiceCreationInput } from "../../../../../../packages/stack/src/services/Catalog.ts";
import { runtimeInfoLayer } from "../../../shared/runtime/runtime-info.layer.ts";
import { CLI_VERSION } from "../../../shared/cli/version.ts";
import {
  database15,
  orioledb,
  orioledbConfigVersion,
  selection,
} from "../../../../tests/helpers/pins.ts";
import { renderCliConfigTemplate } from "../../../shared/init/project-init.templates.ts";

import { mockCommandSettings } from "../../../../tests/helpers/command-mocks.ts";
import { loadStackConfig } from "../../../command-internal/stack-config.ts";
import { KONG_LOCAL_TLS_CERT, KONG_LOCAL_TLS_KEY } from "../../start/templates/kong-local-tls.ts";
import { generateKeyPairSync } from "node:crypto";
import { createStackConfigProject } from "../../../../tests/helpers/stack-config.ts";
import {
  CommandTelemetryAttributes,
  type CommandTelemetryAttributeValues,
} from "../../../telemetry/command-telemetry-attributes.ts";
import { withEnvVar } from "../../../../tests/helpers/command-mocks.ts";
import { cliConfigValuesTestLayer } from "../../../../tests/helpers/config-values-layer.ts";

const load = (projectRoot: string) =>
  loadStackConfig(projectRoot).pipe(
    Effect.provide(
      Layer.mergeAll(
        BunServices.layer,
        BunCrypto.layer,
        runtimeInfoLayer,
        mockCommandSettings({ workdir: projectRoot }),
        cliConfigValuesTestLayer,
      ),
    ),
  );

const project = (contents: string, options: Parameters<typeof createStackConfigProject>[1] = {}) =>
  createStackConfigProject(contents, options).pipe(
    Effect.provide(
      Layer.mergeAll(
        BunServices.layer,
        BunCrypto.layer,
        runtimeInfoLayer,
        cliConfigValuesTestLayer,
      ),
    ),
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

  it.effect(
    "pins the database to the line selected by [db] major_version or orioledb_version",
    () =>
      Effect.gen(function* () {
        const databasePin = (contents: string, name: string) =>
          Effect.gen(function* () {
            const root = yield* project(contents);
            const config = yield* load(root);
            const creations = yield* config.creations(name);
            return creations.find((creation) => creation.service === "database")?.pin;
          });

        expect(
          yield* databasePin('project_id = "pin-15"\n[db]\nmajor_version = 15\n', "pin-15"),
        ).toEqual(database15);
        expect(
          yield* databasePin(
            `project_id = "pin-oriole"\n[db]\norioledb_version = "${orioledbConfigVersion}"\n`,
            "pin-oriole",
          ),
        ).toEqual(orioledb);
      }).pipe(Effect.scoped),
  );

  it.effect("decodes the default recipe and leaves listeners automatic", () =>
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
      for (const service of services) expect(service.pin).toEqual(selection[service.service]);
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
      expect(recipes.has("functions")).toBe(true);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("preserves explicit listener ports while translating every enabled service", () =>
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
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect("hands Studio the API settings it mirrors and its snippets folder", () =>
    Effect.gen(function* () {
      const root = yield* project(`project_id = "stack-config-studio"
[api]
schemas = ["public", "storage"]
extra_search_path = ["public", "extensions"]
max_rows = 250
`);
      const config = yield* load(root);
      const studio = byService(yield* config.creations("stack-studio")).get("studio");
      expect(studio?.service === "studio" ? studio.config : undefined).toMatchObject({
        snippetsRoot: `${root}/supabase/snippets`,
        apiSchemas: "public,storage",
        apiExtraSearchPath: "public,extensions",
        apiMaxRows: 250,
        cliVersion: CLI_VERSION,
      });
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect("leaves stack-opt-in init listeners automatic except disabled pooler", () =>
    Effect.gen(function* () {
      const root = yield* project(renderCliConfigTemplate("stack-config-init", false, true));
      const config = yield* load(root);
      const services = byService(yield* config.creations("stack-config-init"));
      expect(services.get("database")?.endpoints).toEqual({ sql: { port: "auto" } });
      expect(services.get("rest")?.endpoints).toEqual({ http: { port: "auto" } });
      expect(services.get("pooler")).toBeUndefined();
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect("keeps the shared API port when REST is disabled", () =>
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
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect("resolves Auth template and enabled notification files for the stack", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* project(`project_id = "stack-config-auth-template"
[auth.email.template.invite]
subject = "Join us"
content_path = "./supabase/templates/invite.html"
[auth.email.notification.password_changed]
enabled = true
subject = "Changed"
content_path = "./templates/password_changed.txt"
[auth.email.notification.email_changed]
enabled = false
content_path = "./supabase/templates/disabled.html"
`);
      const templates = path.join(root, "supabase", "templates");
      yield* fs.makeDirectory(templates);
      yield* fs.writeFileString(path.join(templates, "invite.html"), "invite");
      yield* fs.writeFileString(path.join(templates, "password_changed.txt"), "changed");

      const config = yield* load(root);
      const auth = byService(yield* config.creations("stack-auth-template")).get("auth");
      if (auth?.service !== "auth") return yield* Effect.die("Auth creation missing");

      expect(auth.config.templates).toEqual([
        { id: "invite", path: path.join(templates, "invite.html"), root },
        {
          id: "password_changed_notification",
          path: path.join(templates, "password_changed.txt"),
          root,
        },
      ]);
      expect(auth.config.settings?.email?.template.invite?.subject).toBe("Join us");
      expect(auth.config.settings?.email?.notification.password_changed?.subject).toBe("Changed");
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect(
    "keeps an in-root symlinked Auth template, refuses an escaping one, and leaves a missing one to the start check",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const missing = yield* project(`project_id = "stack-config-auth-template-missing"
[auth.email.template.invite]
content_path = "./supabase/templates/missing.html"
`);
        const unread = byService(yield* (yield* load(missing)).creations("stack-auth-missing"));
        expect(unread.get("auth")).toMatchObject({
          config: { templates: [{ id: "invite" }] },
        });

        const linked = yield* project(`project_id = "stack-config-auth-template-link"
[auth.email.template.invite]
content_path = "./supabase/templates/invite.html"
`);
        yield* fs.makeDirectory(path.join(linked, "supabase", "templates"));
        yield* fs.writeFileString(path.join(linked, "shared.html"), "shared");
        yield* fs.writeFileString(path.join(linked, "retargeted.html"), "retargeted");
        const link = path.join(linked, "supabase", "templates", "invite.html");
        yield* fs.symlink("../../shared.html", link);
        const kept = byService(yield* (yield* load(linked)).creations("stack-auth-link"));
        expect(kept.get("auth")).toMatchObject({
          config: { templates: [{ id: "invite", path: link, root: linked }] },
        });
        /* The stack reads the configured path per fetch, so a retargeted link serves its new file. */
        yield* fs.remove(link);
        yield* fs.symlink("../../retargeted.html", link);
        const auth = kept.get("auth");
        const served = auth?.service === "auth" ? auth.config.templates?.[0]?.path : undefined;
        expect(yield* fs.readFileString(served ?? "")).toBe("retargeted");

        const escaping = yield* project(`project_id = "stack-config-auth-template-escape"
[auth.email.notification.password_changed]
enabled = true
content_path = "./supabase/link.html"
`);
        const outside = path.join(yield* fs.makeTempDirectoryScoped(), "outside.html");
        yield* fs.writeFileString(outside, "outside");
        yield* fs.symlink(outside, path.join(escaping, "supabase", "link.html"));
        const config = yield* load(escaping);
        const failure = yield* Effect.flip(config.creations("stack-auth-template-escape"));
        expect(failure.message).toContain("resolves outside the project root");
      }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect("ignores Auth template files while Auth is disabled", () =>
    Effect.gen(function* () {
      const root = yield* project(`project_id = "stack-config-auth-template-disabled"
[auth]
enabled = false
[auth.email.template.invite]
content_path = "./supabase/templates/missing.html"
`);
      const config = yield* load(root);
      expect(byService(yield* config.creations("stack-auth-disabled")).has("auth")).toBe(false);
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect("serves api.tls with legacy's embedded pair or the configured one, like legacy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const plain = yield* project(`project_id = "stack-config-tls-off"\n`);
      expect(yield* (yield* load(plain)).apiTls).toBeUndefined();

      const embedded = yield* project(`project_id = "stack-config-tls-embedded"
[api.tls]
enabled = true
`);
      expect(yield* (yield* load(embedded)).apiTls).toEqual({
        cert: KONG_LOCAL_TLS_CERT,
        key: KONG_LOCAL_TLS_KEY,
      });

      /* Without PostgREST the API port still serves https, on the embedded pair. */
      const apiOff = yield* project(`project_id = "stack-config-tls-api-off"
[api]
enabled = false
[api.tls]
enabled = true
cert_path = "certs/missing.crt"
`);
      expect(yield* (yield* load(apiOff)).apiTls).toEqual({
        cert: KONG_LOCAL_TLS_CERT,
        key: KONG_LOCAL_TLS_KEY,
      });

      const custom = yield* project(`project_id = "stack-config-tls-custom"
[api.tls]
enabled = true
cert_path = "certs/local.crt"
key_path = "certs/local.key"
`);
      const certs = path.join(custom, "supabase", "certs");
      yield* fs.makeDirectory(certs);
      yield* fs.writeFileString(path.join(certs, "local.crt"), KONG_LOCAL_TLS_CERT);
      yield* fs.writeFileString(path.join(certs, "local.key"), KONG_LOCAL_TLS_KEY);
      expect(yield* (yield* load(custom)).apiTls).toEqual({
        cert: KONG_LOCAL_TLS_CERT,
        key: KONG_LOCAL_TLS_KEY,
      });
      const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
      for (const key of [other.export({ type: "pkcs8", format: "pem" }).toString(), "not a pem"]) {
        yield* fs.writeFileString(path.join(certs, "local.key"), key);
        expect((yield* Effect.flip((yield* load(custom)).apiTls)).message).toMatch(
          /^Invalid config for api\.tls: failed to load TLS key pair from \S+certs\/local\.crt and \S+certs\/local\.key: /u,
        );
      }
      /* An empty file still builds a secure context, which then serves no certificate. */
      for (const [cert, key] of [
        ["", KONG_LOCAL_TLS_KEY],
        [KONG_LOCAL_TLS_CERT, ""],
      ]) {
        yield* fs.writeFileString(path.join(certs, "local.crt"), cert ?? "");
        yield* fs.writeFileString(path.join(certs, "local.key"), key ?? "");
        expect((yield* Effect.flip((yield* load(custom)).apiTls)).message).toMatch(
          /^Invalid config for api\.tls: failed to load TLS key pair from \S+certs\/local\.crt and \S+certs\/local\.key: /u,
        );
      }

      const halfPair = yield* project(`project_id = "stack-config-tls-half"
[api.tls]
enabled = true
cert_path = "certs/local.crt"
`);
      expect((yield* Effect.flip((yield* load(halfPair)).apiTls)).message).toContain(
        "api.tls.key_path",
      );

      const unreadable = yield* project(`project_id = "stack-config-tls-missing"
[api.tls]
enabled = true
cert_path = "certs/missing.crt"
key_path = "certs/missing.key"
`);
      /* Only the start applying TLS reads the files; every other command loads and composes. */
      const missingFiles = yield* load(unreadable);
      expect(yield* missingFiles.creations("stack-config-tls-missing")).not.toHaveLength(0);
      expect((yield* Effect.flip(missingFiles.apiTls)).message).toContain(
        "failed to read TLS cert",
      );
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect("validates enabled Auth third-party providers", () =>
    Effect.gen(function* () {
      const root = yield* project(`project_id = "stack-config-auth-third-party"
[auth.third_party.firebase]
enabled = true
project_id = ""
`);
      const exit = yield* load(root).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("auth.third_party");
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect("loads an empty signing-key file and skips it when Auth is disabled", () =>
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
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
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
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect("rejects an analytics backend the stack cannot represent", () =>
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
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect("rejects unsupported database versions before creating recipes", () =>
    Effect.gen(function* () {
      const root = yield* project(`project_id = "stack-config-db-version"
[db]
major_version = 14
`);
      const exit = yield* load(root).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(String(exit.cause)).toContain("db.major_version must be 15 or 17");
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect("ignores unresolved experimental S3 env placeholders", () => {
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
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer]));
  });

  it.effect(
    "fails closed on an unpublished OrioleDB version and rejects S3 settings only for OrioleDB",
    () =>
      Effect.gen(function* () {
        const unpublished =
          "db.orioledb_version (or SUPABASE_DB_ORIOLEDB_VERSION) = 17.0.0.000 is not an OrioleDB build this CLI ships for the experimental stack; it ships:";
        const orioledbCanonical = yield* project(`project_id = "stack-config-orioledb-db"
[db]
orioledb_version = "17.0.0.000"
`);
        const orioledbCanonicalExit = yield* load(orioledbCanonical).pipe(Effect.exit);
        expect(Exit.isFailure(orioledbCanonicalExit)).toBe(true);
        if (Exit.isFailure(orioledbCanonicalExit))
          expect(String(orioledbCanonicalExit.cause)).toContain(unpublished);

        const s3 = yield* project(`project_id = "stack-config-experimental-s3"
[experimental]
s3_host = "s3.example.test"
`);
        const s3Config = yield* load(s3);
        expect(s3Config.source.experimental.s3_host).toBe("s3.example.test");

        const [pinned = ""] = orioledbVersions();
        const orioledbS3 = yield* project(`project_id = "stack-config-orioledb-s3"
[db]
orioledb_version = "${pinned}"
[experimental]
s3_host = "s3.example.test"
`);
        const orioledbS3Exit = yield* load(orioledbS3).pipe(Effect.exit);
        expect(Exit.isFailure(orioledbS3Exit)).toBe(true);
        if (Exit.isFailure(orioledbS3Exit))
          expect(String(orioledbS3Exit.cause)).toContain(
            "experimental.s3_host is unsupported by the experimental stack",
          );
      }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect("rejects the removed experimental.orioledb_version key and its env var", () =>
    Effect.gen(function* () {
      const removedKey = yield* project(`project_id = "stack-config-orioledb-removed"
[experimental]
orioledb_version = "17.0.0.000"
`);
      const keyExit = yield* load(removedKey).pipe(Effect.exit);
      expect(Exit.isFailure(keyExit)).toBe(true);
      if (Exit.isFailure(keyExit))
        expect(String(keyExit.cause)).toContain(
          "experimental.orioledb_version in supabase/config.toml is no longer supported. Use db.orioledb_version instead.",
        );

      const envRoot = yield* project('project_id = "stack-config-orioledb-env"\n');
      const envExit = yield* withEnvVar(
        "SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION",
        "17.0.0.000",
        load(envRoot).pipe(Effect.exit),
      );
      expect(Exit.isFailure(envExit)).toBe(true);
      if (Exit.isFailure(envExit))
        expect(String(envExit.cause)).toContain(
          "SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION (set in the shell environment) is no longer supported. Use SUPABASE_DB_ORIOLEDB_VERSION instead.",
        );
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );

  it.effect("records OrioleDB selection on the command event before rejecting it", () =>
    Effect.gen(function* () {
      const loadRecordingOrioleDb = (projectRoot: string) =>
        Effect.gen(function* () {
          const recorded = yield* Ref.make<CommandTelemetryAttributeValues>({});
          const exit = yield* load(projectRoot).pipe(
            Effect.provideService(CommandTelemetryAttributes, {
              record: (values) => Ref.update(recorded, (current) => ({ ...current, ...values })),
            }),
            Effect.exit,
          );
          return { exit, orioledb: (yield* Ref.get(recorded)).orioledb };
        });

      const orioledb = yield* project(`project_id = "stack-config-orioledb-telemetry"
[db]
orioledb_version = "15.1.1.14"
`);
      const rejected = yield* loadRecordingOrioleDb(orioledb);
      expect(Exit.isFailure(rejected.exit)).toBe(true);
      expect(rejected.orioledb).toBe(true);

      const standard = yield* project(`project_id = "stack-config-standard-telemetry"\n`);
      const accepted = yield* loadRecordingOrioleDb(standard);
      expect(Exit.isSuccess(accepted.exit)).toBe(true);
      expect(accepted.orioledb).toBe(false);
    }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer])),
  );
});
