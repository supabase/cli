import { describe, expect, test, vi } from "vitest";
import { BunServices } from "@effect/platform-bun";
import * as SmolToml from "smol-toml";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Layer,
  Option,
  Path,
  PlatformError,
  Redacted,
  Schema,
  type Scope,
} from "effect";
import { CliConfigSchema, toCliConfigJsonSchema, type CliConfig } from "./base.ts";
import { loadCliConfig as loadCliConfigFromBun } from "./bun.ts";
import {
  encodeCliConfigToJson,
  encodeCliConfigToToml,
  cliConfigValueSourceAt,
  isObject,
  type InternalLoadCliConfigOptions,
  type LoadedCliConfig,
} from "./config-document.ts";
import {
  configJsonPath,
  configTomlPath,
  decodeCliConfigDocumentForValidationEffect,
  loadCliConfig,
  loadCliConfigFile,
  remoteNameForProjectRef,
  remoteProjectIdEntries,
  saveCliConfig,
  writeCliConfigDocumentText,
} from "./io.ts";
import { loadCliConfig as loadCliConfigFromNode } from "./node.ts";
import { cliConfigStoreLayer } from "./cli-config.layer.ts";
import { CliConfigStore } from "./cli-config.service.ts";
import { CLI_CONFIG_SCHEMA_URL } from "./schema-metadata.ts";

function makeTempProject() {
  return FileSystem.FileSystem.use((fs) =>
    fs.makeTempDirectoryScoped({ prefix: "supabase-config-" }),
  );
}

const legacyFixturePath = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join(
    path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))),
    "../testdata/legacy-config.toml",
  );
});

const decodeCliConfig = Schema.decodeUnknownSync(CliConfigSchema);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

function runConfigEffect<A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(BunServices.layer)));
}

function stubEnv(name: string, value: string) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      vi.stubEnv(name, value);
    }),
    () =>
      Effect.sync(() => {
        vi.unstubAllEnvs();
      }),
  );
}

const sampleConfig = decodeCliConfig({
  project_id: "ref_123",
  db: {
    pooler: {
      enabled: true,
    },
  },
});

describe("config io", () => {
  test("saves JSON by default when no config exists", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const cwd = yield* makeTempProject();

        const saved = yield* saveCliConfig({ cwd, config: sampleConfig });
        expect(saved.format).toBe("json");
        expect(saved.path).toBe(yield* configJsonPath(cwd));
      }),
    ));

  test("loads strict JSON", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const path = yield* configJsonPath(cwd);

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          path,
          yield* encodeJson({
            project_id: "abc123",
            db: {
              major_version: 16,
            },
            experimental: { stack: true },
          }),
        );

        const loaded = yield* loadCliConfigFile(path);
        expect(loaded.format).toBe("json");
        expect(loaded.config.project_id).toBe("abc123");
        expect(loaded.config.db.major_version).toBe(16);
        expect(loaded.config.experimental.stack).toBe(true);
        expect(loaded.config.api.enabled).toBe(true);
      }),
    ));

  test("populates rawDocument for a .json config", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const path = yield* configJsonPath(cwd);

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          path,
          yield* encodeJson({
            project_id: "abc123",
            db: {
              major_version: 16,
            },
          }),
        );

        const loaded = yield* loadCliConfigFile(path);
        expect(loaded.rawDocument).toEqual({ project_id: "abc123", db: { major_version: 16 } });
      }),
    ));

  test("populates rawText with the exact on-disk bytes for a .json config", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const path = yield* configJsonPath(cwd);

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        const text = yield* encodeJson({ project_id: "abc123", db: { major_version: 16 } });
        yield* fs.writeFileString(path, text);

        const loaded = yield* loadCliConfigFile(path);
        expect(loaded.rawText).toBe(text);
      }),
    ));

  test("populates rawText with the exact on-disk bytes for a .toml config", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const path = yield* configTomlPath(cwd);

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        const text = 'project_id = "abc123"\n\n[db]\nmajor_version = 16\n';
        yield* fs.writeFileString(path, text);

        const loaded = yield* loadCliConfigFile(path);
        expect(loaded.rawText).toBe(text);
      }),
    ));

  test("loads top-level $schema metadata from JSON", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const path = yield* configJsonPath(cwd);

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          path,
          yield* encodeJson({
            $schema: CLI_CONFIG_SCHEMA_URL,
          }),
        );

        const loaded = yield* loadCliConfigFile(path);
        expect(loaded.schemaRef).toBe(CLI_CONFIG_SCHEMA_URL);
        expect(loaded.config.db.major_version).toBe(17);
      }),
    ));

  test("rejects JSON comments and trailing commas", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const path = yield* configJsonPath(cwd);

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          path,
          `{
  // project ref
  "project_id": "abc123",
  "db": {
    "major_version": 16,
  }
}
`,
        );

        const exit = yield* Effect.exit(loadCliConfigFile(path));

        expect(Exit.isFailure(exit)).toBe(true);
      }),
    ));

  test("decodes legacy runtime defaults from an empty config", () => {
    const config = decodeCliConfig({});

    expect(config.api.enabled).toBe(true);
    expect(config.api.schemas).toEqual(["public", "graphql_public"]);
    expect(config.auth.site_url).toBe("http://127.0.0.1:3000");
    expect(config.auth.additional_redirect_urls).toEqual(["https://127.0.0.1:3000"]);
    expect(config.auth.sms.enable_signup).toBe(false);
    expect(config.auth.mfa.totp.enroll_enabled).toBe(false);
    expect(config.db.major_version).toBe(17);
    expect(config.edge_runtime.policy).toBe("per_worker");
    expect(config.analytics.enabled).toBe(true);
    expect(config.studio.openai_api_key).toBeUndefined();
    expect(config.auth.sms.twilio.auth_token).toBeUndefined();
    expect(config.auth.external.github.secret).toBeUndefined();
    expect(config.experimental.s3_host).toBeUndefined();
    expect(config.experimental.s3_region).toBeUndefined();
    expect(config.experimental.s3_access_key).toBeUndefined();
    expect(config.experimental.s3_secret_key).toBeUndefined();
    expect(config.functions).toEqual({});
    expect(config.remotes).toEqual({});
  });

  test("requires enabled twilio fields during decode", () => {
    expect(() =>
      decodeCliConfig({
        auth: {
          sms: {
            twilio: {
              enabled: true,
            },
          },
        },
      }),
    ).toThrow();
  });

  test("rejects a non-finite number during decode", () => {
    expect(() => decodeCliConfig({ db: { port: Infinity } })).toThrow("Expected a finite number");
    expect(() => decodeCliConfig({ api: { max_rows: NaN } })).toThrow("Expected a finite number");
  });

  test("only validates the highest-priority enabled sms provider during decode", () => {
    // Providers are validated in a fixed priority order (twilio, twilio_verify, messagebird,
    // textlocal, vonage); only the first enabled one is checked, so a complete, higher-priority
    // `twilio` block plus an incomplete, lower-priority `messagebird` block must decode fine.
    const config = decodeCliConfig({
      auth: {
        sms: {
          twilio: {
            enabled: true,
            account_sid: "AC123",
            message_service_sid: "MG123",
            auth_token: "secret",
          },
          messagebird: {
            enabled: true,
          },
        },
      },
    });
    expect(config.auth.sms.twilio.enabled).toBe(true);
    expect(config.auth.sms.messagebird.enabled).toBe(true);
  });

  test("rejects an incomplete sms provider when no higher-priority provider is enabled", () => {
    expect(() =>
      decodeCliConfig({
        auth: {
          sms: {
            messagebird: {
              enabled: true,
            },
          },
        },
      }),
    ).toThrow(/auth\.sms\.messagebird\.originator/);
  });

  test("requires enabled smtp fields during decode", () => {
    expect(() =>
      decodeCliConfig({
        auth: {
          email: {
            smtp: {
              enabled: true,
            },
          },
        },
      }),
    ).toThrow();
  });

  test("decodes an unmodeled email template/notification name", () => {
    // `auth.email.template`/`notification` are open maps with no key restriction, and every
    // entry is validated regardless of name — an unrecognized key like
    // `[auth.email.template.custom]` is a legitimate config shape, not a decode error.
    const config = decodeCliConfig({
      auth: {
        email: {
          template: { custom: { subject: "Hi" } },
          notification: { custom_notice: { enabled: true, content_path: "custom.html" } },
        },
      },
    });
    expect(config.auth.email.template["custom"]?.subject).toBe("Hi");
    expect(config.auth.email.notification["custom_notice"]?.enabled).toBe(true);
  });

  test("requires enabled external provider credentials during decode", () => {
    expect(() =>
      decodeCliConfig({
        auth: {
          external: {
            github: {
              enabled: true,
            },
          },
        },
      }),
    ).toThrow();
  });

  test("encodes sparse JSON output", () => {
    const content = encodeCliConfigToJson(sampleConfig);

    expect(content).toContain('"project_id": "ref_123"');
    expect(content).toContain('"pooler"');
    expect(content).toContain('"enabled": true');
    expect(content).not.toContain('"major_version"');
    expect(content).not.toContain('"versions"');
  });

  test("encodes minimal empty configs", () => {
    const config = decodeCliConfig({});

    expect(encodeCliConfigToJson(config)).toBe("{}\n");
    expect(encodeCliConfigToToml(config).trim()).toBe("");
  });

  test("preserves hosted $schema when saving JSON", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* makeTempProject();

        const saved = yield* saveCliConfig({
          cwd,
          config: decodeCliConfig({}),
          schemaRef: CLI_CONFIG_SCHEMA_URL,
        });

        expect(saved.schemaRef).toBe(CLI_CONFIG_SCHEMA_URL);

        const content = yield* fs.readFileString(saved.path);
        expect(content).toContain(`"$schema": "${CLI_CONFIG_SCHEMA_URL}"`);

        const loaded = yield* loadCliConfig(cwd);
        expect(loaded?.schemaRef).toBe(CLI_CONFIG_SCHEMA_URL);
      }),
    ));

  test("preserves local $schema when saving JSON over an existing config", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* makeTempProject();
        const schemaRef = "./node_modules/@supabase/config/schema.json";

        yield* saveCliConfig({
          cwd,
          config: decodeCliConfig({}),
          schemaRef,
        });

        const saved = yield* saveCliConfig({
          cwd,
          config: sampleConfig,
        });

        expect(saved.schemaRef).toBe(schemaRef);

        const content = yield* fs.readFileString(saved.path);
        expect(content).toContain(`"$schema": "${schemaRef}"`);
      }),
    ));

  test("preserves $schema when saving TOML", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* makeTempProject();
        const schemaRef = "./node_modules/@supabase/config/schema.json";

        const saved = yield* saveCliConfig({
          cwd,
          config: decodeCliConfig({}),
          format: "toml",
          schemaRef,
        });

        expect(saved.schemaRef).toBe(schemaRef);

        const content = yield* fs.readFileString(saved.path);
        expect(content).toContain(`"$schema" = "${schemaRef}"`);

        const loaded = yield* loadCliConfig(cwd);
        expect(loaded?.schemaRef).toBe(schemaRef);
      }),
    ));

  test("prefers JSON over TOML when both exist", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const jsonPath = yield* configJsonPath(cwd);
        const tomlPath = yield* configTomlPath(cwd);

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(jsonPath, encodeCliConfigToJson(sampleConfig));
        yield* fs.writeFileString(
          tomlPath,
          `project_id = "toml-ref"

[db]
major_version = 16

[experimental]
stack = true
`,
        );

        const loaded = yield* loadCliConfig(cwd);
        expect(loaded?.format).toBe("json");
        expect(loaded?.config.project_id).toBe("ref_123");
        expect(loaded?.ignoredPaths).toEqual([tomlPath]);
      }),
    ));

  test("loads TOML instead of JSON when tomlOnly is set, even if JSON exists", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const jsonPath = yield* configJsonPath(cwd);
        const tomlPath = yield* configTomlPath(cwd);

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(jsonPath, encodeCliConfigToJson(sampleConfig));
        yield* fs.writeFileString(
          tomlPath,
          `project_id = "toml-ref"

[db]
major_version = 16

[experimental]
stack = true
`,
        );

        const loaded = yield* loadCliConfig(cwd, { tomlOnly: true });
        expect(loaded?.format).toBe("toml");
        expect(loaded?.config.project_id).toBe("toml-ref");
      }),
    ));

  test("returns null when tomlOnly is set and only JSON exists", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const jsonPath = yield* configJsonPath(cwd);

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(jsonPath, encodeCliConfigToJson(sampleConfig));

        const loaded = yield* loadCliConfig(cwd, { tomlOnly: true });
        expect(loaded).toBeNull();
      }),
    ));

  test("loads TOML when JSON is absent", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const tomlPath = yield* configTomlPath(cwd);

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          tomlPath,
          `project_id = "toml-ref"

[db]
major_version = 16

[experimental]
stack = true
`,
        );

        const loaded = yield* loadCliConfig(cwd);
        expect(loaded?.format).toBe("toml");
        expect(loaded?.config.project_id).toBe("toml-ref");
        expect(loaded?.config.db.major_version).toBe(16);
        expect(loaded?.config.experimental.stack).toBe(true);
      }),
    ));

  test("loads the CLI fixture", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const loaded = yield* loadCliConfigFile(yield* legacyFixturePath);
        const production = loaded.config.remotes.production;
        const staging = loaded.config.remotes.staging;

        expect(loaded.format).toBe("toml");
        expect(loaded.config.project_id).toBe("test");
        expect(loaded.config.auth.hook.send_sms.secrets).toBe("env(AUTH_SEND_SMS_SECRETS)");
        expect(loaded.config.edge_runtime.secrets?.test_key).toBe("test_value");
        expect(loaded.config.storage.analytics.buckets).toEqual({ "my-warehouse": {} });
        expect(production).toBeDefined();
        expect(staging).toBeDefined();
        if (!production || !staging) {
          throw new Error("Expected legacy remotes to be loaded.");
        }
        expect(production.project_id).toBe("vpefcjyosynxeiebfscx");
        expect(production.auth.site_url).toBe("http://feature-auth-branch.com/");
        expect(staging.storage?.buckets?.images?.allowed_mime_types).toEqual(["image/png"]);
      }),
    ));

  test("returns null when no config file exists", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const cwd = yield* makeTempProject();

        const loaded = yield* loadCliConfig(cwd);
        expect(loaded).toBeNull();
      }),
    ));

  test("does not ignore an invalid JSON config when TOML also exists", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const jsonPath = yield* configJsonPath(cwd);
        const tomlPath = yield* configTomlPath(cwd);

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(jsonPath, `{"project_id": 123}`);
        yield* fs.writeFileString(
          tomlPath,
          `project_id = "toml-ref"

[db]
major_version = 16
`,
        );

        expect(Exit.isFailure(yield* Effect.exit(loadCliConfig(cwd)))).toBe(true);
      }),
    ));

  test("returns a typed parse error for invalid JSON", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const jsonPath = yield* configJsonPath(cwd);

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(jsonPath, `{"project_id": 123}`);

        const exit = yield* Effect.exit(loadCliConfigFile(jsonPath));

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(error)).toBe(true);
          if (Option.isSome(error)) {
            expect(error.value._tag).toBe("CliConfigParseError");
            if (error.value._tag === "CliConfigParseError") {
              expect(error.value.path).toBe(jsonPath);
              expect(error.value.format).toBe("json");
            }
          }
        }
      }),
    ));

  test("redacts edge_runtime.secrets on the CliConfigParseError document", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const tomlPath = yield* configTomlPath(cwd);

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        // `analytics.port` fails schema decode, which fails the whole `Schema.decodeUnknownSync`
        // call while `edge_runtime.secrets` parses fine on its own. `MY_SUPER_SECRET_VALUE` stands
        // in for a real secret so the assertion below can confirm it never appears in plaintext.
        yield* fs.writeFileString(
          tomlPath,
          `[analytics]
port = "not-a-number"

[edge_runtime.secrets]
FOO = "MY_SUPER_SECRET_VALUE"
`,
        );

        const exit = yield* Effect.exit(loadCliConfigFile(tomlPath));

        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) {
          return;
        }
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).toBe(true);
        if (!Option.isSome(error) || error.value._tag !== "CliConfigParseError") {
          return;
        }

        const edgeRuntime = error.value.document?.edge_runtime;
        const secrets =
          edgeRuntime !== null && typeof edgeRuntime === "object" && edgeRuntime !== undefined
            ? (edgeRuntime as Record<string, unknown>).secrets
            : undefined;
        expect(secrets).toBeDefined();
        const foo = (secrets as Record<string, unknown>).FOO;
        expect(Redacted.isRedacted(foo)).toBe(true);
        expect(Redacted.value(foo as Redacted.Redacted<string>)).toBe("MY_SUPER_SECRET_VALUE");
        // The whole point: a caller that doesn't know to unwrap `Redacted` never sees the raw
        // secret, even via JSON.stringify.
        expect(yield* encodeJson(error.value.document)).not.toContain("MY_SUPER_SECRET_VALUE");
      }),
    ));

  test("redacts a non-string edge_runtime.secrets value on the CliConfigParseError document", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const tomlPath = yield* configTomlPath(cwd);

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        // `FOO` is a TOML array, not a string, so its own schema decode fails, but the raw
        // pre-decode value still carries `MY_SUPER_SECRET_VALUE` in plaintext —
        // `redactEdgeRuntimeSecrets` must wrap it regardless of shape.
        yield* fs.writeFileString(
          tomlPath,
          `[analytics]
port = "not-a-number"

[edge_runtime.secrets]
FOO = ["MY_SUPER_SECRET_VALUE"]
`,
        );

        const exit = yield* Effect.exit(loadCliConfigFile(tomlPath));

        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) {
          return;
        }
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).toBe(true);
        if (!Option.isSome(error) || error.value._tag !== "CliConfigParseError") {
          return;
        }

        const edgeRuntime = error.value.document?.edge_runtime;
        const secrets =
          edgeRuntime !== null && typeof edgeRuntime === "object" && edgeRuntime !== undefined
            ? (edgeRuntime as Record<string, unknown>).secrets
            : undefined;
        expect(secrets).toBeDefined();
        const foo = (secrets as Record<string, unknown>).FOO;
        expect(Redacted.isRedacted(foo)).toBe(true);
        expect(Redacted.value(foo as Redacted.Redacted<unknown>)).toEqual([
          "MY_SUPER_SECRET_VALUE",
        ]);
        expect(yield* encodeJson(error.value.document)).not.toContain("MY_SUPER_SECRET_VALUE");
      }),
    ));

  test("redacts a non-object edge_runtime.secrets field on the CliConfigParseError document", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const tomlPath = yield* configTomlPath(cwd);

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        // `secrets` itself is a TOML array here, not a table, so the whole field is malformed
        // rather than a single bad entry — `redactEdgeRuntimeSecrets` must wrap the field as one
        // unit instead of leaving it raw.
        yield* fs.writeFileString(
          tomlPath,
          `[analytics]
port = "not-a-number"

[edge_runtime]
secrets = ["MY_SUPER_SECRET_VALUE"]
`,
        );

        const exit = yield* Effect.exit(loadCliConfigFile(tomlPath));

        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) {
          return;
        }
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).toBe(true);
        if (!Option.isSome(error) || error.value._tag !== "CliConfigParseError") {
          return;
        }

        const edgeRuntime = error.value.document?.edge_runtime;
        const secrets =
          edgeRuntime !== null && typeof edgeRuntime === "object" && edgeRuntime !== undefined
            ? (edgeRuntime as Record<string, unknown>).secrets
            : undefined;
        expect(Redacted.isRedacted(secrets)).toBe(true);
        expect(Redacted.value(secrets as Redacted.Redacted<unknown>)).toEqual([
          "MY_SUPER_SECRET_VALUE",
        ]);
        expect(yield* encodeJson(error.value.document)).not.toContain("MY_SUPER_SECRET_VALUE");
      }),
    ));

  test("preserves TOML as the active format on save", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const tomlPath = yield* configTomlPath(cwd);
        const jsonPath = yield* configJsonPath(cwd);

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          tomlPath,
          `project_id = "old-ref"

[db]
major_version = 16
`,
        );

        const saved = yield* saveCliConfig({ cwd, config: sampleConfig });

        expect(saved.format).toBe("toml");
        expect(saved.path).toBe(tomlPath);
        expect(yield* fs.exists(jsonPath)).toBe(false);
        const content = yield* fs.readFileString(tomlPath);
        expect(content).toContain('project_id = "ref_123"');
        expect(content).toContain("[db.pooler]");
        expect(content).not.toContain("major_version");
      }),
    ));

  test("preserves JSON as the active format on save", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const jsonPath = yield* configJsonPath(cwd);

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(jsonPath, encodeCliConfigToJson(sampleConfig));

        const saved = yield* saveCliConfig({
          cwd,
          config: decodeCliConfig({
            project_id: "updated-ref",
            auth: {
              enable_signup: false,
            },
          }),
        });

        expect(saved.format).toBe("json");
        expect(saved.path).toBe(jsonPath);
        const content = yield* fs.readFileString(jsonPath);
        expect(content).toContain('"project_id": "updated-ref"');
        expect(content).toContain('"enable_signup": false');
        expect(content).not.toContain('"jwt_expiry"');
      }),
    ));

  test("supports explicit format override", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const tomlPath = yield* configTomlPath(cwd);
        const jsonPath = yield* configJsonPath(cwd);

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(jsonPath, encodeCliConfigToJson(sampleConfig));

        const saved = yield* saveCliConfig({ cwd, config: sampleConfig, format: "toml" });

        expect(saved.format).toBe("toml");
        expect(saved.path).toBe(tomlPath);
        expect(yield* fs.exists(jsonPath)).toBe(false);
        const content = yield* fs.readFileString(tomlPath);
        expect(content).toContain("[db.pooler]");
        expect(content).not.toContain("[versions]");
      }),
    ));

  test("removes TOML when explicitly switching to JSON", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const jsonPath = yield* configJsonPath(cwd);
        const tomlPath = yield* configTomlPath(cwd);

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(tomlPath, encodeCliConfigToToml(sampleConfig));

        const saved = yield* saveCliConfig({ cwd, config: sampleConfig, format: "json" });

        expect(saved.format).toBe("json");
        expect(saved.path).toBe(jsonPath);
        expect(yield* fs.exists(tomlPath)).toBe(false);
      }),
    ));

  test("preserves the discovered project format when saving from a nested cwd", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const nestedCwd = join(cwd, "apps", "web", "src");
        const tomlPath = yield* configTomlPath(cwd);
        const jsonPath = yield* configJsonPath(cwd);

        yield* fs.makeDirectory(nestedCwd, { recursive: true });
        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          tomlPath,
          `project_id = "nested-ref"

[db]
major_version = 16
`,
        );

        const saved = yield* saveCliConfig({
          cwd: nestedCwd,
          config: decodeCliConfig({
            project_id: "nested-updated",
          }),
        });

        expect(saved.format).toBe("toml");
        expect(saved.path).toBe(tomlPath);
        expect(yield* fs.exists(jsonPath)).toBe(false);
        const content = yield* fs.readFileString(tomlPath);
        expect(content).toContain('project_id = "nested-updated"');
      }),
    ));

  test("exposes a CliConfigStore service for the CLI", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const cwd = yield* makeTempProject();
        const layer = cliConfigStoreLayer.pipe(Layer.provide(BunServices.layer));

        const loaded = yield* Effect.gen(function* () {
          const store = yield* CliConfigStore;
          yield* store.save({ cwd, config: sampleConfig });
          return yield* store.load(cwd);
        }).pipe(Effect.provide(layer));

        expect(loaded?.config.project_id).toBe("ref_123");
        expect(loaded?.config.db.pooler.enabled).toBe(true);
      }),
    ));

  test("encodes sparse TOML for fresh output", () => {
    const content = encodeCliConfigToToml(sampleConfig);
    expect(content).toContain('project_id = "ref_123"');
    expect(content).toContain("[db.pooler]");
    expect(content).not.toContain("major_version");
    expect(content).not.toContain("[versions]");
  });

  test("supports the Bun edge entrypoint", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const cwd = yield* makeTempProject();

        yield* saveCliConfig({ cwd, config: sampleConfig });
        const loaded = yield* Effect.promise(() => loadCliConfigFromBun(cwd));
        expect(loaded?.config.project_id).toBe("ref_123");
        expect(loaded?.config.db.pooler.enabled).toBe(true);
      }),
    ));

  test("supports the Node edge entrypoint", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const cwd = yield* makeTempProject();

        yield* saveCliConfig({ cwd, config: sampleConfig });
        const loaded = yield* Effect.promise(() => loadCliConfigFromNode(cwd));
        expect(loaded?.config.project_id).toBe("ref_123");
        expect(loaded?.config.db.pooler.enabled).toBe(true);
      }),
    ));

  test("round-trip: save → load → save produces identical config and file content", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* makeTempProject();

        const original = decodeCliConfig({
          project_id: "roundtrip-ref",
          db: {
            major_version: 16,
            pooler: { enabled: true },
          },
          auth: {
            enable_signup: false,
            site_url: "https://example.com",
          },
          analytics: { enabled: false },
        });

        const saved1 = yield* saveCliConfig({ cwd, config: original });
        const content1 = yield* fs.readFileString(saved1.path);

        const loaded = yield* loadCliConfig(cwd);
        expect(loaded).not.toBeNull();
        expect(loaded!.config).toEqual(original);

        const saved2 = yield* saveCliConfig({ cwd, config: loaded!.config });
        const content2 = yield* fs.readFileString(saved2.path);

        expect(content2).toBe(content1);
      }),
    ));

  test("includes current keys in generated JSON schema", () => {
    const schema = toCliConfigJsonSchema();
    const schemaString = JSON.stringify(schema);

    expect(schemaString).toContain("local_smtp");
    expect(schemaString).toContain("remotes");
    expect(schemaString).toContain("static_files");
    expect(schemaString).toContain("env");
    // The deprecated implementation name must not leak anywhere in the schema,
    // including descriptions (case-insensitive guard).
    expect(schemaString.toLowerCase()).not.toContain("inbucket");
    expect(schemaString).not.toContain("versions");
  });

  test("resolves env() on numeric port fields (CLI-1489)", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(cwd, "supabase", "config.toml"),
          `project_id = "ref_123"

[api]
port = "env(SUPABASE_API_PORT)"

[db]
port = "env(SUPABASE_DB_PORT)"

[analytics]
port = "env(SUPABASE_ANALYTICS_PORT)"
`,
        );
        yield* fs.writeFileString(
          join(cwd, "supabase", ".env"),
          "SUPABASE_API_PORT=54321\nSUPABASE_DB_PORT=54322\nSUPABASE_ANALYTICS_PORT=54327\n",
        );

        const loaded = yield* loadCliConfig(cwd);

        expect(loaded).not.toBeNull();
        expect(loaded!.config.api.port).toBe(54321);
        expect(loaded!.config.db.port).toBe(54322);
        expect(loaded!.config.analytics.port).toBe(54327);
      }),
    ));

  test("resolves env() on boolean fields", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(cwd, "supabase", "config.toml"),
          `project_id = "ref_123"

[analytics]
enabled = "env(SUPABASE_ANALYTICS_ENABLED)"
`,
        );
        yield* fs.writeFileString(
          join(cwd, "supabase", ".env"),
          "SUPABASE_ANALYTICS_ENABLED=false\n",
        );

        const loaded = yield* loadCliConfig(cwd);
        expect(loaded!.config.analytics.enabled).toBe(false);
      }),
    ));

  test.each([
    ["1", true],
    ["TRUE", true],
    ["T", true],
    ["True", true],
    ["0", false],
    ["f", false],
    ["FALSE", false],
  ] as const)(
    "resolves env() on boolean fields using the boolean acceptance set (%s -> %s)",
    (envValue, expected) =>
      runConfigEffect(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { join } = yield* Path.Path;
          const cwd = yield* makeTempProject();

          yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
          yield* fs.writeFileString(
            join(cwd, "supabase", "config.toml"),
            `project_id = "ref_123"

[analytics]
enabled = "env(SUPABASE_ANALYTICS_ENABLED)"
`,
          );
          yield* fs.writeFileString(
            join(cwd, "supabase", ".env"),
            `SUPABASE_ANALYTICS_ENABLED=${envValue}\n`,
          );

          const loaded = yield* loadCliConfig(cwd);
          expect(loaded!.config.analytics.enabled).toBe(expected);
        }),
      ),
  );

  test("splits a comma-separated string literal into a slice", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        // A plain string value for a `[]string` field like `additional_redirect_urls` decodes fine
        // when `cliCompat` is set, not just via `env(...)`.
        const cwd = yield* makeTempProject();

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(cwd, "supabase", "config.toml"),
          `project_id = "ref_123"

[auth]
additional_redirect_urls = "http://a,http://b"
`,
        );

        const loaded = yield* loadCliConfig(cwd, { cliCompat: true });
        expect(loaded!.config.auth.additional_redirect_urls).toEqual(["http://a", "http://b"]);
      }),
    ));

  test("splits an env()-substituted comma-separated string into a slice", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(cwd, "supabase", "config.toml"),
          `project_id = "ref_123"

[auth]
additional_redirect_urls = "env(SUPABASE_REDIRECT_URLS)"
`,
        );
        yield* fs.writeFileString(
          join(cwd, "supabase", ".env"),
          "SUPABASE_REDIRECT_URLS=http://a,http://b\n",
        );

        const loaded = yield* loadCliConfig(cwd, { cliCompat: true });
        expect(loaded!.config.auth.additional_redirect_urls).toEqual(["http://a", "http://b"]);
      }),
    ));

  test("an empty string literal for a slice field decodes to an empty array", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(cwd, "supabase", "config.toml"),
          `project_id = "ref_123"

[auth]
additional_redirect_urls = ""
`,
        );

        const loaded = yield* loadCliConfig(cwd, { cliCompat: true });
        expect(loaded!.config.auth.additional_redirect_urls).toEqual([]);
      }),
    ));

  test("an actual array value for a slice field is left untouched", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(cwd, "supabase", "config.toml"),
          `project_id = "ref_123"

[auth]
additional_redirect_urls = ["http://a", "http://b"]
`,
        );

        const loaded = yield* loadCliConfig(cwd);
        expect(loaded!.config.auth.additional_redirect_urls).toEqual(["http://a", "http://b"]);
      }),
    ));

  test("preserves env() literals on string fields when the var is unset", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(cwd, "supabase", "config.toml"),
          `project_id = "ref_123"

[auth]
jwt_secret = "env(MISSING_SECRET)"
`,
        );

        const loaded = yield* loadCliConfig(cwd);
        expect(loaded!.config.auth.jwt_secret).toBe("env(MISSING_SECRET)");
      }),
    ));

  test("preserves env() literals on string fields when the var is set but empty", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(cwd, "supabase", "config.toml"),
          `project_id = "ref_123"

[auth]
jwt_secret = "env(MISSING_SECRET)"
`,
        );
        yield* fs.writeFileString(join(cwd, "supabase", ".env"), "MISSING_SECRET=\n");

        const loaded = yield* loadCliConfig(cwd);
        expect(loaded!.config.auth.jwt_secret).toBe("env(MISSING_SECRET)");
      }),
    ));

  test("fails to decode a numeric field when env var is unset", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(cwd, "supabase", "config.toml"),
          `project_id = "ref_123"

[analytics]
port = "env(MISSING_PORT)"
`,
        );

        const exit = yield* Effect.exit(loadCliConfig(cwd));

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const failure = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(failure)).toBe(true);
          if (Option.isSome(failure)) {
            expect((failure.value as { _tag: string })._tag).toBe("CliConfigParseError");
          }
        }
      }),
    ));

  test("falls back to ambient process.env when .env is missing", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        yield* stubEnv("SUPABASE_DB_PORT_TEST", "55555");

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(cwd, "supabase", "config.toml"),
          `project_id = "ref_123"

[db]
port = "env(SUPABASE_DB_PORT_TEST)"
`,
        );

        const loaded = yield* loadCliConfig(cwd);
        expect(loaded!.config.db.port).toBe(55555);
      }),
    ));

  // Pins the strict default so callers that don't pass `cliCompat` don't inherit the CLI's
  // config-loading semantics.
  test("loads successfully with a duplicate [remotes.*] project_id when cliCompat is omitted", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(cwd, "supabase", "config.toml"),
          `project_id = "baseref"

[remotes.a]
project_id = "dupref"

[remotes.b]
project_id = "dupref"
`,
        );

        const loaded = yield* loadCliConfig(cwd);
        expect(loaded).not.toBeNull();
        expect(loaded!.config.project_id).toBe("baseref");
      }),
    ));

  test("loads a [remotes.*.compute] section alongside the project's own", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(cwd, "supabase", "config.toml"),
          `project_id = "baseref"

[compute.api]
runtime = "node"

[remotes.staging]
project_id = "abcdefghijklmnopqrst"

[remotes.staging.compute.api]
runtime = "deno"
`,
        );

        const loaded = yield* loadCliConfig(cwd);
        expect(loaded).not.toBeNull();
        expect(loaded!.config.compute).toEqual({ api: { runtime: "node" } });
      }),
    ));

  test("loads successfully with an invalid [remotes.*] project_id format when cliCompat is omitted", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(cwd, "supabase", "config.toml"),
          `project_id = "baseref"

[remotes.bad]
project_id = "not-a-ref"
`,
        );

        const loaded = yield* loadCliConfig(cwd);
        expect(loaded).not.toBeNull();
        expect(loaded!.config.project_id).toBe("baseref");
      }),
    ));

  test("does not split a comma-separated string literal for an array field when cliCompat is omitted", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(cwd, "supabase", "config.toml"),
          `project_id = "ref_123"

[auth]
additional_redirect_urls = "http://a,http://b"
`,
        );

        const exit = yield* Effect.exit(loadCliConfig(cwd));

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(error)).toBe(true);
          if (Option.isSome(error)) {
            expect((error.value as { _tag: string })._tag).toBe("CliConfigParseError");
          }
        }
      }),
    ));

  test("does not resolve a lowercase-named env() reference when cliCompat is omitted", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        yield* stubEnv("lowercase_ref_default_off_test", "lowercase-ref-value");
        const cwd = yield* makeTempProject();

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(cwd, "supabase", "config.toml"),
          `project_id = "env(lowercase_ref_default_off_test)"\n`,
        );

        const loaded = yield* loadCliConfig(cwd);
        expect(loaded!.config.project_id).toBe("env(lowercase_ref_default_off_test)");
      }),
    ));

  test("resolves a lowercase-named env() reference when cliCompat is true", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        yield* stubEnv("lowercase_ref_default_on_test", "lowercase-ref-value");
        const cwd = yield* makeTempProject();

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(cwd, "supabase", "config.toml"),
          `project_id = "env(lowercase_ref_default_on_test)"\n`,
        );

        const loaded = yield* loadCliConfig(cwd, { cliCompat: true });
        expect(loaded!.config.project_id).toBe("lowercase-ref-value");
      }),
    ));
});

describe("saveCliConfig atomic failures", () => {
  function prepareConfigFile() {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { join } = yield* Path.Path;
      const cwd = yield* makeTempProject();
      const directory = join(cwd, "supabase");
      const filePath = join(directory, "config.json");
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(filePath, yield* encodeJson({ project_id: "old-ref" }));
      return { cwd, directory, filePath };
    });
  }

  function runSaveWithFileSystem(
    cwd: string,
    decorate: (fs: FileSystem.FileSystem) => FileSystem.FileSystem,
  ) {
    return Effect.exit(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* saveCliConfig({ cwd, config: sampleConfig }).pipe(
          Effect.provideService(FileSystem.FileSystem, decorate(fs)),
        );
      }),
    );
  }

  function injectedFailure(method: string, path: string) {
    return PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method,
      pathOrDescriptor: path,
      description: "injected failure",
    });
  }

  test("surfaces a typed PlatformError when the temp-file write fails and leaves the original intact", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { cwd, directory, filePath } = yield* prepareConfigFile();

        const injectedError = injectedFailure("writeFileString", filePath);
        const exit = yield* runSaveWithFileSystem(cwd, (fs) => ({
          ...fs,
          writeFileString: (candidate, content, options) =>
            candidate.startsWith(`${filePath}.tmp.`)
              ? Effect.fail(injectedError)
              : fs.writeFileString(candidate, content, options),
        }));

        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) return;
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) {
          expect(error.value).toBe(injectedError);
        }
        expect(yield* decodeJson(yield* fs.readFileString(filePath))).toEqual({
          project_id: "old-ref",
        });
        expect(
          (yield* fs.readDirectory(directory)).filter((entry) =>
            entry.startsWith("config.json.tmp."),
          ),
        ).toEqual([]);
      }),
    ));

  test("surfaces a typed PlatformError when rename fails and cleans the temp file", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { cwd, directory, filePath } = yield* prepareConfigFile();

        const injectedError = injectedFailure("rename", filePath);
        const exit = yield* runSaveWithFileSystem(cwd, (fs) => ({
          ...fs,
          rename: (from, to) =>
            to === filePath ? Effect.fail(injectedError) : fs.rename(from, to),
        }));

        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) return;
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) {
          expect(error.value).toBe(injectedError);
        }
        expect(yield* decodeJson(yield* fs.readFileString(filePath))).toEqual({
          project_id: "old-ref",
        });
        expect(
          (yield* fs.readDirectory(directory)).filter((entry) =>
            entry.startsWith("config.json.tmp."),
          ),
        ).toEqual([]);
      }),
    ));

  test("cleans the temp file when interrupted during rename", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { cwd, directory, filePath } = yield* prepareConfigFile();

        const renameStarted = yield* Deferred.make<void>();
        const interruptedFs: FileSystem.FileSystem = {
          ...fs,
          rename: (from, to) =>
            to === filePath
              ? Deferred.succeed(renameStarted, undefined).pipe(Effect.andThen(Effect.never))
              : fs.rename(from, to),
        };
        const fiber = yield* Effect.forkChild(
          saveCliConfig({ cwd, config: sampleConfig }).pipe(
            Effect.provideService(FileSystem.FileSystem, interruptedFs),
          ),
          { startImmediately: true },
        );
        yield* Deferred.await(renameStarted);
        yield* Fiber.interrupt(fiber);

        expect(yield* decodeJson(yield* fs.readFileString(filePath))).toEqual({
          project_id: "old-ref",
        });
        expect(
          (yield* fs.readDirectory(directory)).filter((entry) =>
            entry.startsWith("config.json.tmp."),
          ),
        ).toEqual([]);
      }),
    ));
});

describe("config io [remotes.*] merge", () => {
  function writeTomlProject(toml: string) {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { join } = yield* Path.Path;
      const cwd = yield* makeTempProject();
      yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
      yield* fs.writeFileString(join(cwd, "supabase", "config.toml"), toml);
      return cwd;
    });
  }

  // Remote `project_id`s below are valid 20-lowercase-letter refs, since `Config.Validate`
  // rejects every `[remotes.*].project_id` against that pattern on every config load, so test
  // fixtures must satisfy it too, even when a scenario doesn't care about the ref's value.
  const PREVIEW_REF = "previewrefaaaaaaaaaa";
  const STAGING_REF = "stagingrefaaaaaaaaaa";

  const BASE_WITH_REMOTES = `project_id = "baseref"

[api]
enabled = true
schemas = ["public", "custom_base"]
max_rows = 123

[db]
major_version = 15

[remotes.preview]
project_id = "${PREVIEW_REF}"
[remotes.preview.api]
schemas = ["remote_only"]
max_rows = 999

[remotes.staging]
project_id = "${STAGING_REF}"
[remotes.staging.api]
enabled = false
`;

  function originAt(loaded: LoadedCliConfig | null | undefined, path: ReadonlyArray<string>) {
    return loaded === null || loaded === undefined
      ? undefined
      : cliConfigValueSourceAt(loaded, path);
  }

  function injectedProjectEnv(values: Readonly<Record<string, string>>) {
    return {
      paths: {
        projectRoot: "",
        supabaseDir: "",
        configPath: "",
        envPath: "",
        envLocalPath: "",
      },
      values,
      loadedPaths: [],
      sources: {},
    };
  }

  test("tracks the source of effective local, remote, and environment values", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const localCwd = yield* writeTomlProject(`project_id = "baseref"

[api]
port = 6001
`);
        const envCwd = yield* writeTomlProject(`project_id = "baseref"

[api]
port = "env(API_PORT)"
`);
        const remoteCwd = yield* writeTomlProject(`project_id = "baseref"

[remotes.preview]
project_id = "${PREVIEW_REF}"
[remotes.preview.db]
port = 6002
`);
        const remoteEnvCwd = yield* writeTomlProject(`project_id = "baseref"

[remotes.preview]
project_id = "${PREVIEW_REF}"
[remotes.preview.db]
port = "env(REMOTE_DB_PORT)"
`);
        const omittedCwd = yield* writeTomlProject(`project_id = "baseref"
`);

        const loaded = yield* loadCliConfig(localCwd);
        const envLoaded = yield* loadCliConfig(envCwd, {
          cliProjectEnv: injectedProjectEnv({ API_PORT: "6001" }),
        });
        const remoteLoaded = yield* loadCliConfig(remoteCwd, { projectRef: PREVIEW_REF });
        const remoteEnvLoaded = yield* loadCliConfig(remoteEnvCwd, {
          projectRef: PREVIEW_REF,
          cliProjectEnv: injectedProjectEnv({ REMOTE_DB_PORT: "6003" }),
        });
        const omittedLoaded = yield* loadCliConfig(omittedCwd);

        expect(originAt(loaded, ["api", "port"])).toBe("local");
        expect(originAt(envLoaded, ["api", "port"])).toBe("environment");
        expect(originAt(remoteLoaded, ["db", "port"])).toBe("remote");
        expect(originAt(remoteEnvLoaded, ["db", "port"])).toBe("environment");
        expect(originAt(omittedLoaded, ["studio", "port"])).toBeUndefined();
      }),
    ));

  test("tracks environment origins for local and selected-remote array leaves", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const localArrayCwd = yield* writeTomlProject(`project_id = "baseref"

[api]
schemas = ["env(LOCAL_SCHEMA)"]
`);
        const remoteArrayCwd = yield* writeTomlProject(`project_id = "baseref"

[remotes.preview]
project_id = "${PREVIEW_REF}"
[remotes.preview.api]
schemas = ["env(REMOTE_SCHEMA)"]
`);

        const localArrayLoaded = yield* loadCliConfig(localArrayCwd, {
          cliProjectEnv: injectedProjectEnv({ LOCAL_SCHEMA: "local_schema" }),
        });
        const remoteArrayLoaded = yield* loadCliConfig(remoteArrayCwd, {
          projectRef: PREVIEW_REF,
          cliProjectEnv: injectedProjectEnv({ REMOTE_SCHEMA: "remote_schema" }),
        });

        expect(originAt(localArrayLoaded, ["api", "schemas"])).toBe("environment");
        expect(originAt(remoteArrayLoaded, ["api", "schemas"])).toBe("environment");
      }),
    ));

  test("merges the matching remote subtree over the base before decode", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const cwd = yield* writeTomlProject(BASE_WITH_REMOTES);

        const loaded = yield* loadCliConfig(cwd, { projectRef: PREVIEW_REF });
        expect(loaded!.appliedRemote).toBe("preview");
        expect(loaded!.config.project_id).toBe(PREVIEW_REF);
        expect(loaded!.config.api.max_rows).toBe(999);
        // Array replaced wholesale, not element-merged.
        expect(loaded!.config.api.schemas).toEqual(["remote_only"]);
        expect(loaded!.config.api.enabled).toBe(true);
        expect(loaded!.config.db.major_version).toBe(15);
        expect(loaded!.document?.remotes).toBeUndefined();
      }),
    ));

  test("rawDocument stays pre-interpolation and pre-merge, with remotes intact, while document is resolved and merged", () =>
    runConfigEffect(
      Effect.gen(function* () {
        yield* stubEnv("SUPABASE_RAW_DOCUMENT_MAX_ROWS_TEST", "555");
        const cwd = yield* writeTomlProject(`project_id = "baseref"

[api]
max_rows = "env(SUPABASE_RAW_DOCUMENT_MAX_ROWS_TEST)"

[remotes.preview]
project_id = "${PREVIEW_REF}"
[remotes.preview.api]
max_rows = 999
`);
        const loaded = yield* loadCliConfig(cwd, { projectRef: PREVIEW_REF });

        expect(loaded!.config.api.max_rows).toBe(999);
        expect(loaded!.document?.remotes).toBeUndefined();

        const rawApi = loaded!.rawDocument?.api;
        expect(isObject(rawApi) ? rawApi.max_rows : undefined).toBe(
          "env(SUPABASE_RAW_DOCUMENT_MAX_ROWS_TEST)",
        );
        const rawRemotes = loaded!.rawDocument?.remotes;
        expect(isObject(rawRemotes) ? Object.keys(rawRemotes) : undefined).toEqual(["preview"]);
        const rawPreview = isObject(rawRemotes) ? rawRemotes.preview : undefined;
        expect(isObject(rawPreview) ? rawPreview.project_id : undefined).toBe(PREVIEW_REF);
      }),
    ));

  // An unselected `remotes` table survives on `document` (interpolated), unlike the matched case
  // above where it's stripped; callers deciding where to write must still use `rawDocument`.
  test("keeps an interpolated remotes table on document when no remote matches", () =>
    runConfigEffect(
      Effect.gen(function* () {
        yield* stubEnv("SUPABASE_UNMATCHED_REMOTE_REF_TEST", STAGING_REF);
        const cwd = yield* writeTomlProject(`project_id = "baseref"

[remotes.staging]
project_id = "env(SUPABASE_UNMATCHED_REMOTE_REF_TEST)"
`);
        const loaded = yield* loadCliConfig(cwd);
        expect(loaded!.appliedRemote).toBeUndefined();

        const documentRemotes = loaded!.document?.remotes;
        const documentStaging = isObject(documentRemotes) ? documentRemotes.staging : undefined;
        expect(isObject(documentStaging) ? documentStaging.project_id : undefined).toBe(
          STAGING_REF,
        );

        const rawRemotes = loaded!.rawDocument?.remotes;
        const rawStaging = isObject(rawRemotes) ? rawRemotes.staging : undefined;
        expect(isObject(rawStaging) ? rawStaging.project_id : undefined).toBe(
          "env(SUPABASE_UNMATCHED_REMOTE_REF_TEST)",
        );
      }),
    ));

  test("interpolatedRemotes carries resolved project_id values distinct from the raw literal", () =>
    runConfigEffect(
      Effect.gen(function* () {
        yield* stubEnv("SUPABASE_INTERPOLATED_REMOTES_TEST", STAGING_REF);
        const cwd = yield* writeTomlProject(`project_id = "baseref"

[remotes.staging]
project_id = "env(SUPABASE_INTERPOLATED_REMOTES_TEST)"
`);
        const loaded = yield* loadCliConfig(cwd);

        const interpolatedStaging = loaded!.interpolatedRemotes?.staging;
        expect(isObject(interpolatedStaging) ? interpolatedStaging.project_id : undefined).toBe(
          STAGING_REF,
        );

        const rawRemotes = loaded!.rawDocument?.remotes;
        const rawStaging = isObject(rawRemotes) ? rawRemotes.staging : undefined;
        expect(isObject(rawStaging) ? rawStaging.project_id : undefined).toBe(
          "env(SUPABASE_INTERPOLATED_REMOTES_TEST)",
        );
      }),
    ));

  test("carries appliedRemote on CliConfigParseError when the matched remote's decode fails", () =>
    runConfigEffect(
      Effect.gen(function* () {
        // The remote match/merge notice is owed even when the subsequent decode fails.
        // `db.major_version` is an unrelated schema-decode error; the merge must still have
        // happened (and be reported) ahead of it.
        const cwd = yield* writeTomlProject(
          `${BASE_WITH_REMOTES}
[remotes.preview.db]
major_version = "not-a-number"
`,
        );

        const exit = yield* Effect.exit(loadCliConfig(cwd, { projectRef: PREVIEW_REF }));
        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) {
          return;
        }
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).toBe(true);
        if (!Option.isSome(error) || error.value._tag !== "CliConfigParseError") {
          return;
        }
        expect(error.value.appliedRemote).toBe("preview");
      }),
    ));

  test("loads the base config verbatim when no remote matches", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const cwd = yield* writeTomlProject(BASE_WITH_REMOTES);

        const loaded = yield* loadCliConfig(cwd, { projectRef: "unknownref" });
        expect(loaded!.appliedRemote).toBeUndefined();
        expect(loaded!.config.project_id).toBe("baseref");
        expect(loaded!.config.api.max_rows).toBe(123);
        expect(loaded!.config.api.schemas).toEqual(["public", "custom_base"]);
      }),
    ));

  test("does not merge remotes when no projectRef is requested and none has an empty project_id", () =>
    runConfigEffect(
      Effect.gen(function* () {
        // `projectRef` defaults to `""`, so this only stays unmerged because neither remote's
        // `project_id` is empty.
        const cwd = yield* writeTomlProject(BASE_WITH_REMOTES);

        const loaded = yield* loadCliConfig(cwd);
        expect(loaded!.appliedRemote).toBeUndefined();
        expect(loaded!.config.api.max_rows).toBe(123);
        expect(Object.keys(loaded!.config.remotes)).toEqual(["preview", "staging"]);
      }),
    ));

  test("rejects duplicate project_id across remotes even when no projectRef is requested", () =>
    runConfigEffect(
      Effect.gen(function* () {
        // The duplicate-project_id check runs unconditionally on every config load, in the same
        // loop that resolves the `[remotes.*]` override — it is not gated on a caller actually
        // selecting a remote.
        const cwd = yield* writeTomlProject(`project_id = "baseref"

[remotes.a]
project_id = "dupref"

[remotes.b]
project_id = "dupref"
`);

        const message = yield* loadCliConfig(cwd, { cliCompat: true }).pipe(
          Effect.catchTag("DuplicateRemoteProjectIdError", (error) =>
            Effect.succeed(error.message),
          ),
        );
        expect(message).toBe("duplicate project_id for [remotes.b] and [remotes.a]");
      }),
    ));

  // `cliCompat` is required even though `projectRef` is passed: the duplicate/format checks
  // are gated solely on `cliCompat`, not on whether a remote is being selected.
  test("rejects duplicate project_id across remotes", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const cwd = yield* writeTomlProject(`project_id = "baseref"

[remotes.a]
project_id = "dupref"

[remotes.b]
project_id = "dupref"
`);

        const message = yield* loadCliConfig(cwd, {
          projectRef: "dupref",
          cliCompat: true,
        }).pipe(
          Effect.catchTag("DuplicateRemoteProjectIdError", (error) =>
            Effect.succeed(error.message),
          ),
        );
        expect(message).toBe("duplicate project_id for [remotes.b] and [remotes.a]");
      }),
    ));

  test("rejects duplicate project_id among remotes that do not match projectRef", () =>
    runConfigEffect(
      Effect.gen(function* () {
        // The duplicate map is built across all `[remotes.*]` blocks before applying the matching
        // override, so a clash between two non-target remotes still fails.
        const cwd = yield* writeTomlProject(`project_id = "baseref"

[remotes.target]
project_id = "previewref"

[remotes.a]
project_id = "dupref"

[remotes.b]
project_id = "dupref"
`);

        const message = yield* loadCliConfig(cwd, {
          projectRef: "previewref",
          cliCompat: true,
        }).pipe(
          Effect.catchTag("DuplicateRemoteProjectIdError", (error) =>
            Effect.succeed(error.message),
          ),
        );
        expect(message).toBe("duplicate project_id for [remotes.b] and [remotes.a]");
      }),
    ));

  test("rejects two remotes that both omit project_id", () =>
    runConfigEffect(
      Effect.gen(function* () {
        // A missing project_id reads as "", so two remotes that both omit it collide on the empty
        // key.
        const cwd = yield* writeTomlProject(`project_id = "baseref"

[remotes.a]
[remotes.a.api]
max_rows = 1

[remotes.b]
[remotes.b.api]
max_rows = 2
`);

        const message = yield* loadCliConfig(cwd, {
          projectRef: "previewref",
          cliCompat: true,
        }).pipe(
          Effect.catchTag("DuplicateRemoteProjectIdError", (error) =>
            Effect.succeed(error.message),
          ),
        );
        expect(message).toBe("duplicate project_id for [remotes.b] and [remotes.a]");
      }),
    ));

  test("rejects a remote project_id that is not a valid 20-letter ref, even with no projectRef requested", () =>
    runConfigEffect(
      Effect.gen(function* () {
        // Every `[remotes.*].project_id` is checked against the ref pattern on every config load,
        // not only the one that ends up selected, so this must fail closed even when the caller
        // never selects a remote.
        const cwd = yield* writeTomlProject(`project_id = "baseref"

[remotes.bad]
project_id = "not-a-ref"
`);

        const message = yield* loadCliConfig(cwd, { cliCompat: true }).pipe(
          Effect.catchTag("InvalidRemoteProjectIdError", (error) => Effect.succeed(error.message)),
        );
        expect(message).toBe(
          "Invalid config for remotes.bad.project_id. Must be like: abcdefghijklmnopqrst",
        );
      }),
    ));

  test("the merged document carries pointer sections introduced by the remote", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const cwd = yield* writeTomlProject(`project_id = "baseref"

[remotes.preview]
project_id = "${PREVIEW_REF}"
[remotes.preview.db.ssl_enforcement]
enabled = true
`);

        const loaded = yield* loadCliConfig(cwd, { projectRef: PREVIEW_REF });
        // `presenceIn` reads `document` to detect optional pointer sections;
        // a remote-introduced `db.ssl_enforcement` must be present there.
        const db = loaded!.document?.db;
        expect(typeof db === "object" && db !== null && "ssl_enforcement" in db).toBe(true);
      }),
    ));

  test("forces db.seed.enabled false when the matching remote omits it", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const cwd = yield* writeTomlProject(`project_id = "baseref"

[db.seed]
enabled = true

[remotes.preview]
project_id = "${PREVIEW_REF}"
[remotes.preview.api]
max_rows = 5
`);

        const loaded = yield* loadCliConfig(cwd, { projectRef: PREVIEW_REF });
        expect(loaded!.config.db.seed.enabled).toBe(false);
      }),
    ));

  test("preserves db.seed.enabled when the matching remote sets it", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const cwd = yield* writeTomlProject(`project_id = "baseref"

[remotes.preview]
project_id = "${PREVIEW_REF}"
[remotes.preview.db.seed]
enabled = true
`);

        const loaded = yield* loadCliConfig(cwd, { projectRef: PREVIEW_REF });
        expect(loaded!.config.db.seed.enabled).toBe(true);
      }),
    ));

  test("resolves env() on a lowercase-named variable", () =>
    runConfigEffect(
      Effect.gen(function* () {
        // Env-var matching is case-agnostic when `cliCompat` is set; without it, the strict
        // SCREAMING_SNAKE_CASE matcher wouldn't match this lowercase name at all.
        yield* stubEnv("project_id", "lowercase-ref");
        const cwd = yield* writeTomlProject(`project_id = "env(project_id)"\n`);
        const loaded = yield* loadCliConfig(cwd, { cliCompat: true });
        expect(loaded!.config.project_id).toBe("lowercase-ref");
      }),
    ));

  test("does not match a remote whose project_id is env(REF) against the resolved ref", () =>
    runConfigEffect(
      Effect.gen(function* () {
        // A `[remotes.x] project_id = "env(REF)"` never matches a caller-supplied, already-resolved
        // `REF`: matching compares the literal `env(REF)` string, not what it resolves to.
        yield* stubEnv("SUPABASE_REMOTE_ENV_REF_TEST", PREVIEW_REF);
        const cwd = yield* writeTomlProject(`project_id = "baseref"

[api]
max_rows = 1

[remotes.preview]
project_id = "env(SUPABASE_REMOTE_ENV_REF_TEST)"
[remotes.preview.api]
max_rows = 999
`);
        const loaded = yield* loadCliConfig(cwd, { projectRef: PREVIEW_REF });
        expect(loaded!.appliedRemote).toBeUndefined();
        expect(loaded!.config.api.max_rows).toBe(1);
      }),
    ));

  test("validates a remote's env(REF) project_id format against its resolved value, not the literal", () =>
    runConfigEffect(
      Effect.gen(function* () {
        // Format validation runs after `env(...)` resolution, so it validates the resolved
        // project_id against the pattern, not the literal `env(REF)` string.
        yield* stubEnv("SUPABASE_REMOTE_ENV_REF_FORMAT_TEST", PREVIEW_REF);
        const cwd = yield* writeTomlProject(`project_id = "baseref"

[remotes.preview]
project_id = "env(SUPABASE_REMOTE_ENV_REF_FORMAT_TEST)"
`);
        const loaded = yield* loadCliConfig(cwd);
        expect(loaded!.appliedRemote).toBeUndefined();
        expect(loaded!.config.project_id).toBe("baseref");
      }),
    ));

  test("resolves env() references inside the matching remote before merge", () =>
    runConfigEffect(
      Effect.gen(function* () {
        yield* stubEnv("SUPABASE_REMOTE_MAX_ROWS_TEST", "777");
        const cwd = yield* writeTomlProject(`project_id = "baseref"

[api]
max_rows = 1

[remotes.preview]
project_id = "${PREVIEW_REF}"
[remotes.preview.api]
max_rows = "env(SUPABASE_REMOTE_MAX_ROWS_TEST)"
`);
        const loaded = yield* loadCliConfig(cwd, { projectRef: PREVIEW_REF });
        expect(loaded!.config.api.max_rows).toBe(777);
      }),
    ));

  // Business-rule checks (`Auth.External.validate()`, etc.) run exactly once, against the
  // merged effective config, never iterated over every remote — a non-selected `[remotes.*]`
  // block's own business-rule violations must not fail the whole config load.
  test("loads an unselected remote whose external provider is enabled without a secret", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const cwd = yield* writeTomlProject(
          `project_id = "baseref"

[remotes.staging]
project_id = "${STAGING_REF}"

[remotes.staging.auth.external.github]
enabled = true
`,
        );

        // [remotes.staging] is never selected/merged, so it's never business-rule-validated,
        // even though it decodes fine structurally.
        const loaded = yield* loadCliConfig(cwd);
        expect(loaded!.appliedRemote).toBeUndefined();
        expect(loaded!.config.remotes.staging?.auth.external.github.enabled).toBe(true);
      }),
    ));

  test("still validates the same remote's external provider once it is selected", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const cwd = yield* writeTomlProject(
          `project_id = "baseref"

[remotes.staging]
project_id = "${STAGING_REF}"

[remotes.staging.auth.external.github]
enabled = true
`,
        );

        // Selecting [remotes.staging] merges it into the effective config, which is
        // business-rule-validated — a required `client_id`/`secret` is missing, so this must
        // still fail.
        const exit = yield* Effect.exit(loadCliConfig(cwd, { projectRef: STAGING_REF }));
        expect(Exit.isFailure(exit)).toBe(true);
      }),
    ));

  test("still fails on a structurally malformed value inside an unselected remote", () =>
    runConfigEffect(
      Effect.gen(function* () {
        // Every remote is structurally decoded regardless of selection — only the
        // merged-config-only business rules are skipped for a non-selected remote, not type/shape
        // decoding.
        const cwd = yield* writeTomlProject(
          `${BASE_WITH_REMOTES}
[remotes.staging.db]
major_version = "not-a-number"
`,
        );

        const exit = yield* Effect.exit(loadCliConfig(cwd));
        expect(Exit.isFailure(exit)).toBe(true);
      }),
    ));
});

describe("config io removed keys", () => {
  function writeToml(cwd: string, contents: string) {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { join } = yield* Path.Path;
      const path = yield* configTomlPath(cwd);
      yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
      yield* fs.writeFileString(path, contents);
      return path;
    });
  }

  function loadToml(contents: string) {
    return Effect.gen(function* () {
      const cwd = yield* makeTempProject();
      return yield* loadCliConfigFile(yield* writeToml(cwd, contents));
    });
  }

  function loadTomlFailure(contents: string) {
    return Effect.gen(function* () {
      const cwd = yield* makeTempProject();
      const error = yield* Effect.flip(loadCliConfigFile(yield* writeToml(cwd, contents)));
      expect(error._tag).toBe("CliConfigRemovedKeyError");
      return error;
    });
  }

  const stagingRemote = `[remotes.staging]
project_id = "stagingrefaaaaaaaaaa"
`;

  test("the config schema accepts only an empty experimental.orioledb_version", () => {
    const decode = Schema.decodeUnknownSync(CliConfigSchema);
    expect(() => decode({ experimental: { orioledb_version: "" } })).not.toThrow();
    expect(() => decode({ experimental: { orioledb_version: "17.0.1.084-orioledb" } })).toThrow();
  });

  test.each([
    {
      name: "[inbucket] whatever its contents",
      toml: "[inbucket]\nenabled = false\n",
      key: "[inbucket]",
      replacement: "[local_smtp]",
    },
    {
      name: "[remotes.*.inbucket]",
      toml: `${stagingRemote}\n[remotes.staging.inbucket]\nport = 33333\n`,
      key: "[remotes.staging.inbucket]",
      replacement: "[remotes.staging.local_smtp]",
    },
    {
      name: "a non-empty experimental.orioledb_version",
      toml: '[experimental]\norioledb_version = "15.1.0.150"\n',
      key: "experimental.orioledb_version",
      replacement: "db.orioledb_version",
    },
    {
      name: "a non-string experimental.orioledb_version",
      toml: "[experimental]\norioledb_version = 1\n",
      key: "experimental.orioledb_version",
      replacement: "db.orioledb_version",
    },
    {
      name: "a remote's non-empty experimental.orioledb_version",
      toml: `${stagingRemote}\n[remotes.staging.experimental]\norioledb_version = "15.1.0.150"\n`,
      key: "remotes.staging.experimental.orioledb_version",
      replacement: "remotes.staging.db.orioledb_version",
    },
    {
      name: "an enabled [auth.external.slack]",
      toml: "[auth.external.slack]\nenabled = true\n",
      key: "[auth.external.slack]",
      replacement: "[auth.external.slack_oidc]",
    },
    {
      name: "a disabled [auth.external.linkedin]",
      toml: "[auth.external.linkedin]\nenabled = false\n",
      key: "[auth.external.linkedin]",
      replacement: "[auth.external.linkedin_oidc]",
    },
    {
      name: "a remote's [auth.external.linkedin]",
      toml: `${stagingRemote}\n[remotes.staging.auth.external.linkedin]\nenabled = true\n`,
      key: "[remotes.staging.auth.external.linkedin]",
      replacement: "[remotes.staging.auth.external.linkedin_oidc]",
    },
  ])("rejects $name", ({ toml, key, replacement }) =>
    runConfigEffect(
      Effect.gen(function* () {
        const error = yield* loadTomlFailure(`project_id = "abc123"\n\n${toml}`);

        expect(error).toMatchObject({ removedKeys: [{ key, replacement }] });
      }),
    ),
  );

  test("names the key, the file and the replacement", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const error = yield* loadTomlFailure(
          'project_id = "abc123"\n\n[inbucket]\nenabled = true\n',
        );

        expect(error.message).toBe(
          "[inbucket] in supabase/config.toml is no longer supported. Use [local_smtp] instead.",
        );
      }),
    ));

  test("reports every removed key in one error, the top level before each remote", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const error = yield* loadTomlFailure(
          `project_id = "abc123"

[inbucket]
enabled = true

[experimental]
orioledb_version = "15.1.0.150"

[auth.external.slack]
enabled = true

${stagingRemote}
[remotes.staging.inbucket]
enabled = true

[remotes.staging.auth.external.linkedin]
enabled = false
`,
        );

        expect(error.message).toBe(
          [
            "supabase/config.toml uses config keys that are no longer supported:",
            "  [inbucket]: use [local_smtp] instead.",
            "  experimental.orioledb_version: use db.orioledb_version instead.",
            "  [auth.external.slack]: use [auth.external.slack_oidc] instead.",
            "  [remotes.staging.inbucket]: use [remotes.staging.local_smtp] instead.",
            "  [remotes.staging.auth.external.linkedin]: use [remotes.staging.auth.external.linkedin_oidc] instead.",
          ].join("\n"),
        );
      }),
    ));

  test("saves over a config that uses removed keys and keeps its $schema", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* makeTempProject();
        const schemaRef = "./node_modules/@supabase/config/schema.json";
        const filePath = yield* writeToml(
          cwd,
          `"$schema" = "${schemaRef}"\nproject_id = "abc123"\n\n[inbucket]\nenabled = true\n`,
        );

        const saved = yield* saveCliConfig({
          cwd,
          config: decodeCliConfig({ project_id: "abc123" }),
        });

        expect(saved.schemaRef).toBe(schemaRef);
        const content = yield* fs.readFileString(filePath);
        expect(content).toContain(`"$schema" = "${schemaRef}"`);
        expect(content).not.toContain("inbucket");
      }),
    ));

  describe("an empty experimental.orioledb_version", () => {
    test("loads silently and leaves no trace in the loaded document", () =>
      runConfigEffect(
        Effect.gen(function* () {
          const loaded = yield* loadToml(
            `project_id = "abc123"

[experimental]
orioledb_version = ""

${stagingRemote}
[remotes.staging.experimental]
orioledb_version = ""
`,
          );

          expect(loaded.deprecatedPaths).toEqual([]);
          expect(loaded.rawDocument).toEqual({
            project_id: "abc123",
            experimental: {},
            remotes: { staging: { project_id: "stagingrefaaaaaaaaaa", experimental: {} } },
          });
          expect(loaded.document).not.toHaveProperty("experimental.orioledb_version");
          expect(loaded.config.db.orioledb_version).toBeUndefined();
          expect(loaded.valueOrigins?.map((origin) => origin.path.join("."))).not.toContain(
            "experimental.orioledb_version",
          );
        }),
      ));

    test("leaves db.orioledb_version as written", () =>
      runConfigEffect(
        Effect.gen(function* () {
          const loaded = yield* loadToml(
            `project_id = "abc123"

[db]
orioledb_version = "15.1.0.150"

[experimental]
orioledb_version = ""
`,
          );

          expect(loaded.config.db.orioledb_version).toBe("15.1.0.150");
        }),
      ));
  });
});

describe("config io [auth.email|sms] enabled replaces enable_signup", () => {
  function loadToml(contents: string, options?: InternalLoadCliConfigOptions) {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { join } = yield* Path.Path;
      const cwd = yield* makeTempProject();
      const path = yield* configTomlPath(cwd);
      yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
      yield* fs.writeFileString(path, contents);

      return yield* loadCliConfigFile(path, options);
    });
  }

  const STAGING_REF = "stagingrefaaaaaaaaaa";

  const deprecation = (path: string) => `${path}.enable_signup`;

  type Section = "email" | "sms";

  test.each<{ section: Section; value: boolean }>([
    { section: "email", value: false },
    { section: "email", value: true },
    { section: "sms", value: true },
  ])(
    "decodes a legacy $section enable_signup = $value and reports it as deprecated",
    ({ section, value }) =>
      runConfigEffect(
        Effect.gen(function* () {
          const loaded = yield* loadToml(
            `project_id = "abc123"

[auth.${section}]
enable_signup = ${value}
`,
          );

          expect(loaded.config.auth[section].enable_signup).toBe(value);
          expect(loaded.deprecatedPaths).toEqual([deprecation(`auth.${section}`)]);
        }),
      ),
  );

  test.each<{ section: Section; value: boolean }>([
    { section: "email", value: false },
    { section: "sms", value: true },
  ])(
    "folds $section enabled = $value into enable_signup without reporting a deprecation",
    ({ section, value }) =>
      runConfigEffect(
        Effect.gen(function* () {
          const loaded = yield* loadToml(
            `project_id = "abc123"

[auth.${section}]
enabled = ${value}
`,
          );

          expect(loaded.config.auth[section].enable_signup).toBe(value);
          expect(loaded.document).toHaveProperty(`auth.${section}.enable_signup`, value);
          expect(loaded.document).not.toHaveProperty(`auth.${section}.enabled`);
          expect(loaded.deprecatedPaths).toEqual([]);
        }),
      ),
  );

  test.each<{ section: Section; enabled: boolean }>([
    { section: "email", enabled: false },
    { section: "email", enabled: true },
    { section: "sms", enabled: true },
    { section: "sms", enabled: false },
  ])(
    "lets $section enabled = $enabled beat a disagreeing enable_signup, and still reports it as deprecated",
    ({ section, enabled }) =>
      runConfigEffect(
        Effect.gen(function* () {
          const loaded = yield* loadToml(
            `project_id = "abc123"

[auth.${section}]
enabled = ${enabled}
enable_signup = ${!enabled}
`,
          );

          expect(loaded.config.auth[section].enable_signup).toBe(enabled);
          expect(loaded.deprecatedPaths).toEqual([deprecation(`auth.${section}`)]);
        }),
      ),
  );

  test("defaults email on and sms off, with nothing deprecated, when neither key is set", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const loaded = yield* loadToml(`project_id = "abc123"\n`);

        expect(loaded.config.auth.email.enable_signup).toBe(true);
        expect(loaded.config.auth.sms.enable_signup).toBe(false);
        expect(loaded.deprecatedPaths).toEqual([]);
      }),
    ));

  test("names the remote block in the deprecated path for a legacy key under [remotes.*]", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const loaded = yield* loadToml(
          `project_id = "abc123"

[remotes.staging]
project_id = "${STAGING_REF}"

[remotes.staging.auth.sms]
enable_signup = true
`,
        );

        expect(loaded.config.remotes.staging?.auth.sms.enable_signup).toBe(true);
        expect(loaded.deprecatedPaths).toEqual([deprecation("remotes.staging.auth.sms")]);
      }),
    ));

  test("folds enabled inside an unselected [remotes.*] block", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const loaded = yield* loadToml(
          `project_id = "abc123"

[remotes.staging]
project_id = "${STAGING_REF}"

[remotes.staging.auth.email]
enabled = false
`,
        );

        expect(loaded.config.remotes.staging?.auth.email.enable_signup).toBe(false);
        expect(loaded.deprecatedPaths).toEqual([]);
      }),
    ));

  test("a selected remote's legacy enable_signup beats the base's enabled", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const loaded = yield* loadToml(
          `project_id = "abc123"

[auth.email]
enabled = false

[remotes.staging]
project_id = "${STAGING_REF}"

[remotes.staging.auth.email]
enable_signup = true
`,
          { projectRef: STAGING_REF },
        );

        expect(loaded.appliedRemote).toBe("staging");
        expect(loaded.config.auth.email.enable_signup).toBe(true);
        expect(loaded.deprecatedPaths).toEqual([deprecation("remotes.staging.auth.email")]);
      }),
    ));

  test("resolves enabled = env(...) and records the environment origin at enable_signup", () =>
    runConfigEffect(
      Effect.gen(function* () {
        yield* stubEnv("SUPABASE_PROVIDER_ENABLED_ENV_TEST", "false");
        const loaded = yield* loadToml(
          `project_id = "abc123"

[auth.email]
enabled = "env(SUPABASE_PROVIDER_ENABLED_ENV_TEST)"
`,
        );

        expect(loaded.config.auth.email.enable_signup).toBe(false);
        expect(cliConfigValueSourceAt(loaded, ["auth", "email", "enable_signup"])).toBe(
          "environment",
        );
        expect(cliConfigValueSourceAt(loaded, ["auth", "email", "enabled"])).toBeUndefined();
        expect(loaded.deprecatedPaths).toEqual([]);
      }),
    ));

  const encoders: ReadonlyArray<{
    format: string;
    encode: (config: CliConfig) => string;
    parse: (text: string) => unknown;
  }> = [
    { format: "TOML", encode: encodeCliConfigToToml, parse: (text) => SmolToml.parse(text) },
    { format: "JSON", encode: encodeCliConfigToJson, parse: (text) => JSON.parse(text) },
  ];

  describe.each(encoders)("encoding to $format", ({ encode, parse }) => {
    test("writes enabled, not enable_signup, for a decoded legacy provider switch", () => {
      const config = decodeCliConfig({
        auth: { email: { enable_signup: false }, sms: { enable_signup: true } },
      });

      expect(parse(encode(config))).toEqual({
        auth: { email: { enabled: false }, sms: { enabled: true } },
      });
    });

    test("lets enabled beat a disagreeing enable_signup on the same section", () => {
      const config = decodeCliConfig({
        auth: {
          email: { enabled: true, enable_signup: false },
          sms: { enabled: false, enable_signup: true },
        },
      });

      expect(parse(encode(config))).toEqual({
        auth: { email: { enabled: true }, sms: { enabled: false } },
      });
    });

    test("writes enabled in every [remotes.*] block, with enabled winning over enable_signup", () => {
      const config = decodeCliConfig({
        remotes: {
          legacy: {
            project_id: STAGING_REF,
            auth: { email: { enable_signup: false }, sms: { enable_signup: true } },
          },
          both: {
            project_id: "bothrefaaaaaaaaaaaaa",
            auth: {
              email: { enabled: true, enable_signup: false },
              sms: { enabled: false, enable_signup: true },
            },
          },
        },
      });

      const { remotes } = parse(encode(config)) as {
        remotes: Record<string, { auth: { email: object; sms: object } }>;
      };

      expect(remotes.legacy?.auth.email).toMatchObject({ enabled: false });
      expect(remotes.legacy?.auth.sms).toMatchObject({ enabled: true });
      expect(remotes.both?.auth.email).toMatchObject({ enabled: true });
      expect(remotes.both?.auth.sms).toMatchObject({ enabled: false });
      for (const remote of Object.values(remotes)) {
        expect(remote.auth.email).not.toHaveProperty("enable_signup");
        expect(remote.auth.sms).not.toHaveProperty("enable_signup");
      }
    });
  });

  test.each<{ section: Section; value: boolean }>([
    { section: "email", value: false },
    { section: "sms", value: true },
  ])(
    "load, save, load keeps $section enabled = $value as enabled and reports nothing deprecated",
    ({ section, value }) =>
      runConfigEffect(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { join } = yield* Path.Path;
          const cwd = yield* makeTempProject();
          yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
          yield* fs.writeFileString(
            yield* configTomlPath(cwd),
            `project_id = "abc123"\n\n[auth.${section}]\nenabled = ${value}\n`,
          );

          const first = yield* loadCliConfig(cwd);
          const saved = yield* saveCliConfig({ cwd, config: first!.config });
          const second = yield* loadCliConfig(cwd);

          expect(first?.deprecatedPaths).toEqual([]);
          const text = yield* fs.readFileString(saved.path);
          expect(text).toContain(`enabled = ${value}`);
          expect(text).not.toContain("enable_signup");
          expect(second?.config.auth[section].enable_signup).toBe(value);
          expect(second?.deprecatedPaths).toEqual([]);
        }),
      ),
  );

  test("reports legacy keys through deprecatedPaths and prints nothing to the console", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const consoleSpies = yield* Effect.forEach(["error", "warn"] as const, (method) =>
          Effect.acquireRelease(
            Effect.sync(() => vi.spyOn(console, method).mockImplementation(() => {})),
            (spy) => Effect.sync(() => spy.mockRestore()),
          ),
        );

        const loaded = yield* loadToml(
          `project_id = "abc123"

[auth.email]
enable_signup = false

[remotes.staging]
project_id = "${STAGING_REF}"

[remotes.staging.auth.sms]
enable_signup = true
`,
        );

        expect(loaded.deprecatedPaths).toEqual([
          deprecation("auth.email"),
          deprecation("remotes.staging.auth.sms"),
        ]);
        for (const spy of consoleSpies) {
          expect(spy).not.toHaveBeenCalled();
        }
      }),
    ));
});

describe("remoteNameForProjectRef / remoteProjectIdEntries", () => {
  test("matches a remote by its raw-literal project_id", () => {
    const remotes = {
      staging: { project_id: "stagingrefaaaaaaaaaa" },
      preview: { project_id: "previewrefaaaaaaaaaa" },
    };
    expect(remoteNameForProjectRef(remotes, "previewrefaaaaaaaaaa")).toBe("preview");
    expect(remoteNameForProjectRef(remotes, "stagingrefaaaaaaaaaa")).toBe("staging");
  });

  test("does not match a block whose project_id is still the literal env(REF) form, even when REF resolves to the queried ref", () => {
    // Compares the raw string, not the interpolated value: a block whose `project_id` is the
    // literal `env(...)` form must never match an already-resolved ref.
    const remotes = {
      staging: { project_id: "env(SUPABASE_REMOTE_REF)" },
    };
    expect(remoteNameForProjectRef(remotes, "stagingrefaaaaaaaaaa")).toBeUndefined();
  });

  test("treats a missing project_id as an empty string", () => {
    const remotes = { staging: {} };
    expect(remoteNameForProjectRef(remotes, "")).toBe("staging");
    expect(remoteNameForProjectRef(remotes, "stagingrefaaaaaaaaaa")).toBeUndefined();
  });

  test("returns undefined for undefined/garbage remotes", () => {
    expect(remoteNameForProjectRef(undefined, "ref")).toBeUndefined();
    expect(remoteNameForProjectRef(null, "ref")).toBeUndefined();
    expect(remoteNameForProjectRef("garbage", "ref")).toBeUndefined();
    expect(remoteNameForProjectRef(["array"], "ref")).toBeUndefined();
    expect(remoteNameForProjectRef(42, "ref")).toBeUndefined();
  });

  test("returns undefined when projectRef itself is undefined, even for a remote with an empty project_id", () => {
    const remotes = { staging: {} };
    expect(remoteNameForProjectRef(remotes, undefined)).toBeUndefined();
  });

  test("remoteProjectIdEntries lists every remote's name and project_id, in document order", () => {
    const remotes = {
      staging: { project_id: "stagingrefaaaaaaaaaa" },
      preview: {},
    };
    expect(remoteProjectIdEntries(remotes)).toEqual([
      { name: "staging", projectId: "stagingrefaaaaaaaaaa" },
      { name: "preview", projectId: "" },
    ]);
  });

  test("remoteProjectIdEntries returns [] for undefined/garbage remotes", () => {
    expect(remoteProjectIdEntries(undefined)).toEqual([]);
    expect(remoteProjectIdEntries(null)).toEqual([]);
    expect(remoteProjectIdEntries("garbage")).toEqual([]);
    expect(remoteProjectIdEntries(["array"])).toEqual([]);
  });
});

describe("writeCliConfigDocumentText", () => {
  function tempFileTargets() {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { join } = yield* Path.Path;
      const cwd = yield* makeTempProject();
      const dir = join(cwd, "supabase");
      yield* fs.makeDirectory(dir, { recursive: true });
      return { cwd, filePath: join(dir, "config.toml") };
    });
  }

  function tmpSurvivors(dir: string, baseName: string) {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const entries = yield* fs.readDirectory(dir);
      return entries.filter((entry) => entry.startsWith(`${baseName}.tmp.`));
    });
  }

  test("replaces the file's content via a temp file in the same directory, then renames over the target", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const { cwd, filePath } = yield* tempFileTargets();

        yield* fs.writeFileString(filePath, 'project_id = "old"\n');

        yield* writeCliConfigDocumentText(filePath, 'project_id = "new"\n');

        const content = yield* fs.readFileString(filePath);
        expect(content).toBe('project_id = "new"\n');
        expect(yield* tmpSurvivors(join(cwd, "supabase"), "config.toml")).toEqual([]);
      }),
    ));

  test("leaves no temp file behind after a successful write", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const { cwd, filePath } = yield* tempFileTargets();

        yield* fs.writeFileString(filePath, 'project_id = "old"\n');
        yield* writeCliConfigDocumentText(filePath, 'project_id = "new"\n');

        const entries = yield* fs.readDirectory(join(cwd, "supabase"));
        expect(entries).toEqual(["config.toml"]);
      }),
    ));

  test("preserves the target file's existing mode", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { filePath } = yield* tempFileTargets();

        yield* fs.writeFileString(filePath, 'project_id = "old"\n');
        yield* fs.chmod(filePath, 0o600);

        yield* writeCliConfigDocumentText(filePath, 'project_id = "new"\n');

        const info = yield* fs.stat(filePath);
        expect(info.mode & 0o777).toBe(0o600);
      }),
    ));

  test("fails with a typed CliConfigWriteError (not a defect) when the destination directory doesn't exist, leaving nothing behind", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const filePath = join(cwd, "supabase", "config.toml");

        const exit = yield* Effect.exit(
          writeCliConfigDocumentText(filePath, 'project_id = "new"\n'),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) {
          return;
        }
        // A typed failure, not a defect: findErrorOption only finds `Fail` reasons.
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) {
          expect((error.value as { _tag: string })._tag).toBe("CliConfigWriteError");
          expect((error.value as { path: string }).path).toBe(filePath);
        }

        expect(Exit.isFailure(yield* Effect.exit(fs.readFileString(filePath)))).toBe(true);
        expect(Exit.isFailure(yield* Effect.exit(fs.readDirectory(join(cwd, "supabase"))))).toBe(
          true,
        );
      }),
    ));

  // The directory-missing case above fails before any temp file exists, so it never exercises
  // `Effect.ensuring`'s cleanup removing a real survivor. An existing directory as the
  // destination lets the temp file get created, so the rename step is what fails instead.
  test("fails with a typed CliConfigWriteError when rename fails, and still cleans up the temp file it already created", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const { cwd, filePath } = yield* tempFileTargets();

        yield* fs.makeDirectory(filePath);

        const exit = yield* Effect.exit(
          writeCliConfigDocumentText(filePath, 'project_id = "new"\n'),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) {
          return;
        }
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) {
          expect((error.value as { _tag: string })._tag).toBe("CliConfigWriteError");
          expect((error.value as { path: string }).path).toBe(filePath);
        }

        expect(yield* tmpSurvivors(join(cwd, "supabase"), "config.toml")).toEqual([]);
      }),
    ));
});

describe("decodeCliConfigDocumentForValidationEffect", () => {
  test("folds an unfolded auth.{email,sms}.enabled into enable_signup, as a pull-edited document carries it", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const config = yield* decodeCliConfigDocumentForValidationEffect(
          { project_id: "abc123", auth: { email: { enabled: false }, sms: { enabled: true } } },
          { cliCompat: true, path: "supabase/config.toml", format: "toml" },
        );
        expect(config.auth.email.enable_signup).toBe(false);
        expect(config.auth.sms.enable_signup).toBe(true);
      }),
    ));

  test("fails with CliConfigRemovedKeyError naming every removed key, remotes included", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          decodeCliConfigDocumentForValidationEffect(
            {
              project_id: "abc123",
              inbucket: { enabled: true },
              remotes: { staging: { experimental: { orioledb_version: "15.1.0.150" } } },
            },
            { cliCompat: true, path: "supabase/config.toml", format: "toml" },
          ),
        );

        expect(error).toMatchObject({
          _tag: "CliConfigRemovedKeyError",
          removedKeys: [
            { key: "[inbucket]", replacement: "[local_smtp]" },
            {
              key: "remotes.staging.experimental.orioledb_version",
              replacement: "remotes.staging.db.orioledb_version",
            },
          ],
        });
      }),
    ));

  test("tolerates an empty experimental.orioledb_version", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const config = yield* decodeCliConfigDocumentForValidationEffect(
          { project_id: "abc123", experimental: { orioledb_version: "" } },
          { cliCompat: true, path: "supabase/config.toml", format: "toml" },
        );

        expect(config).toEqual(decodeCliConfig({ project_id: "abc123" }));
      }),
    ));

  test("decodes a valid document successfully", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const config = yield* decodeCliConfigDocumentForValidationEffect(
          { project_id: "abc123" },
          { cliCompat: true, path: "supabase/config.toml", format: "toml" },
        );
        expect(config.project_id).toBe("abc123");
      }),
    ));

  test("fails with a typed CliConfigParseError (SchemaError cause) when a root business-rule check fails", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const document = {
          project_id: "abc123",
          auth: { sms: { twilio: { enabled: true, account_sid: "", message_service_sid: "" } } },
        };
        const exit = yield* Effect.exit(
          decodeCliConfigDocumentForValidationEffect(document, {
            cliCompat: true,
            path: "supabase/config.toml",
            format: "toml",
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) {
          return;
        }
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) {
          expect((error.value as { _tag: string })._tag).toBe("CliConfigParseError");
          expect(Schema.isSchemaError((error.value as { cause: unknown }).cause)).toBe(true);
        }
      }),
    ));

  test("does not apply business-rule checks to a [remotes.*] block when no remoteName is given (checks disabled)", () =>
    runConfigEffect(
      Effect.gen(function* () {
        // The same `enabled: true` + empty `account_sid`/`message_service_sid` shape that fails at
        // the root above decodes fine inside a `[remotes.*]` block, which decodes with
        // `disableChecks: true` since business rules only apply to the merged effective config.
        const document = {
          project_id: "abc123",
          remotes: {
            staging: {
              project_id: "stagingrefaaaaaaaaaa",
              auth: {
                sms: { twilio: { enabled: true, account_sid: "", message_service_sid: "" } },
              },
            },
          },
        };
        const config = yield* decodeCliConfigDocumentForValidationEffect(document, {
          cliCompat: true,
          path: "supabase/config.toml",
          format: "toml",
        });
        expect(config.remotes["staging"]).toBeDefined();
      }),
    ));

  test("resolves env(VAR) from the project's own .env file, not just the ambient process environment", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        // Resolves `env(VAR)` exactly like `loadCliConfigFile` — including a var that only exists
        // in the project's own `.env` file, never in `process.env`.
        const cwd = yield* makeTempProject();
        const path = yield* configTomlPath(cwd);

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(path, 'project_id = "demo"\n');
        yield* fs.writeFileString(
          join(cwd, "supabase", ".env"),
          "SUPABASE_VALIDATION_PG_VERSION_TEST=16\n",
        );

        const config = yield* decodeCliConfigDocumentForValidationEffect(
          {
            project_id: "abc123",
            db: { major_version: "env(SUPABASE_VALIDATION_PG_VERSION_TEST)" },
          },
          { cliCompat: true, path, format: "toml" },
        );
        expect(config.db.major_version).toBe(16);
      }),
    ));

  test("leaves an unresolved env(VAR) literal in place rather than failing the field's own required-non-empty check", () =>
    runConfigEffect(
      Effect.gen(function* () {
        // A required string field spelled as `env(VAR)` with `VAR` unset decodes as the literal
        // `env(VAR)` string, which is non-empty, so it still satisfies a required-field check even
        // though it never actually resolved.
        const document = {
          project_id: "abc123",
          auth: {
            sms: {
              twilio: {
                enabled: true,
                account_sid: "AC123",
                message_service_sid: "MG123",
                auth_token: "env(SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN)",
              },
            },
          },
        };
        const config = yield* decodeCliConfigDocumentForValidationEffect(document, {
          cliCompat: true,
          path: "supabase/config.toml",
          format: "toml",
        });
        expect(config.auth.sms.twilio.auth_token).toBe("env(SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN)");
      }),
    ));

  test("remoteName merges the [remotes.*] block over the root and validates the merged projection: a rule violation only visible after the merge fails", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const document = {
          project_id: "abc123",
          remotes: {
            staging: {
              project_id: "stagingrefaaaaaaaaaa",
              auth: {
                sms: { twilio: { enabled: true, account_sid: "", message_service_sid: "" } },
              },
            },
          },
        };
        const exit = yield* Effect.exit(
          decodeCliConfigDocumentForValidationEffect(document, {
            cliCompat: true,
            path: "supabase/config.toml",
            format: "toml",
            remoteName: "staging",
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) {
          return;
        }
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) {
          expect((error.value as { _tag: string })._tag).toBe("CliConfigParseError");
          expect(Schema.isSchemaError((error.value as { cause: unknown }).cause)).toBe(true);
          expect((error.value as { appliedRemote?: string }).appliedRemote).toBe("staging");
        }
      }),
    ));

  test("the same document passes when remoteName is omitted — the remote's own rule violation is invisible before the merge", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const document = {
          project_id: "abc123",
          remotes: {
            staging: {
              project_id: "stagingrefaaaaaaaaaa",
              auth: {
                sms: { twilio: { enabled: true, account_sid: "", message_service_sid: "" } },
              },
            },
          },
        };
        const config = yield* decodeCliConfigDocumentForValidationEffect(document, {
          cliCompat: true,
          path: "supabase/config.toml",
          format: "toml",
        });
        expect(config.remotes["staging"]).toBeDefined();
      }),
    ));
});
