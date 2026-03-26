import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  import.meta.dir,
  "../../../.repos/supabase-cli-go/pkg/config/testdata/config.toml",
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

  test("omits non-legacy keys from generated JSON schema", () => {
    const document = Schema.toJsonSchemaDocument(ProjectConfigSchema).schema;
    const schemaString = JSON.stringify(document);

    expect(schemaString).toContain("remotes");
    expect(schemaString).toContain("static_files");
    expect(schemaString).not.toContain("versions");
  });
});
