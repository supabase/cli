import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CLI_CONFIG_ENV_ALIASES,
  CLI_CONFIG_FAMILIES,
  CLI_NON_CONFIG_ENV_NAMES,
} from "./cli-config-key-annotations.ts";
import {
  CliConfigKeys,
  CliEnvNames,
  cliConfigFamilyKey,
  cliConfigRegistry,
  deriveCliConfigEnvName,
} from "./cli-config-keys.ts";
import { CLI_CONFIG_TIER_ORDER } from "./cli-config-key.ts";

const srcDir = fileURLToPath(new URL("..", import.meta.url));

const productionSources = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts") && !file.endsWith(".test.ts"))
  .filter((file) => !file.includes("__fixtures__") && !file.startsWith("shared/compute/stacks"))
  .map((file) => ({ file, text: readFileSync(join(srcDir, file), "utf8") }));

const quotedEnvNames = new Set(
  productionSources.flatMap(({ text }) =>
    [...text.matchAll(/["'`](SUPABASE_[A-Z0-9_]+)["'`]/g)].map((match) => match[1] ?? ""),
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
  it("resolves tiers in the fixed order", () => {
    expect(CLI_CONFIG_TIER_ORDER).toEqual(["flag", "shell", "projectEnv", "config", "default"]);
  });

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

  it("accounts for every SUPABASE_* name the CLI source reads", () => {
    expect(quotedEnvNames.size).toBeGreaterThan(100);
    const unaccounted = [...quotedEnvNames]
      .filter((name) => !name.endsWith("_"))
      .filter((name) => !registryEnvNames.has(name) && !(name in CLI_NON_CONFIG_ENV_NAMES));

    expect(unaccounted).toEqual([]);
  });

  it("produces every env override the legacy db reader honours", () => {
    const reader = readFileSync(join(srcDir, "command-internal/db-config.toml-read.ts"), "utf8");
    const block = /const ENV_OVERRIDABLE_KEYS = \[([\s\S]*?)\] as const;/.exec(reader)?.[1] ?? "";
    const dottedKeys = [...block.matchAll(/"([a-z0-9_.]+)"/g)].map((match) => match[1] ?? "");

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

  it("reads shell-only names for the project id and service role key", () => {
    expect(CliEnvNames.projectId.name).toBe(CliConfigKeys.projectId.env[0]);
    expect(CliEnvNames.authServiceRoleKey.name).toBe(CliConfigKeys.auth.serviceRoleKey.env[0]);
  });
});
