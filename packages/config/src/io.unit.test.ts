import { describe, expect, it } from "@effect/vitest";
import { afterEach, vi } from "vitest";
import { BunServices } from "@effect/platform-bun";
import {
  Cause,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
  Redacted,
  Schema,
  Scope,
} from "effect";
import { ProjectConfigSchema, toProjectConfigJsonSchema } from "./base.ts";
import { loadProjectConfig as loadProjectConfigFromBun } from "./bun.ts";
import {
  configJsonPath,
  configTomlPath,
  encodeProjectConfigToJson,
  encodeProjectConfigToToml,
  loadProjectConfig,
  loadProjectConfigFile,
  projectConfigValueSourceAt,
  type LoadedProjectConfig,
  saveProjectConfig,
  type LoadProjectConfigOptions,
} from "./io.ts";
import { loadProjectConfig as loadProjectConfigFromNode } from "./node.ts";
import { projectConfigStoreLayer } from "./project-config.layer.ts";
import { ProjectConfigStore } from "./project-config.service.ts";
import type { ProjectEnvironment } from "./project.ts";
import { PROJECT_CONFIG_SCHEMA_URL } from "./schema-metadata.ts";
function runConfigProgram<A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Effect.Effect<A, E, FileSystem.FileSystem | Path.Path> {
  return effect.pipe(Effect.provide(BunServices.layer));
}
const live = <A, E>(
  name: string,
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) => it.effect(name, () => effect.pipe(Effect.provide(BunServices.layer)));
const decodeProjectConfig = Schema.decodeUnknownSync(ProjectConfigSchema);
const sampleConfig = decodeProjectConfig({
  project_id: "ref_123",
  db: {
    pooler: {
      enabled: true,
    },
  },
});
function injectedProjectEnv(values: Readonly<Record<string, string>>): ProjectEnvironment {
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
describe("config io", () => {
  live(
    "saves JSON by default when no config exists",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      const saved = yield* runConfigProgram(
        saveProjectConfig({
          cwd,
          config: sampleConfig,
        }),
      );
      expect(saved.format).toBe("json");
      expect(saved.path).toBe(yield* runConfigProgram(configJsonPath(cwd)));
    }),
  );
  live(
    "loads strict JSON",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      const path = yield* runConfigProgram(configJsonPath(cwd));
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(path, `{"project_id":"abc123","db":{"major_version":16}}`);
      const loaded = yield* runConfigProgram(loadProjectConfigFile(path));
      expect(loaded.format).toBe("json");
      expect(loaded.config.project_id).toBe("abc123");
      expect(loaded.config.db.major_version).toBe(16);
      expect(loaded.config.api.enabled).toBe(true);
    }),
  );
  live(
    "loads top-level $schema metadata from JSON",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      const path = yield* runConfigProgram(configJsonPath(cwd));
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(path, `{"$schema":"${PROJECT_CONFIG_SCHEMA_URL}"}`);
      const loaded = yield* runConfigProgram(loadProjectConfigFile(path));
      expect(loaded.schemaRef).toBe(PROJECT_CONFIG_SCHEMA_URL);
      expect(loaded.config.db.major_version).toBe(17);
    }),
  );
  live(
    "rejects JSON comments and trailing commas",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      const path = yield* runConfigProgram(configJsonPath(cwd));
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
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
      const exit = yield* Effect.exit(
        loadProjectConfigFile(path).pipe(Effect.provide(BunServices.layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
  it("decodes legacy runtime defaults from an empty config", () => {
    const config = decodeProjectConfig({});
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
  it("requires enabled twilio fields during decode", () => {
    expect(() =>
      decodeProjectConfig({
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
  it("only validates the highest-priority enabled sms provider during decode (Go switch parity)", () => {
    // Go's `(s *sms) validate()` (`apps/cli-go/pkg/config/config.go:1348-1410`) is a boolean
    // `switch` that inspects providers in a fixed priority order (twilio, twilio_verify,
    // messagebird, textlocal, vonage) and validates ONLY the first enabled one — a later
    // enabled-but-incomplete provider is never even looked at. A complete, higher-priority
    // `twilio` block plus an incomplete, lower-priority `messagebird` block must decode fine.
    const config = decodeProjectConfig({
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
  it("rejects an incomplete sms provider when no higher-priority provider is enabled", () => {
    expect(() =>
      decodeProjectConfig({
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
  it("requires enabled smtp fields during decode", () => {
    expect(() =>
      decodeProjectConfig({
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
  it("decodes an unmodeled email template/notification name (Go map[string] parity)", () => {
    // Go's `Auth.Email.Template`/`Notification` are genuine `map[string]emailTemplate`/
    // `map[string]notification` (`apps/cli-go/pkg/config/auth.go:247-248`) — open maps with no
    // key restriction; `(e *email) validate(fsys)` (`pkg/config/config.go:1293-1313`) iterates
    // every entry regardless of name. An unrecognized key like `[auth.email.template.custom]`
    // is a legitimate config shape Go accepts, not a decode error.
    const config = decodeProjectConfig({
      auth: {
        email: {
          template: {
            custom: {
              subject: "Hi",
            },
          },
          notification: {
            custom_notice: {
              enabled: true,
              content_path: "custom.html",
            },
          },
        },
      },
    });
    expect(config.auth.email.template["custom"]?.subject).toBe("Hi");
    expect(config.auth.email.notification["custom_notice"]?.enabled).toBe(true);
  });
  it("requires enabled external provider credentials during decode", () => {
    expect(() =>
      decodeProjectConfig({
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
  it("encodes sparse JSON output", () => {
    const content = encodeProjectConfigToJson(sampleConfig);
    expect(content).toContain('"project_id": "ref_123"');
    expect(content).toContain('"pooler"');
    expect(content).toContain('"enabled": true');
    expect(content).not.toContain('"major_version"');
    expect(content).not.toContain('"versions"');
  });
  it("encodes minimal empty configs", () => {
    const config = decodeProjectConfig({});
    expect(encodeProjectConfigToJson(config)).toBe("{}\n");
    expect(encodeProjectConfigToToml(config).trim()).toBe("");
  });
  live(
    "preserves hosted $schema when saving JSON",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      const saved = yield* runConfigProgram(
        saveProjectConfig({
          cwd,
          config: decodeProjectConfig({}),
          schemaRef: PROJECT_CONFIG_SCHEMA_URL,
        }),
      );
      expect(saved.schemaRef).toBe(PROJECT_CONFIG_SCHEMA_URL);
      const content = yield* fileSystem.readFileString(saved.path);
      expect(content).toContain(`"$schema": "${PROJECT_CONFIG_SCHEMA_URL}"`);
      const loaded = yield* runConfigProgram(loadProjectConfig(cwd));
      expect(loaded?.schemaRef).toBe(PROJECT_CONFIG_SCHEMA_URL);
    }),
  );
  live(
    "preserves local $schema when saving JSON over an existing config",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      const schemaRef = "./node_modules/@supabase/config/schema.json";
      yield* runConfigProgram(
        saveProjectConfig({
          cwd,
          config: decodeProjectConfig({}),
          schemaRef,
        }),
      );
      const saved = yield* runConfigProgram(
        saveProjectConfig({
          cwd,
          config: sampleConfig,
        }),
      );
      expect(saved.schemaRef).toBe(schemaRef);
      const content = yield* fileSystem.readFileString(saved.path);
      expect(content).toContain(`"$schema": "${schemaRef}"`);
    }),
  );
  live(
    "preserves $schema when saving TOML",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      const schemaRef = "./node_modules/@supabase/config/schema.json";
      const saved = yield* runConfigProgram(
        saveProjectConfig({
          cwd,
          config: decodeProjectConfig({}),
          format: "toml",
          schemaRef,
        }),
      );
      expect(saved.schemaRef).toBe(schemaRef);
      const content = yield* fileSystem.readFileString(saved.path);
      expect(content).toContain(`"$schema" = "${schemaRef}"`);
      const loaded = yield* runConfigProgram(loadProjectConfig(cwd));
      expect(loaded?.schemaRef).toBe(schemaRef);
    }),
  );
  live(
    "prefers JSON over TOML when both exist",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      const jsonPath = yield* runConfigProgram(configJsonPath(cwd));
      const tomlPath = yield* runConfigProgram(configTomlPath(cwd));
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(jsonPath, encodeProjectConfigToJson(sampleConfig));
      yield* fileSystem.writeFileString(
        tomlPath,
        `project_id = "toml-ref"

[db]
major_version = 16
`,
      );
      const loaded = yield* runConfigProgram(loadProjectConfig(cwd));
      expect(loaded?.format).toBe("json");
      expect(loaded?.config.project_id).toBe("ref_123");
      expect(loaded?.ignoredPaths).toEqual([tomlPath]);
    }),
  );

  // Go's `NewPathBuilder`/`Config.Load` (`apps/cli-go/pkg/config/utils.go:
  // 43-48`) only ever resolves `supabase/config.toml` — it has no concept of a
  // JSON project config file. Go-parity callers (legacy `status`/`stop`) pass
  // `tomlOnly: true` so a stray `config.json` never wins over `config.toml`.
  live(
    "loads TOML instead of JSON when tomlOnly is set, even if JSON exists",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      const jsonPath = yield* runConfigProgram(configJsonPath(cwd));
      const tomlPath = yield* runConfigProgram(configTomlPath(cwd));
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(jsonPath, encodeProjectConfigToJson(sampleConfig));
      yield* fileSystem.writeFileString(
        tomlPath,
        `project_id = "toml-ref"

[db]
major_version = 16
`,
      );
      const loaded = yield* runConfigProgram(
        loadProjectConfig(cwd, {
          tomlOnly: true,
        }),
      );
      expect(loaded?.format).toBe("toml");
      expect(loaded?.config.project_id).toBe("toml-ref");
    }),
  );
  live(
    "returns null when tomlOnly is set and only JSON exists",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      const jsonPath = yield* runConfigProgram(configJsonPath(cwd));
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(jsonPath, encodeProjectConfigToJson(sampleConfig));
      const loaded = yield* runConfigProgram(
        loadProjectConfig(cwd, {
          tomlOnly: true,
        }),
      );
      expect(loaded).toBeNull();
    }),
  );
  live(
    "loads TOML when JSON is absent",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      const tomlPath = yield* runConfigProgram(configTomlPath(cwd));
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        tomlPath,
        `project_id = "toml-ref"

[db]
major_version = 16
`,
      );
      const loaded = yield* runConfigProgram(loadProjectConfig(cwd));
      expect(loaded?.format).toBe("toml");
      expect(loaded?.config.project_id).toBe("toml-ref");
      expect(loaded?.config.db.major_version).toBe(16);
    }),
  );
  live(
    "loads the legacy CLI fixture",
    Effect.gen(function* () {
      const pathService = yield* Path.Path;
      const legacyFixturePath = yield* pathService.fromFileUrl(
        new URL("../testdata/legacy-config.toml", import.meta.url),
      );
      const loaded = yield* runConfigProgram(loadProjectConfigFile(legacyFixturePath));
      const production = loaded.config.remotes.production;
      const staging = loaded.config.remotes.staging;
      expect(loaded.format).toBe("toml");
      expect(loaded.config.project_id).toBe("test");
      expect(loaded.config.auth.hook.send_sms.secrets).toBe("env(AUTH_SEND_SMS_SECRETS)");
      expect(loaded.config.edge_runtime.secrets?.test_key).toBe("test_value");
      expect(loaded.config.storage.analytics.buckets).toEqual({
        "my-warehouse": {},
      });
      expect(production).toBeDefined();
      expect(staging).toBeDefined();
      if (!production || !staging) {
        throw new Error("Expected legacy remotes to be loaded.");
      }
      expect(production.project_id).toBe("vpefcjyosynxeiebfscx");
      expect(production.auth.site_url).toBe("http://feature-auth-branch.com/");
      expect(staging.storage?.buckets?.images?.allowed_mime_types).toEqual(["image/png"]);
    }),
  );
  live(
    "returns null when no config file exists",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      const loaded = yield* runConfigProgram(loadProjectConfig(cwd));
      expect(loaded).toBeNull();
    }),
  );
  live(
    "does not ignore an invalid JSON config when TOML also exists",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      const jsonPath = yield* runConfigProgram(configJsonPath(cwd));
      const tomlPath = yield* runConfigProgram(configTomlPath(cwd));
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(jsonPath, `{"project_id": 123}`);
      yield* fileSystem.writeFileString(
        tomlPath,
        `project_id = "toml-ref"

[db]
major_version = 16
`,
      );
      const exit = yield* Effect.exit(loadProjectConfig(cwd));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
  live(
    "returns a typed parse error for invalid JSON",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      const jsonPath = yield* runConfigProgram(configJsonPath(cwd));
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(jsonPath, `{"project_id": 123}`);
      const exit = yield* Effect.exit(
        loadProjectConfigFile(jsonPath).pipe(Effect.provide(BunServices.layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) {
          expect(error.value._tag).toBe("ProjectConfigParseError");
          if (error.value._tag === "ProjectConfigParseError") {
            expect(error.value.path).toBe(jsonPath);
            expect(error.value.format).toBe("json");
          }
        }
      }
    }),
  );
  live(
    "redacts edge_runtime.secrets on the ProjectConfigParseError document",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      const tomlPath = yield* runConfigProgram(configTomlPath(cwd));
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      // `analytics.port` fails schema decode (expects a number), which is
      // enough to fail the whole `Schema.decodeUnknownSync` call while
      // `edge_runtime.secrets` parses fine on its own — the scenario
      // `recoverEdgeRuntimeConfig` (apps/cli's `secrets set`) exists to
      // recover from. `MY_SUPER_SECRET_VALUE` stands in for a real secret so
      // the assertion below can confirm it never appears in plaintext.
      yield* fileSystem.writeFileString(
        tomlPath,
        `[analytics]
port = "not-a-number"

[edge_runtime.secrets]
FOO = "MY_SUPER_SECRET_VALUE"
`,
      );
      const exit = yield* Effect.exit(
        loadProjectConfigFile(tomlPath).pipe(Effect.provide(BunServices.layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) {
        return;
      }
      const error = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(error)).toBe(true);
      if (!Option.isSome(error) || error.value._tag !== "ProjectConfigParseError") {
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
      // The whole point: a caller that doesn't know to unwrap `Redacted`
      // (e.g. an uncaught error serialized into a log) never sees the raw
      // secret, even via JSON.stringify.
      const encodedDocument = yield* Schema.encodeUnknownEffect(
        Schema.fromJsonString(Schema.Unknown),
      )(error.value.document);
      expect(encodedDocument).not.toContain("MY_SUPER_SECRET_VALUE");
    }),
  );
  live(
    "redacts a non-string edge_runtime.secrets value on the ProjectConfigParseError document",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      const tomlPath = yield* runConfigProgram(configTomlPath(cwd));
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      // `FOO` is a TOML array, not a string — the schema decode for this
      // entry fails, but the raw pre-decode value still carries
      // `MY_SUPER_SECRET_VALUE` in plaintext. `redactEdgeRuntimeSecrets` must
      // wrap the entry regardless of its shape, not just string entries.
      yield* fileSystem.writeFileString(
        tomlPath,
        `[analytics]
port = "not-a-number"

[edge_runtime.secrets]
FOO = ["MY_SUPER_SECRET_VALUE"]
`,
      );
      const exit = yield* Effect.exit(
        loadProjectConfigFile(tomlPath).pipe(Effect.provide(BunServices.layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) {
        return;
      }
      const error = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(error)).toBe(true);
      if (!Option.isSome(error) || error.value._tag !== "ProjectConfigParseError") {
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
      expect(Redacted.value(foo as Redacted.Redacted<unknown>)).toEqual(["MY_SUPER_SECRET_VALUE"]);
      const encodedDocument = yield* Schema.encodeUnknownEffect(
        Schema.fromJsonString(Schema.Unknown),
      )(error.value.document);
      expect(encodedDocument).not.toContain("MY_SUPER_SECRET_VALUE");
    }),
  );
  live(
    "redacts a non-object edge_runtime.secrets field on the ProjectConfigParseError document",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      const tomlPath = yield* runConfigProgram(configTomlPath(cwd));
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      // `secrets` itself is a TOML array here, not a table — the whole field
      // is malformed rather than a single entry inside it. `isObject` rejects
      // arrays, so `redactEdgeRuntimeSecrets` must wrap the field as one unit
      // instead of falling through its early-return and leaving it raw.
      yield* fileSystem.writeFileString(
        tomlPath,
        `[analytics]
port = "not-a-number"

[edge_runtime]
secrets = ["MY_SUPER_SECRET_VALUE"]
`,
      );
      const exit = yield* Effect.exit(
        loadProjectConfigFile(tomlPath).pipe(Effect.provide(BunServices.layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) {
        return;
      }
      const error = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(error)).toBe(true);
      if (!Option.isSome(error) || error.value._tag !== "ProjectConfigParseError") {
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
      const encodedDocument = yield* Schema.encodeUnknownEffect(
        Schema.fromJsonString(Schema.Unknown),
      )(error.value.document);
      expect(encodedDocument).not.toContain("MY_SUPER_SECRET_VALUE");
    }),
  );
  live(
    "preserves TOML as the active format on save",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      const tomlPath = yield* runConfigProgram(configTomlPath(cwd));
      const jsonPath = yield* runConfigProgram(configJsonPath(cwd));
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        tomlPath,
        `project_id = "old-ref"

[db]
major_version = 16
`,
      );
      const saved = yield* runConfigProgram(
        saveProjectConfig({
          cwd,
          config: sampleConfig,
        }),
      );
      expect(saved.format).toBe("toml");
      expect(saved.path).toBe(tomlPath);
      expect(yield* fileSystem.exists(jsonPath)).toBe(false);
      const content = yield* fileSystem.readFileString(tomlPath);
      expect(content).toContain('project_id = "ref_123"');
      expect(content).toContain("[db.pooler]");
      expect(content).not.toContain("major_version");
    }),
  );
  live(
    "preserves JSON as the active format on save",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      const jsonPath = yield* runConfigProgram(configJsonPath(cwd));
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(jsonPath, encodeProjectConfigToJson(sampleConfig));
      const saved = yield* runConfigProgram(
        saveProjectConfig({
          cwd,
          config: decodeProjectConfig({
            project_id: "updated-ref",
            auth: {
              enable_signup: false,
            },
          }),
        }),
      );
      expect(saved.format).toBe("json");
      expect(saved.path).toBe(jsonPath);
      const content = yield* fileSystem.readFileString(jsonPath);
      expect(content).toContain('"project_id": "updated-ref"');
      expect(content).toContain('"enable_signup": false');
      expect(content).not.toContain('"jwt_expiry"');
    }),
  );
  live(
    "supports explicit format override",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      const tomlPath = yield* runConfigProgram(configTomlPath(cwd));
      const jsonPath = yield* runConfigProgram(configJsonPath(cwd));
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(jsonPath, encodeProjectConfigToJson(sampleConfig));
      const saved = yield* runConfigProgram(
        saveProjectConfig({
          cwd,
          config: sampleConfig,
          format: "toml",
        }),
      );
      expect(saved.format).toBe("toml");
      expect(saved.path).toBe(tomlPath);
      expect(yield* fileSystem.exists(jsonPath)).toBe(false);
      const content = yield* fileSystem.readFileString(tomlPath);
      expect(content).toContain("[db.pooler]");
      expect(content).not.toContain("[versions]");
    }),
  );
  live(
    "removes TOML when explicitly switching to JSON",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      const jsonPath = yield* runConfigProgram(configJsonPath(cwd));
      const tomlPath = yield* runConfigProgram(configTomlPath(cwd));
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(tomlPath, encodeProjectConfigToToml(sampleConfig));
      const saved = yield* runConfigProgram(
        saveProjectConfig({
          cwd,
          config: sampleConfig,
          format: "json",
        }),
      );
      expect(saved.format).toBe("json");
      expect(saved.path).toBe(jsonPath);
      expect(yield* fileSystem.exists(tomlPath)).toBe(false);
    }),
  );
  live(
    "preserves the discovered project format when saving from a nested cwd",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      const nestedCwd = pathService.join(cwd, "apps", "web", "src");
      const tomlPath = yield* runConfigProgram(configTomlPath(cwd));
      const jsonPath = yield* runConfigProgram(configJsonPath(cwd));
      yield* fileSystem.makeDirectory(nestedCwd, {
        recursive: true,
      });
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        tomlPath,
        `project_id = "nested-ref"

[db]
major_version = 16
`,
      );
      const saved = yield* runConfigProgram(
        saveProjectConfig({
          cwd: nestedCwd,
          config: decodeProjectConfig({
            project_id: "nested-updated",
          }),
        }),
      );
      expect(saved.format).toBe("toml");
      expect(saved.path).toBe(tomlPath);
      expect(yield* fileSystem.exists(jsonPath)).toBe(false);
      const content = yield* fileSystem.readFileString(tomlPath);
      expect(content).toContain('project_id = "nested-updated"');
    }),
  );
  live(
    "exposes a ProjectConfigStore service for the CLI",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      const layer = projectConfigStoreLayer.pipe(Layer.provide(BunServices.layer));
      const loaded = yield* Effect.gen(function* () {
        const store = yield* ProjectConfigStore;
        yield* store.save({
          cwd,
          config: sampleConfig,
        });
        return yield* store.load(cwd);
      }).pipe(Effect.provide(layer));
      expect(loaded?.config.project_id).toBe("ref_123");
      expect(loaded?.config.db.pooler.enabled).toBe(true);
    }),
  );
  it("encodes sparse TOML for fresh output", () => {
    const content = encodeProjectConfigToToml(sampleConfig);
    expect(content).toContain('project_id = "ref_123"');
    expect(content).toContain("[db.pooler]");
    expect(content).not.toContain("major_version");
    expect(content).not.toContain("[versions]");
  });
  live(
    "supports the Bun edge entrypoint",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      yield* runConfigProgram(
        saveProjectConfig({
          cwd,
          config: sampleConfig,
        }),
      );
      const loaded = yield* Effect.promise(() => loadProjectConfigFromBun(cwd));
      expect(loaded?.config.project_id).toBe("ref_123");
      expect(loaded?.config.db.pooler.enabled).toBe(true);
    }),
  );
  live(
    "supports the Node edge entrypoint",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      yield* runConfigProgram(
        saveProjectConfig({
          cwd,
          config: sampleConfig,
        }),
      );
      const loaded = yield* Effect.promise(() => loadProjectConfigFromNode(cwd));
      expect(loaded?.config.project_id).toBe("ref_123");
      expect(loaded?.config.db.pooler.enabled).toBe(true);
    }),
  );
  live(
    "round-trip: save → load → save produces identical config and file content",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      const original = decodeProjectConfig({
        project_id: "roundtrip-ref",
        db: {
          major_version: 16,
          pooler: {
            enabled: true,
          },
        },
        auth: {
          enable_signup: false,
          site_url: "https://example.com",
        },
        analytics: {
          enabled: false,
        },
      });
      const saved1 = yield* runConfigProgram(
        saveProjectConfig({
          cwd,
          config: original,
        }),
      );
      const content1 = yield* fileSystem.readFileString(saved1.path);
      const loaded = yield* runConfigProgram(loadProjectConfig(cwd));
      expect(loaded).not.toBeNull();
      expect(loaded!.config).toEqual(original);
      const saved2 = yield* runConfigProgram(
        saveProjectConfig({
          cwd,
          config: loaded!.config,
        }),
      );
      const content2 = yield* fileSystem.readFileString(saved2.path);
      expect(content2).toBe(content1);
    }),
  );
  it("includes current keys in generated JSON schema", () => {
    const schema = toProjectConfigJsonSchema();
    const schemaString = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(schema);
    expect(schemaString).toContain("local_smtp");
    expect(schemaString).toContain("remotes");
    expect(schemaString).toContain("static_files");
    expect(schemaString).toContain("env");
    // The deprecated implementation name must not leak anywhere in the schema,
    // including descriptions (case-insensitive guard).
    expect(schemaString.toLowerCase()).not.toContain("inbucket");
    expect(schemaString).not.toContain("versions");
  });
  live(
    "resolves env() on numeric port fields (CLI-1489)",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        pathService.join(cwd, "supabase", "config.toml"),
        `project_id = "ref_123"

[api]
port = "env(SUPABASE_API_PORT)"

[db]
port = "env(SUPABASE_DB_PORT)"

[analytics]
port = "env(SUPABASE_ANALYTICS_PORT)"
`,
      );
      yield* fileSystem.writeFileString(
        pathService.join(cwd, "supabase", ".env"),
        "SUPABASE_API_PORT=54321\nSUPABASE_DB_PORT=54322\nSUPABASE_ANALYTICS_PORT=54327\n",
      );
      const loaded = yield* runConfigProgram(loadProjectConfig(cwd));
      expect(loaded).not.toBeNull();
      expect(loaded!.config.api.port).toBe(54321);
      expect(loaded!.config.db.port).toBe(54322);
      expect(loaded!.config.analytics.port).toBe(54327);
    }),
  );
  live(
    "resolves env() on boolean fields",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        pathService.join(cwd, "supabase", "config.toml"),
        `project_id = "ref_123"

[analytics]
enabled = "env(SUPABASE_ANALYTICS_ENABLED)"
`,
      );
      yield* fileSystem.writeFileString(
        pathService.join(cwd, "supabase", ".env"),
        "SUPABASE_ANALYTICS_ENABLED=false\n",
      );
      const loaded = yield* runConfigProgram(loadProjectConfig(cwd));
      expect(loaded!.config.analytics.enabled).toBe(false);
    }),
  );
  it.effect.each([
    ["1", true],
    ["TRUE", true],
    ["T", true],
    ["True", true],
    ["0", false],
    ["f", false],
    ["FALSE", false],
  ] as const)(
    "resolves env() on boolean fields using Go's strconv.ParseBool acceptance set (%s -> %s)",
    ([envValue, expected]) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "supabase-config-",
        });
        yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          pathService.join(cwd, "supabase", "config.toml"),
          `project_id = "ref_123"

[analytics]
enabled = "env(SUPABASE_ANALYTICS_ENABLED)"
`,
        );
        yield* fileSystem.writeFileString(
          pathService.join(cwd, "supabase", ".env"),
          `SUPABASE_ANALYTICS_ENABLED=${String(envValue)}\n`,
        );
        const loaded = yield* runConfigProgram(loadProjectConfig(cwd));
        expect(loaded!.config.analytics.enabled).toBe(expected);
      }).pipe(Effect.provide(BunServices.layer)),
  );
  live(
    "splits a comma-separated string literal into a slice (Go's StringToSliceHookFunc)",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      // Go's `newDecodeHook` (`apps/cli-go/pkg/config/config.go:775-784`) wires
      // `mapstructure.StringToSliceHookFunc(",")` unconditionally, so a plain
      // string value for a `[]string` field like `additional_redirect_urls`
      // decodes fine in Go — not just via `env(...)`.
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        pathService.join(cwd, "supabase", "config.toml"),
        `project_id = "ref_123"

[auth]
additional_redirect_urls = "http://a,http://b"
`,
      );
      const loaded = yield* runConfigProgram(
        loadProjectConfig(cwd, {
          goViperCompat: true,
        }),
      );
      expect(loaded!.config.auth.additional_redirect_urls).toEqual(["http://a", "http://b"]);
    }),
  );
  live(
    "splits an env()-substituted comma-separated string into a slice",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        pathService.join(cwd, "supabase", "config.toml"),
        `project_id = "ref_123"

[auth]
additional_redirect_urls = "env(SUPABASE_REDIRECT_URLS)"
`,
      );
      yield* fileSystem.writeFileString(
        pathService.join(cwd, "supabase", ".env"),
        "SUPABASE_REDIRECT_URLS=http://a,http://b\n",
      );
      const loaded = yield* runConfigProgram(
        loadProjectConfig(cwd, {
          goViperCompat: true,
        }),
      );
      expect(loaded!.config.auth.additional_redirect_urls).toEqual(["http://a", "http://b"]);
    }),
  );
  live(
    "an empty string literal for a slice field decodes to an empty array",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        pathService.join(cwd, "supabase", "config.toml"),
        `project_id = "ref_123"

[auth]
additional_redirect_urls = ""
`,
      );
      const loaded = yield* runConfigProgram(
        loadProjectConfig(cwd, {
          goViperCompat: true,
        }),
      );
      expect(loaded!.config.auth.additional_redirect_urls).toEqual([]);
    }),
  );
  live(
    "an actual array value for a slice field is left untouched",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        pathService.join(cwd, "supabase", "config.toml"),
        `project_id = "ref_123"

[auth]
additional_redirect_urls = ["http://a", "http://b"]
`,
      );
      const loaded = yield* runConfigProgram(loadProjectConfig(cwd));
      expect(loaded!.config.auth.additional_redirect_urls).toEqual(["http://a", "http://b"]);
    }),
  );
  live(
    "preserves env() literals on string fields when the var is unset (Go parity)",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        pathService.join(cwd, "supabase", "config.toml"),
        `project_id = "ref_123"

[auth]
jwt_secret = "env(MISSING_SECRET)"
`,
      );
      const loaded = yield* runConfigProgram(loadProjectConfig(cwd));
      expect(loaded!.config.auth.jwt_secret).toBe("env(MISSING_SECRET)");
    }),
  );
  live(
    "preserves env() literals on string fields when the var is set but empty (Go parity)",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        pathService.join(cwd, "supabase", "config.toml"),
        `project_id = "ref_123"

[auth]
jwt_secret = "env(MISSING_SECRET)"
`,
      );
      yield* fileSystem.writeFileString(
        pathService.join(cwd, "supabase", ".env"),
        "MISSING_SECRET=\n",
      );
      const loaded = yield* runConfigProgram(loadProjectConfig(cwd));
      expect(loaded!.config.auth.jwt_secret).toBe("env(MISSING_SECRET)");
    }),
  );
  live(
    "fails to decode a numeric field when env var is unset",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        pathService.join(cwd, "supabase", "config.toml"),
        `project_id = "ref_123"

[analytics]
port = "env(MISSING_PORT)"
`,
      );
      const exit = yield* Effect.exit(
        loadProjectConfig(cwd).pipe(Effect.provide(BunServices.layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(
            (
              failure.value as {
                _tag: string;
              }
            )._tag,
          ).toBe("ProjectConfigParseError");
        }
      }
    }),
  );
  live(
    "falls back to ambient process.env when .env is missing",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        pathService.join(cwd, "supabase", "config.toml"),
        `project_id = "ref_123"

[db]
port = "env(SUPABASE_DB_PORT_TEST)"
`,
      );
      const loaded = yield* runConfigProgram(
        loadProjectConfig(cwd, {
          projectEnv: injectedProjectEnv({
            SUPABASE_DB_PORT_TEST: "55555",
          }),
        }),
      );
      expect(loaded!.config.db.port).toBe(55555);
    }),
  );

  // Regression coverage for the default-off (`goViperCompat` omitted) path —
  // these pin pre-PR-#5765 behavior so `next/`, `packages/stack`, and the
  // functions manifest (none of which pass `goViperCompat`) don't inherit the
  // Go-parity legacy shell's stricter/wider semantics.
  live(
    "loads successfully with a duplicate [remotes.*] project_id when goViperCompat is omitted",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        pathService.join(cwd, "supabase", "config.toml"),
        `project_id = "baseref"

[remotes.a]
project_id = "dupref"

[remotes.b]
project_id = "dupref"
`,
      );
      const loaded = yield* runConfigProgram(loadProjectConfig(cwd));
      expect(loaded).not.toBeNull();
      expect(loaded!.config.project_id).toBe("baseref");
    }),
  );
  live(
    "loads successfully with an invalid [remotes.*] project_id format when goViperCompat is omitted",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        pathService.join(cwd, "supabase", "config.toml"),
        `project_id = "baseref"

[remotes.bad]
project_id = "not-a-ref"
`,
      );
      const loaded = yield* runConfigProgram(loadProjectConfig(cwd));
      expect(loaded).not.toBeNull();
      expect(loaded!.config.project_id).toBe("baseref");
    }),
  );
  live(
    "does not split a comma-separated string literal for an array field when goViperCompat is omitted",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        pathService.join(cwd, "supabase", "config.toml"),
        `project_id = "ref_123"

[auth]
additional_redirect_urls = "http://a,http://b"
`,
      );
      const exit = yield* Effect.exit(
        loadProjectConfig(cwd).pipe(Effect.provide(BunServices.layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) {
          expect(
            (
              error.value as {
                _tag: string;
              }
            )._tag,
          ).toBe("ProjectConfigParseError");
        }
      }
    }),
  );
  live(
    "does not warn on a deprecated provider (but still strips it) when goViperCompat is omitted",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      const warnings: Array<string> = [];
      vi.spyOn(console, "error").mockImplementation((...args) => {
        warnings.push(args.map((a) => String(a)).join(" "));
      });
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        pathService.join(cwd, "supabase", "config.toml"),
        `project_id = "abc123"

[auth.external.slack]
enabled = true
`,
      );
      const loaded = yield* runConfigProgram(loadProjectConfig(cwd));
      expect("slack" in loaded!.config.auth.external).toBe(false);
      expect(warnings.some((m) => m.includes("is deprecated"))).toBe(false);
      vi.restoreAllMocks();
    }),
  );
  live(
    "does not resolve a lowercase-named env() reference when goViperCompat is omitted",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        pathService.join(cwd, "supabase", "config.toml"),
        `project_id = "env(lowercase_ref_default_off_test)"\n`,
      );
      const loaded = yield* runConfigProgram(
        loadProjectConfig(cwd, {
          projectEnv: injectedProjectEnv({
            lowercase_ref_default_off_test: "lowercase-ref-value",
          }),
        }),
      );
      expect(loaded!.config.project_id).toBe("env(lowercase_ref_default_off_test)");
    }),
  );
  live(
    "resolves a lowercase-named env() reference when goViperCompat is true",
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        pathService.join(cwd, "supabase", "config.toml"),
        `project_id = "env(lowercase_ref_default_on_test)"\n`,
      );
      const loaded = yield* runConfigProgram(
        loadProjectConfig(cwd, {
          goViperCompat: true,
          projectEnv: injectedProjectEnv({
            lowercase_ref_default_on_test: "lowercase-ref-value",
          }),
        }),
      );
      expect(loaded!.config.project_id).toBe("lowercase-ref-value");
    }),
  );
});
describe("config io [remotes.*] merge", () => {
  function writeTomlProject(
    toml: string,
  ): Effect.Effect<
    string,
    PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path | Scope.Scope
  > {
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(pathService.join(cwd, "supabase", "config.toml"), toml);
      return cwd;
    });
  }

  // Remote `project_id`s below are valid 20-lowercase-letter refs (Go's
  // `refPattern`, `config.go:558`) — `Config.Validate` rejects every
  // `[remotes.*].project_id` against that pattern unconditionally on every
  // config load (`config.go:996-1001`), so test fixtures must satisfy it too,
  // even for scenarios that don't care about the ref's specific value.
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
  function originAt(loaded: LoadedProjectConfig | null | undefined, path: ReadonlyArray<string>) {
    return loaded === null || loaded === undefined
      ? undefined
      : projectConfigValueSourceAt(loaded, path);
  }
  live(
    "tracks the source of effective local, remote, and environment values",
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
      const loaded = yield* runConfigProgram(loadProjectConfig(localCwd));
      const envLoaded = yield* runConfigProgram(
        loadProjectConfig(envCwd, {
          projectEnv: injectedProjectEnv({
            API_PORT: "6001",
          }),
        }),
      );
      const remoteLoaded = yield* runConfigProgram(
        loadProjectConfig(remoteCwd, {
          projectRef: PREVIEW_REF,
        }),
      );
      const remoteEnvLoaded = yield* runConfigProgram(
        loadProjectConfig(remoteEnvCwd, {
          projectRef: PREVIEW_REF,
          projectEnv: injectedProjectEnv({
            REMOTE_DB_PORT: "6003",
          }),
        }),
      );
      const omittedLoaded = yield* runConfigProgram(loadProjectConfig(omittedCwd));
      expect(originAt(loaded, ["api", "port"])).toBe("local");
      expect(originAt(envLoaded, ["api", "port"])).toBe("environment");
      expect(originAt(remoteLoaded, ["db", "port"])).toBe("remote");
      expect(originAt(remoteEnvLoaded, ["db", "port"])).toBe("environment");
      expect(originAt(omittedLoaded, ["studio", "port"])).toBeUndefined();
    }),
  );
  live(
    "tracks environment origins for local and selected-remote array leaves",
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
      const localArrayLoaded = yield* runConfigProgram(
        loadProjectConfig(localArrayCwd, {
          projectEnv: injectedProjectEnv({
            LOCAL_SCHEMA: "local_schema",
          }),
        }),
      );
      const remoteArrayLoaded = yield* runConfigProgram(
        loadProjectConfig(remoteArrayCwd, {
          projectRef: PREVIEW_REF,
          projectEnv: injectedProjectEnv({
            REMOTE_SCHEMA: "remote_schema",
          }),
        }),
      );
      expect(originAt(localArrayLoaded, ["api", "schemas"])).toBe("environment");
      expect(originAt(remoteArrayLoaded, ["api", "schemas"])).toBe("environment");
    }),
  );
  live(
    "merges the matching remote subtree over the base before decode",
    Effect.gen(function* () {
      const cwd = yield* writeTomlProject(BASE_WITH_REMOTES);
      const loaded = yield* runConfigProgram(
        loadProjectConfig(cwd, {
          projectRef: PREVIEW_REF,
        }),
      );
      expect(loaded!.appliedRemote).toBe("preview");
      // remote block's project_id overrides the base
      expect(loaded!.config.project_id).toBe(PREVIEW_REF);
      // remote scalar wins
      expect(loaded!.config.api.max_rows).toBe(999);
      // array replaced wholesale (not element-merged)
      expect(loaded!.config.api.schemas).toEqual(["remote_only"]);
      // base-only sibling under the same table survives
      expect(loaded!.config.api.enabled).toBe(true);
      // a non-matching remote ([remotes.staging]) is not applied
      expect(loaded!.config.db.major_version).toBe(15);
      // remotes are stripped from the merged document before decode
      expect(loaded!.document?.remotes).toBeUndefined();
    }),
  );
  live(
    "carries appliedRemote on ProjectConfigParseError when the matched remote's decode fails",
    Effect.gen(function* () {
      // Go prints `Loading config override: [remotes.<name>]` unconditionally
      // as soon as the `project_id` match is found, *before* `mapstructure`
      // decode runs (`apps/cli-go/pkg/config/config.go:604-609`) — so the notice
      // is still owed even when the decode that follows fails. `db.major_version`
      // is an unrelated schema-decode error; the remote merge must still have
      // happened (and be reported) ahead of it.
      const cwd = yield* writeTomlProject(`${BASE_WITH_REMOTES}
[remotes.preview.db]
major_version = "not-a-number"
`);
      const exit = yield* Effect.exit(
        loadProjectConfig(cwd, {
          projectRef: PREVIEW_REF,
        }).pipe(Effect.provide(BunServices.layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) {
        return;
      }
      const error = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(error)).toBe(true);
      if (!Option.isSome(error) || error.value._tag !== "ProjectConfigParseError") {
        return;
      }
      expect(error.value.appliedRemote).toBe("preview");
    }),
  );
  live(
    "loads the base config verbatim when no remote matches",
    Effect.gen(function* () {
      const cwd = yield* writeTomlProject(BASE_WITH_REMOTES);
      const loaded = yield* runConfigProgram(
        loadProjectConfig(cwd, {
          projectRef: "unknownref",
        }),
      );
      expect(loaded!.appliedRemote).toBeUndefined();
      expect(loaded!.config.project_id).toBe("baseref");
      expect(loaded!.config.api.max_rows).toBe(123);
      expect(loaded!.config.api.schemas).toEqual(["public", "custom_base"]);
    }),
  );
  live(
    "does not merge remotes when no projectRef is requested and none has an empty project_id",
    Effect.gen(function* () {
      // `projectRef` defaults to "" (Go's own `Config.ProjectId` default for
      // commands with no `--project-ref` flag), so this only stays unmerged
      // because neither remote's `project_id` is empty.
      const cwd = yield* writeTomlProject(BASE_WITH_REMOTES);
      const loaded = yield* runConfigProgram(loadProjectConfig(cwd));
      expect(loaded!.appliedRemote).toBeUndefined();
      expect(loaded!.config.api.max_rows).toBe(123);
      expect(Object.keys(loaded!.config.remotes)).toEqual(["preview", "staging"]);
    }),
  );
  live(
    "rejects duplicate project_id across remotes even when no projectRef is requested",
    Effect.gen(function* () {
      // Go's duplicate-project_id check (config.go:594-602) runs unconditionally
      // on every config load, inside the same loop that resolves the [remotes.*]
      // override — it is not gated on a caller actually selecting a remote.
      // status/stop (internal/utils/flags/config_path.go:11) never bind a
      // `--project-ref` flag, so they hit this check with `Config.ProjectId == ""`,
      // and it must still fail on a config-wide duplicate.
      const cwd = yield* writeTomlProject(`project_id = "baseref"

[remotes.a]
project_id = "dupref"

[remotes.b]
project_id = "dupref"
`);
      const message = yield* loadProjectConfig(cwd, {
        goViperCompat: true,
      }).pipe(
        Effect.catchTag("DuplicateRemoteProjectIdError", (error) => Effect.succeed(error.message)),
        Effect.provide(BunServices.layer),
      );
      expect(message).toBe("duplicate project_id for [remotes.b] and [remotes.a]");
    }),
  );

  // `goViperCompat` is required even though a `projectRef` is passed: the
  // duplicate/format checks in `applyRemoteOverride` are gated solely on
  // `goViperCompat`, not on whether a remote is being selected — the remote
  // match/merge itself stays unconditional, but pre-PR-#5765 callers that
  // pass a `projectRef` without opting into Go parity no longer get these
  // checks for free.
  live(
    "rejects duplicate project_id across remotes with Go's message",
    Effect.gen(function* () {
      const cwd = yield* writeTomlProject(`project_id = "baseref"

[remotes.a]
project_id = "dupref"

[remotes.b]
project_id = "dupref"
`);
      const message = yield* loadProjectConfig(cwd, {
        projectRef: "dupref",
        goViperCompat: true,
      }).pipe(
        Effect.catchTag("DuplicateRemoteProjectIdError", (error) => Effect.succeed(error.message)),
        Effect.provide(BunServices.layer),
      );
      expect(message).toBe("duplicate project_id for [remotes.b] and [remotes.a]");
    }),
  );
  live(
    "rejects duplicate project_id among remotes that do not match projectRef",
    Effect.gen(function* () {
      // Go builds the duplicate map across all [remotes.*] blocks before applying the
      // matching override, so a clash between two non-target remotes still fails even
      // though neither shares projectRef (config.go:503-518).
      const cwd = yield* writeTomlProject(`project_id = "baseref"

[remotes.target]
project_id = "previewref"

[remotes.a]
project_id = "dupref"

[remotes.b]
project_id = "dupref"
`);
      const message = yield* loadProjectConfig(cwd, {
        projectRef: "previewref",
        goViperCompat: true,
      }).pipe(
        Effect.catchTag("DuplicateRemoteProjectIdError", (error) => Effect.succeed(error.message)),
        Effect.provide(BunServices.layer),
      );
      expect(message).toBe("duplicate project_id for [remotes.b] and [remotes.a]");
    }),
  );
  live(
    "rejects two remotes that both omit project_id",
    Effect.gen(function* () {
      // A missing project_id reads as "" (Go's viper.GetString), so two remotes that
      // both omit it collide on the empty key.
      const cwd = yield* writeTomlProject(`project_id = "baseref"

[remotes.a]
[remotes.a.api]
max_rows = 1

[remotes.b]
[remotes.b.api]
max_rows = 2
`);
      const message = yield* loadProjectConfig(cwd, {
        projectRef: "previewref",
        goViperCompat: true,
      }).pipe(
        Effect.catchTag("DuplicateRemoteProjectIdError", (error) => Effect.succeed(error.message)),
        Effect.provide(BunServices.layer),
      );
      expect(message).toBe("duplicate project_id for [remotes.b] and [remotes.a]");
    }),
  );
  live(
    "rejects a remote project_id that is not a valid 20-letter ref, even with no projectRef requested",
    Effect.gen(function* () {
      // Go's Config.Validate (config.go:996-1001) checks every [remotes.*].project_id
      // against refPattern unconditionally on every config load — not only the one
      // that ends up selected — so this must fail closed before status/stop reach
      // Docker, exactly like Go, even when the caller never selects a remote.
      const cwd = yield* writeTomlProject(`project_id = "baseref"

[remotes.bad]
project_id = "not-a-ref"
`);
      const message = yield* loadProjectConfig(cwd, {
        goViperCompat: true,
      }).pipe(
        Effect.catchTag("InvalidRemoteProjectIdError", (error) => Effect.succeed(error.message)),
        Effect.provide(BunServices.layer),
      );
      expect(message).toBe(
        "Invalid config for remotes.bad.project_id. Must be like: abcdefghijklmnopqrst",
      );
    }),
  );
  live(
    "the merged document carries pointer sections introduced by the remote",
    Effect.gen(function* () {
      const cwd = yield* writeTomlProject(`project_id = "baseref"

[remotes.preview]
project_id = "${PREVIEW_REF}"
[remotes.preview.db.ssl_enforcement]
enabled = true
`);
      const loaded = yield* runConfigProgram(
        loadProjectConfig(cwd, {
          projectRef: PREVIEW_REF,
        }),
      );
      // `legacyPresenceIn` reads `document` to detect optional pointer sections;
      // a remote-introduced `db.ssl_enforcement` must be present there.
      const db = loaded!.document?.db;
      expect(typeof db === "object" && db !== null && "ssl_enforcement" in db).toBe(true);
    }),
  );
  live(
    "forces db.seed.enabled false when the matching remote omits it",
    Effect.gen(function* () {
      const cwd = yield* writeTomlProject(`project_id = "baseref"

[db.seed]
enabled = true

[remotes.preview]
project_id = "${PREVIEW_REF}"
[remotes.preview.api]
max_rows = 5
`);
      const loaded = yield* runConfigProgram(
        loadProjectConfig(cwd, {
          projectRef: PREVIEW_REF,
        }),
      );
      expect(loaded!.config.db.seed.enabled).toBe(false);
    }),
  );
  live(
    "preserves db.seed.enabled when the matching remote sets it",
    Effect.gen(function* () {
      const cwd = yield* writeTomlProject(`project_id = "baseref"

[remotes.preview]
project_id = "${PREVIEW_REF}"
[remotes.preview.db.seed]
enabled = true
`);
      const loaded = yield* runConfigProgram(
        loadProjectConfig(cwd, {
          projectRef: PREVIEW_REF,
        }),
      );
      expect(loaded!.config.db.seed.enabled).toBe(true);
    }),
  );
  live(
    "resolves env() on a lowercase-named variable, matching Go's case-agnostic matcher",
    Effect.gen(function* () {
      // Go's `LoadEnvHook` (`apps/cli-go/pkg/config/decode_hooks.go:11`) is
      // `^env\((.*)\)$` — it doesn't restrict the captured name's case, so
      // `project_id = "env(project_id)"` resolves against a same-case env var
      // in the Go CLI. This isn't specific to `project_id`; any string field
      // goes through the same pre-decode walk. This case-agnostic matching is
      // itself one of the four Go-viper-parity behaviors gated by
      // `goViperCompat` — without it, the strict SCREAMING_SNAKE_CASE matcher
      // wouldn't match this lowercase name at all.
      const cwd = yield* writeTomlProject(`project_id = "env(project_id)"\n`);
      const loaded = yield* runConfigProgram(
        loadProjectConfig(cwd, {
          goViperCompat: true,
          projectEnv: injectedProjectEnv({
            project_id: "lowercase-ref",
          }),
        }),
      );
      expect(loaded!.config.project_id).toBe("lowercase-ref");
    }),
  );
  live(
    "does not match a remote whose project_id is env(REF) against the resolved ref (Go parity)",
    Effect.gen(function* () {
      // Go's `loadFromFile` duplicate-check/selection loop reads viper's RAW
      // string values (`config.go:596-610`) and only calls `c.load(v)` — which
      // resolves `env(...)` via `LoadEnvHook` — afterward (`config.go:611`,
      // `decode_hooks.go:13-26`). So a `[remotes.x] project_id = "env(REF)"`
      // never matches a caller-supplied, already-resolved `REF`: Go compares the
      // literal `env(REF)` string, not what it resolves to.
      const cwd = yield* writeTomlProject(`project_id = "baseref"

[api]
max_rows = 1

[remotes.preview]
project_id = "env(SUPABASE_REMOTE_ENV_REF_TEST)"
[remotes.preview.api]
max_rows = 999
`);
      const loaded = yield* runConfigProgram(
        loadProjectConfig(cwd, {
          projectRef: PREVIEW_REF,
          projectEnv: injectedProjectEnv({
            SUPABASE_REMOTE_ENV_REF_TEST: PREVIEW_REF,
          }),
        }),
      );
      expect(loaded!.appliedRemote).toBeUndefined();
      expect(loaded!.config.api.max_rows).toBe(1);
    }),
  );
  live(
    "validates a remote's env(REF) project_id format against its resolved value, not the literal",
    Effect.gen(function* () {
      // Go's `Config.Validate` (`config.go:989-1001`) runs entirely after the
      // struct decode, by which point `LoadEnvHook` has already resolved
      // `env(...)` — so it validates the RESOLVED project_id against the
      // 20-lowercase-letter pattern, not the literal `env(REF)` string (which
      // would never match the pattern itself).
      const cwd = yield* writeTomlProject(`project_id = "baseref"

[remotes.preview]
project_id = "env(SUPABASE_REMOTE_ENV_REF_FORMAT_TEST)"
`);
      const loaded = yield* runConfigProgram(
        loadProjectConfig(cwd, {
          projectEnv: injectedProjectEnv({
            SUPABASE_REMOTE_ENV_REF_FORMAT_TEST: PREVIEW_REF,
          }),
        }),
      );
      expect(loaded!.appliedRemote).toBeUndefined();
      expect(loaded!.config.project_id).toBe("baseref");
    }),
  );
  live(
    "resolves env() references inside the matching remote before merge",
    Effect.gen(function* () {
      const cwd = yield* writeTomlProject(`project_id = "baseref"

[api]
max_rows = 1

[remotes.preview]
project_id = "${PREVIEW_REF}"
[remotes.preview.api]
max_rows = "env(SUPABASE_REMOTE_MAX_ROWS_TEST)"
`);
      const loaded = yield* runConfigProgram(
        loadProjectConfig(cwd, {
          projectRef: PREVIEW_REF,
          projectEnv: injectedProjectEnv({
            SUPABASE_REMOTE_MAX_ROWS_TEST: "777",
          }),
        }),
      );
      expect(loaded!.config.api.max_rows).toBe(777);
    }),
  );

  // Go's `Config.Validate` only checks `remotes.*.project_id` format for
  // every remote (`config.go:996-1001`, "Since remote config is merged to
  // base, we only need to validate the project_id field") — every other
  // business-rule check (`Auth.External.validate()`, etc.) runs exactly once,
  // against the merged effective config (`config.go:1136-1152`), never
  // iterated over `c.Remotes[*]`. A non-selected `[remotes.*]` block's own
  // business-rule violations must not fail the whole config load.
  live(
    "loads an unselected remote whose external provider is enabled without a secret",
    Effect.gen(function* () {
      const cwd = yield* writeTomlProject(`project_id = "baseref"

[remotes.staging]
project_id = "${STAGING_REF}"

[remotes.staging.auth.external.github]
enabled = true
`);
      // No projectRef requested, so [remotes.staging] is never selected/merged —
      // Go would never business-rule-validate it, even though it decodes fine
      // structurally.
      const loaded = yield* runConfigProgram(loadProjectConfig(cwd));
      expect(loaded!.appliedRemote).toBeUndefined();
      expect(loaded!.config.remotes.staging?.auth.external.github.enabled).toBe(true);
    }),
  );
  live(
    "still validates the same remote's external provider once it is selected",
    Effect.gen(function* () {
      const cwd = yield* writeTomlProject(`project_id = "baseref"

[remotes.staging]
project_id = "${STAGING_REF}"

[remotes.staging.auth.external.github]
enabled = true
`);
      // Selecting [remotes.staging] merges it into the effective config, which
      // Go DOES business-rule-validate (config.go:1136-1152) — a required
      // `client_id`/`secret` is missing, so this must still fail.
      const exit = yield* Effect.exit(
        loadProjectConfig(cwd, {
          projectRef: STAGING_REF,
        }).pipe(Effect.provide(BunServices.layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
  live(
    "still fails on a structurally malformed value inside an unselected remote",
    Effect.gen(function* () {
      // Go's `UnmarshalExact` always structurally decodes every remote
      // (`config.go:246,749-756`) regardless of selection — only the
      // merged-config-only business rules are skipped for a non-selected
      // remote, not type/shape decoding.
      const cwd = yield* writeTomlProject(`${BASE_WITH_REMOTES}
[remotes.staging.db]
major_version = "not-a-number"
`);
      const exit = yield* Effect.exit(
        loadProjectConfig(cwd).pipe(Effect.provide(BunServices.layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});
describe("config io deprecated [inbucket] back-compat", () => {
  let warnings: Array<string> = [];
  let errorSpy:
    | {
        mockRestore: () => void;
      }
    | undefined;
  function captureWarnings() {
    warnings = [];
    // loadProjectConfigFile emits the deprecation warning via Console.error, whose
    // default implementation delegates to globalThis.console.error (stderr).
    errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    });
  }
  afterEach(() => {
    errorSpy?.mockRestore();
    errorSpy = undefined;
  });
  function loadToml(contents: string) {
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      const configPath = yield* runConfigProgram(configTomlPath(cwd));
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(configPath, contents);
      return yield* runConfigProgram(loadProjectConfigFile(configPath));
    });
  }
  live(
    "loads a deprecated [inbucket] section as [local_smtp]",
    Effect.gen(function* () {
      captureWarnings();
      const loaded = yield* loadToml(`project_id = "abc123"

[inbucket]
enabled = true
port = 12345
`);
      expect(loaded.config.local_smtp.enabled).toBe(true);
      expect(loaded.config.local_smtp.port).toBe(12345);
      expect("inbucket" in loaded.config).toBe(false);
      expect(loaded.document).not.toHaveProperty("inbucket");
      expect(loaded.document).toHaveProperty("local_smtp");
      expect(
        warnings.some((m) =>
          m.includes(
            "WARN: config section [inbucket] is deprecated. Please use [local_smtp] instead.",
          ),
        ),
      ).toBe(true);
    }),
  );
  live(
    "fills schema defaults when a deprecated [inbucket] section is partial",
    Effect.gen(function* () {
      const loaded = yield* loadToml(`project_id = "abc123"

[inbucket]
port = 9999
`);

      // enabled is omitted by the user; the schema default (true) must survive the
      // inbucket -> local_smtp rewrite rather than collapsing to a zero value.
      expect(loaded.config.local_smtp.enabled).toBe(true);
      expect(loaded.config.local_smtp.port).toBe(9999);
    }),
  );
  live(
    "prefers an explicit [local_smtp] when both sections are present",
    Effect.gen(function* () {
      captureWarnings();
      const loaded = yield* loadToml(`project_id = "abc123"

[inbucket]
enabled = true
port = 11111

[local_smtp]
enabled = true
port = 22222
`);
      expect(loaded.config.local_smtp.port).toBe(22222);
      expect(loaded.document).not.toHaveProperty("inbucket");
      // The deprecation warning still fires because the deprecated key was present.
      expect(warnings.some((m) => m.includes("[inbucket] is deprecated"))).toBe(true);
    }),
  );
  live(
    "normalizes a deprecated [remotes.*.inbucket] section",
    Effect.gen(function* () {
      captureWarnings();
      const loaded = yield* loadToml(`project_id = "abc123"

[remotes.staging]
project_id = "stagingrefaaaaaaaaaa"

[remotes.staging.inbucket]
enabled = true
port = 33333
`);
      const staging = loaded.config.remotes.staging;
      expect(staging?.local_smtp?.port).toBe(33333);
      expect(staging).not.toHaveProperty("inbucket");
      expect(
        warnings.some((m) =>
          m.includes(
            "WARN: config section [remotes.staging.inbucket] is deprecated. Please use [remotes.staging.local_smtp] instead.",
          ),
        ),
      ).toBe(true);
    }),
  );
  live(
    "does not warn when only [local_smtp] is used",
    Effect.gen(function* () {
      captureWarnings();
      const loaded = yield* loadToml(`project_id = "abc123"

[local_smtp]
enabled = true
port = 54324
`);
      expect(loaded.config.local_smtp.port).toBe(54324);
      expect(warnings.some((m) => m.includes("is deprecated"))).toBe(false);
    }),
  );
});
describe("config io deprecated [auth.external.{linkedin,slack}] back-compat", () => {
  let warnings: Array<string> = [];
  let errorSpy:
    | {
        mockRestore: () => void;
      }
    | undefined;
  function captureWarnings() {
    warnings = [];
    errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    });
  }
  afterEach(() => {
    errorSpy?.mockRestore();
    errorSpy = undefined;
  });
  function loadToml(contents: string, options?: LoadProjectConfigOptions) {
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "supabase-config-",
      });
      const configPath = yield* runConfigProgram(configTomlPath(cwd));
      yield* fileSystem.makeDirectory(pathService.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(configPath, contents);
      return yield* runConfigProgram(loadProjectConfigFile(configPath, options));
    });
  }
  live(
    "loads a bare [auth.external.slack] block without required fields",
    Effect.gen(function* () {
      captureWarnings();
      const loaded = yield* loadToml(
        `project_id = "abc123"

[auth.external.slack]
enabled = true
`,
        {
          goViperCompat: true,
        },
      );
      expect("slack" in loaded.config.auth.external).toBe(false);
      expect(loaded.document).not.toHaveProperty("auth.external.slack");
      expect(
        warnings.some((m) =>
          m.includes(
            'WARN: disabling deprecated "slack" provider. Please use [auth.external.slack_oidc] instead',
          ),
        ),
      ).toBe(true);
    }),
  );
  live(
    "loads a bare [auth.external.linkedin] block without required fields",
    Effect.gen(function* () {
      captureWarnings();
      const loaded = yield* loadToml(
        `project_id = "abc123"

[auth.external.linkedin]
enabled = true
`,
        {
          goViperCompat: true,
        },
      );
      expect("linkedin" in loaded.config.auth.external).toBe(false);
      expect(
        warnings.some((m) =>
          m.includes(
            'WARN: disabling deprecated "linkedin" provider. Please use [auth.external.linkedin_oidc] instead',
          ),
        ),
      ).toBe(true);
    }),
  );
  live(
    "does not warn when the deprecated section is present but disabled",
    Effect.gen(function* () {
      captureWarnings();
      const loaded = yield* loadToml(`project_id = "abc123"

[auth.external.slack]
enabled = false
`);
      expect("slack" in loaded.config.auth.external).toBe(false);
      expect(warnings.some((m) => m.includes("is deprecated"))).toBe(false);
    }),
  );
  live(
    "does not warn when only [auth.external.slack_oidc] is used",
    Effect.gen(function* () {
      captureWarnings();
      const loaded = yield* loadToml(`project_id = "abc123"

[auth.external.slack_oidc]
enabled = true
client_id = "abc"
secret = "shh"
`);
      expect(loaded.config.auth.external.slack_oidc.enabled).toBe(true);
      expect(warnings.some((m) => m.includes("is deprecated"))).toBe(false);
    }),
  );
  live(
    "strips a deprecated [remotes.*.auth.external.slack] block without warning for an unselected remote",
    Effect.gen(function* () {
      captureWarnings();
      const loaded = yield* loadToml(`project_id = "abc123"

[remotes.staging]
project_id = "stagingrefaaaaaaaaaa"

[remotes.staging.auth.external.slack]
enabled = true
`);

      // Not requesting `projectRef` means no remote is selected, so `remotes` survives
      // decode verbatim (minus the deprecated key) rather than being merged/dropped.
      expect(loaded.config.remotes.staging?.auth.external).not.toHaveProperty("slack");
      expect(warnings.some((m) => m.includes("is deprecated"))).toBe(false);
    }),
  );
});
