import { inspect } from "node:util";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Option, Path, Predicate } from "effect";

import { pinnedConfigProvider } from "../../../../tests/helpers/config-env-pins.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { mockOutput, mockProcessControl } from "../../../../tests/helpers/mocks.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { CliEnvNameSource } from "../../../shared/config/cli-config-provider.layer.ts";
import { renderCliConfigTemplate } from "../../../shared/init/project-init.templates.ts";
import type { OutputFormat } from "../../../shared/output/types.ts";
import { configValidate } from "./validate.handler.ts";

const tempRoot = useTempWorkdir("supabase-config-validate-");

interface RunOptions {
  readonly format?: OutputFormat;
  readonly outputFlag?: "json";
  readonly env?: Readonly<Record<string, string>>;
  readonly resolveEnv?: boolean;
}

const writeFile = Effect.fnUntraced(function* (relative: string, text: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(tempRoot.current, relative);
  yield* fs.makeDirectory(path.dirname(target), { recursive: true });
  yield* fs.writeFileString(target, text);
});

const validate = Effect.fnUntraced(function* (
  files: Readonly<Record<string, string>>,
  options: RunOptions = {},
) {
  for (const [relative, text] of Object.entries(files)) yield* writeFile(relative, text);
  const out = mockOutput({ format: options.format ?? "text" });
  const telemetry = mockTelemetryStateTracked();
  const processControl = mockProcessControl();
  const layer = Layer.mergeAll(
    out.layer,
    telemetry.layer,
    processControl.layer,
    mockCommandSettings({ workdir: tempRoot.current, explicitWorkdir: true }),
    Layer.succeed(
      OutputFlag,
      options.outputFlag === undefined ? Option.none() : Option.some(options.outputFlag),
    ),
    Layer.effect(ConfigProvider.ConfigProvider, pinnedConfigProvider(options.env)),
    Layer.succeed(CliEnvNameSource, () => Object.keys(options.env ?? {})),
    BunServices.layer,
  );
  const outcome = yield* configValidate({ resolveEnv: options.resolveEnv === true }).pipe(
    Effect.provide(layer),
    Effect.result,
  );
  return {
    stdout: out.stdoutText,
    stderr: out.stderrText,
    failure: outcome._tag === "Failure" ? outcome.failure : undefined,
    failureTag:
      outcome._tag === "Failure" && Predicate.hasProperty(outcome.failure, "_tag")
        ? outcome.failure._tag
        : undefined,
    exitCode: processControl.exitCode,
    successes: out.messages.filter((message) => message.type === "success"),
    flushed: telemetry.flushed,
  };
});

const tomlFile = (text: string) => ({ "supabase/config.toml": text });

const SPEC_TOML = `project_id = "demo"

[api]
enabled = true
prot = 54321
max_rows = "lots"

[db]
major_version = 16

[auth.external.github]
enabled = true

[auth.email.smtp]
enabled = true
host = "smtp.test"
port = 587
user = "mailer"
pass = "env(SMTP_PASS)"
admin_email = "a@test.dev"

[remotes.staging]
project_id = "abcdefghijklmnopqrst"

[remotes.staging.api]
max_rows = "many"
`;

const SPEC_JSONC = `{
  // three problems on three lines
  "project_id": "demo",
  "api": {
    "prot": 54321,
    "max_rows": "lots",
  },
  "db": { "major_version": 16 }
}
`;

const reportedTexts = (result: {
  readonly stdout: string;
  readonly successes: ReadonlyArray<unknown>;
}) => `${result.stdout}\n${inspect(result.successes, { depth: 10 })}`;

const payloadOf = (result: { readonly successes: ReadonlyArray<{ readonly data?: unknown }> }) =>
  result.successes[0]?.data;

describe("config validate integration", () => {
  it.effect("accepts the init template with no warnings", () =>
    Effect.gen(function* () {
      const text = yield* validate(tomlFile(renderCliConfigTemplate("demo", false)));
      expect(text.failure).toBeUndefined();
      expect(text.stdout).toBe(
        "✓ supabase/config.toml is valid\n  7 values come from env(); run with --resolve-env to check them\n",
      );
      expect(text.stderr).toBe("");
      expect(text.exitCode).toBeUndefined();
      expect(text.flushed).toBe(true);

      const json = yield* validate(tomlFile(renderCliConfigTemplate("demo", false)), {
        format: "json",
      });
      expect(payloadOf(json)).toEqual({
        schema_version: 1,
        valid: true,
        complete: true,
        file: "supabase/config.toml",
        format: "toml",
        remotes: [],
        unknown_values: 7,
        deferred: [],
        errors: [],
        warnings: [],
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("accepts JSON and JSONC configs", () =>
    Effect.gen(function* () {
      const json = yield* validate({ "supabase/config.json": '{ "project_id": "demo" }' });
      expect(json.stdout).toBe("✓ supabase/config.json is valid\n");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("accepts a JSONC config with comments and trailing commas", () =>
    Effect.gen(function* () {
      const result = yield* validate({
        "supabase/config.jsonc": '{\n  // name\n  "project_id": "demo",\n}\n',
      });
      expect(result.stdout).toBe("✓ supabase/config.jsonc is valid\n");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("reports every problem of the spec config in one run and exits 1 quietly", () =>
    Effect.gen(function* () {
      const result = yield* validate(tomlFile(SPEC_TOML));

      expect(result.failure).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toMatchInlineSnapshot(`
        "  ✗ api.prot  unknown key
            supabase/config.toml:5:1
            help: did you mean \`port\`?

          ✗ api.max_rows  expected a non-negative integer
            supabase/config.toml:6:12

          ✗ db.major_version  unsupported Postgres version
            supabase/config.toml:9:17
            help: use one of 14, 15, 17

          ✗ auth.external.github.client_id  required when auth.external.github.enabled = true
            supabase/config.toml:11:2
            help: set client_id, or set enabled = false

          ✗ auth.external.github.secret  required when auth.external.github.enabled = true
            supabase/config.toml:11:2
            help: set secret, or set enabled = false

          ✗ api.max_rows  expected a non-negative integer  [remote: staging]
            supabase/config.toml:26:12

        ✗ 6 errors in supabase/config.toml
          1 value comes from env() and 1 check was not run; run with --resolve-env to check them
          Checked remotes: staging
        "
      `);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("reports the spec config as a JSON payload", () =>
    Effect.gen(function* () {
      const result = yield* validate(tomlFile(SPEC_TOML), { format: "json" });

      expect(result.exitCode).toBe(1);
      expect(payloadOf(result)).toMatchInlineSnapshot(`
        {
          "complete": true,
          "deferred": [
            {
              "check": "auth.email.smtp.pass",
              "reason": "env",
              "waits_on": [
                "auth.email.smtp.pass",
              ],
            },
          ],
          "errors": [
            {
              "code": "unknown_key",
              "column": 1,
              "end_column": 5,
              "end_line": 5,
              "help": "did you mean \`port\`?",
              "key": "api.prot",
              "line": 5,
              "path": "api.prot",
              "reason": "unknown key",
              "severity": "error",
            },
            {
              "code": "invalid_value",
              "column": 12,
              "end_column": 18,
              "end_line": 6,
              "key": "api.max_rows",
              "line": 6,
              "path": "api.max_rows",
              "reason": "expected a non-negative integer",
              "severity": "error",
            },
            {
              "code": "invalid_value",
              "column": 17,
              "end_column": 19,
              "end_line": 9,
              "help": "use one of 14, 15, 17",
              "key": "db.major_version",
              "line": 9,
              "path": "db.major_version",
              "reason": "unsupported Postgres version",
              "severity": "error",
            },
            {
              "code": "missing_required",
              "column": 2,
              "end_column": 22,
              "end_line": 11,
              "help": "set client_id, or set enabled = false",
              "key": "auth.external.github.client_id",
              "line": 11,
              "path": "auth.external.github.client_id",
              "reason": "required when auth.external.github.enabled = true",
              "severity": "error",
            },
            {
              "code": "missing_required",
              "column": 2,
              "end_column": 22,
              "end_line": 11,
              "help": "set secret, or set enabled = false",
              "key": "auth.external.github.secret",
              "line": 11,
              "path": "auth.external.github.secret",
              "reason": "required when auth.external.github.enabled = true",
              "severity": "error",
            },
            {
              "code": "invalid_value",
              "column": 12,
              "end_column": 18,
              "end_line": 26,
              "key": "remotes.staging.api.max_rows",
              "line": 26,
              "path": "api.max_rows",
              "reason": "expected a non-negative integer",
              "remote": "staging",
              "severity": "error",
            },
          ],
          "file": "supabase/config.toml",
          "format": "toml",
          "remotes": [
            "staging",
          ],
          "schema_version": 1,
          "unknown_values": 1,
          "valid": false,
          "warnings": [],
        }
      `);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("reports problems in a JSONC config", () =>
    Effect.gen(function* () {
      const result = yield* validate({ "supabase/config.jsonc": SPEC_JSONC });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toMatchInlineSnapshot(`
        "  ✗ api.prot  unknown key
            supabase/config.jsonc:5:5
            help: did you mean \`port\`?

          ✗ api.max_rows  expected a non-negative integer
            supabase/config.jsonc:6:17

          ✗ db.major_version  unsupported Postgres version
            supabase/config.jsonc:8:28
            help: use one of 14, 15, 17

        ✗ 3 errors in supabase/config.jsonc
        "
      `);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("keeps checking values and validations after a schema error", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile(
          `project_id = "demo"\n[api]\nmax_rows = "lots"\n[db]\nmajor_version = 16\nport = 54322\n[auth.captcha]\nenabled = true\nprovider = "turnstile"\n`,
        ),
      );

      const data = payloadOf(
        yield* validate(tomlFile('project_id = "demo"\n'), { format: "json" }),
      );
      expect(data).toMatchObject({ valid: true });
      expect(result.stdout).toContain("api.max_rows");
      expect(result.stdout).toContain("db.major_version  unsupported Postgres version");
      expect(result.stdout).toContain(
        "auth.captcha.secret  required when auth.captcha.enabled = true",
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("reports a removed key together with a typo and the rest", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile(
          `project_id = "demo"\n[inbucket]\nport = 54324\n[api]\nprot = 1\n[db]\nmajor_version = 16\n`,
        ),
        { format: "json" },
      );

      const data = payloadOf(result);
      expect(data).toMatchObject({ valid: false, complete: true });
      expect(Reflect.get(data ?? {}, "errors")).toMatchObject([
        { code: "removed_key", key: "inbucket", help: "rename [inbucket] to [local_smtp]" },
        { code: "unknown_key", key: "api.prot" },
        { code: "invalid_value", key: "db.major_version" },
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("keeps validating the base when a remote has a structural error", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile(
          `project_id = "demo"\n[db]\nmajor_version = 16\n[remotes.prod]\nproject_id = "abcdefghijklmnopqrst"\n[remotes.prod.api]\nmax_rows = "many"\n`,
        ),
      );

      expect(result.stdout).toContain("db.major_version  unsupported Postgres version");
      expect(result.stdout).toContain("api.max_rows");
      expect(result.stdout).toContain("[remote: prod]");
      expect(result.stdout).not.toContain("[remote: prod]\n    supabase/config.toml:3");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("reports every bad remote project_id and still validates every remote block", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile(
          `project_id = "demo"\n[remotes.a]\nproject_id = "bad"\n[remotes.b]\nproject_id = "worse"\n[remotes.c]\nproject_id = "abcdefghijklmnopqrst"\n[remotes.c.api]\nmax_rows = "many"\n`,
        ),
        { format: "json" },
      );

      const data = payloadOf(result);
      expect(data).toMatchObject({
        remotes: ["a", "b", "c"],
        complete: true,
      });
      expect(Reflect.get(data ?? {}, "errors")).toMatchObject([
        { code: "remote_project_id", key: "remotes.a.project_id", remote: "a" },
        { code: "remote_project_id", key: "remotes.b.project_id", remote: "b" },
        { code: "invalid_value", key: "remotes.c.api.max_rows", remote: "c" },
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("reports a duplicate remote project_id against the later remote", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile(
          `project_id = "demo"\n[remotes.a]\nproject_id = "abcdefghijklmnopqrst"\n[remotes.b]\nproject_id = "abcdefghijklmnopqrst"\n`,
        ),
      );

      expect(result.stdout).toContain("project_id  same project_id as remotes.a  [remote: b]");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("still validates a duplicate remote and quotes a bracketed original", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile(
          `project_id = "demo"\n[remotes."a]b"]\nproject_id = "abcdefghijklmnopqrst"\n[remotes.b]\nproject_id = "abcdefghijklmnopqrst"\n[remotes.b.api]\nmax_rows = "lots"\n`,
        ),
        { format: "json" },
      );

      const data = payloadOf(result) ?? {};
      expect(Reflect.get(data, "remotes")).toContain("b");
      expect(Reflect.get(data, "errors")).toMatchObject([
        {
          code: "remote_project_id",
          remote: "b",
          reason: 'same project_id as remotes."a]b"',
        },
        { code: "invalid_value", remote: "b", key: "remotes.b.api.max_rows" },
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("stops and says so when the env files cannot be read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(tempRoot.current, "supabase", ".env"), { recursive: true });
      const result = yield* validate(tomlFile('project_id = "demo"\n[db]\nmajor_version = 16\n'), {
        format: "json",
        resolveEnv: true,
      });

      expect(payloadOf(result)).toMatchObject({
        valid: false,
        complete: false,
        stopped_at: "env_file",
      });
      expect(Reflect.get(payloadOf(result) ?? {}, "errors")).toMatchObject([{ code: "env_file" }]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("stops after a syntax error and reports it as incomplete", () =>
    Effect.gen(function* () {
      const text = yield* validate(tomlFile('project_id = "demo"\n[db\nport = 1\n'));
      expect(text.stdout).toContain("Stopped after the syntax check.");
      expect(text.stdout).toContain("run supabase config validate again to check the rest");

      const json = yield* validate(tomlFile('project_id = "demo"\n[db\nport = 1\n'), {
        format: "json",
      });
      expect(payloadOf(json)).toMatchObject({
        valid: false,
        complete: false,
        stopped_at: "syntax",
      });
      expect(Reflect.get(payloadOf(json) ?? {}, "errors")).toMatchObject([
        { code: "syntax", line: 2 },
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("stops when config.json and config.jsonc both exist", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        {
          "supabase/config.json": '{ "project_id": "a" }',
          "supabase/config.jsonc": '{ "project_id": "b" }',
        },
        { format: "json" },
      );

      expect(payloadOf(result)).toMatchObject({
        valid: false,
        complete: false,
        stopped_at: "file_conflict",
      });
      expect(Reflect.get(payloadOf(result) ?? {}, "errors")).toMatchObject([
        {
          code: "file_conflict",
          reason: "supabase/config.json and supabase/config.jsonc both exist",
          help: "delete the file you don't use",
        },
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("points at the schema declaration when the config schema is too new", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile('#:schema https://supabase.com/schemas/config/v99.json\nproject_id = "demo"\n'),
      );

      expect(result.stdout).toContain("supabase/config.toml:1:10");
      expect(result.stdout).toContain("Stopped after the schema version check.");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("treats a config.toml beside config.json as an error", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        {
          "supabase/config.json": '{ "project_id": "demo" }',
          "supabase/config.toml": 'project_id = "other"\n',
        },
        { format: "json" },
      );

      expect(result.exitCode).toBe(1);
      expect(Reflect.get(payloadOf(result) ?? {}, "errors")).toMatchObject([
        {
          code: "shadowed_file",
          file: "supabase/config.toml",
          reason: "is not validated or used: supabase/config.json takes precedence",
          help: "delete the file you don't use",
        },
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("does not let an unset base reference hide a remote's own error", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile(
          'project_id = "demo"\n[api]\nmax_rows = "env(ROWS)"\n[remotes.prod]\nproject_id = "abcdefghijklmnopqrst"\n[remotes.prod.api]\nmax_rows = "many"\n',
        ),
        { format: "json" },
      );

      expect(Reflect.get(payloadOf(result) ?? {}, "errors")).toMatchObject([
        { code: "invalid_value", key: "remotes.prod.api.max_rows" },
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("masks the siblings of an env() reference held in an array", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile(
          'project_id = "demo"\n[api]\nschemas = ["env(UNSET_SCHEMA)", "hunter2-do-not-print"]\n',
        ),
        { resolveEnv: true },
      );

      expect(result.stdout).toContain("UNSET_SCHEMA is not set. It is used at 3:");
      expect(reportedTexts(result)).not.toContain("hunter2-do-not-print");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("keeps an unknown key whose value is an unresolved env() reference", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile('project_id = "demo"\n[api]\nprot = "env(UNSET_PORT)"\n'),
        { format: "json" },
      );

      expect(Reflect.get(payloadOf(result) ?? {}, "errors")).toMatchObject([
        { code: "unknown_key", key: "api.prot" },
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("reports a remotes key that is not a table, and a remote that is not a table", () =>
    Effect.gen(function* () {
      const scalar = yield* validate(tomlFile('project_id = "demo"\nremotes = 123\n'), {
        format: "json",
      });
      expect(Reflect.get(payloadOf(scalar) ?? {}, "errors")).toMatchObject([
        { code: "invalid_type", key: "remotes", line: 2, column: 11 },
      ]);

      const entry = yield* validate(
        tomlFile('project_id = "demo"\n[remotes]\nstaging = "abcdefghijklmnopqrst"\n'),
        { format: "json" },
      );
      expect(Reflect.get(payloadOf(entry) ?? {}, "errors")).toMatchObject([
        { code: "invalid_type", key: "remotes.staging", line: 3 },
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("names the real env file and failure kind when a root .env cannot be parsed", () =>
    Effect.gen(function* () {
      yield* writeFile(".env", "!bad-line-do-not-print\n");
      const result = yield* validate(tomlFile('project_id = "demo"\n'), {
        format: "json",
        resolveEnv: true,
      });

      expect(payloadOf(result)).toMatchObject({ complete: false, stopped_at: "env_file" });
      expect(Reflect.get(payloadOf(result) ?? {}, "errors")).toMatchObject([
        { code: "env_file", file: ".env", reason: "could not be parsed" },
      ]);
      expect(reportedTexts(result)).not.toContain("bad-line-do-not-print");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("locates a key under a table whose name contains a dot", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile(
          'project_id = "demo"\n[storage.buckets.images]\npublic = true\n[storage.buckets.images.prod]\npublic = false\n[storage.buckets."images.prod"]\npublic = "yes"\n',
        ),
        { format: "json" },
      );

      expect(Reflect.get(payloadOf(result) ?? {}, "errors")).toContainEqual(
        expect.objectContaining({ code: "invalid_type", line: 7, column: 10 }),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("validates a remote block whose project_id is unusable", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile(
          'project_id = "demo"\n[remotes.c]\nproject_id = "env(CPID)"\n[remotes.c.api]\nport = "zz"\n[remotes.c.db]\nmajor_version = 99\n',
        ),
        { format: "json" },
      );

      const data = payloadOf(result) ?? {};
      expect(Reflect.get(data, "valid")).toBe(false);
      expect(Reflect.get(data, "remotes")).toEqual(["c"]);
      expect(Reflect.get(data, "errors")).toMatchObject([
        { remote: "c", key: "remotes.c.api.port" },
        { remote: "c", key: "remotes.c.db.major_version" },
      ]);
      expect(Reflect.get(data, "warnings")).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("keeps a cross-key error that reads no unresolved reference", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile(
          'project_id = "demo"\n[auth.mfa.totp]\nenroll_enabled = true\n[auth.mfa.phone]\nverify_enabled = "env(VERIFY_PHONE)"\n',
        ),
        { format: "json" },
      );

      expect(Reflect.get(payloadOf(result) ?? {}, "errors")).toMatchObject([
        { key: "auth.mfa.totp.enroll_enabled" },
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("keeps a cross-key error whose check does not read the unresolved gate", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile(
          'project_id = "demo"\n[edge_runtime]\nenabled = "env(ENABLE_EDGE)"\ndeno_version = 99\n',
        ),
        { format: "json" },
      );

      expect(Reflect.get(payloadOf(result) ?? {}, "errors")).toMatchObject([
        { key: "edge_runtime.deno_version" },
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("keeps a remote's own error when the base value is unknown", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile(
          'project_id = "demo"\n[auth]\nenabled = "env(ENABLE_AUTH)"\nsite_url = ""\n[remotes.prod]\nproject_id = "abcdefghijklmnopqrst"\n[remotes.prod.auth]\nenabled = true\n',
        ),
        { format: "json" },
      );

      expect(Reflect.get(payloadOf(result) ?? {}, "errors")).toMatchObject([
        { key: "auth.site_url", remote: "prod" },
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  const GATED_PRODUCERS: ReadonlyArray<{
    readonly name: string;
    readonly gate: string;
    readonly error: string;
    readonly toml: (gate: string) => string;
  }> = [
    {
      name: "api required fields",
      gate: "api.enabled",
      error: "api.port",
      toml: (gate) => `[api]\nenabled = ${gate}\nport = 0\n`,
    },
    {
      name: "api.tls required paths",
      gate: "api.tls.enabled",
      error: "api.tls.cert_path",
      toml: (gate) => `[api.tls]\nenabled = ${gate}\nkey_path = "k.key"\n`,
    },
    {
      name: "api.tls file reads behind api.enabled",
      gate: "api.enabled",
      error: "api.tls.cert_path",
      toml: (gate) =>
        `[api]\nenabled = ${gate}\n[api.tls]\nenabled = true\ncert_path = "missing.pem"\nkey_path = "missing.key"\n`,
    },
    {
      name: "api.tls file reads behind api.tls.enabled",
      gate: "api.tls.enabled",
      error: "api.tls.cert_path",
      toml: (gate) =>
        `[api.tls]\nenabled = ${gate}\ncert_path = "missing.pem"\nkey_path = "missing.key"\n`,
    },
    {
      name: "studio required fields",
      gate: "studio.enabled",
      error: "studio.port",
      toml: (gate) => `[studio]\nenabled = ${gate}\nport = 0\n`,
    },
    {
      name: "local_smtp required port",
      gate: "local_smtp.enabled",
      error: "local_smtp.port",
      toml: (gate) => `[local_smtp]\nenabled = ${gate}\nport = 0\n`,
    },
    {
      name: "auth required fields",
      gate: "auth.enabled",
      error: "auth.site_url",
      toml: (gate) => `[auth]\nenabled = ${gate}\nsite_url = ""\n`,
    },
    {
      name: "auth signing keys read",
      gate: "auth.enabled",
      error: "auth.signing_keys_path",
      toml: (gate) => `[auth]\nenabled = ${gate}\nsigning_keys_path = "missing.json"\n`,
    },
    {
      name: "auth email template content read",
      gate: "auth.enabled",
      error: "auth.email.template.invite.content_path",
      toml: (gate) =>
        `[auth]\nenabled = ${gate}\n[auth.email.template.invite]\ncontent_path = "missing.html"\n`,
    },
    {
      name: "auth email notification content read",
      gate: "auth.email.notification.password_changed.enabled",
      error: "auth.email.notification.password_changed.content_path",
      toml: (gate) =>
        `[auth.email.notification.password_changed]\nenabled = ${gate}\ncontent_path = "missing.html"\n`,
    },
    {
      name: "auth.email.smtp required fields",
      gate: "auth.email.smtp.enabled",
      error: "auth.email.smtp.host",
      toml: (gate) => `[auth.email.smtp]\nenabled = ${gate}\n`,
    },
    {
      name: "auth.captcha required fields",
      gate: "auth.captcha.enabled",
      error: "auth.captcha.provider",
      toml: (gate) => `[auth.captcha]\nenabled = ${gate}\n`,
    },
    {
      name: "auth.hook uri",
      gate: "auth.hook.custom_access_token.enabled",
      error: "auth.hook.custom_access_token.uri",
      toml: (gate) => `[auth.hook.custom_access_token]\nenabled = ${gate}\nuri = ""\n`,
    },
    {
      name: "auth.third_party required field",
      gate: "auth.third_party.firebase.enabled",
      error: "auth.third_party.firebase.project_id",
      toml: (gate) => `[auth.third_party.firebase]\nenabled = ${gate}\n`,
    },
    {
      name: "auth.sms provider",
      gate: "auth.sms.twilio.enabled",
      error: "auth.sms.twilio.account_sid",
      toml: (gate) => `[auth.sms.twilio]\nenabled = ${gate}\n`,
    },
    {
      name: "auth.external provider",
      gate: "auth.external.myidp.enabled",
      error: "auth.external.myidp.secret",
      toml: (gate) => `[auth.external.myidp]\nenabled = ${gate}\nclient_id = "client"\n`,
    },
    {
      name: "auth.passkey webauthn",
      gate: "auth.passkey.enabled",
      error: "auth.webauthn",
      toml: (gate) => `[auth.passkey]\nenabled = ${gate}\n`,
    },
    {
      name: "analytics bigquery fields",
      gate: "analytics.enabled",
      error: "analytics.gcp_project_id",
      toml: (gate) => `[analytics]\nenabled = ${gate}\nbackend = "bigquery"\n`,
    },
  ];

  it.effect.each(GATED_PRODUCERS)(
    "defers $name when $gate is an env() reference, and reports it when the gate is true",
    ({ error, toml }) =>
      Effect.gen(function* () {
        const unset = yield* validate(tomlFile(`project_id = "demo"\n${toml('"env(GATE_ON)"')}`), {
          format: "json",
        });
        const open = yield* validate(tomlFile(`project_id = "demo"\n${toml("true")}`), {
          format: "json",
        });

        expect(payloadOf(unset)).toMatchObject({ valid: true, errors: [], warnings: [] });
        expect(Reflect.get(payloadOf(unset) ?? {}, "deferred")).not.toEqual([]);
        expect(Reflect.get(payloadOf(open) ?? {}, "errors")).toContainEqual(
          expect.objectContaining({ key: error }),
        );
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("still reports a malformed literal remote project_id", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile('project_id = "demo"\n[remotes.prod]\nproject_id = "nope"\n'),
        { format: "json" },
      );

      expect(Reflect.get(payloadOf(result) ?? {}, "errors")).toMatchObject([
        { code: "remote_project_id", remote: "prod", line: 3 },
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("scopes a removed-table rename hint to its remote", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile(
          'project_id = "demo"\n[remotes.prod]\nproject_id = "abcdefghijklmnopqrst"\n[remotes.prod.inbucket]\nport = 54324\n',
        ),
        { format: "json" },
      );

      expect(Reflect.get(payloadOf(result) ?? {}, "errors")).toMatchObject([
        {
          code: "removed_key",
          remote: "prod",
          help: "rename [remotes.prod.inbucket] to [remotes.prod.local_smtp]",
        },
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("keeps a dotted remote name whole in a removed-table rename hint", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile(
          'project_id = "demo"\n[remotes."prod.eu"]\nproject_id = "abcdefghijklmnopqrst"\n[remotes."prod.eu".inbucket]\nport = 54324\n',
        ),
        { format: "json" },
      );

      expect(Reflect.get(payloadOf(result) ?? {}, "errors")).toMatchObject([
        {
          code: "removed_key",
          remote: "prod.eu",
          help: 'rename [remotes."prod.eu".inbucket] to [remotes."prod.eu".local_smtp]',
        },
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("quotes the empty choice of a codec enum", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile('project_id = "demo"\n[auth]\npassword_requirements = "nope"\n'),
        { format: "json" },
      );

      expect(Reflect.get(payloadOf(result) ?? {}, "errors")).toMatchObject([
        {
          code: "invalid_enum",
          key: "auth.password_requirements",
          reason:
            'expected one of "", letters_digits, lower_upper_letters_digits, lower_upper_letters_digits_symbols',
        },
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("does not warn about unset env() references under a disabled custom provider", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile(
          'project_id = "demo"\n[auth.external.myidp]\nenabled = false\nclient_id = "env(UNSET_IDP_ID)"\nsecret = "env(UNSET_IDP_SECRET)"\n',
        ),
        { format: "json" },
      );

      expect(payloadOf(result)).toMatchObject({ valid: true });
      expect(Reflect.get(payloadOf(result) ?? {}, "warnings")).toEqual([]);
      expect(Reflect.get(payloadOf(result) ?? {}, "deferred")).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("reports a remote's own error when it replaces an unset env() value with a table", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile(
          'project_id = "demo"\n[api]\nmax_rows = "env(UNSET_ROWS)"\n[remotes.prod]\nproject_id = "abcdefghijklmnopqrst"\n[remotes.prod.api.max_rows]\nx = 1\n',
        ),
        { format: "json" },
      );

      expect(Reflect.get(payloadOf(result) ?? {}, "errors")).toContainEqual(
        expect.objectContaining({ remote: "prod", key: "remotes.prod.api.max_rows" }),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("locates a codec failure under a provider name that contains a dot", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile('project_id = "demo"\n[auth.external."my.idp"]\nenabled = "yes"\n'),
        { format: "json" },
      );

      expect(Reflect.get(payloadOf(result) ?? {}, "errors")).toContainEqual(
        expect.objectContaining({ line: 3 }),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect.each(["email", "sms"])(
    "names auth.%s.enabled by the spelling the document uses",
    (provider) =>
      Effect.gen(function* () {
        const result = yield* validate(
          tomlFile(`project_id = "demo"\n[auth.${provider}]\nenabled = "invalid"\n`),
          { format: "json" },
        );

        expect(Reflect.get(payloadOf(result) ?? {}, "errors")).toMatchObject([
          { key: `auth.${provider}.enabled`, line: 3 },
        ]);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("reports a present key with a bad value once, not also as missing", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile('project_id = "demo"\n[local.services.rest]\nversion = "tok-secret-orioledb"\n'),
        { format: "json" },
      );

      expect(Reflect.get(payloadOf(result) ?? {}, "errors")).toMatchObject([
        { code: "invalid_value", key: "local.services.rest.version", line: 3 },
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("locates a remote without project_id inside that remote, not on the base key", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile('project_id = "demo"\n[remotes.prod]\n[remotes.prod.api]\nmax_rows = 1\n'),
        { format: "json" },
      );

      expect(Reflect.get(payloadOf(result) ?? {}, "errors")).toMatchObject([
        { code: "remote_project_id", remote: "prod", line: 2 },
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("names the bigquery backend when a gcp key is missing", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile(
          'project_id = "demo"\n[analytics]\nenabled = true\nbackend = "bigquery"\ngcp_jwt_path = "k.json"\n',
        ),
      );

      expect(result.stdout).toContain(
        "analytics.gcp_project_id  required when analytics.backend = bigquery",
      );
      expect(result.stdout).toContain('help: set gcp_project_id, or set backend = "postgres"');
      expect(result.stdout).toContain('help: set gcp_project_number, or set backend = "postgres"');
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("names auth.passkey.enabled as the switch for missing webauthn keys", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile(
          'project_id = "demo"\n[auth.passkey]\nenabled = true\n[auth.webauthn]\nrp_display_name = "x"\n',
        ),
      );

      expect(result.stdout).toContain("help: set rp_id, or set auth.passkey.enabled = false");
      expect(result.stdout).not.toContain("set enabled = false");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("locates keys in a TOML file that starts with a byte order mark", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile('\uFEFFproject_id = "demo"\n[db]\nmajor_version = 16\n'),
        { format: "json" },
      );

      expect(Reflect.get(payloadOf(result) ?? {}, "errors")).toMatchObject([
        { key: "db.major_version", line: 3, column: 17, end_line: 3, end_column: 19 },
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("does not treat an env() reference as a value of the wrong type", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile('project_id = "demo"\n[api]\nport = "env(API_PORT)"\n'),
      );

      expect(result.exitCode).toBeUndefined();
      expect(result.stdout).toContain("✓ supabase/config.toml is valid");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("says how many values and checks the env() references left unchecked", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile(
          'project_id = "demo"\n[auth.captcha]\nenabled = true\nprovider = "turnstile"\nsecret = "env(CAPTCHA_SECRET)"\n',
        ),
      );

      expect(result.stdout).toMatch(
        /\n  1 value comes from env\(\) and \d+ checks? w(as|ere) not run; run with --resolve-env to check them\n/,
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("lists the deferred checks and unknown values in the JSON payload", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile(
          'project_id = "demo"\n[auth.captcha]\nenabled = true\nprovider = "turnstile"\nsecret = "env(CAPTCHA_SECRET)"\n',
        ),
        { format: "json" },
      );

      expect(payloadOf(result)).toMatchObject({ valid: true, complete: true, unknown_values: 1 });
      expect(Reflect.get(payloadOf(result) ?? {}, "deferred")).toContainEqual({
        check: "auth.captcha.secret",
        reason: "env",
        waits_on: ["auth.captcha.secret"],
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("reports a base error once, not again for every remote", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile(
          'project_id = "demo"\n[api]\nmax_rows = "lots"\n[remotes.a]\nproject_id = "abcdefghijklmnopqrst"\n[remotes.b]\nproject_id = "bbcdefghijklmnopqrst"\n',
        ),
        { format: "json" },
      );

      const errors = Reflect.get(payloadOf(result) ?? {}, "errors");
      expect(errors).toHaveLength(1);
      expect(errors).toMatchObject([{ key: "api.max_rows", line: 3 }]);
      expect(errors[0]).not.toHaveProperty("remote");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("locates a problem a remote causes in that remote", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile(
          'project_id = "demo"\n[remotes.a]\nproject_id = "abcdefghijklmnopqrst"\n[remotes.a.db]\nmajor_version = 99\n',
        ),
        { format: "json" },
      );

      expect(Reflect.get(payloadOf(result) ?? {}, "errors")).toMatchObject([
        { remote: "a", key: "remotes.a.db.major_version", line: 5 },
      ]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  describe("--resolve-env", () => {
    const OPTIONAL_TWICE =
      'project_id = "demo"\n[studio]\nopenai_api_key = "env(OPENAI)"\n[experimental]\ns3_access_key = "env(OPENAI)"\n';

    it.effect(
      "names a missing variable and every place it is used, as a warning when unneeded",
      () =>
        Effect.gen(function* () {
          const result = yield* validate(tomlFile(OPTIONAL_TWICE), { resolveEnv: true });

          expect(result.exitCode).toBeUndefined();
          expect(result.stdout).toContain(
            "⚠ studio.openai_api_key  OPENAI is not set. It is used at 3:18, 5:17",
          );
          expect(result.stdout).toContain("✓ supabase/config.toml is valid · 1 warning");
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.effect("reports a variable set to an empty value", () =>
      Effect.gen(function* () {
        const result = yield* validate(
          { ...tomlFile(OPTIONAL_TWICE), "supabase/.env": "OPENAI=\n" },
          { resolveEnv: true, format: "json" },
        );

        expect(Reflect.get(payloadOf(result) ?? {}, "warnings")).toMatchObject([
          { code: "env_empty", key: "studio.openai_api_key" },
        ]);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.effect("lets an empty shell variable mask a value in a .env file", () =>
      Effect.gen(function* () {
        const result = yield* validate(
          { ...tomlFile(OPTIONAL_TWICE), "supabase/.env": "OPENAI=from-file\n" },
          { resolveEnv: true, format: "json", env: { OPENAI: "" } },
        );

        expect(Reflect.get(payloadOf(result) ?? {}, "warnings")).toMatchObject([
          { code: "env_empty" },
        ]);
        expect(reportedTexts(result)).not.toContain("from-file");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.effect("accepts variables the shell and the selected .env.<name> file supply", () =>
      Effect.gen(function* () {
        const result = yield* validate(
          {
            ...tomlFile(
              'project_id = "demo"\n[studio]\nopenai_api_key = "env(FROM_SHELL)"\n[experimental]\ns3_access_key = "env(FROM_STAGING)"\n',
            ),
            "supabase/.env.staging": "FROM_STAGING=value\n",
          },
          {
            resolveEnv: true,
            env: { FROM_SHELL: "value", SUPABASE_ENV: "staging" },
          },
        );

        expect(result.stdout).toBe("✓ supabase/config.toml is valid\n");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.effect("makes an unset variable an error when a check needs it", () =>
      Effect.gen(function* () {
        const result = yield* validate(
          tomlFile(
            'project_id = "demo"\n[auth.captcha]\nenabled = true\nprovider = "turnstile"\nsecret = "env(CAPTCHA_SECRET)"\n',
          ),
          { resolveEnv: true, format: "json" },
        );

        expect(result.exitCode).toBe(1);
        expect(Reflect.get(payloadOf(result) ?? {}, "errors")).toMatchObject([
          { code: "env_unset", key: "auth.captcha.secret", line: 5 },
        ]);
        expect(Reflect.get(payloadOf(result) ?? {}, "deferred")).not.toEqual([]);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.effect("makes an unset variable an error when it feeds a number key", () =>
      Effect.gen(function* () {
        const result = yield* validate(
          tomlFile('project_id = "demo"\n[api]\nport = "env(API_PORT)"\n'),
          { resolveEnv: true, format: "json" },
        );

        expect(result.exitCode).toBe(1);
        expect(Reflect.get(payloadOf(result) ?? {}, "errors")).toMatchObject([
          { code: "env_unset", key: "api.port" },
        ]);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.effect("checks a set value like a literal and never prints it", () =>
      Effect.gen(function* () {
        const result = yield* validate(
          tomlFile('project_id = "demo"\n[api]\nport = "env(API_PORT)"\n'),
          { resolveEnv: true, env: { API_PORT: "hunter2-not-a-port" } },
        );

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toContain("api.port  expected");
        expect(reportedTexts(result)).not.toContain("hunter2-not-a-port");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.effect("passes a fresh init project with warnings only", () =>
      Effect.gen(function* () {
        const result = yield* validate(tomlFile(renderCliConfigTemplate("demo", false)), {
          resolveEnv: true,
          format: "json",
        });

        expect(result.exitCode).toBeUndefined();
        expect(payloadOf(result)).toMatchObject({ valid: true, errors: [], deferred: [] });
      }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("secrets never print", () => {
    const SECRET = "hunter2-do-not-print";

    const leaks = (result: Parameters<typeof reportedTexts>[0]) =>
      expect(reportedTexts(result)).not.toContain(SECRET);

    it.effect("prints no source text for a document with a syntax error", () =>
      Effect.gen(function* () {
        const result = yield* validate(
          tomlFile(`project_id = "demo"\n[auth.email.smtp]\npass = "${SECRET}"\nhost = "x\n`),
        );

        leaks(result);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.effect("masks a typo'd secret key and its neighbours", () =>
      Effect.gen(function* () {
        const result = yield* validate(
          tomlFile(
            `project_id = "demo"\n[auth.email.smtp]\nenabled = true\nhost = "h"\nport = 25\nuser = "u"\nadmin_email = "a@b.dev"\npasss = "${SECRET}"\n`,
          ),
          { format: "json" },
        );

        expect(Reflect.get(payloadOf(result) ?? {}, "errors")).toMatchObject([
          { code: "missing_required", key: "auth.email.smtp.pass" },
          { code: "unknown_key", key: "auth.email.smtp.passs", help: "did you mean `pass`?" },
        ]);
        leaks(result);
        const text = yield* validate(
          tomlFile(
            `project_id = "demo"\n[auth.email.smtp]\nenabled = true\nhost = "h"\nport = 25\nuser = "u"\nadmin_email = "a@b.dev"\npasss = "${SECRET}"\n`,
          ),
        );
        leaks(text);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.effect("masks a custom provider secret, db.vault and a multi-line secret", () =>
      Effect.gen(function* () {
        const result = yield* validate(
          tomlFile(
            `project_id = "demo"\n[auth.external.mycorp]\nenabled = true\nsecret = "${SECRET}"\nbogus = 1\n[db.vault]\nk = "${SECRET}"\n[auth.hook.send_email]\nenabled = true\nuri = "https://x.test"\nsecrets = """${SECRET}\n${SECRET}-line2"""\nbogus2 = 1\n`,
          ),
        );

        expect(result.stdout).toContain("auth.hook.send_email.secrets");
        leaks(result);
        expect(result.stdout).not.toContain("line2");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.effect(
      "masks comment-looking and padded-base64 continuation lines of a multi-line secret",
      () =>
        Effect.gen(function* () {
          const padded = "c2VjcmV0cGFzc3dvcmQ==";
          const result = yield* validate(
            tomlFile(
              `project_id = "demo"\n[auth.hook.send_email]\nenabled = true\nuri = "https://x.test"\nsecrets = """\n# ${SECRET}\n${padded}"""\nbogus = 1\n`,
            ),
          );

          expect(result.stdout).toContain("auth.hook.send_email.bogus");
          leaks(result);
          expect(result.stdout).not.toContain(padded.slice(0, 8));
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.effect("masks the nested values of an inline table at a located value", () =>
      Effect.gen(function* () {
        const result = yield* validate(
          tomlFile(`project_id = "demo"\n[api]\nmax_rows = { secret = "${SECRET}" }\n`),
        );

        expect(result.stdout).toContain("api.max_rows");
        leaks(result);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.effect("masks the URL on the context and problem lines", () =>
      Effect.gen(function* () {
        const url = "https://user:pass-secret@host.test/x?token=tok-secret";
        const context = yield* validate(
          tomlFile(`project_id = "demo"\n[auth]\nsite_url = "${url}"\nbogus = 1\n`),
        );
        expect(context.stdout).not.toContain("pass-secret");
        expect(context.stdout).not.toContain("tok-secret");

        const own = yield* validate(
          tomlFile(
            'project_id = "demo"\n[studio]\napi_url = "http://u:pass-secret@[bad/x?token=tok-secret"\n',
          ),
        );
        expect(own.stdout).toContain("studio.api_url");
        expect(own.stdout).not.toContain("pass-secret");
        expect(own.stdout).not.toContain("tok-secret");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    const ADVERSARIAL: ReadonlyArray<readonly [string, Readonly<Record<string, string>>]> = [
      [
        "multi-line secret with comment-looking and base64 lines",
        tomlFile(
          `project_id = "demo"\n[auth.hook.send_email]\nenabled = true\nuri = "https://x.test"\nsecrets = """\n# ${SECRET}\nc2VjcmV0cGFzc3dvcmQ=="""\nbogus = 1\n`,
        ),
      ],
      [
        "sibling of an env() reference in an array",
        tomlFile(
          `project_id = "demo"\n[api]\nschemas = ["env(UNSET_SCHEMA)", "${SECRET}"]\nbogus = 1\n`,
        ),
      ],
      [
        "nested inline table at a public key",
        tomlFile(`project_id = "demo"\n[api]\nmax_rows = { secret = "${SECRET}" }\nbogus = 1\n`),
      ],
      [
        "nested table inside an array context line",
        tomlFile(`project_id = "demo"\n[api]\nschemas = [{ secret = "${SECRET}" }]\nbogus = 1\n`),
      ],
      [
        "triple-quoted string inside an inline table",
        tomlFile(
          `project_id = "demo"\nauth = { jwt_secret = """foo", ${SECRET} = "x", tail = "bar""" }\nbogus = 1\n`,
        ),
      ],
      [
        "credential URL on the context line",
        tomlFile(
          `project_id = "demo"\n[auth]\nsite_url = "https://user:pw-secret@host.test/x?token=tok-secret"\nbogus = 1\n`,
        ),
      ],
      [
        "credential URL as the problem value",
        tomlFile(
          `project_id = "demo"\n[studio]\napi_url = "http://u:pw-secret@[bad/x?token=tok-secret"\n`,
        ),
      ],
      [
        "escaped JSON URL on the context line",
        {
          "supabase/config.jsonc": `{\n  "project_id": "demo",\n  "auth": {\n    "site_url": "https:\\/\\/user:pw-secret@host.test/x?token=tok-secret",\n    "bogus": 1\n  }\n}\n`,
        },
      ],
      [
        "line that ends a multi-line JSON value and starts a public property",
        {
          "supabase/config.jsonc": `{\n  "project_id": "demo",\n  "api": {\n    "schemas": [\n      "a",\n      "${SECRET}"], "max_rows": 1000,\n    "prot": 1\n  }\n}\n`,
        },
      ],
      [
        "apostrophe in URL userinfo and query on the context line",
        tomlFile(
          `project_id = "demo"\n[auth]\nsite_url = "https://user:pw'hunter2@host.test/x?token=tok-secret'x"\nbogus = 1\n`,
        ),
      ],
      [
        "apostrophe in URL userinfo as the problem value",
        tomlFile(
          `project_id = "demo"\n[studio]\napi_url = "https://user:pw'hunter2@[bad/x?token=tok-secret"\n`,
        ),
      ],
      [
        "scheme-less credential string on the context line",
        tomlFile(`project_id = "demo"\n[auth]\nsite_url = "user:hunter2@host.test"\nbogus = 1\n`),
      ],
      [
        "literal dotted key that looks like a public path",
        tomlFile(`project_id = "demo"\n"db.port" = "hunter2"\nbogus = 1\n`),
      ],
      [
        "value-bearing schema filter message",
        tomlFile(
          'project_id = "demo"\n[local.services.auth]\nversion = "hunter2"\n[local.services.rest]\nversion = "tok-secret-orioledb"\n',
        ),
      ],
      [
        "schema reference carrying credentials",
        tomlFile(
          `#:schema https://user:pw-secret@host.test/s.json?token=tok-secret\nproject_id = "demo"\n`,
        ),
      ],
    ];

    for (const [name, files] of ADVERSARIAL) {
      it.effect(`never prints a marker for: ${name}`, () =>
        Effect.gen(function* () {
          const text = yield* validate(files);
          const json = yield* validate(files, { format: "json" });

          expect(text.stdout).toMatch(/[✗⚠]/);
          for (const result of [text, json]) {
            const printed = reportedTexts(result);
            for (const marker of ["hunter2", "pw-secret", "tok-secret", "c2VjcmV0"]) {
              expect(printed).not.toContain(marker);
            }
          }
        }).pipe(Effect.provide(BunServices.layer)),
      );
    }

    it.effect("masks db.root_key and a hook secret in JSON mode and in JSONC frames", () =>
      Effect.gen(function* () {
        const result = yield* validate({
          "supabase/config.jsonc": `{\n  "project_id": "demo",\n  "db": { "root_key": "${SECRET}", "major_version": 16 }\n}\n`,
        });

        expect(result.stdout).toContain("db.major_version");
        leaks(result);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.effect("does not print a configured value in any message", () =>
      Effect.gen(function* () {
        const result = yield* validate(
          tomlFile(
            `project_id = "demo"\n[auth.hook.send_email]\nenabled = true\nuri = "https://u:${SECRET}@x.test"\nsecrets = "v1,whsec_${SECRET}"\n[studio]\napi_url = "http://[${SECRET}"\n`,
          ),
          { format: "json" },
        );

        leaks(result);
      }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  it.effect("fails with the missing-project message when there is no config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(tempRoot.current, { recursive: true });
      const result = yield* validate({});

      expect(result.failure).toMatchObject({ _tag: "ConfigValidateLoadError" });
      expect(result.failure?.message).toContain("file not found");
      expect(result.flushed).toBe(true);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("rejects -o/--output in favour of --output-format", () =>
    Effect.gen(function* () {
      const result = yield* validate(tomlFile('project_id = "demo"\n'), { outputFlag: "json" });

      expect(result.failure).toMatchObject({
        _tag: "ConfigValidateOutputFlagUnsupportedError",
        message:
          "the -o/--output flag is not supported by config validate; use --output-format json|stream-json instead.",
      });
      expect(result.stdout).toBe("");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("never reads the linked project ref", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(tempRoot.current, "supabase", ".temp", "project-ref"), {
        recursive: true,
      });
      const result = yield* validate(tomlFile('project_id = "demo"\n'));

      expect(result.failure).toBeUndefined();
      expect(result.stdout).toBe("✓ supabase/config.toml is valid\n");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("fails a config.json whose top level is not an object", () =>
    Effect.gen(function* () {
      for (const root of ["[]", "5"]) {
        const result = yield* validate({ "supabase/config.json": root }, { format: "json" });

        expect(result.exitCode).toBe(1);
        expect(payloadOf(result)).toMatchObject({
          valid: false,
          complete: false,
          stopped_at: "syntax",
          errors: [{ code: "syntax", reason: "the top level must be an object" }],
        });
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("attributes a deprecated key to a remote whose name contains a dot", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile(
          'project_id = "demo"\n[remotes."prod.eu"]\nproject_id = "abcdefghijklmnopqrst"\n[remotes."prod.eu".auth.email]\nenable_signup = true\n',
        ),
        { format: "json" },
      );

      expect(Reflect.get(payloadOf(result) ?? {}, "warnings")).toContainEqual(
        expect.objectContaining({
          code: "deprecated_key",
          remote: "prod.eu",
          key: "remotes.prod.eu.auth.email.enable_signup",
        }),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("does not suggest --resolve-env for checks skipped over an invalid value", () =>
    Effect.gen(function* () {
      const text = yield* validate(tomlFile('project_id = "demo"\n[api]\nenabled = "maybe"\n'));

      expect(text.stdout).toMatch(/\d+ checks? w(as|ere) not run because .* invalid or missing/);
      expect(text.stdout).not.toContain("--resolve-env");

      const json = yield* validate(tomlFile('project_id = "demo"\n[api]\nenabled = "maybe"\n'), {
        format: "json",
      });
      const deferred = Reflect.get(payloadOf(json) ?? {}, "deferred");
      expect(deferred).toContainEqual(
        expect.objectContaining({ check: "api.port", reason: "invalid" }),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("defers requirement checks of an enabled custom provider whose values are unset", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile(
          'project_id = "demo"\n[auth.external.myidp]\nenabled = true\nclient_id = "env(UNSET_IDP_ID)"\nsecret = "env(UNSET_IDP_SECRET)"\n',
        ),
        { format: "json" },
      );

      expect(Reflect.get(payloadOf(result) ?? {}, "deferred")).toContainEqual({
        check: "auth.external.required",
        reason: "env",
        waits_on: ["auth.external.myidp.client_id", "auth.external.myidp.secret"],
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
