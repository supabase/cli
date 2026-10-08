import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BunServices } from "@effect/platform-bun";
import { CliConfigSchema } from "@supabase/config";
import { DEFAULT_POSTGRES_ROOT_KEY } from "@supabase/stack/defaults";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Path, Schema } from "effect";

import { getDocumentValue } from "./cli-config-document.ts";
import {
  CLI_CONFIG_ENV_ALIASES,
  CLI_CONFIG_FAMILIES,
  CLI_CONFIG_SCHEMA_EXCLUDED,
  CLI_NON_CONFIG_ENV_NAMES,
} from "./cli-config-key-annotations.ts";
import {
  CliConfigKeys,
  CliEnvNames,
  cliConfigDocumentOnlyPaths,
  cliConfigFamilyKey,
  cliConfigRegistry,
  cliConfigSchemaKeyDefs,
  deriveCliConfigEnvName,
} from "./cli-config-keys.ts";

const srcDir = fileURLToPath(new URL("..", import.meta.url));

const registryFiles = new Set([
  "config/cli-config-key-annotations.ts",
  "config/cli-config-key.ts",
  "config/cli-config-keys.ts",
]);

const productionSources = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts") && !file.endsWith(".test.ts"))
  .filter((file) => !file.includes("__fixtures__") && !file.startsWith("shared/compute/stacks"))
  .filter((file) => !registryFiles.has(file))
  .map((file) => ({ file, text: readFileSync(join(srcDir, file), "utf8") }));

const referencedEnvNames = new Set(
  productionSources.flatMap(({ text }) =>
    [...text.matchAll(/\bSUPABASE_[A-Z0-9_]+\b/g)].map((match) => match[0]),
  ),
);

const registryEnvNames = new Set(cliConfigRegistry.keys.flatMap((key) => key.env));

const camelCase = (segment: string) =>
  segment.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());

const treeLookup = (path: string): unknown =>
  path.split(".").reduce<unknown>((node, segment) => {
    if (typeof node !== "object" || node === null) return undefined;
    return Reflect.get(node, camelCase(segment));
  }, CliConfigKeys);

describe("config key registry", () => {
  it("gives every env name to exactly one key", () => {
    const names = cliConfigRegistry.keys.flatMap((key) => key.env);

    expect(names.length).toBe(registryEnvNames.size);
  });

  it("derives env names from the document path", () => {
    expect(deriveCliConfigEnvName("auth.mfa.web_authn.enroll_enabled")).toBe(
      "SUPABASE_AUTH_MFA_WEB_AUTHN_ENROLL_ENABLED",
    );
    expect(CliConfigKeys.db.seed.enabled.env).toEqual(["SUPABASE_DB_SEED_ENABLED"]);
    expect(CliConfigKeys.db.seed.sqlPaths.path).toBe("db.seed.sql_paths");
  });

  it("never derives a name the CLI reads for something else", () => {
    const collisions = [...registryEnvNames].filter((name) => name in CLI_NON_CONFIG_ENV_NAMES);

    expect(collisions).toEqual([]);
  });

  it("accounts for every SUPABASE_* name the CLI source mentions outside the registry files", () => {
    expect(referencedEnvNames.size).toBeGreaterThan(25);
    const unaccounted = [...referencedEnvNames]
      .filter((name) => !name.endsWith("_"))
      .filter((name) => !registryEnvNames.has(name) && !(name in CLI_NON_CONFIG_ENV_NAMES));

    expect(unaccounted).toEqual([]);
  });

  it("produces an env override for every key the db reader honoured before the registry", () => {
    const dottedKeys: ReadonlyArray<string> = JSON.parse(
      readFileSync(join(srcDir, "config/testdata/env-overridable-keys.json"), "utf8"),
    );

    const missing = dottedKeys.filter((dotted) => {
      const key = cliConfigRegistry.keyAt(dotted);
      return key === undefined || !key.env.includes(deriveCliConfigEnvName(dotted));
    });

    expect(dottedKeys.length).toBeGreaterThan(150);
    expect(missing).toEqual([]);
  });

  it("follows the legacy prefixes for hooks, sms providers and the dynamic tables", () => {
    expect(CliConfigKeys.auth.hook.sendSms.uri.env).toEqual(["SUPABASE_AUTH_HOOK_SEND_SMS_URI"]);
    expect(CliConfigKeys.auth.sms.twilioVerify.accountSid.env).toEqual([
      "SUPABASE_AUTH_SMS_TWILIO_VERIFY_ACCOUNT_SID",
    ]);
    const [external, template, notification] = CLI_CONFIG_FAMILIES;
    expect(external && cliConfigFamilyKey(external, "custom_oidc", "secret")?.env).toEqual([
      "SUPABASE_AUTH_EXTERNAL_CUSTOM_OIDC_SECRET",
    ]);
    expect(template && cliConfigFamilyKey(template, "invite", "content_path")?.env).toEqual([
      "SUPABASE_AUTH_EMAIL_TEMPLATE_INVITE_CONTENT_PATH",
    ]);
    expect(
      notification && cliConfigFamilyKey(notification, "email_changed", "enabled")?.env,
    ).toEqual(["SUPABASE_AUTH_EMAIL_NOTIFICATION_EMAIL_CHANGED_ENABLED"]);
  });

  it("resolves every deprecated alias to a real key that keeps its canonical name first", () => {
    for (const [path, aliases] of Object.entries(CLI_CONFIG_ENV_ALIASES)) {
      const key = cliConfigRegistry.keyAt(path);
      expect(key?.env[0]).toBe(deriveCliConfigEnvName(path));
      expect(key?.env.slice(1)).toEqual(aliases);
    }
  });

  it("keeps document-only keys out of the environment and the linked password out of the document", () => {
    expect(CliConfigKeys.db.password.env).toEqual([]);
    expect(CliConfigKeys.db.rootKey.secret).toBe(true);
    expect(CliConfigKeys.linkedDb.password).toMatchObject({
      env: ["SUPABASE_DB_PASSWORD"],
      document: false,
      envScope: "linkedTarget",
    });
    expect(
      cliConfigRegistry.keys
        .filter((key) => key.envScope === "linkedTarget")
        .map((key) => key.path),
    ).toEqual(["linkedDb.password"]);
  });

  it("marks schema secrets and gates section-scoped env", () => {
    expect(CliConfigKeys.auth.jwtSecret.secret).toBe(true);
    expect(CliConfigKeys.auth.captcha.secret.envRequiresSection).toBe("auth.captcha");
    expect(CliConfigKeys.experimental.webhooks.enabled.envRequiresSection).toBe(
      "experimental.webhooks",
    );
    expect(CliConfigKeys.storage.imageTransformation.enabled.envRequiresSection).toBe(
      "storage.image_transformation",
    );
    expect(CliConfigKeys.db.seed.enabled.envRequiresSection).toBeUndefined();
  });

  it("exposes every registry key through the typed tree", () => {
    const misaligned = cliConfigRegistry.keys.filter((key) => treeLookup(key.path) !== key);

    expect(misaligned.map((key) => key.path)).toEqual([]);
  });

  it.effect("defaults every key to what the schema decodes from an empty document", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const decoded = Schema.decodeUnknownSync(CliConfigSchema)({});
      const context = {
        workdir: "/work/proj",
        projectRef: Option.none<string>(),
        path,
        configAt: () => undefined,
      };

      const mismatched = cliConfigRegistry.keys.flatMap((key) => {
        const raw = getDocumentValue(decoded, key.path);
        if (
          key.document === false ||
          key.materializeDefault === true ||
          cliConfigDocumentOnlyPaths.has(key.path)
        ) {
          return [];
        }
        const expected =
          raw === undefined
            ? Option.none()
            : key.normalize === undefined
              ? raw
              : key.normalize(raw, context);
        const actual = key.defaultValue(context);
        const matches =
          raw === undefined
            ? Option.isOption(actual) && Option.isNone(actual)
            : JSON.stringify(actual) === JSON.stringify(expected);
        return matches ? [] : [{ path: key.path, expected, actual }];
      });

      expect(mismatched).toEqual([]);
      expect(CliConfigKeys.db.rootKey.defaultValue(context)).toBe(DEFAULT_POSTGRES_ROOT_KEY);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it("keeps every schema leaf in the registry unless it is explicitly excluded", () => {
    expect(Object.keys(CLI_CONFIG_SCHEMA_EXCLUDED)).toEqual(["experimental.inspect.rules"]);
    expect(cliConfigRegistry.keyAt("experimental.inspect.rules")).toBeUndefined();
    expect(cliConfigRegistry.keyAt("experimental.webhooks.enabled")).toBeDefined();
  });

  it("refuses a schema leaf it has no codec for", () => {
    const withDate = Schema.Struct({ nested: Schema.Struct({ when: Schema.Date }) });

    expect(() => cliConfigSchemaKeyDefs(withDate.ast)).toThrow(/nested\.when/);
  });

  it("reads shell-only names for the project id and service role key", () => {
    expect(CliEnvNames.projectId.name).toBe(CliConfigKeys.projectId.env[0]);
    expect(CliEnvNames.authServiceRoleKey.name).toBe(CliConfigKeys.auth.serviceRoleKey.env[0]);
  });
});
