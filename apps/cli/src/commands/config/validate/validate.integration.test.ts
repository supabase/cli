import { inspect } from "node:util";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path, Predicate } from "effect";

import { configValuesLayer } from "../../../../tests/helpers/config-values-layer.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { mockOutput, mockProcessControl } from "../../../../tests/helpers/mocks.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { renderCliConfigTemplate } from "../../../shared/init/project-init.templates.ts";
import type { OutputFormat } from "../../../shared/output/types.ts";
import { configValidate } from "./validate.handler.ts";

const tempRoot = useTempWorkdir("supabase-config-validate-");

interface RunOptions {
  readonly format?: OutputFormat;
  readonly outputFlag?: "json";
  readonly env?: Readonly<Record<string, string>>;
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
    configValuesLayer({ env: options.env }),
    BunServices.layer,
  );
  const outcome = yield* configValidate().pipe(Effect.provide(layer), Effect.result);
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
      expect(text.stdout).toBe("✓ supabase/config.toml is valid\n");
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
            4 │ enabled = true
          > 5 │ prot = ****
              │ ^^^^
            help: did you mean \`port\`?

          ✗ api.max_rows  expected a non-negative integer
            supabase/config.toml:6:12
            5 │ prot = ****
          > 6 │ max_rows = "lots"
              │            ^^^^^^

          ✗ db.major_version  unsupported Postgres version
            supabase/config.toml:9:17
            8 │ [db]
          > 9 │ major_version = 16
              │                 ^^
            help: use one of 13, 14, 15, 17

          ✗ auth.external.github.client_id  required when auth.external.github.enabled = true
            supabase/config.toml:11:2
            10 │
          > 11 │ [auth.external.github]
               │  ^^^^^^^^^^^^^^^^^^^^
            help: set client_id, or set enabled = false

          ✗ auth.external.github.secret  required when auth.external.github.enabled = true
            supabase/config.toml:11:2
            10 │
          > 11 │ [auth.external.github]
               │  ^^^^^^^^^^^^^^^^^^^^
            help: set secret, or set enabled = false

          ⚠ auth.email.smtp.pass  SMTP_PASS is not set, so this key gets the literal text "env(SMTP_PASS)"
            supabase/config.toml:19:8
            18 │ user = "mailer"
          > 19 │ pass = "env(SMTP_PASS)"
               │        ^^^^^^^^^^^^^^^^
            help: set SMTP_PASS in your shell or supabase/.env (SUPABASE_ENV=<name> also reads supabase/.env.<name>)

          ✗ api.max_rows  expected a non-negative integer  [remote: staging]
            supabase/config.toml:26:12
            25 │ [remotes.staging.api]
          > 26 │ max_rows = "many"
               │            ^^^^^^

        ✗ 6 errors, 1 warning in supabase/config.toml
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
              "help": "use one of 13, 14, 15, 17",
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
          "valid": false,
          "warnings": [
            {
              "code": "env_unresolved",
              "column": 8,
              "end_column": 24,
              "end_line": 19,
              "help": "set SMTP_PASS in your shell or supabase/.env (SUPABASE_ENV=<name> also reads supabase/.env.<name>)",
              "key": "auth.email.smtp.pass",
              "line": 19,
              "path": "auth.email.smtp.pass",
              "reason": "SMTP_PASS is not set, so this key gets the literal text "env(SMTP_PASS)"",
              "severity": "warning",
            },
          ],
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
            4 │   "api": {
          > 5 │     "prot": ****,
              │     ^^^^^^
            help: did you mean \`port\`?

          ✗ api.max_rows  expected a non-negative integer
            supabase/config.jsonc:6:17
            5 │     "prot": ****,
          > 6 │     "max_rows": "lots",
              │                 ^^^^^^

          ✗ db.major_version  unsupported Postgres version
            supabase/config.jsonc:8:28
            7 │   },
          > 8 │   "db": { "major_version": 16 }
              │                            ^^
            help: use one of 13, 14, 15, 17

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
        { env: { SUPABASE_STUDIO_PORT: "nope" } },
      );

      const data = payloadOf(
        yield* validate(tomlFile('project_id = "demo"\n'), { format: "json" }),
      );
      expect(data).toMatchObject({ valid: true });
      expect(result.stdout).toContain("api.max_rows");
      expect(result.stdout).toContain("db.major_version  unsupported Postgres version");
      expect(result.stdout).toContain("studio.port");
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

  it.effect("reports every bad remote and still validates the healthy ones", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile(
          `project_id = "demo"\n[remotes.a]\nproject_id = "bad"\n[remotes.b]\nproject_id = "worse"\n[remotes.c]\nproject_id = "abcdefghijklmnopqrst"\n[remotes.c.api]\nmax_rows = "many"\n`,
        ),
        { format: "json" },
      );

      const data = payloadOf(result);
      expect(data).toMatchObject({
        remotes: ["c"],
        skipped_remotes: [
          { name: "a", reason: "invalid project_id" },
          { name: "b", reason: "invalid project_id" },
        ],
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

  it.effect("stops and says so when the env files cannot be read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(tempRoot.current, "supabase", ".env"), { recursive: true });
      const result = yield* validate(tomlFile('project_id = "demo"\n[db]\nmajor_version = 16\n'), {
        format: "json",
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

  it.effect("warns about an unset env() reference in an enabled section", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile(
          'project_id = "demo"\n[auth.email.smtp]\nenabled = true\nhost = "h"\nport = 25\nuser = "u"\npass = "env(SMTP_PASS)"\nadmin_email = "a@b.dev"\n',
        ),
      );

      expect(result.exitCode).toBeUndefined();
      expect(result.stdout).toContain(
        '⚠ auth.email.smtp.pass  SMTP_PASS is not set, so this key gets the literal text "env(SMTP_PASS)"',
      );
      expect(result.stdout).toContain(
        "help: set SMTP_PASS in your shell or supabase/.env (SUPABASE_ENV=<name> also reads supabase/.env.<name>)",
      );
      expect(result.stdout).toContain("✓ supabase/config.toml is valid · 1 warning");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("warns about a reference in a table that is enabled by default", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile('project_id = "demo"\n[auth]\nsite_url = "env(SITE_URL)"\n'),
      );

      expect(result.stdout).toContain("⚠ auth.site_url  SITE_URL is not set");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("warns for a remote reference under a section the base enables", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile(
          'project_id = "demo"\n[auth.external.github]\nenabled = true\nclient_id = "c"\nsecret = "s"\n[remotes.prod]\nproject_id = "abcdefghijklmnopqrst"\n[remotes.prod.auth.external.github]\nsecret = "env(GH_SECRET)"\n',
        ),
      );

      expect(result.stdout).toContain("⚠ auth.external.github.secret  GH_SECRET is not set");
      expect(result.stdout).toContain("[remote: prod]");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("stays quiet about unset references in a disabled table and optional keys", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile(
          'project_id = "demo"\n[auth.external.github]\nenabled = false\nsecret = "env(GITHUB_SECRET)"\n[studio]\nopenai_api_key = "env(OPENAI_API_KEY)"\n',
        ),
      );

      expect(result.stdout).toBe("✓ supabase/config.toml is valid\n");
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
      );

      expect(result.stdout).toContain("api.schemas.0  UNSET_SCHEMA is not set");
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

  it.effect("keeps an invalid SUPABASE_* override of a key holding an unresolved reference", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile('project_id = "demo"\n[db]\nport = "env(UNSET_DB_PORT)"\n'),
        { format: "json", env: { SUPABASE_DB_PORT: "abc" } },
      );

      expect(Reflect.get(payloadOf(result) ?? {}, "errors")).toMatchObject([
        { code: "invalid_value", key: "db.port" },
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

  it.effect(
    "warns, not fails, when a remote enables a section whose base keys are unresolved",
    () =>
      Effect.gen(function* () {
        const result = yield* validate(
          tomlFile(
            'project_id = "demo"\n[api.tls]\nenabled = false\ncert_path = "env(UNSET_CERT)"\nkey_path = "env(UNSET_KEY)"\n[remotes.prod]\nproject_id = "abcdefghijklmnopqrst"\n[remotes.prod.api.tls]\nenabled = true\n',
          ),
        );

        expect(result.exitCode).toBeUndefined();
        expect(result.stdout).toContain("⚠ api.tls.cert_path  UNSET_CERT is not set");
        expect(result.stdout).toContain("⚠ api.tls.key_path  UNSET_KEY is not set");
        expect(result.stdout).toContain("[remote: prod]");
        expect(result.stdout).not.toContain("✗");
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("names the real env file and failure kind when a root .env cannot be parsed", () =>
    Effect.gen(function* () {
      yield* writeFile(".env", "!bad-line-do-not-print\n");
      const result = yield* validate(tomlFile('project_id = "demo"\n'), { format: "json" });

      expect(payloadOf(result)).toMatchObject({ complete: false, stopped_at: "env_file" });
      expect(Reflect.get(payloadOf(result) ?? {}, "errors")).toMatchObject([
        { code: "env_file", file: ".env", reason: "could not be parsed" },
      ]);
      expect(reportedTexts(result)).not.toContain("bad-line-do-not-print");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "points a semantic error from a SUPABASE_* override at the variable, not the file",
    () =>
      Effect.gen(function* () {
        const result = yield* validate(
          tomlFile('project_id = "demo"\n[db]\nmajor_version = 17\n'),
          { env: { SUPABASE_DB_MAJOR_VERSION: "16" } },
        );

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toContain("db.major_version  unsupported Postgres version");
        expect(result.stdout).toContain(
          "help: SUPABASE_DB_MAJOR_VERSION (shell) sets this value, not supabase/config.toml; fix or unset it there",
        );
        expect(result.stdout).not.toContain("supabase/config.toml:");
        expect(result.stdout).not.toContain("major_version = 17");
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

  it.effect("skips a remote whose project_id is an unset env() reference and warns instead", () =>
    Effect.gen(function* () {
      const result = yield* validate(
        tomlFile('project_id = "demo"\n[remotes.prod]\nproject_id = "env(UNSET_REF)"\n'),
      );

      expect(result.exitCode).toBeUndefined();
      expect(result.stdout).toContain("⚠ project_id  UNSET_REF is not set");
      expect(result.stdout).toContain("[remote: prod]");
      expect(result.stdout).toContain(
        "Skipped remotes: prod (project_id is an unset env() reference)",
      );
      expect(result.stdout).not.toContain("✗");
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

  it.effect("reports an invalid env-sourced remote project_id as external, not at the file", () =>
    Effect.gen(function* () {
      const files = tomlFile(
        'project_id = "demo"\n[remotes.prod]\nproject_id = "abcdefghijklmnopqrst"\n',
      );
      const json = yield* validate(files, {
        format: "json",
        env: { SUPABASE_REMOTES_PROD_PROJECT_ID: "nope" },
      });
      const text = yield* validate(files, {
        env: { SUPABASE_REMOTES_PROD_PROJECT_ID: "nope" },
      });

      const errors = Reflect.get(payloadOf(json) ?? {}, "errors");
      expect(errors).toMatchObject([
        {
          code: "remote_project_id",
          remote: "prod",
          help: expect.stringContaining("SUPABASE_REMOTES_PROD_PROJECT_ID"),
        },
      ]);
      expect(errors).not.toMatchObject([{ line: expect.anything() }]);
      expect(text.stdout).toContain("SUPABASE_REMOTES_PROD_PROJECT_ID");
      expect(text.stdout).not.toMatch(/config\.toml:\d/);
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

  it.effect(
    "stays quiet about an unresolved reference when a SUPABASE_* variable supplies the value",
    () =>
      Effect.gen(function* () {
        const result = yield* validate(
          tomlFile('project_id = "demo"\n[db]\nport = "env(UNSET_DB_PORT)"\n'),
          { env: { SUPABASE_DB_PORT: "5432" } },
        );

        expect(result.stdout).toBe("✓ supabase/config.toml is valid\n");
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("reports a removed env variable as an incomplete run", () =>
    Effect.gen(function* () {
      const result = yield* validate(tomlFile('project_id = "demo"\n'), {
        format: "json",
        env: { SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION: "15" },
      });

      expect(payloadOf(result)).toMatchObject({
        valid: false,
        complete: false,
        stopped_at: "removed_env",
      });
      expect(Reflect.get(payloadOf(result) ?? {}, "errors")).toMatchObject([
        { code: "removed_env" },
      ]);

      const text = yield* validate(tomlFile('project_id = "demo"\n'), {
        env: { SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION: "15" },
      });
      expect(text.stdout).toContain("Stopped after resolving the environment variables.");
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

  it.effect("attributes an invalid SUPABASE_* variable to the variable, not a line", () =>
    Effect.gen(function* () {
      const result = yield* validate(tomlFile('project_id = "demo"\n[db]\nport = 54322\n'), {
        env: { SUPABASE_DB_PORT: "abc" },
      });

      expect(result.stdout).toContain("  ✗ db.port  expected a port (0-65535)");
      expect(result.stdout).toContain(
        "help: SUPABASE_DB_PORT (shell) sets this value, not supabase/config.toml; fix or unset it there",
      );
      expect(result.stdout).not.toContain("abc");
      expect(result.stdout).not.toContain("port = 54322");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  describe("secrets never print", () => {
    const SECRET = "hunter2-do-not-print";

    const leaks = (result: Parameters<typeof reportedTexts>[0]) =>
      expect(reportedTexts(result)).not.toContain(SECRET);

    it.effect("masks every line of a document with a syntax error", () =>
      Effect.gen(function* () {
        const result = yield* validate(
          tomlFile(`project_id = "demo"\n[auth.email.smtp]\npass = "${SECRET}"\nhost = "x\n`),
        );

        expect(result.stdout).toContain("> 4 │ ****");
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
        expect(text.stdout).toContain("passs = ****");
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
          expect(result.stdout).toContain("bogus = ****");
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

    it.effect("redacts credentials and query strings of a public URL value", () =>
      Effect.gen(function* () {
        const url = "https://user:pass-secret@host.test/x?token=tok-secret";
        const context = yield* validate(
          tomlFile(`project_id = "demo"\n[auth]\nsite_url = "${url}"\nbogus = 1\n`),
        );
        expect(context.stdout).toContain('site_url = "https://****@host.test/x?****"');
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
});
