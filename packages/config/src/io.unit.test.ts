import { afterEach, describe, expect, test, vi } from "vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path, Schema } from "effect";
import { ProjectConfigSchema } from "./base.ts";
import { loadProjectConfig as loadProjectConfigFromBun } from "./bun.ts";
import {
  configJsonPath,
  configTomlPath,
  encodeProjectConfigToJson,
  encodeProjectConfigToToml,
  loadProjectConfig,
  loadProjectConfigFile,
  saveProjectConfig,
} from "./io.ts";
import { loadProjectConfig as loadProjectConfigFromNode } from "./node.ts";
import { projectConfigStoreLayer } from "./project-config.layer.ts";
import { ProjectConfigStore } from "./project-config.service.ts";
import { PROJECT_CONFIG_SCHEMA_URL } from "./schema-metadata.ts";

function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), "supabase-config-"));
}

const legacyFixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../testdata/legacy-config.toml",
);

const decodeProjectConfig = Schema.decodeUnknownSync(ProjectConfigSchema);

function runConfigEffect<A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));
}

const sampleConfig = decodeProjectConfig({
  project_id: "ref_123",
  db: {
    pooler: {
      enabled: true,
    },
  },
});

describe("config io", () => {
  test("saves JSON by default when no config exists", async () => {
    const cwd = makeTempProject();

    try {
      const saved = await runConfigEffect(saveProjectConfig({ cwd, config: sampleConfig }));
      expect(saved.format).toBe("json");
      expect(saved.path).toBe(await runConfigEffect(configJsonPath(cwd)));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("loads strict JSON", async () => {
    const cwd = makeTempProject();
    const path = await runConfigEffect(configJsonPath(cwd));

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({
          project_id: "abc123",
          db: {
            major_version: 16,
          },
        }),
      );

      const loaded = await runConfigEffect(loadProjectConfigFile(path));
      expect(loaded.format).toBe("json");
      expect(loaded.config.project_id).toBe("abc123");
      expect(loaded.config.db.major_version).toBe(16);
      expect(loaded.config.api.enabled).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("loads top-level $schema metadata from JSON", async () => {
    const cwd = makeTempProject();
    const path = await runConfigEffect(configJsonPath(cwd));

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({
          $schema: PROJECT_CONFIG_SCHEMA_URL,
        }),
      );

      const loaded = await runConfigEffect(loadProjectConfigFile(path));
      expect(loaded.schemaRef).toBe(PROJECT_CONFIG_SCHEMA_URL);
      expect(loaded.config.db.major_version).toBe(17);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("rejects JSON comments and trailing commas", async () => {
    const cwd = makeTempProject();
    const path = await runConfigEffect(configJsonPath(cwd));

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(
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

      const exit = await Effect.runPromiseExit(
        loadProjectConfigFile(path).pipe(Effect.provide(BunServices.layer)),
      );

      expect(Exit.isFailure(exit)).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("decodes legacy runtime defaults from an empty config", () => {
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

  test("requires enabled twilio fields during decode", () => {
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

  test("requires enabled smtp fields during decode", () => {
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

  test("requires enabled external provider credentials during decode", () => {
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

  test("encodes sparse JSON output", () => {
    const content = encodeProjectConfigToJson(sampleConfig);

    expect(content).toContain('"project_id": "ref_123"');
    expect(content).toContain('"pooler"');
    expect(content).toContain('"enabled": true');
    expect(content).not.toContain('"major_version"');
    expect(content).not.toContain('"versions"');
  });

  test("encodes minimal empty configs", () => {
    const config = decodeProjectConfig({});

    expect(encodeProjectConfigToJson(config)).toBe("{}\n");
    expect(encodeProjectConfigToToml(config).trim()).toBe("");
  });

  test("preserves hosted $schema when saving JSON", async () => {
    const cwd = makeTempProject();

    try {
      const saved = await runConfigEffect(
        saveProjectConfig({
          cwd,
          config: decodeProjectConfig({}),
          schemaRef: PROJECT_CONFIG_SCHEMA_URL,
        }),
      );

      expect(saved.schemaRef).toBe(PROJECT_CONFIG_SCHEMA_URL);

      const content = await readFile(saved.path, "utf8");
      expect(content).toContain(`"$schema": "${PROJECT_CONFIG_SCHEMA_URL}"`);

      const loaded = await runConfigEffect(loadProjectConfig(cwd));
      expect(loaded?.schemaRef).toBe(PROJECT_CONFIG_SCHEMA_URL);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("preserves local $schema when saving JSON over an existing config", async () => {
    const cwd = makeTempProject();
    const schemaRef = "./node_modules/@supabase/config/schema.json";

    try {
      await runConfigEffect(
        saveProjectConfig({
          cwd,
          config: decodeProjectConfig({}),
          schemaRef,
        }),
      );

      const saved = await runConfigEffect(
        saveProjectConfig({
          cwd,
          config: sampleConfig,
        }),
      );

      expect(saved.schemaRef).toBe(schemaRef);

      const content = await readFile(saved.path, "utf8");
      expect(content).toContain(`"$schema": "${schemaRef}"`);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("preserves $schema when saving TOML", async () => {
    const cwd = makeTempProject();
    const schemaRef = "./node_modules/@supabase/config/schema.json";

    try {
      const saved = await runConfigEffect(
        saveProjectConfig({
          cwd,
          config: decodeProjectConfig({}),
          format: "toml",
          schemaRef,
        }),
      );

      expect(saved.schemaRef).toBe(schemaRef);

      const content = await readFile(saved.path, "utf8");
      expect(content).toContain(`"$schema" = "${schemaRef}"`);

      const loaded = await runConfigEffect(loadProjectConfig(cwd));
      expect(loaded?.schemaRef).toBe(schemaRef);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("prefers JSON over TOML when both exist", async () => {
    const cwd = makeTempProject();
    const jsonPath = await runConfigEffect(configJsonPath(cwd));
    const tomlPath = await runConfigEffect(configTomlPath(cwd));

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(jsonPath, encodeProjectConfigToJson(sampleConfig));
      await writeFile(
        tomlPath,
        `project_id = "toml-ref"

[db]
major_version = 16
`,
      );

      const loaded = await runConfigEffect(loadProjectConfig(cwd));
      expect(loaded?.format).toBe("json");
      expect(loaded?.config.project_id).toBe("ref_123");
      expect(loaded?.ignoredPaths).toEqual([tomlPath]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("loads TOML when JSON is absent", async () => {
    const cwd = makeTempProject();
    const tomlPath = await runConfigEffect(configTomlPath(cwd));

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(
        tomlPath,
        `project_id = "toml-ref"

[db]
major_version = 16
`,
      );

      const loaded = await runConfigEffect(loadProjectConfig(cwd));
      expect(loaded?.format).toBe("toml");
      expect(loaded?.config.project_id).toBe("toml-ref");
      expect(loaded?.config.db.major_version).toBe(16);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("loads the legacy CLI fixture", async () => {
    const loaded = await runConfigEffect(loadProjectConfigFile(legacyFixturePath));
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
  });

  test("returns null when no config file exists", async () => {
    const cwd = makeTempProject();

    try {
      const loaded = await runConfigEffect(loadProjectConfig(cwd));
      expect(loaded).toBeNull();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("does not ignore an invalid JSON config when TOML also exists", async () => {
    const cwd = makeTempProject();
    const jsonPath = await runConfigEffect(configJsonPath(cwd));
    const tomlPath = await runConfigEffect(configTomlPath(cwd));

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(jsonPath, `{"project_id": 123}`);
      await writeFile(
        tomlPath,
        `project_id = "toml-ref"

[db]
major_version = 16
`,
      );

      await expect(runConfigEffect(loadProjectConfig(cwd))).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("returns a typed parse error for invalid JSON", async () => {
    const cwd = makeTempProject();
    const jsonPath = await runConfigEffect(configJsonPath(cwd));

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(jsonPath, `{"project_id": 123}`);

      const exit = await Effect.runPromiseExit(
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
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("preserves TOML as the active format on save", async () => {
    const cwd = makeTempProject();
    const tomlPath = await runConfigEffect(configTomlPath(cwd));
    const jsonPath = await runConfigEffect(configJsonPath(cwd));

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(
        tomlPath,
        `project_id = "old-ref"

[db]
major_version = 16
`,
      );

      const saved = await runConfigEffect(saveProjectConfig({ cwd, config: sampleConfig }));

      expect(saved.format).toBe("toml");
      expect(saved.path).toBe(tomlPath);
      expect(await Bun.file(jsonPath).exists()).toBe(false);
      const content = await readFile(tomlPath, "utf8");
      expect(content).toContain('project_id = "ref_123"');
      expect(content).toContain("[db.pooler]");
      expect(content).not.toContain("major_version");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("preserves JSON as the active format on save", async () => {
    const cwd = makeTempProject();
    const jsonPath = await runConfigEffect(configJsonPath(cwd));

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(jsonPath, encodeProjectConfigToJson(sampleConfig));

      const saved = await runConfigEffect(
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
      const content = await readFile(jsonPath, "utf8");
      expect(content).toContain('"project_id": "updated-ref"');
      expect(content).toContain('"enable_signup": false');
      expect(content).not.toContain('"jwt_expiry"');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("supports explicit format override", async () => {
    const cwd = makeTempProject();
    const tomlPath = await runConfigEffect(configTomlPath(cwd));
    const jsonPath = await runConfigEffect(configJsonPath(cwd));

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(jsonPath, encodeProjectConfigToJson(sampleConfig));

      const saved = await runConfigEffect(
        saveProjectConfig({ cwd, config: sampleConfig, format: "toml" }),
      );

      expect(saved.format).toBe("toml");
      expect(saved.path).toBe(tomlPath);
      expect(await Bun.file(jsonPath).exists()).toBe(false);
      const content = await readFile(tomlPath, "utf8");
      expect(content).toContain("[db.pooler]");
      expect(content).not.toContain("[versions]");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("removes TOML when explicitly switching to JSON", async () => {
    const cwd = makeTempProject();
    const jsonPath = await runConfigEffect(configJsonPath(cwd));
    const tomlPath = await runConfigEffect(configTomlPath(cwd));

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(tomlPath, encodeProjectConfigToToml(sampleConfig));

      const saved = await runConfigEffect(
        saveProjectConfig({ cwd, config: sampleConfig, format: "json" }),
      );

      expect(saved.format).toBe("json");
      expect(saved.path).toBe(jsonPath);
      expect(await Bun.file(tomlPath).exists()).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("preserves the discovered project format when saving from a nested cwd", async () => {
    const cwd = makeTempProject();
    const nestedCwd = join(cwd, "apps", "web", "src");
    const tomlPath = await runConfigEffect(configTomlPath(cwd));
    const jsonPath = await runConfigEffect(configJsonPath(cwd));

    try {
      await mkdir(nestedCwd, { recursive: true });
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(
        tomlPath,
        `project_id = "nested-ref"

[db]
major_version = 16
`,
      );

      const saved = await runConfigEffect(
        saveProjectConfig({
          cwd: nestedCwd,
          config: decodeProjectConfig({
            project_id: "nested-updated",
          }),
        }),
      );

      expect(saved.format).toBe("toml");
      expect(saved.path).toBe(tomlPath);
      expect(await Bun.file(jsonPath).exists()).toBe(false);
      const content = await readFile(tomlPath, "utf8");
      expect(content).toContain('project_id = "nested-updated"');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("exposes a ProjectConfigStore service for the CLI", async () => {
    const cwd = makeTempProject();
    const layer = projectConfigStoreLayer.pipe(Layer.provide(BunServices.layer));

    try {
      const loaded = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* ProjectConfigStore;
          yield* store.save({ cwd, config: sampleConfig });
          return yield* store.load(cwd);
        }).pipe(Effect.provide(layer)),
      );

      expect(loaded?.config.project_id).toBe("ref_123");
      expect(loaded?.config.db.pooler.enabled).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("encodes sparse TOML for fresh output", () => {
    const content = encodeProjectConfigToToml(sampleConfig);
    expect(content).toContain('project_id = "ref_123"');
    expect(content).toContain("[db.pooler]");
    expect(content).not.toContain("major_version");
    expect(content).not.toContain("[versions]");
  });

  test("supports the Bun edge entrypoint", async () => {
    const cwd = makeTempProject();

    try {
      await saveProjectConfig({ cwd, config: sampleConfig }).pipe(
        Effect.provide(BunServices.layer),
        Effect.runPromise,
      );
      const loaded = await loadProjectConfigFromBun(cwd);
      expect(loaded?.config.project_id).toBe("ref_123");
      expect(loaded?.config.db.pooler.enabled).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("supports the Node edge entrypoint", async () => {
    const cwd = makeTempProject();

    try {
      await saveProjectConfig({ cwd, config: sampleConfig }).pipe(
        Effect.provide(BunServices.layer),
        Effect.runPromise,
      );
      const loaded = await loadProjectConfigFromNode(cwd);
      expect(loaded?.config.project_id).toBe("ref_123");
      expect(loaded?.config.db.pooler.enabled).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("round-trip: save → load → save produces identical config and file content", async () => {
    const cwd = makeTempProject();

    try {
      const original = decodeProjectConfig({
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

      const saved1 = await runConfigEffect(saveProjectConfig({ cwd, config: original }));
      const content1 = await readFile(saved1.path, "utf8");

      const loaded = await runConfigEffect(loadProjectConfig(cwd));
      expect(loaded).not.toBeNull();
      expect(loaded!.config).toEqual(original);

      const saved2 = await runConfigEffect(saveProjectConfig({ cwd, config: loaded!.config }));
      const content2 = await readFile(saved2.path, "utf8");

      expect(content2).toBe(content1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("includes current keys in generated JSON schema", () => {
    const document = Schema.toJsonSchemaDocument(ProjectConfigSchema).schema;
    const schemaString = JSON.stringify(document);

    expect(schemaString).toContain("local_smtp");
    expect(schemaString).toContain("remotes");
    expect(schemaString).toContain("static_files");
    expect(schemaString).toContain("env");
    // The deprecated implementation name must not leak anywhere in the schema,
    // including descriptions (case-insensitive guard).
    expect(schemaString.toLowerCase()).not.toContain("inbucket");
    expect(schemaString).not.toContain("versions");
  });

  test("resolves env() on numeric port fields (CLI-1489)", async () => {
    const cwd = makeTempProject();

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(
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
      await writeFile(
        join(cwd, "supabase", ".env"),
        "SUPABASE_API_PORT=54321\nSUPABASE_DB_PORT=54322\nSUPABASE_ANALYTICS_PORT=54327\n",
      );

      const loaded = await runConfigEffect(loadProjectConfig(cwd));

      expect(loaded).not.toBeNull();
      expect(loaded!.config.api.port).toBe(54321);
      expect(loaded!.config.db.port).toBe(54322);
      expect(loaded!.config.analytics.port).toBe(54327);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("resolves env() on boolean fields", async () => {
    const cwd = makeTempProject();

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(
        join(cwd, "supabase", "config.toml"),
        `project_id = "ref_123"

[analytics]
enabled = "env(SUPABASE_ANALYTICS_ENABLED)"
`,
      );
      await writeFile(join(cwd, "supabase", ".env"), "SUPABASE_ANALYTICS_ENABLED=false\n");

      const loaded = await runConfigEffect(loadProjectConfig(cwd));
      expect(loaded!.config.analytics.enabled).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("preserves env() literals on string fields when the var is unset (Go parity)", async () => {
    const cwd = makeTempProject();

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(
        join(cwd, "supabase", "config.toml"),
        `project_id = "ref_123"

[auth]
jwt_secret = "env(MISSING_SECRET)"
`,
      );

      const loaded = await runConfigEffect(loadProjectConfig(cwd));
      expect(loaded!.config.auth.jwt_secret).toBe("env(MISSING_SECRET)");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("fails to decode a numeric field when env var is unset", async () => {
    const cwd = makeTempProject();

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(
        join(cwd, "supabase", "config.toml"),
        `project_id = "ref_123"

[analytics]
port = "env(MISSING_PORT)"
`,
      );

      const exit = await Effect.runPromiseExit(
        loadProjectConfig(cwd).pipe(Effect.provide(BunServices.layer)),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect((failure.value as { _tag: string })._tag).toBe("ProjectConfigParseError");
        }
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("falls back to ambient process.env when .env is missing", async () => {
    const cwd = makeTempProject();
    const previous = process.env.SUPABASE_DB_PORT_TEST;
    process.env.SUPABASE_DB_PORT_TEST = "55555";

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(
        join(cwd, "supabase", "config.toml"),
        `project_id = "ref_123"

[db]
port = "env(SUPABASE_DB_PORT_TEST)"
`,
      );

      const loaded = await runConfigEffect(loadProjectConfig(cwd));
      expect(loaded!.config.db.port).toBe(55555);
    } finally {
      if (previous === undefined) {
        delete process.env.SUPABASE_DB_PORT_TEST;
      } else {
        process.env.SUPABASE_DB_PORT_TEST = previous;
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("config io [remotes.*] merge", () => {
  async function writeTomlProject(toml: string): Promise<string> {
    const cwd = makeTempProject();
    await mkdir(join(cwd, "supabase"), { recursive: true });
    await writeFile(join(cwd, "supabase", "config.toml"), toml);
    return cwd;
  }

  const BASE_WITH_REMOTES = `project_id = "baseref"

[api]
enabled = true
schemas = ["public", "custom_base"]
max_rows = 123

[db]
major_version = 15

[remotes.preview]
project_id = "previewref"
[remotes.preview.api]
schemas = ["remote_only"]
max_rows = 999

[remotes.staging]
project_id = "stagingref"
[remotes.staging.api]
enabled = false
`;

  test("merges the matching remote subtree over the base before decode", async () => {
    const cwd = await writeTomlProject(BASE_WITH_REMOTES);
    try {
      const loaded = await runConfigEffect(loadProjectConfig(cwd, { projectRef: "previewref" }));
      expect(loaded!.appliedRemote).toBe("preview");
      // remote block's project_id overrides the base
      expect(loaded!.config.project_id).toBe("previewref");
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
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("loads the base config verbatim when no remote matches", async () => {
    const cwd = await writeTomlProject(BASE_WITH_REMOTES);
    try {
      const loaded = await runConfigEffect(loadProjectConfig(cwd, { projectRef: "unknownref" }));
      expect(loaded!.appliedRemote).toBeUndefined();
      expect(loaded!.config.project_id).toBe("baseref");
      expect(loaded!.config.api.max_rows).toBe(123);
      expect(loaded!.config.api.schemas).toEqual(["public", "custom_base"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("does not merge remotes when no projectRef is requested", async () => {
    const cwd = await writeTomlProject(BASE_WITH_REMOTES);
    try {
      const loaded = await runConfigEffect(loadProjectConfig(cwd));
      expect(loaded!.appliedRemote).toBeUndefined();
      expect(loaded!.config.api.max_rows).toBe(123);
      expect(Object.keys(loaded!.config.remotes)).toEqual(["preview", "staging"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("rejects duplicate project_id across remotes with Go's message", async () => {
    const cwd = await writeTomlProject(`project_id = "baseref"

[remotes.a]
project_id = "dupref"

[remotes.b]
project_id = "dupref"
`);
    try {
      const message = await Effect.runPromise(
        loadProjectConfig(cwd, { projectRef: "dupref" }).pipe(
          Effect.catchTag("DuplicateRemoteProjectIdError", (error) =>
            Effect.succeed(error.message),
          ),
          Effect.provide(BunServices.layer),
        ),
      );
      expect(message).toBe("duplicate project_id for [remotes.b] and [remotes.a]");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("rejects duplicate project_id among remotes that do not match projectRef", async () => {
    // Go builds the duplicate map across all [remotes.*] blocks before applying the
    // matching override, so a clash between two non-target remotes still fails even
    // though neither shares projectRef (config.go:503-518).
    const cwd = await writeTomlProject(`project_id = "baseref"

[remotes.target]
project_id = "previewref"

[remotes.a]
project_id = "dupref"

[remotes.b]
project_id = "dupref"
`);
    try {
      const message = await Effect.runPromise(
        loadProjectConfig(cwd, { projectRef: "previewref" }).pipe(
          Effect.catchTag("DuplicateRemoteProjectIdError", (error) =>
            Effect.succeed(error.message),
          ),
          Effect.provide(BunServices.layer),
        ),
      );
      expect(message).toBe("duplicate project_id for [remotes.b] and [remotes.a]");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("rejects two remotes that both omit project_id", async () => {
    // A missing project_id reads as "" (Go's viper.GetString), so two remotes that
    // both omit it collide on the empty key.
    const cwd = await writeTomlProject(`project_id = "baseref"

[remotes.a]
[remotes.a.api]
max_rows = 1

[remotes.b]
[remotes.b.api]
max_rows = 2
`);
    try {
      const message = await Effect.runPromise(
        loadProjectConfig(cwd, { projectRef: "previewref" }).pipe(
          Effect.catchTag("DuplicateRemoteProjectIdError", (error) =>
            Effect.succeed(error.message),
          ),
          Effect.provide(BunServices.layer),
        ),
      );
      expect(message).toBe("duplicate project_id for [remotes.b] and [remotes.a]");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("the merged document carries pointer sections introduced by the remote", async () => {
    const cwd = await writeTomlProject(`project_id = "baseref"

[remotes.preview]
project_id = "previewref"
[remotes.preview.db.ssl_enforcement]
enabled = true
`);
    try {
      const loaded = await runConfigEffect(loadProjectConfig(cwd, { projectRef: "previewref" }));
      // `legacyPresenceIn` reads `document` to detect optional pointer sections;
      // a remote-introduced `db.ssl_enforcement` must be present there.
      const db = loaded!.document?.db;
      expect(typeof db === "object" && db !== null && "ssl_enforcement" in db).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("forces db.seed.enabled false when the matching remote omits it", async () => {
    const cwd = await writeTomlProject(`project_id = "baseref"

[db.seed]
enabled = true

[remotes.preview]
project_id = "previewref"
[remotes.preview.api]
max_rows = 5
`);
    try {
      const loaded = await runConfigEffect(loadProjectConfig(cwd, { projectRef: "previewref" }));
      expect(loaded!.config.db.seed.enabled).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("preserves db.seed.enabled when the matching remote sets it", async () => {
    const cwd = await writeTomlProject(`project_id = "baseref"

[remotes.preview]
project_id = "previewref"
[remotes.preview.db.seed]
enabled = true
`);
    try {
      const loaded = await runConfigEffect(loadProjectConfig(cwd, { projectRef: "previewref" }));
      expect(loaded!.config.db.seed.enabled).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("resolves env() references inside the matching remote before merge", async () => {
    const previous = process.env.SUPABASE_REMOTE_MAX_ROWS_TEST;
    process.env.SUPABASE_REMOTE_MAX_ROWS_TEST = "777";
    const cwd = await writeTomlProject(`project_id = "baseref"

[api]
max_rows = 1

[remotes.preview]
project_id = "previewref"
[remotes.preview.api]
max_rows = "env(SUPABASE_REMOTE_MAX_ROWS_TEST)"
`);
    try {
      const loaded = await runConfigEffect(loadProjectConfig(cwd, { projectRef: "previewref" }));
      expect(loaded!.config.api.max_rows).toBe(777);
    } finally {
      if (previous === undefined) {
        delete process.env.SUPABASE_REMOTE_MAX_ROWS_TEST;
      } else {
        process.env.SUPABASE_REMOTE_MAX_ROWS_TEST = previous;
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("config io deprecated [inbucket] back-compat", () => {
  let warnings: Array<string> = [];
  let errorSpy: ReturnType<typeof vi.spyOn> | undefined;

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

  async function loadToml(contents: string) {
    const cwd = makeTempProject();
    const path = await runConfigEffect(configTomlPath(cwd));
    await mkdir(join(cwd, "supabase"), { recursive: true });
    await writeFile(path, contents);
    try {
      return await runConfigEffect(loadProjectConfigFile(path));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  test("loads a deprecated [inbucket] section as [local_smtp]", async () => {
    captureWarnings();
    const loaded = await loadToml(
      `project_id = "abc123"

[inbucket]
enabled = true
port = 12345
`,
    );

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
  });

  test("fills schema defaults when a deprecated [inbucket] section is partial", async () => {
    const loaded = await loadToml(
      `project_id = "abc123"

[inbucket]
port = 9999
`,
    );

    // enabled is omitted by the user; the schema default (true) must survive the
    // inbucket -> local_smtp rewrite rather than collapsing to a zero value.
    expect(loaded.config.local_smtp.enabled).toBe(true);
    expect(loaded.config.local_smtp.port).toBe(9999);
  });

  test("prefers an explicit [local_smtp] when both sections are present", async () => {
    captureWarnings();
    const loaded = await loadToml(
      `project_id = "abc123"

[inbucket]
enabled = true
port = 11111

[local_smtp]
enabled = true
port = 22222
`,
    );

    expect(loaded.config.local_smtp.port).toBe(22222);
    expect(loaded.document).not.toHaveProperty("inbucket");
    // The deprecation warning still fires because the deprecated key was present.
    expect(warnings.some((m) => m.includes("[inbucket] is deprecated"))).toBe(true);
  });

  test("normalizes a deprecated [remotes.*.inbucket] section", async () => {
    captureWarnings();
    const loaded = await loadToml(
      `project_id = "abc123"

[remotes.staging]
project_id = "stagingref"

[remotes.staging.inbucket]
enabled = true
port = 33333
`,
    );

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
  });

  test("does not warn when only [local_smtp] is used", async () => {
    captureWarnings();
    const loaded = await loadToml(
      `project_id = "abc123"

[local_smtp]
enabled = true
port = 54324
`,
    );

    expect(loaded.config.local_smtp.port).toBe(54324);
    expect(warnings.some((m) => m.includes("is deprecated"))).toBe(false);
  });
});
