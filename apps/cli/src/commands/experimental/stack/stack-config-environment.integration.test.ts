import { Buffer } from "node:buffer";

import { encrypt, PrivateKey } from "eciesjs";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option, Redacted } from "effect";

import { withEnvVar } from "../../../../tests/helpers/command-mocks.ts";
import { StackConfigError, loadStackConfig } from "./stack-config.ts";
import { createStackConfigProject } from "./stack-config.test-fixtures.ts";

function withEnvironment<A, E, R>(
  values: Readonly<Record<string, string | undefined>>,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Object.entries(values).reduce(
    (effect, [name, value]) => withEnvVar(name, value, effect),
    body,
  );
}

function project(
  config: string,
  options: {
    readonly rootEnv?: string;
    readonly supabaseEnv?: string;
    readonly sharedFunctionEnvironment?: string;
    readonly functionEnvironments?: Readonly<Record<string, string>>;
  } = {},
): string {
  const root = createStackConfigProject(config, {
    prefix: "supabase-stack-config-env-",
    ...options,
  });
  return root;
}

const load = (projectRoot: string) =>
  loadStackConfig(projectRoot).pipe(Effect.provide(BunServices.layer));

const encrypted = (privateKey: string, plaintext: string): string =>
  `encrypted:${Buffer.from(
    encrypt(PrivateKey.fromHex(privateKey).publicKey.toHex(false), Buffer.from(plaintext, "utf8")),
  ).toString("base64")}`;

const privateKey = "7fd7210cef8f331ee8c55897996aaaafd853a2b20a4dc73d6d75759f65d2a7eb";
const wrongPrivateKey = "11".repeat(32);

describe("loadStackConfig environment overrides", () => {
  it.effect(
    "uses shell > supabase dotenv > project-root dotenv, with empty and indirect values handled",
    () => {
      const root = project(
        `project_id = "stack-config-env-precedence"
[auth]
site_url = "from-config"
`,
        {
          rootEnv: "SUPABASE_AUTH_SITE_URL=root\nAUTH_SITE_URL=root-indirect\n",
          supabaseEnv: "SUPABASE_AUTH_SITE_URL=supabase\nAUTH_SITE_URL=supabase-indirect\n",
        },
      );
      return withEnvVar(
        "SUPABASE_AUTH_SITE_URL",
        "shell",
        Effect.gen(function* () {
          const shell = yield* load(root);
          if (shell.capabilities?.auth === undefined || !("settings" in shell.capabilities.auth))
            throw new Error("auth settings missing");
          expect(shell.capabilities.auth.settings?.site_url).toBe("shell");

          const indirect = yield* withEnvVar(
            "SUPABASE_AUTH_SITE_URL",
            "env(AUTH_SITE_URL)",
            load(root),
          );
          if (
            indirect.capabilities?.auth === undefined ||
            !("settings" in indirect.capabilities.auth)
          )
            throw new Error("auth settings missing");
          expect(indirect.capabilities.auth.settings?.site_url).toBe("supabase-indirect");

          const empty = yield* withEnvVar("SUPABASE_AUTH_SITE_URL", "", load(root));
          if (empty.capabilities?.auth === undefined || !("settings" in empty.capabilities.auth))
            throw new Error("auth settings missing");
          expect(empty.capabilities.auth.settings?.site_url).toBe("from-config");
        }),
      );
    },
  );

  it.effect(
    "applies defaults-backed auth.email overrides but does not materialize absent SMTP, providers, or hooks",
    () => {
      const root = project(
        `project_id = "stack-config-auth-presence"
`,
        {
          supabaseEnv: [
            "SUPABASE_AUTH_EMAIL_ENABLE_SIGNUP=false",
            "SUPABASE_AUTH_EMAIL_SMTP_ENABLED=true",
            "SUPABASE_AUTH_EXTERNAL_GITHUB_ENABLED=true",
            "SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED=true",
            "",
          ].join("\n"),
        },
      );
      return Effect.gen(function* () {
        const config = yield* load(root);
        if (config.capabilities?.auth === undefined || !("settings" in config.capabilities.auth))
          throw new Error("auth settings missing");
        const auth = config.capabilities.auth.settings;
        expect(auth?.email?.enable_signup).toBe(false);
        expect(auth?.email?.smtp).toBeUndefined();
        expect(auth?.external?.github).toBeUndefined();
        expect(auth?.hook?.custom_access_token).toBeUndefined();
      });
    },
  );

  it.effect("disables and re-enables a service through the effective environment layer", () => {
    const disabledRoot = project('project_id = "stack-config-env-disable-file"\n', {
      supabaseEnv: "SUPABASE_AUTH_ENABLED=false\n",
    });
    const enabledRoot = project(
      'project_id = "stack-config-env-enable-shell"\n[auth]\nenabled = false\n',
    );
    return withEnvVar(
      "SUPABASE_AUTH_ENABLED",
      undefined,
      Effect.gen(function* () {
        const disabled = yield* load(disabledRoot);
        expect(disabled.capabilities?.auth).toEqual({ enabled: false });

        const enabled = yield* withEnvVar("SUPABASE_AUTH_ENABLED", "true", load(enabledRoot));
        if (enabled.capabilities?.auth === undefined || !("settings" in enabled.capabilities.auth))
          throw new Error("auth settings missing");
        expect(enabled.capabilities.auth.settings).toBeDefined();
      }),
    );
  });

  it.effect("applies JWT environment overrides while auth is disabled", () => {
    const root = project(
      `project_id = "stack-config-disabled-auth-jwt"
`,
      {
        supabaseEnv: [
          "SUPABASE_AUTH_ENABLED=false",
          "SUPABASE_AUTH_JWT_ISSUER=https://issuer.example.test",
          "SUPABASE_AUTH_JWT_SECRET=01234567890123456789012345678901",
          "",
        ].join("\n"),
      },
    );
    const signingPathRoot = project(
      `project_id = "stack-config-disabled-auth-signing-path"
[auth]
enabled = false
`,
      { supabaseEnv: "SUPABASE_AUTH_SIGNING_KEYS_PATH=keys.json\n" },
    );
    return Effect.gen(function* () {
      const config = yield* load(root);
      expect(config.capabilities?.auth).toEqual({ enabled: false });
      expect(config.security?.jwt?.issuer).toBe("https://issuer.example.test");
      const signing = config.security?.jwt?.signing;
      expect(signing?.kind).toBe("symmetric");
      if (signing?.kind !== "symmetric") throw new Error("symmetric signing missing");
      expect(Redacted.value(signing.secret)).toBe("01234567890123456789012345678901");
      const signingPath = yield* load(signingPathRoot);
      expect(signingPath.security?.jwt?.signing).toEqual({
        kind: "jwks-file",
        path: "supabase/keys.json",
      });
    });
  });

  it.effect("rejects an env-enabled SMTP section without a port", () => {
    const root = project(
      `project_id = "stack-config-smtp-env-enable-missing-port"
[auth.email.smtp]
enabled = false
host = "smtp.example.test"
user = "smtp-user"
pass = "smtp-pass"
admin_email = "admin@example.test"
`,
      { supabaseEnv: "SUPABASE_AUTH_EMAIL_SMTP_ENABLED=true\n" },
    );
    return Effect.gen(function* () {
      const exit = yield* load(root).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("auth.email.smtp.port");
    });
  });

  it.effect("does not decrypt an unused provider secret when auth is disabled", () => {
    const root = project(
      `project_id = "stack-config-disabled-auth-provider-secret"
[auth]
enabled = false
[auth.external.github]
enabled = true
client_id = "github-client"
secret = "encrypted:not-a-real-ciphertext"
`,
    );
    return withEnvVar(
      "DOTENV_PRIVATE_KEY",
      undefined,
      Effect.gen(function* () {
        const config = yield* load(root);
        expect(config.capabilities?.auth).toEqual({ enabled: false });
      }),
    );
  });

  it.effect("re-enables a file-disabled Studio service with its env-provided listener port", () => {
    const root = project(
      `project_id = "stack-config-studio-env-reenable"
[studio]
enabled = false
port = 55440
`,
    );
    return withEnvironment(
      { SUPABASE_STUDIO_ENABLED: "true", SUPABASE_STUDIO_PORT: "55441" },
      Effect.gen(function* () {
        const config = yield* load(root);
        if (
          config.capabilities?.studio === undefined ||
          !("settings" in config.capabilities.studio)
        )
          throw new Error("Studio settings missing");
        expect(config.listeners?.studio).toEqual({ port: 55441 });
      }),
    );
  });

  it.effect("validates unsupported Figma from effective provider presence", () => {
    const disabledInFile = project(
      `project_id = "stack-config-figma-env-enable"
[auth.external.figma]
enabled = false
`,
    );
    const enabledInFile = project(
      `project_id = "stack-config-figma-env-disable"
[auth.external.figma]
enabled = true
client_id = "figma-client"
secret = "figma-secret"
`,
    );
    return withEnvVar(
      "SUPABASE_AUTH_EXTERNAL_FIGMA_ENABLED",
      "true",
      Effect.gen(function* () {
        const enabled = yield* load(disabledInFile).pipe(Effect.exit);
        expect(Exit.isFailure(enabled)).toBe(true);
        if (Exit.isFailure(enabled)) expect(String(enabled.cause)).toContain("auth.external.figma");

        const disabled = yield* withEnvVar(
          "SUPABASE_AUTH_EXTERNAL_FIGMA_ENABLED",
          "false",
          load(enabledInFile),
        );
        if (
          disabled.capabilities?.auth === undefined ||
          !("settings" in disabled.capabilities.auth)
        )
          throw new Error("auth settings missing");
        expect(Object.hasOwn(disabled.capabilities.auth.settings?.external ?? {}, "figma")).toBe(
          false,
        );
      }),
    );
  });

  it.effect("overrides present SMTP, provider, and hook fields from SUPABASE_* values", () => {
    const root = project(
      `project_id = "stack-config-auth-nested-overrides"
[auth.email.smtp]
enabled = true
host = "config-smtp"
port = 2525
user = "config-user"
pass = "config-pass"
admin_email = "config-admin@example.test"
sender_name = "Config Sender"
[auth.external.github]
enabled = true
client_id = "config-client"
secret = "config-secret"
[auth.hook.custom_access_token]
enabled = true
uri = "config-hook"
`,
      {
        supabaseEnv: [
          "SUPABASE_AUTH_EMAIL_SMTP_HOST=env-smtp",
          "SUPABASE_AUTH_EMAIL_SMTP_PORT=2526",
          "SUPABASE_AUTH_EMAIL_SMTP_USER=env-user",
          "SUPABASE_AUTH_EMAIL_SMTP_PASS=env-pass",
          "SUPABASE_AUTH_EMAIL_SMTP_ADMIN_EMAIL=env-admin@example.test",
          "SUPABASE_AUTH_EMAIL_SMTP_SENDER_NAME=Env Sender",
          "SUPABASE_AUTH_EXTERNAL_GITHUB_ENABLED=false",
          "SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID=env-client",
          "SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET=env-secret",
          "SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED=false",
          "SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_URI=env-hook",
          "",
        ].join("\n"),
      },
    );
    return Effect.gen(function* () {
      const config = yield* load(root);
      if (config.capabilities?.auth === undefined || !("settings" in config.capabilities.auth))
        throw new Error("auth settings missing");
      const auth = config.capabilities.auth.settings;
      expect(auth?.email?.smtp).toMatchObject({
        enabled: true,
        host: "env-smtp",
        port: 2526,
        user: "env-user",
        admin_email: "env-admin@example.test",
        sender_name: "Env Sender",
      });
      expect(auth?.email?.smtp?.pass).toBeDefined();
      if (auth?.email?.smtp?.pass === undefined) throw new Error("SMTP password missing");
      expect(Redacted.value(auth.email.smtp.pass)).toBe("env-pass");
      expect(auth?.external?.github).toMatchObject({
        enabled: false,
        client_id: "env-client",
      });
      expect(auth?.hook?.custom_access_token).toMatchObject({
        enabled: false,
        uri: "env-hook",
      });
    });
  });

  it.effect("rejects incomplete auth sections after effective environment overrides", () => {
    const cases = [
      {
        name: "external provider",
        config: `[auth.external.github]\nenabled = false\n`,
        env: "SUPABASE_AUTH_EXTERNAL_GITHUB_ENABLED=true\n",
        message: "auth.external.github.client_id",
      },
      {
        name: "SMS provider",
        config: `[auth.sms.vonage]\nenabled = false\n`,
        env: "SUPABASE_AUTH_SMS_VONAGE_ENABLED=true\n",
        message: "auth.sms.vonage.from",
      },
    ];
    return Effect.gen(function* () {
      for (const testCase of cases) {
        const root = project(
          `project_id = "stack-config-auth-invalid-${testCase.name}"\n${testCase.config}`,
          {
            supabaseEnv: testCase.env,
          },
        );
        const exit = yield* load(root).pipe(Effect.exit);
        expect(Exit.isFailure(exit), testCase.name).toBe(true);
        if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain(testCase.message);
      }
    });
  });

  it.effect("gates auth validation on the effective auth capability", () => {
    const root = project(
      `project_id = "stack-config-auth-effective-gate"
[auth]
enabled = false
[auth.external.github]
enabled = false
`,
      {
        supabaseEnv: [
          "SUPABASE_AUTH_ENABLED=true",
          "SUPABASE_AUTH_EXTERNAL_GITHUB_ENABLED=true",
          "",
        ].join("\n"),
      },
    );
    return Effect.gen(function* () {
      const enabled = yield* load(root).pipe(Effect.exit);
      expect(Exit.isFailure(enabled)).toBe(true);
      if (Exit.isFailure(enabled)) expect(String(enabled.cause)).toContain("auth.external.github");

      const disabled = yield* withEnvVar("SUPABASE_AUTH_ENABLED", "false", load(root));
      expect(disabled.capabilities?.auth).toEqual({ enabled: false });
    });
  });

  it.effect("accepts a valid encrypted HTTPS auth hook", () => {
    const hookSecret = `v1,whsec_${"A".repeat(32)}`;
    const root = project(
      `project_id = "stack-config-auth-encrypted-hook"
[auth.hook.custom_access_token]
enabled = true
uri = "https://hooks.example.test"
secrets = "${encrypted(privateKey, hookSecret)}"
`,
      { supabaseEnv: `DOTENV_PRIVATE_KEY=${privateKey}\n` },
    );
    return Effect.gen(function* () {
      const config = yield* load(root);
      if (config.capabilities?.auth === undefined || !("settings" in config.capabilities.auth))
        throw new Error("auth settings missing");
      const hook = config.capabilities.auth.settings?.hook?.custom_access_token;
      expect(hook?.uri).toBe("https://hooks.example.test");
      expect(hook?.secrets).toBeDefined();
      if (hook?.secrets === undefined) throw new Error("hook secret missing");
      expect(Redacted.value(hook.secrets)).toBe(hookSecret);
    });
  });

  it.effect(
    "redacts plaintext and encrypted Vonage API keys and preserves disabled SMTP shape",
    () => {
      const encryptedApiKey = encrypted(privateKey, "encrypted-vonage-api-key");
      const plaintextRoot = project(`project_id = "stack-config-vonage-plaintext"
[auth.email.smtp]
enabled = false
[auth.sms.vonage]
enabled = true
from = "from"
api_key = "plaintext-vonage-api-key"
api_secret = "vonage-api-secret"
`);
      const encryptedRoot = project(
        `project_id = "stack-config-vonage-encrypted"
[auth.sms.vonage]
enabled = true
from = "from"
api_key = "${encryptedApiKey}"
api_secret = "vonage-api-secret"
`,
        { supabaseEnv: `DOTENV_PRIVATE_KEY=${privateKey}\n` },
      );
      return Effect.gen(function* () {
        const plaintext = yield* load(plaintextRoot);
        const plaintextAuth = plaintext.capabilities?.auth;
        if (plaintextAuth === undefined || !("settings" in plaintextAuth))
          throw new Error("plaintext auth settings missing");
        expect(plaintextAuth.settings?.sms?.vonage?.api_key).toBeDefined();
        expect(Redacted.value(plaintextAuth.settings!.sms!.vonage!.api_key!)).toBe(
          "plaintext-vonage-api-key",
        );
        expect(plaintextAuth.settings?.email?.smtp).not.toHaveProperty("port");

        const encryptedConfig = yield* load(encryptedRoot);
        const encryptedAuth = encryptedConfig.capabilities?.auth;
        if (encryptedAuth === undefined || !("settings" in encryptedAuth))
          throw new Error("encrypted auth settings missing");
        expect(encryptedAuth.settings?.sms?.vonage?.api_key).toBeDefined();
        expect(Redacted.value(encryptedAuth.settings!.sms!.vonage!.api_key!)).toBe(
          "encrypted-vonage-api-key",
        );
      });
    },
  );

  it.effect("applies stack environment overrides while preserving optional settings", () => {
    const root = project(
      `project_id = "stack-config-stack-overrides"
[api]
enabled = true
auto_expose_new_tables = false
[storage]
[storage.image_transformation]
enabled = false
[db]
health_timeout = "2m"
[auth]
signing_keys_path = "keys.json"
`,
      {
        supabaseEnv: [
          "SUPABASE_API_AUTO_EXPOSE_NEW_TABLES=true",
          "SUPABASE_STORAGE_IMAGE_TRANSFORMATION_ENABLED=true",
          "SUPABASE_DB_HEALTH_TIMEOUT=45s",
          "SUPABASE_AUTH_SIGNING_KEYS_PATH=overridden-keys.json",
          "SUPABASE_AUTH_EXTERNAL_APPLE_ENABLED=true",
          "SUPABASE_AUTH_EXTERNAL_APPLE_CLIENT_ID=apple-client",
          "SUPABASE_AUTH_EXTERNAL_APPLE_SECRET=apple-secret",
          "",
        ].join("\n"),
      },
    );
    const absentImageRoot = project('project_id = "stack-config-absent-image"\n', {
      supabaseEnv: "SUPABASE_STORAGE_IMAGE_TRANSFORMATION_ENABLED=true\n",
    });
    const absentApiRoot = project('project_id = "stack-config-absent-api-field"\n');
    const explicitFalseApiRoot = project(
      `project_id = "stack-config-explicit-false-api-field"
[api]
auto_expose_new_tables = true
`,
      { supabaseEnv: "SUPABASE_API_AUTO_EXPOSE_NEW_TABLES=false\n" },
    );
    return Effect.gen(function* () {
      const config = yield* load(root);
      if (config.capabilities?.rest === undefined || !("settings" in config.capabilities.rest))
        throw new Error("REST settings missing");
      expect(config.capabilities.rest.settings?.auto_expose_new_tables).toBe(true);
      if (config.capabilities.storage === undefined || !("settings" in config.capabilities.storage))
        throw new Error("storage settings missing");
      expect(config.capabilities.storage.settings?.image_transformation).toEqual({ enabled: true });
      expect(config.capabilities.database?.settings?.health_timeout).toBe("45s");
      expect(config.security?.jwt?.signing).toEqual({
        kind: "jwks-file",
        path: "supabase/overridden-keys.json",
      });
      if (config.capabilities.auth === undefined || !("settings" in config.capabilities.auth))
        throw new Error("auth settings missing");
      expect(config.capabilities.auth.settings?.signing_keys_path).toBe("overridden-keys.json");
      expect(config.capabilities.auth.settings?.external?.apple).toMatchObject({
        enabled: true,
        client_id: "apple-client",
      });

      const absentImage = yield* load(absentImageRoot);
      if (
        absentImage.capabilities?.storage === undefined ||
        !("settings" in absentImage.capabilities.storage)
      )
        throw new Error("absent-image storage settings missing");
      expect(absentImage.capabilities.storage.settings?.image_transformation).toBeUndefined();

      const absentApi = yield* load(absentApiRoot);
      if (
        absentApi.capabilities?.rest === undefined ||
        !("settings" in absentApi.capabilities.rest)
      )
        throw new Error("absent-api REST settings missing");
      expect(absentApi.capabilities.rest.settings?.auto_expose_new_tables).toBeUndefined();

      const explicitFalseApi = yield* load(explicitFalseApiRoot);
      if (
        explicitFalseApi.capabilities?.rest === undefined ||
        !("settings" in explicitFalseApi.capabilities.rest)
      )
        throw new Error("explicit-false REST settings missing");
      expect(explicitFalseApi.capabilities.rest.settings?.auto_expose_new_tables).toBe(false);
    });
  });

  it.effect("rejects an invalid analytics backend environment override", () => {
    const root = project('project_id = "stack-config-invalid-analytics-backend"\n');
    return withEnvVar(
      "SUPABASE_ANALYTICS_BACKEND",
      "invalid-backend",
      Effect.gen(function* () {
        const exit = yield* load(root).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain("analytics.backend");
        }
      }),
    );
  });

  it.effect("honors representative API, analytics, database, and Studio overrides", () => {
    const root = project(
      `project_id = "stack-config-representative-overrides"
[api]
schemas = ["config-schema"]
[db]
major_version = 15
[studio]
openai_api_key = "config-studio-key"
`,
      {
        supabaseEnv: [
          "SUPABASE_API_SCHEMAS=public,storage",
          "SUPABASE_ANALYTICS_BACKEND=bigquery",
          "SUPABASE_ANALYTICS_VECTOR_PORT=54328",
          "SUPABASE_ANALYTICS_GCP_PROJECT_ID=env-project",
          "SUPABASE_DB_MAJOR_VERSION=17",
          "SUPABASE_STUDIO_OPENAI_API_KEY=env-studio-key",
          "",
        ].join("\n"),
      },
    );
    return Effect.gen(function* () {
      const config = yield* load(root);
      if (config.capabilities?.rest === undefined || !("settings" in config.capabilities.rest))
        throw new Error("REST settings missing");
      if (config.capabilities?.studio === undefined || !("settings" in config.capabilities.studio))
        throw new Error("Studio settings missing");
      expect(config.capabilities.rest.settings?.schemas).toEqual(["public", "storage"]);
      expect(config.capabilities.database?.version).toBe("17");
      if (
        config.capabilities.analytics === undefined ||
        !("settings" in config.capabilities.analytics)
      )
        throw new Error("analytics settings missing");
      expect(config.capabilities.analytics.settings?.backend).toBe("bigquery");
      expect(config.capabilities.analytics.settings?.vector_port).toBe(54328);
      expect(config.capabilities.analytics.settings?.gcp_project_id).toBe("env-project");
      expect(config.capabilities.studio.settings?.openai_api_key).toBeDefined();
      if (config.capabilities.studio.settings?.openai_api_key === undefined)
        throw new Error("Studio secret missing");
      expect(Redacted.value(config.capabilities.studio.settings.openai_api_key)).toBe(
        "env-studio-key",
      );
    });
  });

  it.effect("creates listeners from env-only ports and leaves omitted defaults dynamic", () => {
    const root = project('project_id = "stack-config-env-only-ports"\n');
    return withEnvironment(
      { SUPABASE_API_PORT: "0xD431", SUPABASE_DB_PORT: "010" },
      Effect.gen(function* () {
        const overridden = yield* load(root);
        expect(overridden.listeners?.api).toEqual({ port: 54321 });
        expect(overridden.listeners?.database).toEqual({ port: 8 });

        const defaults = yield* withEnvironment(
          { SUPABASE_API_PORT: undefined, SUPABASE_DB_PORT: undefined },
          load(root),
        );
        expect(defaults.listeners).toEqual({});
      }),
    );
  });

  it.effect(
    "creates an env-only pooler capability and listener without a raw db.pooler table",
    () => {
      const root = project('project_id = "stack-config-env-only-pooler"\n');
      return withEnvironment(
        { SUPABASE_DB_POOLER_ENABLED: "true", SUPABASE_DB_POOLER_PORT: "55450" },
        Effect.gen(function* () {
          const config = yield* load(root);
          if (
            config.capabilities?.pooler === undefined ||
            !("settings" in config.capabilities.pooler)
          )
            throw new Error("pooler settings missing");
          expect(config.listeners?.pooler).toEqual({ port: 55450 });
        }),
      );
    },
  );

  it.effect("keeps an absent raw Studio section disabled through env overrides", () => {
    const root = project('project_id = "stack-config-absent-studio-disabled"\n');
    return withEnvironment(
      { SUPABASE_STUDIO_ENABLED: "false", SUPABASE_STUDIO_PORT: "55451" },
      Effect.gen(function* () {
        const config = yield* load(root);
        expect(config.capabilities?.studio).toEqual({ enabled: false });
        expect(config.listeners?.studio).toEqual({ enabled: false });
      }),
    );
  });

  it.effect("fails a malformed env-only port override as a config error", () => {
    const root = project('project_id = "stack-config-malformed-env-port"\n');
    return withEnvVar(
      "SUPABASE_DB_PORT",
      "not-a-port",
      Effect.gen(function* () {
        const exit = yield* load(root).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(exit.cause)).toContain("db.port");
          expect(String(exit.cause)).not.toContain("StackConfigError: StackConfigError");
        }
      }),
    );
  });

  it.effect(
    "decrypts config, shared function, per-function, and config env secrets into Redacted values",
    () => {
      const authSecret = "auth-secret-that-is-long-enough";
      const studioSecret = "studio-api-key";
      const edgeSecret = "edge-config-secret";
      const functionConfigSecret = "function-config-secret";
      const sharedSecret = "function-shared-secret";
      const localOverrideSecret = "function-local-override-secret";
      const localSecret = "function-local-secret";
      const root = project(
        `project_id = "stack-config-encrypted-values"
[auth]
jwt_secret = "${encrypted(privateKey, authSecret)}"
[studio]
openai_api_key = "${encrypted(privateKey, studioSecret)}"
[edge_runtime]
enabled = true
secrets = { EDGE_SECRET = "${encrypted(privateKey, edgeSecret)}" }
[functions.hello]
env = { CONFIG_SECRET = "env(CONFIG_FN_SECRET)" }
`,
        {
          supabaseEnv: `CONFIG_FN_SECRET=${encrypted(privateKey, functionConfigSecret)}\n`,
          sharedFunctionEnvironment: `SHARED_SECRET=${encrypted(privateKey, sharedSecret)}\n`,
          functionEnvironments: {
            hello: `SHARED_SECRET=${encrypted(privateKey, localOverrideSecret)}\nLOCAL_SECRET=${encrypted(privateKey, localSecret)}\n`,
            world: "",
          },
        },
      );
      return withEnvironment(
        {
          DOTENV_PRIVATE_KEY: `${wrongPrivateKey},,${privateKey}`,
          DOTENV_PRIVATE_KEY_TEST: wrongPrivateKey,
        },
        Effect.gen(function* () {
          const config = yield* load(root);
          if (config.capabilities?.auth === undefined || !("settings" in config.capabilities.auth))
            throw new Error("auth settings missing");
          if (
            config.capabilities?.studio === undefined ||
            !("settings" in config.capabilities.studio)
          )
            throw new Error("studio settings missing");
          if (
            config.capabilities?.functions === undefined ||
            !("settings" in config.capabilities.functions)
          )
            throw new Error("functions settings missing");
          const authSecretValue = config.capabilities.auth.settings?.jwt_secret;
          const studioSecretValue = config.capabilities.studio.settings?.openai_api_key;
          const functions = config.capabilities.functions.settings?.functions;
          const edgeSecrets = config.capabilities.functions.settings?.edge_runtime?.secrets;
          expect(authSecretValue).toBeDefined();
          expect(studioSecretValue).toBeDefined();
          expect(functions?.hello?.env?.CONFIG_SECRET).toBeDefined();
          expect(functions?.hello?.env?.SHARED_SECRET).toBeDefined();
          expect(functions?.hello?.env?.LOCAL_SECRET).toBeDefined();
          expect(functions?.world?.env?.SHARED_SECRET).toBeDefined();
          expect(edgeSecrets?.EDGE_SECRET).toBeDefined();
          if (
            authSecretValue === undefined ||
            studioSecretValue === undefined ||
            functions?.hello?.env?.CONFIG_SECRET === undefined ||
            functions.hello.env.SHARED_SECRET === undefined ||
            functions.hello.env.LOCAL_SECRET === undefined ||
            functions.world?.env?.SHARED_SECRET === undefined ||
            edgeSecrets?.EDGE_SECRET === undefined
          )
            throw new Error("encrypted settings missing");
          expect(Redacted.value(authSecretValue)).toBe(authSecret);
          expect(Redacted.value(studioSecretValue)).toBe(studioSecret);
          expect(Redacted.value(functions.hello.env.CONFIG_SECRET)).toBe(functionConfigSecret);
          expect(Redacted.value(functions.hello.env.SHARED_SECRET)).toBe(localOverrideSecret);
          expect(Redacted.value(functions.hello.env.LOCAL_SECRET)).toBe(localSecret);
          expect(Redacted.value(functions.world.env.SHARED_SECRET)).toBe(sharedSecret);
          expect(Redacted.value(edgeSecrets.EDGE_SECRET)).toBe(edgeSecret);
        }),
      );
    },
  );

  it.effect("lets a valid encrypted auth env override replace invalid file ciphertext", () => {
    const plaintext = "valid-env-auth-secret-that-is-long-enough";
    const ciphertext = encrypted(privateKey, plaintext);
    const root = project(
      `project_id = "stack-config-encrypted-env-wins"
[auth]
jwt_secret = "encrypted:invalid-file-ciphertext"
`,
    );
    return withEnvironment(
      { DOTENV_PRIVATE_KEY: privateKey, SUPABASE_AUTH_JWT_SECRET: ciphertext },
      Effect.gen(function* () {
        const config = yield* load(root);
        if (config.capabilities?.auth === undefined || !("settings" in config.capabilities.auth))
          throw new Error("auth settings missing");
        const signing = config.security?.jwt?.signing;
        expect(signing?.kind).toBe("symmetric");
        if (signing?.kind !== "symmetric") throw new Error("symmetric signing missing");
        expect(Redacted.value(signing.secret)).toBe(plaintext);
      }),
    );
  });

  it.effect(
    "does not disclose encrypted secret, plaintext, or key on missing or wrong key errors",
    () => {
      const plaintext = "secret-plaintext-that-must-not-appear";
      const ciphertext = encrypted(privateKey, plaintext);
      const root = project(
        `project_id = "stack-config-encrypted-error"
[auth]
jwt_secret = "${ciphertext}"
`,
      );
      return Effect.gen(function* () {
        for (const key of [undefined, wrongPrivateKey]) {
          const exit = yield* withEnvVar("DOTENV_PRIVATE_KEY", key, load(root).pipe(Effect.exit));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const message = String(exit.cause);
            expect(message).toContain("could not be decrypted");
            expect(message).not.toContain(plaintext);
            expect(message).not.toContain(ciphertext);
            expect(message).not.toContain(privateKey);
            expect(message).not.toContain(wrongPrivateKey);
            const error = Cause.findErrorOption(exit.cause);
            expect(Option.isSome(error)).toBe(true);
            if (Option.isSome(error)) expect(error.value).toBeInstanceOf(StackConfigError);
          }
        }
      });
    },
  );

  it.effect("does not read a disabled function's dotenv file or unresolved env reference", () => {
    const root = project(
      `project_id = "stack-config-disabled-function-env"
[functions.disabled]
enabled = false
env = { TOKEN = "env(MISSING_DISABLED_FUNCTION_ENV)" }
`,
      { functionEnvironments: { disabled: "lowercase=value\n!=secret-value\n" } },
    );
    return Effect.gen(function* () {
      const config = yield* load(root);
      if (
        config.capabilities?.functions === undefined ||
        !("settings" in config.capabilities.functions)
      )
        throw new Error("functions settings missing");
      expect(config.capabilities.functions.settings?.functions?.disabled?.enabled).toBe(false);
    });
  });
});
