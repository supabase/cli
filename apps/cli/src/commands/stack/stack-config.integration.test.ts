// oxlint-disable-next-line effecttsgo/node-builtin-import -- filesystem test fixture uses the host adapter at this boundary
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- filesystem test fixture uses the host adapter at this boundary
import { join, win32 } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option, Path, Redacted } from "effect";
import { renderCliConfigTemplate } from "../../shared/init/project-init.templates.ts";

import { StackConfigError, loadStackConfig } from "./stack-config.ts";

const load = (projectRoot: string) =>
  loadStackConfig(projectRoot).pipe(Effect.provide(BunServices.layer));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(contents: string, signingKeys?: string): string {
  const root = mkdtempSync(join(tmpdir(), "supabase-stack-config-"));
  roots.push(root);
  mkdirSync(join(root, "supabase"), { recursive: true });
  mkdirSync(join(root, "supabase", "functions", "hello"), { recursive: true });
  mkdirSync(join(root, "supabase", "functions", "world"), { recursive: true });
  mkdirSync(join(root, "supabase", "functions", "plain"), { recursive: true });
  mkdirSync(join(root, "supabase", "functions", "old.backup"), { recursive: true });
  mkdirSync(join(root, "supabase", "functions", "_shared"), { recursive: true });
  writeFileSync(join(root, "supabase", "config.toml"), contents);
  writeFileSync(join(root, "supabase", ".env"), "CONFIG_FN=config-value\n");
  writeFileSync(
    join(root, "supabase", "functions", ".env"),
    'SHARED=shared\nOVERRIDE=shared\nQUOTED="hello # world" # comment\n',
  );
  writeFileSync(
    join(root, "supabase", "functions", "hello", ".env"),
    "LOCAL=local\nOVERRIDE=local\n",
  );
  writeFileSync(join(root, "supabase", "functions", "world", ".env"), "WORLD=yes\n");
  if (signingKeys !== undefined)
    writeFileSync(join(root, "supabase", "signing-keys.json"), signingKeys);
  return root;
}

describe("loadStackConfig", () => {
  it.effect("maps service settings, secrets, function files, and explicit ports", () => {
    const root = project(`
project_id = "stack-config-test"
[api]
port = 55421
schemas = ["public", "private"]
[db]
port = 55422
[db.pooler]
enabled = true
pool_mode = "session"
default_pool_size = 33
max_client_conn = 222
[auth]
jwt_secret = "01234567890123456789012345678901"
[auth.email.smtp]
enabled = true
host = "smtp.example.test"
port = 2525
user = "smtp-user"
pass = "smtp-secret"
admin_email = "admin@example.test"
sender_name = "Test"
[auth.external.github]
enabled = true
client_id = "client"
secret = "secret"
[auth.hook.custom_access_token]
enabled = true
uri = "pg-functions://custom"
[edge_runtime]
enabled = true
inspector_port = 58083
[functions.hello]
verify_jwt = false
import_map = "./functions/import_map.json"
entrypoint = "./functions/hello/index.ts"
env = { API_KEY = "env(CONFIG_FN)" }
`);
    return Effect.gen(function* () {
      const config = yield* load(root);
      expect(config.listeners).toMatchObject({
        api: { port: 55421 },
        database: { port: 55422 },
        functionsInspector: { port: 58083 },
      });
      expect(config.listeners?.studio).toBeUndefined();
      if (config.capabilities?.rest === undefined || !("settings" in config.capabilities.rest))
        throw new Error("REST settings missing");
      expect(config.capabilities.rest.settings?.schemas).toEqual(["public", "private"]);
      if (
        config.capabilities?.functions === undefined ||
        !("settings" in config.capabilities.functions)
      )
        throw new Error("Functions settings missing");
      expect(config.capabilities.functions.settings?.functions?.hello).toMatchObject({
        verify_jwt: false,
        import_map: "../import_map.json",
        entrypoint: "index.ts",
        env: {
          API_KEY: expect.anything(),
          SHARED: expect.anything(),
          LOCAL: expect.anything(),
          OVERRIDE: expect.anything(),
        },
      });
      expect(config.capabilities.functions.settings?.functions?.world?.env).toMatchObject({
        WORLD: expect.anything(),
      });
      const helloEnv = config.capabilities.functions.settings?.functions?.hello?.env;
      const plainEnv = config.capabilities.functions.settings?.functions?.plain?.env;
      expect(config.capabilities.functions.settings?.functions?.["old.backup"]).toBeUndefined();
      expect(config.capabilities.functions.settings?.functions?._shared).toBeUndefined();
      expect(helloEnv).toBeDefined();
      expect(plainEnv).toBeDefined();
      if (helloEnv === undefined || plainEnv === undefined) throw new Error("function env missing");
      expect(Redacted.value(helloEnv.API_KEY!)).toBe("config-value");
      expect(Redacted.value(helloEnv.OVERRIDE!)).toBe("local");
      expect(Redacted.value(plainEnv.SHARED!)).toBe("shared");
      expect(Redacted.value(plainEnv.QUOTED!)).toBe("hello # world");
      if (config.capabilities.auth === undefined || !("settings" in config.capabilities.auth))
        throw new Error("auth settings missing");
      expect(config.capabilities.auth.settings?.email?.smtp).toMatchObject({
        enabled: true,
        host: "smtp.example.test",
      });
      expect(config.capabilities.auth.settings?.external?.github).toMatchObject({
        enabled: true,
        client_id: "client",
      });
      expect(config.capabilities.auth.settings?.hook?.custom_access_token).toMatchObject({
        enabled: true,
        uri: "pg-functions://custom",
      });
      if (config.capabilities.pooler === undefined || !("settings" in config.capabilities.pooler))
        throw new Error("pooler settings missing");
      expect(config.capabilities.pooler.settings).toMatchObject({
        pool_mode: "session",
        default_pool_size: 33,
        max_client_conn: 222,
      });
      expect(config.security?.jwt?.signing?.kind).toBe("symmetric");
    });
  });

  it.effect("rejects an enabled provider the stack cannot represent", () => {
    const root = project(`project_id = "stack-config-figma"
[auth.external.figma]
enabled = true
client_id = "figma-client"
secret = "figma-secret"
`);
    return Effect.gen(function* () {
      const exit = yield* load(root).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("auth.external.figma");
    });
  });

  it.effect("keeps disabled unsupported providers harmless", () => {
    const root = project(`project_id = "stack-config-disabled-figma"
[auth.external.figma]
enabled = false
`);
    return Effect.gen(function* () {
      const config = yield* load(root);
      if (config.capabilities?.auth === undefined || !("settings" in config.capabilities.auth))
        throw new Error("auth settings missing");
      expect(Object.hasOwn(config.capabilities.auth.settings?.external ?? {}, "figma")).toBe(false);
    });
  });

  it.effect("rejects an unset function env reference without dropping it", () => {
    const root = project(`project_id = "stack-config-missing-env"
[functions.hello]
env = { TOKEN = "env(SUPABASE_STACK_TEST_MISSING_ENV)" }
`);
    return Effect.gen(function* () {
      const exit = yield* load(root).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("functions.hello.env");
    });
  });

  it.effect("reports unsupported dotenv keys with the file and key only", () => {
    const root = project('project_id = "stack-config-invalid-env-key"\n');
    writeFileSync(join(root, "supabase", "functions", ".env"), "lowercase=value\nSECRET=value\n");
    return Effect.gen(function* () {
      const exit = yield* load(root).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) expect(failure.value).toBeInstanceOf(StackConfigError);
        const message = String(exit.cause);
        expect(message).toContain("functions/.env");
        expect(message).toContain("lowercase");
        expect(message).not.toContain("value");
      }
    });
  });

  it.effect("sanitizes malformed dotenv parser errors", () => {
    const root = project('project_id = "stack-config-malformed-env"\n');
    writeFileSync(join(root, "supabase", "functions", ".env"), "BROKEN=value\n!=secret-value\n");
    return Effect.gen(function* () {
      const exit = yield* load(root).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("Failed to parse environment file");
        expect(String(exit.cause)).not.toContain("secret-value");
        expect(String(exit.cause)).not.toContain("StackConfigError: StackConfigError");
      }
    });
  });

  it.effect("preserves platform-specific absolute signing paths", () => {
    const root = project(
      `project_id = "stack-config-windows-signing-path"
[auth]
signing_keys_path = 'C:\\keys\\signing.json'
`,
    );
    return Effect.gen(function* () {
      const nativePath = yield* Path.Path;
      const config = yield* loadStackConfig(root).pipe(
        Effect.provideService(Path.Path, { ...nativePath, isAbsolute: win32.isAbsolute }),
      );
      expect(config.security?.jwt?.signing).toEqual({
        kind: "jwks-file",
        path: "C:\\keys\\signing.json",
      });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("rejects encrypted secrets with a targeted diagnostic", () => {
    const root = project(
      `project_id = "stack-config-encrypted-secret"
[auth]
jwt_secret = "encrypted:not-a-real-ciphertext"
`,
    );
    return Effect.gen(function* () {
      const exit = yield* load(root).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const message = String(exit.cause);
        expect(message).toContain("capabilities.auth.settings.jwt_secret uses an encrypted secret");
        expect(message).not.toContain("not-a-real-ciphertext");
      }
    });
  });

  it.effect("rejects encrypted function dotenv values", () => {
    const root = project('project_id = "stack-config-encrypted-function-secret"\n');
    writeFileSync(join(root, "supabase", "functions", ".env"), "DOTENV=encrypted:dotenv\n");
    return Effect.gen(function* () {
      const exit = yield* load(root).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const message = String(exit.cause);
        expect(message).toContain("uses an encrypted secret");
        expect(message).not.toContain("encrypted:dotenv");
      }
    });
  });

  it.effect("rejects function paths outside the function root", () => {
    const root = project(`project_id = "stack-config-outside-function"

[functions.hello]
import_map = "./import_map.json"
`);
    return Effect.gen(function* () {
      const exit = yield* load(root).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("functions.hello.import_map");
    });
  });

  it.effect(
    "rejects supabase-prefixed function paths that resolve outside the project root",
    () => {
      const root = project(`project_id = "stack-config-nested-supabase"

[functions.hello]
entrypoint = "supabase/functions/hello/index.ts"
`);
      return Effect.gen(function* () {
        const exit = yield* load(root).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(String(exit.cause)).toContain("functions.hello.entrypoint");
      });
    },
  );

  it.effect("resolves supabase-prefixed signing paths beneath the config directory", () => {
    const root = project(
      `project_id = "stack-config-signing-path"
[auth]
signing_keys_path = "supabase/signing-keys.json"
`,
    );
    return Effect.gen(function* () {
      const config = yield* load(root);
      expect(config.security?.jwt?.signing).toEqual({
        kind: "jwks-file",
        path: "supabase/supabase/signing-keys.json",
      });
    });
  });

  it.effect("lets the stack runtime resolve the API port for Studio's default URL", () => {
    const root = project('project_id = "stack-config-studio-default"\n');
    return Effect.gen(function* () {
      const config = yield* load(root);
      if (config.capabilities?.studio === undefined || !("settings" in config.capabilities.studio))
        throw new Error("Studio settings missing");
      expect(config.capabilities.studio.settings).toEqual({
        api_url: undefined,
        openai_api_key: undefined,
      });
    });
  });

  it.effect("parses legacy dotenv expansion and colon assignments", () => {
    const root = project('project_id = "stack-config-dotenv-compat"\n');
    writeFileSync(
      join(root, "supabase", "functions", ".env"),
      "BASE=shared\nEXPANDED=$BASE\nCOLON: colon-value\n",
    );
    return Effect.gen(function* () {
      const config = yield* load(root);
      if (
        config.capabilities?.functions === undefined ||
        !("settings" in config.capabilities.functions)
      )
        throw new Error("Functions settings missing");
      const env = config.capabilities.functions.settings?.functions?.hello?.env;
      expect(env).toBeDefined();
      if (env === undefined) throw new Error("Function env missing");
      expect(Redacted.value(env.EXPANDED!)).toBe("shared");
      expect(Redacted.value(env.COLON!)).toBe("colon-value");
    });
  });

  it.effect("keeps the gateway listener when API service is disabled for auth", () => {
    const root = project(`project_id = "stack-config-gateway"
[api]
enabled = false
port = 55430
[auth]
enabled = true
`);
    return Effect.gen(function* () {
      const config = yield* load(root);
      expect(config.listeners?.api).toEqual({ port: 55430 });
    });
  });

  it.effect("keeps the gateway listener when analytics is enabled", () => {
    const root = project(`project_id = "stack-config-analytics-gateway"
[api]
enabled = false
port = 55431
[auth]
enabled = false
[realtime]
enabled = false
[storage]
enabled = false
[edge_runtime]
enabled = false
[analytics]
enabled = true
`);
    return Effect.gen(function* () {
      const config = yield* load(root);
      expect(config.listeners?.api).toEqual({ port: 55431 });
    });
  });

  it.effect("keeps disabled functions capability free of settings", () => {
    const root = project(`project_id = "stack-config-disabled-functions"
[edge_runtime]
enabled = false
`);
    return Effect.gen(function* () {
      const config = yield* load(root);
      expect(config.capabilities?.functions).toEqual({ enabled: false });
    });
  });

  it.effect("leaves listeners absent when ports are omitted", () => {
    const root = project(`project_id = "stack-config-defaults"
[edge_runtime]
enabled = true
`);
    return Effect.gen(function* () {
      const config = yield* load(root);
      expect(config.listeners).toEqual({});
      expect(config.listeners?.functionsInspector).toBeUndefined();
      if (config.capabilities?.database !== undefined && "settings" in config.capabilities.database)
        expect(config.capabilities.database.settings?.health_timeout).toBe("2m");
    });
  });

  it.effect("loads the actual initialized stack config template", () => {
    const root = project(renderCliConfigTemplate("stack-config-init", false));
    return Effect.gen(function* () {
      const config = yield* load(root);
      expect(config.listeners?.api).toEqual({ port: 54321 });
      expect(config.listeners?.database).toEqual({ port: 54322 });
      expect(config.listeners?.pooler).toEqual({ enabled: false });
      expect(config.listeners?.smtp).toBeUndefined();
      expect(config.listeners?.pop3).toBeUndefined();
      expect(config.listeners?.functionsInspector).toEqual({ port: 8083 });
    });
  });

  it.effect("ignores unresolved function env references when edge runtime is disabled", () => {
    const root = project(`project_id = "stack-config-disabled-functions-env"
[edge_runtime]
enabled = false
[functions.hello]
env = { TOKEN = "env(SUPABASE_STACK_TEST_DISABLED_MISSING_ENV)" }
`);
    return Effect.gen(function* () {
      const config = yield* load(root);
      expect(config.capabilities?.functions).toEqual({ enabled: false });
    });
  });

  it.effect("does not read disabled edge runtime dotenv files", () => {
    const root = project(`project_id = "stack-config-disabled-dotenv"
[edge_runtime]
enabled = false
`);
    writeFileSync(join(root, "supabase", "functions", ".env"), "lowercase=value\n");
    return Effect.gen(function* () {
      const config = yield* load(root);
      expect(config.capabilities?.functions).toEqual({ enabled: false });
    });
  });

  it.effect("accepts the initialized disabled service listeners with explicit ports", () => {
    const root = project(`project_id = "stack-config-disabled-listeners"
[api]
enabled = false
port = 55431
[auth]
enabled = false
[realtime]
enabled = false
[storage]
enabled = false
[db]
port = 55432
[db.pooler]
enabled = false
port = 55433
[studio]
enabled = false
port = 55434
[local_smtp]
enabled = false
port = 55435
smtp_port = 55436
pop3_port = 55437
[edge_runtime]
enabled = false
inspector_port = 55438
[analytics]
enabled = false
`);
    return Effect.gen(function* () {
      const config = yield* load(root);
      expect(config.listeners).toEqual({
        api: { enabled: false },
        database: { port: 55432 },
        pooler: { enabled: false },
        studio: { enabled: false },
        mailUi: { enabled: false },
        smtp: { enabled: false },
        pop3: { enabled: false },
        functionsInspector: { enabled: false },
      });
    });
  });

  it.effect("fails clearly when the project has not been initialized", () => {
    const root = mkdtempSync(join(tmpdir(), "supabase-stack-config-empty-"));
    roots.push(root);
    return Effect.gen(function* () {
      const exit = yield* loadStackConfig(root).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("supabase init");
    }).pipe(Effect.provide(BunServices.layer));
  });
});
