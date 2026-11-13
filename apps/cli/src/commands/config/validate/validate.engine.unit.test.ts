import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { parseCliConfigDocumentFile } from "@supabase/config/internal";
import { Effect, Exit, FileSystem, Path, PlatformError } from "effect";

import type {
  CliConfigEnvLookup,
  CliConfigEnvState,
} from "../../../config/cli-config-env-lookup.ts";
import { renderCliConfigTemplate } from "../../../shared/init/project-init.templates.ts";
import { enumerateCliConfigKeys } from "../../../config/cli-config-registry-pass.ts";
import {
  makeCliConfigUnitIo,
  type CliConfigUnitIo,
} from "../../../command-internal/config-check-core.ts";
import {
  analyzeContext,
  classifyEnvProblems,
  collapseProblems,
  decodeWithStandIns,
  enclosingTableToMark,
  markUnknown,
  runConfigValidation,
  runConfigValidationWithStandIn,
  runUnitsInContext,
  type EngineProblem,
  type RawProblem,
  type StandIn,
  type StatusTable,
} from "./validate.engine.ts";

const run = Effect.fnUntraced(function* (
  toml: string,
  env?: CliConfigEnvLookup,
  standIn?: StandIn,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "config-validate-engine-" });
  yield* fs.makeDirectory(path.join(root, "supabase"), { recursive: true });
  yield* fs.writeFileString(path.join(root, "supabase", "config.toml"), toml);
  const parsed = yield* parseCliConfigDocumentFile(root, { search: false });
  if (parsed === null) return yield* Effect.die("fixture config was not found");
  return yield* standIn === undefined
    ? runConfigValidation(parsed, root, env)
    : runConfigValidationWithStandIn(parsed, root, env, standIn);
});

const lookupOf = (states: Readonly<Record<string, CliConfigEnvState>>): CliConfigEnvLookup => ({
  lookup: (name) => states[name] ?? { state: "unset" },
  dotenvPrivateKeys: [],
});

const label = (problem: EngineProblem): string =>
  `${problem.remote ?? "base"}:${problem.path.join(".")}:${problem.code}`;

const labels = (problems: ReadonlyArray<EngineProblem>): ReadonlyArray<string> =>
  problems.map(label).toSorted();

type Variants = Readonly<Record<string, readonly [unknown, unknown]>>;

const BOOL: readonly [unknown, unknown] = [true, false];
const PORT: readonly [unknown, unknown] = [0, 54321];
const TEXT: readonly [unknown, unknown] = ["", "value"];

const probes = (variants: Variants): ReadonlyArray<Readonly<Record<string, unknown>>> => {
  const names = Object.keys(variants);
  const pick = (name: string, index: 0 | 1) => variants[name]?.[index];
  const single = names.flatMap((name) =>
    ([0, 1] as const).map((index) => ({ [name]: pick(name, index) })),
  );
  const together = ([0, 1] as const).flatMap((first) => [
    Object.fromEntries(names.map((name) => [name, pick(name, first)])),
    Object.fromEntries(
      names.map((name, position) => [
        name,
        pick(name, position % 2 === 0 ? first : first === 0 ? 1 : 0),
      ]),
    ),
  ]);
  return [...single, ...together];
};

const sameProblemsForEveryStandIn = Effect.fnUntraced(function* (toml: string, variants: Variants) {
  const baseline = yield* run(toml);
  const seen: Array<ReadonlyArray<string>> = [];
  for (const probe of probes(variants)) {
    const result = yield* run(toml, undefined, (name) =>
      Object.hasOwn(probe, name) ? probe[name] : undefined,
    );
    seen.push(labels(result.problems));
    expect(
      result.deferred.map((item) => `${item.remote ?? "base"}:${item.check}`).toSorted(),
    ).toEqual(baseline.deferred.map((item) => `${item.remote ?? "base"}:${item.check}`).toSorted());
  }
  for (const problems of seen) expect(problems).toEqual(labels(baseline.problems));
  return baseline;
});

const BASE_FIXTURE = `project_id = "demo"

[db]
major_version = 13

[api]
enabled = "env(API_ENABLED)"
port = "env(API_PORT)"

[api.tls]
enabled = "env(TLS_ENABLED)"
cert_path = "no-such-cert.pem"
key_path = "no-such-key.pem"

[auth]
site_url = "env(SITE_URL)"

[auth.email.smtp]
enabled = "env(SMTP_ENABLED)"
host = "env(SMTP_HOST)"

[auth.third_party.firebase]
enabled = "env(FIREBASE_ENABLED)"
`;

const BASE_VARIANTS: Variants = {
  API_ENABLED: BOOL,
  API_PORT: PORT,
  TLS_ENABLED: BOOL,
  SITE_URL: TEXT,
  SMTP_ENABLED: BOOL,
  SMTP_HOST: TEXT,
  FIREBASE_ENABLED: BOOL,
};

const SWITCH_FIXTURE = `project_id = "demo"

[auth]
site_url = "http://localhost"

[auth.passkey]
enabled = "env(PASSKEY)"

[auth.external.my_oidc]
enabled = "env(OIDC)"

[auth.sms.twilio]
enabled = "env(TWILIO)"
account_sid = "sid"

[auth.sms.vonage]
enabled = true

[auth.hook.send_sms]
enabled = "env(HOOK)"
uri = "env(HOOK_URI)"

[auth.email.smtp]
enabled = "env(SMTP_ON)"
host = "h"
port = "env(SMTP_PORT)"
`;

const SWITCH_VARIANTS: Variants = {
  PASSKEY: BOOL,
  OIDC: BOOL,
  TWILIO: BOOL,
  HOOK: BOOL,
  HOOK_URI: ["", "https://example.com/hook"],
  SMTP_ON: BOOL,
  SMTP_PORT: PORT,
};

const STRING_VARIANTS: Variants = {
  PASSKEY: ["true", "false"],
  OIDC: ["true", "false"],
  TWILIO: ["true", "false"],
  HOOK: ["true", "false"],
  SMTP_ON: ["true", "false"],
  SMTP_PORT: ["587", "0"],
};

const REMOTE_FIXTURE = `project_id = "demo"

[api]
enabled = false

[api.tls]
enabled = true
cert_path = "no-such-cert.pem"
key_path = "no-such-key.pem"

[db]
major_version = 13

[remotes.staging]
project_id = "abcdefghijklmnopqrst"

[remotes.staging.api]
enabled = "env(STAGING_API)"
port = "env(STAGING_PORT)"

[remotes.staging.auth.email.smtp]
host = "env(STAGING_HOST)"
`;

const REMOTE_VARIANTS: Variants = {
  STAGING_API: BOOL,
  STAGING_PORT: PORT,
  STAGING_HOST: TEXT,
};

describe("runConfigValidation", () => {
  describe("stand-ins", () => {
    it.effect("never change what the base reports", () =>
      Effect.gen(function* () {
        const baseline = yield* sameProblemsForEveryStandIn(BASE_FIXTURE, BASE_VARIANTS);

        expect(labels(baseline.problems)).toEqual(["base:db.major_version:invalid_value"]);
        expect(baseline.unknownValues).toBe(7);
        expect(baseline.deferred.length).toBeGreaterThan(0);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("never change what the switches and string-valued probes decide", () =>
      Effect.gen(function* () {
        const typed = yield* sameProblemsForEveryStandIn(SWITCH_FIXTURE, SWITCH_VARIANTS);
        const strings = yield* sameProblemsForEveryStandIn(SWITCH_FIXTURE, STRING_VARIANTS);

        expect(labels(typed.problems)).toEqual(labels(strings.problems));
        expect(typed.deferred.map((item) => item.check)).toEqual(
          expect.arrayContaining(["auth.webauthn", "auth.sms.provider", "auth.hook"]),
        );
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("never change what a remote reports", () =>
      Effect.gen(function* () {
        const baseline = yield* sameProblemsForEveryStandIn(REMOTE_FIXTURE, REMOTE_VARIANTS);

        expect(labels(baseline.problems)).toEqual([
          "base:db.major_version:invalid_value",
          "staging:auth.email.smtp.admin_email:missing_required",
          "staging:auth.email.smtp.pass:missing_required",
          "staging:auth.email.smtp.port:missing_required",
          "staging:auth.email.smtp.user:missing_required",
        ]);
        expect(baseline.deferred.some((item) => item.remote === "staging")).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );
  });

  describe("known mistakes", () => {
    it.effect("are reported next to an unknown value and located at the key", () =>
      Effect.gen(function* () {
        const result = yield* run(`project_id = "demo"

[auth.email.smtp]
host = "env(SMTP_HOST)"
port = 0
`);

        expect(labels(result.problems)).toEqual([
          "base:auth.email.smtp.admin_email:missing_required",
          "base:auth.email.smtp.pass:missing_required",
          "base:auth.email.smtp.port:missing_required",
          "base:auth.email.smtp.user:missing_required",
        ]);
        const port = result.problems.find(
          (problem) => problem.path.join(".") === "auth.email.smtp.port",
        );
        expect(port?.location?.line).toBe(5);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("name the spelling the document uses for renamed keys", () =>
      Effect.gen(function* () {
        const result = yield* run(`project_id = "demo"

[auth.email]
enabled = "maybe"
`);

        expect(labels(result.problems)).toEqual(["base:auth.email.enabled:invalid_value"]);
        expect(result.problems[0]?.location?.line).toBe(4);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("keep the CLI wording where the CLI check and the table rule find one thing", () =>
      Effect.gen(function* () {
        const result = yield* run(`project_id = "demo"

[auth.email.smtp]
port = 0
user = "u"
pass = "p"
admin_email = "a@test.dev"
`);

        expect(labels(result.problems)).toEqual([
          "base:auth.email.smtp.host:missing_required",
          "base:auth.email.smtp.port:missing_required",
        ]);
        for (const problem of result.problems) expect(problem.reason).toMatch(/^required when/);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("keep the table rule's rejection when the CLI check is switched off", () =>
      Effect.gen(function* () {
        const result = yield* run(`project_id = "demo"

[auth]
enabled = false

[auth.external.github]
enabled = true
`);

        expect(labels(result.problems)).toEqual([
          "base:auth.external.github.client_id:missing_required",
          "base:auth.external.github.secret:missing_required",
        ]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );
  });

  describe("known mistakes beside unknown values", () => {
    it.effect("a custom external provider is not held to the built-in providers' rule", () =>
      Effect.gen(function* () {
        const result = yield* run(`project_id = "demo"

[auth]
enabled = false

[auth.external.myidp]
enabled = true
`);

        expect(result.problems).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("an unsupported hook scheme is reported while its secrets are unknown", () =>
      Effect.gen(function* () {
        const result = yield* run(`project_id = "demo"

[auth.hook.send_sms]
enabled = true
uri = "ftp://x"
secrets = "env(HOOK_SECRETS)"
`);

        expect(labels(result.problems)).toEqual(["base:auth.hook.send_sms.uri:invalid_value"]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("a missing rp_id is reported while rp_display_name is unknown", () =>
      Effect.gen(function* () {
        const result = yield* run(`project_id = "demo"

[auth.passkey]
enabled = true

[auth.webauthn]
rp_display_name = "env(RP_NAME)"
rp_origins = ["http://localhost:3000"]
`);

        expect(labels(result.problems)).toEqual(["base:auth.webauthn.rp_id:missing_required"]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("a duration that start rejects is reported", () =>
      Effect.gen(function* () {
        const result = yield* run(`project_id = "demo"

[auth.email]
max_frequency = "5x"
`);

        expect(labels(result.problems)).toEqual(["base:auth.email.max_frequency:invalid_value"]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );
  });

  describe("counting checks", () => {
    const THIRD_PARTY = `project_id = "demo"

[auth.third_party.firebase]
enabled = true
project_id = "firebase-project"

[auth.third_party.clerk]
enabled = "env(CLERK_ENABLED)"
domain = "clerk.example.com"
`;

    it.effect("report when the known values settle it", () =>
      Effect.gen(function* () {
        const result = yield* run(`${THIRD_PARTY}
[auth.third_party.auth0]
enabled = true
tenant = "tenant"
`);

        expect(labels(result.problems)).toEqual(["base:auth.third_party:invalid_value"]);
        expect(result.deferred.map((item) => item.check)).not.toContain("auth.third_party");
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("defer when an unknown value could decide it", () =>
      Effect.gen(function* () {
        const result = yield* run(THIRD_PARTY);

        expect(result.problems).toEqual([]);
        expect(result.deferred.map((item) => item.check)).toContain("auth.third_party");
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );
  });

  describe("switches", () => {
    it.effect("defer an smtp table whose enabled is unknown instead of turning it on", () =>
      Effect.gen(function* () {
        const result = yield* run(`project_id = "demo"

[auth.email.smtp]
enabled = "env(SMTP_ENABLED)"
`);

        expect(result.problems).toEqual([]);
        const checks = result.deferred.map((item) => item.check);
        expect(checks).toEqual(
          expect.arrayContaining(["auth.email.smtp.host", "auth.email.smtp.port"]),
        );
        expect(checks).not.toContain("auth.email.smtp.table.host");
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );
  });

  describe("remotes", () => {
    const withRemotes = (...blocks: ReadonlyArray<string>) => `project_id = "demo"

[db]
major_version = 13

[api]
port = "not-a-port"

${blocks.join("\n")}`;
    const remote = (name: string, ref: string, body = "") => `[remotes.${name}]
project_id = "${ref}"
${body}`;

    it.effect("report a base problem once, however many remotes inherit it", () =>
      Effect.gen(function* () {
        const result = yield* run(
          withRemotes(remote("one", "aaaaaaaaaaaaaaaaaaaa"), remote("two", "bbbbbbbbbbbbbbbbbbbb")),
        );

        expect(labels(result.problems)).toEqual([
          "base:api.port:invalid_value",
          "base:db.major_version:invalid_value",
        ]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("give a remote the error of a key it replaces with a wrong type", () =>
      Effect.gen(function* () {
        const result = yield* run(
          withRemotes(
            remote("whole", "aaaaaaaaaaaaaaaaaaaa", "api = []\n"),
            remote("leaf", "bbbbbbbbbbbbbbbbbbbb", "[remotes.leaf.api]\nport = []\n"),
          ),
        );

        expect(labels(result.problems)).toEqual([
          "base:api.port:invalid_value",
          "base:db.major_version:invalid_value",
          "leaf:api.port:invalid_value",
          "whole:api:invalid_type",
        ]);
        const whole = result.problems.find((problem) => problem.remote === "whole");
        expect(whole?.location?.line).toBeGreaterThan(8);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("give a remote that only enables the api the missing TLS files", () =>
      Effect.gen(function* () {
        const result = yield* run(`project_id = "demo"

[api]
enabled = false

[api.tls]
enabled = true
cert_path = "no-such-cert.pem"
key_path = "no-such-key.pem"

${remote("staging", "aaaaaaaaaaaaaaaaaaaa", "[remotes.staging.api]\nenabled = true\n")}`);

        expect(labels(result.problems)).toEqual([
          "staging:api.tls.cert_path:invalid_value",
          "staging:api.tls.key_path:invalid_value",
        ]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("report remote project ids as written and never compare unknown ones", () =>
      Effect.gen(function* () {
        const result = yield* run(`project_id = "demo"

${remote("bad", "short")}
${remote("dup-a", "cccccccccccccccccccc")}
${remote("dup-b", "cccccccccccccccccccc")}
${remote("env-a", "env(REF_A)")}
${remote("env-b", "env(REF_B)")}
`);

        expect(labels(result.problems)).toEqual([
          "bad:project_id:remote_project_id",
          "dup-b:project_id:remote_project_id",
        ]);
        expect(result.unknownValues).toBe(2);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );
  });

  describe("a fresh init config", () => {
    it.effect("has no problems in default mode and defers what reads env()", () =>
      Effect.gen(function* () {
        const result = yield* run(renderCliConfigTemplate("demo", false));

        expect(result.problems).toEqual([]);
        expect(result.complete).toBe(true);
        expect(result.unknownValues).toBeGreaterThan(0);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );
  });

  describe("a fresh init config", () => {
    it.effect("defers nothing for a disabled provider", () =>
      Effect.gen(function* () {
        const result = yield* run(renderCliConfigTemplate("demo", false));

        expect(result.deferred.filter((item) => item.check.startsWith("auth.external"))).toEqual(
          [],
        );
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("has no errors under --resolve-env with nothing set", () =>
      Effect.gen(function* () {
        const result = yield* run(renderCliConfigTemplate("demo", false), lookupOf({}));

        expect(result.problems.filter((problem) => problem.severity === "error")).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );
  });

  describe("with env lookups", () => {
    const FIXTURE = `project_id = "demo"

[db]
port = "env(DB_PORT)"

[auth]
site_url = "env(SITE_URL)"
`;

    it.effect("validates a value that is set like any other", () =>
      Effect.gen(function* () {
        const bad = yield* run(
          FIXTURE,
          lookupOf({
            DB_PORT: { state: "set", value: "abc" },
            SITE_URL: { state: "set", value: "x" },
          }),
        );
        const good = yield* run(
          FIXTURE,
          lookupOf({
            DB_PORT: { state: "set", value: "5432" },
            SITE_URL: { state: "set", value: "x" },
          }),
        );

        expect(labels(bad.problems)).toEqual(["base:db.port:invalid_value"]);
        expect(good.problems).toEqual([]);
        expect(good.unknownValues).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("makes an unset variable an error only when something needs it", () =>
      Effect.gen(function* () {
        const result = yield* run(
          FIXTURE,
          lookupOf({ DB_PORT: { state: "empty", source: "shell" } }),
        );

        const byName = Object.fromEntries(
          result.problems.map((problem) => [problem.env?.name, problem]),
        );
        expect(byName["DB_PORT"]).toMatchObject({ code: "env_empty", severity: "error" });
        expect(byName["SITE_URL"]).toMatchObject({ code: "env_unset", severity: "error" });
        expect(byName["SITE_URL"]?.env?.uses).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("warns about an unset variable no check waited on", () =>
      Effect.gen(function* () {
        const result = yield* run(
          `project_id = "demo"

[studio]
openai_api_key = "env(OPENAI_API_KEY)"
`,
          lookupOf({}),
        );

        expect(result.problems).toMatchObject([{ code: "env_unset", severity: "warning" }]);
        expect(result.deferred).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );
  });
  it.effect("names the allowed choices of a codec enum without quotes", () =>
    Effect.gen(function* () {
      const result = yield* run('project_id = "demo"\n[auth]\npassword_requirements = "nope"\n');

      expect(result.problems).toMatchObject([
        {
          code: "invalid_enum",
          reason:
            'expected one of "", letters_digits, lower_upper_letters_digits, lower_upper_letters_digits_symbols',
          help: 'use one of "", letters_digits, lower_upper_letters_digits, lower_upper_letters_digits_symbols',
        },
      ]);
      expect(result.problems.map(({ reason, help }) => `${reason} ${help}`).join()).not.toContain(
        "nope",
      );
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("names the other remote of a duplicate project_id, never the id", () =>
    Effect.gen(function* () {
      const result = yield* run(
        'project_id = "demo"\n[remotes.a]\nproject_id = "abcdefghijklmnopqrst"\n[remotes.b]\nproject_id = "abcdefghijklmnopqrst"\n',
      );

      expect(result.problems).toMatchObject([
        { code: "remote_project_id", remote: "b", reason: "same project_id as remotes.a" },
      ]);
      expect(result.problems.map(({ reason, help }) => `${reason} ${help}`).join()).not.toContain(
        "abcdefghijklmnopqrst",
      );
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("reports no duplicate between remotes that omit project_id", () =>
    Effect.gen(function* () {
      const result = yield* run(
        'project_id = "demo"\n[remotes.a.api]\nport = 1\n[remotes.b.api]\nport = 2\n',
      );

      expect(labels(result.problems)).toEqual([
        "a:project_id:remote_project_id",
        "b:project_id:remote_project_id",
      ]);
      expect(result.problems.map((problem) => problem.reason)).not.toContainEqual(
        expect.stringContaining("same project_id"),
      );
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("runs no project_id checks for a remote that is not a table", () =>
    Effect.gen(function* () {
      const result = yield* run(
        'project_id = "demo"\n[remotes]\nstaging = "abcdefghijklmnopqrst"\n',
      );

      expect(result.problems).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  describe("units read the values start reads", () => {
    const SMTP_STRING_PORT = `project_id = "demo"

[auth.email.smtp]
host = "h"
port = "587"
user = "u"
pass = "p"
admin_email = "a@b.c"
`;

    it.effect("accepts a port written as a string, like start", () =>
      Effect.gen(function* () {
        const result = yield* run(SMTP_STRING_PORT);

        expect(result.problems).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("accepts a port that env() supplies as a string", () =>
      Effect.gen(function* () {
        const result = yield* run(
          SMTP_STRING_PORT.replace('"587"', '"env(SMTP_PORT)"'),
          lookupOf({ SMTP_PORT: { state: "set", value: "587" } }),
        );

        expect(result.problems).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("does not apply the smtp table rule while the smtp table is not enabled", () =>
      Effect.gen(function* () {
        const result = yield* run(`project_id = "demo"

[auth]
enabled = false

[auth.email.smtp]
host = "h"
`);

        expect(result.problems).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("reports each smtp field the table rule finds while another is unknown", () =>
      Effect.gen(function* () {
        const result = yield* run(`project_id = "demo"

[auth]
enabled = false

[auth.email.smtp]
enabled = true
host = "env(SMTP_HOST)"
`);

        expect(labels(result.problems)).toEqual([
          "base:auth.email.smtp.admin_email:missing_required",
          "base:auth.email.smtp.pass:missing_required",
          "base:auth.email.smtp.port:missing_required",
          "base:auth.email.smtp.user:missing_required",
        ]);
        expect(result.deferred.map((item) => item.check)).toContain("auth.email.smtp.host");
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("gives a table-rule finding its requirement as the reason, with help", () =>
      Effect.gen(function* () {
        const result = yield* run(`project_id = "demo"

[auth]
enabled = false

[auth.external.github]
enabled = true
client_id = "env(GITHUB_ID)"
`);

        expect(result.problems).toMatchObject([
          {
            code: "missing_required",
            path: ["auth", "external", "github", "secret"],
            reason: "required when auth.external.github.enabled = true",
            help: "set secret, or set enabled = false",
          },
        ]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("reports each external provider field on its own", () =>
      Effect.gen(function* () {
        const result = yield* run(`project_id = "demo"

[auth]
enabled = false

[auth.external.github]
enabled = true
secret = "env(GITHUB_SECRET)"
`);

        expect(labels(result.problems)).toEqual([
          "base:auth.external.github.client_id:missing_required",
        ]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );
  });

  describe("required keys that read env()", () => {
    const REQUIRED_ENV = `project_id = "demo"

[local.services.auth]
version = "env(AUTH_VERSION)"

[local.services.realtime]
version = "not-a-version!!"
`;

    it.effect("still reports the other problems and completes", () =>
      Effect.gen(function* () {
        const result = yield* run(REQUIRED_ENV);

        expect(labels(result.problems)).toEqual([
          "base:local.services.realtime.version:invalid_value",
        ]);
        expect(result.complete).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("keeps the same result when the variable is unset under --resolve-env", () =>
      Effect.gen(function* () {
        const result = yield* run(REQUIRED_ENV, lookupOf({}));

        expect(labels(result.problems)).toEqual([
          "base:local.services.auth.version:env_unset",
          "base:local.services.realtime.version:invalid_value",
        ]);
        expect(result.complete).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("reports an invalid required key beside another service's error and completes", () =>
      Effect.gen(function* () {
        const result = yield* run(`project_id = "demo"

[local.services.auth]
version = 5

[local.services.realtime]
version = "not-a-version!!"
`);

        expect(labels(result.problems)).toEqual([
          "base:local.services.auth.version:invalid_type",
          "base:local.services.realtime.version:invalid_value",
        ]);
        expect(result.complete).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );
  });

  describe("units read only what their check needs", () => {
    it.effect("reports an invalid version while a sibling container value is env()", () =>
      Effect.gen(function* () {
        const result = yield* run(`project_id = "demo"

[local.services.realtime]
version = "not-a-version!!"
container.memory = "env(REALTIME_MEMORY)"
`);

        expect(labels(result.problems)).toContain(
          "base:local.services.realtime.version:invalid_value",
        );
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect(
      "reports an unknown migration check rule while another rule's severity is env()",
      () =>
        Effect.gen(function* () {
          const result = yield* run(`project_id = "demo"

[db.migrations.checks]
rls_disabled_in_pubic = "warn"
rls_enabled_no_policy = "env(SEVERITY)"
`);

          expect(labels(result.problems)).toContain(
            "base:db.migrations.checks.rls_disabled_in_pubic:invalid_value",
          );
        }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );
  });

  describe("unset variables on enum keys", () => {
    it.effect("are errors under --resolve-env, because the literal would be rejected", () =>
      Effect.gen(function* () {
        const result = yield* run(
          'project_id = "demo"\n[auth]\npassword_requirements = "env(PW_REQ)"\n',
          lookupOf({}),
        );

        expect(result.problems).toMatchObject([
          { code: "env_unset", severity: "error", env: { name: "PW_REQ" } },
        ]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("stay warnings on a string key whose literal is accepted", () =>
      Effect.gen(function* () {
        const result = yield* run(
          'project_id = "demo"\n[studio]\nopenai_api_key = "env(OPENAI_API_KEY)"\n',
          lookupOf({}),
        );

        expect(result.problems).toMatchObject([{ code: "env_unset", severity: "warning" }]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );
  });

  describe("units read only what their branch needs", () => {
    const withFile = Effect.fnUntraced(function* (toml: string, file: string, body: string) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "config-validate-engine-" });
      yield* fs.makeDirectory(path.join(root, "supabase"), { recursive: true });
      yield* fs.writeFileString(path.join(root, "supabase", "config.toml"), toml);
      yield* fs.writeFileString(path.join(root, "supabase", file), body);
      const parsed = yield* parseCliConfigDocumentFile(root, { search: false });
      if (parsed === null) return yield* Effect.die("fixture config was not found");
      return yield* runConfigValidation(parsed, root, undefined);
    });

    it.effect("reports an asymmetric key error while jwt_secret is unknown", () =>
      Effect.gen(function* () {
        const result = yield* withFile(
          `project_id = "demo"

[auth]
jwt_secret = "env(JWT_SECRET)"
signing_keys_path = "keys.json"
`,
          "keys.json",
          '[{"kty":"RSA","kid":"k","n":"x","e":"AQAB"}]',
        );

        expect(labels(result.problems)).toContain("base:auth.anon_key:invalid_value");
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("reports one role's key error while the other role's key is unknown", () =>
      Effect.gen(function* () {
        const result = yield* withFile(
          `project_id = "demo"

[auth]
anon_key = "env(ANON_KEY)"
signing_keys_path = "keys.json"
`,
          "keys.json",
          '[{"kty":"RSA","kid":"k","n":"x","e":"AQAB"}]',
        );

        expect(labels(result.problems)).toContain("base:auth.service_role_key:invalid_value");
        expect(labels(result.problems)).not.toContain("base:auth.anon_key:invalid_value");
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("reports a content_path error while inline content is unknown", () =>
      Effect.gen(function* () {
        const result = yield* run(`project_id = "demo"

[auth.email.template.invite]
content_path = "./missing.html"
content = "env(INLINE)"
`);

        expect(labels(result.problems)).toContain(
          "base:auth.email.template.invite.content_path:invalid_value",
        );
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("reports a base provider error once when a remote edits a sibling provider", () =>
      Effect.gen(function* () {
        const result = yield* run(`project_id = "demo"

[auth.external.github]
enabled = true

[remotes.staging]
project_id = "abcdefghijklmnopqrst"

[remotes.staging.auth.external.google]
client_id = "x"
`);

        const github = labels(result.problems).filter((item) => item.includes("external.github"));
        expect(github.length).toBeGreaterThan(0);
        expect(github.every((item) => item.startsWith("base:"))).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );
  });

  describe("remote ownership", () => {
    it.effect("does not repeat base problems under a remote that edits another entry", () =>
      Effect.gen(function* () {
        const result = yield* run(`project_id = "demo"

[storage.buckets."bad#name"]

[auth.email.template.invite]
content_path = "./missing.html"

[remotes.staging]
project_id = "abcdefghijklmnopqrst"

[remotes.staging.storage.buckets.other]
public = true

[remotes.staging.auth.email.template.recovery]
subject = "y"
`);

        expect(labels(result.problems)).toEqual([
          "base:auth.email.template.invite.content_path:invalid_value",
          "base:storage.buckets.bad#name:invalid_value",
        ]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("reports a base bucket name error once when a remote edits a value inside it", () =>
      Effect.gen(function* () {
        const result = yield* run(`project_id = "demo"

[storage.buckets."bad#name"]

[remotes.staging]
project_id = "abcdefghijklmnopqrst"

[remotes.staging.storage.buckets."bad#name"]
public = true
`);

        expect(labels(result.problems)).toEqual(["base:storage.buckets.bad#name:invalid_value"]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("reports a bucket name error under the remote that adds the bucket", () =>
      Effect.gen(function* () {
        const result = yield* run(`project_id = "demo"

[remotes.staging]
project_id = "abcdefghijklmnopqrst"

[remotes.staging.storage.buckets."bad#name"]
public = true
`);

        expect(labels(result.problems)).toEqual(["staging:storage.buckets.bad#name:invalid_value"]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("reports a missing key to the base when a remote only edits a sibling", () =>
      Effect.gen(function* () {
        const result = yield* run(`project_id = "demo"

[local.services.default]
image = "a"

[remotes.staging]
project_id = "abcdefghijklmnopqrst"

[remotes.staging.local.services.default]
image = "b"
`);

        expect(labels(result.problems)).toEqual([
          "base:local.services.default.version:missing_required",
        ]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("gives a remote the missing key of a table only that remote adds", () =>
      Effect.gen(function* () {
        const result = yield* run(`project_id = "demo"

[remotes.staging]
project_id = "abcdefghijklmnopqrst"

[remotes.staging.local.services.default]
image = "b"
`);

        expect(labels(result.problems)).toEqual([
          "staging:local.services.default.version:missing_required",
        ]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("marks a problem written in the base block as inherited", () =>
      Effect.gen(function* () {
        const result = yield* run(`project_id = "demo"

[auth]
enabled = "env(ENABLE_AUTH)"
site_url = ""

[remotes.prod]
project_id = "abcdefghijklmnopqrst"

[remotes.prod.auth]
enabled = true
`);

        expect(result.problems).toMatchObject([
          { remote: "prod", inBase: true, path: ["auth", "site_url"] },
        ]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("quotes a remote name that is not a bare key in the duplicate message", () =>
      Effect.gen(function* () {
        const result = yield* run(
          'project_id = "demo"\n[remotes."a]b"]\nproject_id = "abcdefghijklmnopqrst"\n[remotes."c d"]\nproject_id = "abcdefghijklmnopqrst"\n',
        );

        expect(result.problems).toHaveLength(1);
        expect(result.problems[0]?.reason).toMatch(/^same project_id as remotes\."[^"]+"$/);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );
  });

  describe("unusable switches", () => {
    it.effect("defer the checks that branch on an invalid passkey flag", () =>
      Effect.gen(function* () {
        const result = yield* run(`project_id = "demo"

[auth.passkey]
enabled = "maybe"
`);

        expect(labels(result.problems)).toEqual(["base:auth.passkey.enabled:invalid_value"]);
        expect(result.deferred).toContainEqual({
          check: "auth.webauthn",
          reason: "invalid",
          waitsOn: ["auth.passkey.enabled"],
        });
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("defer the checks that branch on an invalid custom provider flag", () =>
      Effect.gen(function* () {
        const result = yield* run(`project_id = "demo"

[auth.external.my_oidc]
enabled = "maybe"
`);

        expect(labels(result.problems)).toEqual([
          "base:auth.external.my_oidc.enabled:invalid_value",
        ]);
        expect(result.deferred.map((item) => item.check)).toEqual(
          expect.arrayContaining(["auth.external.required"]),
        );
        expect(result.deferred.map((item) => item.check)).not.toContain(
          "auth.external.table.client_id",
        );
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );
  });

  describe("encrypted secrets", () => {
    const CIPHERTEXT =
      "encrypted:BKiXH15AyRzeohGyUrmB6cGjSklCrrBjdesQlX1VcXo/Xp20Bi2gGZ3AlIqxPQDmjVAALnhZamKnuY73l8Dz1P+BYiZUgxTSLzdCvdYUyVbNekj2UudbdUizBViERtZkuQwZHIv/";
    const PRIVATE_KEY = "7fd7210cef8f331ee8c55897996aaaafd853a2b20a4dc73d6d75759f65d2a7eb";
    const FIXTURE = `project_id = "demo"

[auth.captcha]
enabled = true
provider = "hcaptcha"
secret = "${CIPHERTEXT}"
`;

    it.effect("are unknown in default mode, never rejected", () =>
      Effect.gen(function* () {
        const result = yield* run(FIXTURE);

        expect(result.problems).toEqual([]);
        expect(result.deferred.map((item) => item.check)).toContain("auth.captcha.secret");
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("decrypt under --resolve-env with the project's private key", () =>
      Effect.gen(function* () {
        const result = yield* run(FIXTURE, {
          lookup: () => ({ state: "unset" }),
          dotenvPrivateKeys: [PRIVATE_KEY],
        });

        expect(result.problems).toEqual([]);
        expect(result.deferred).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect("fail under --resolve-env without a key that decrypts them", () =>
      Effect.gen(function* () {
        const result = yield* run(FIXTURE, lookupOf({}));

        expect(labels(result.problems)).toEqual(["base:auth.captcha.secret:invalid_value"]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );
  });
});

const statusLabels = (status: StatusTable): ReadonlyArray<string> =>
  [...status.values()].map((entry) => `${entry.path.join(".")}:${entry.state}`).toSorted();

describe("enclosingTableToMark", () => {
  it("skips tables that are already unknown", () => {
    const status: StatusTable = new Map();
    markUnknown(status, ["local", "services", "auth"], "table");

    expect(enclosingTableToMark(status, ["local", "services", "auth", "version"])).toEqual([
      "local",
      "services",
    ]);
  });

  it("returns nothing once every enclosing table is unknown", () => {
    const status: StatusTable = new Map();
    markUnknown(status, [], "table");
    markUnknown(status, ["api"], "table");

    expect(enclosingTableToMark(status, ["api", "port"])).toBeUndefined();
  });
});

describe("decodeWithStandIns", () => {
  it("marks the enclosing table and reports incomplete when a stand-in is still rejected", () => {
    const status: StatusTable = new Map();
    markUnknown(status, ["api", "port"], "invalid");
    const decoding = { project_id: "demo", api: { port: "not-a-port" } };

    const outcome = decodeWithStandIns(decoding, status, () => undefined);

    expect(outcome.complete).toBe(false);
    expect(outcome.config?.api.port).toBeDefined();
    expect(statusLabels(status)).toEqual(["api.port:invalid", "api:table"]);
  });

  it("stands in for an invalid required key without marking its table", () => {
    const status: StatusTable = new Map();
    markUnknown(status, ["local", "services", "auth", "version"], "invalid");
    const decoding = { project_id: "demo", local: { services: { auth: {} } } };

    const outcome = decodeWithStandIns(decoding, status, () => undefined);

    expect(outcome.complete).toBe(true);
    expect(outcome.config).toBeDefined();
    expect(statusLabels(status)).toEqual(["local.services.auth.version:invalid"]);
  });
});

describe("collapseProblems", () => {
  const problem = (overrides: Partial<RawProblem>): RawProblem => ({
    remote: undefined,
    path: ["auth", "site_url"],
    rank: 1,
    code: "missing_required",
    reason: "first",
    ...overrides,
  });

  it("keeps the lowest rank and, on a tie, the first", () => {
    const kept = collapseProblems([
      problem({ rank: 2, reason: "schema" }),
      problem({ rank: 0, reason: "cli" }),
      problem({ rank: 0, reason: "later" }),
    ]);

    expect(kept.map((item) => item.reason)).toEqual(["cli"]);
  });

  it("keeps problems that differ by context, key or code", () => {
    const kept = collapseProblems([
      problem({}),
      problem({ remote: "prod" }),
      problem({ path: ["auth", "jwt_secret"] }),
      problem({ code: "invalid_value" }),
    ]);

    expect(kept).toHaveLength(4);
  });
});

describe("classifyEnvProblems", () => {
  const keys = enumerateCliConfigKeys({});
  const use = (name: string, path: ReadonlyArray<string>, state: "unset" | "empty") => ({
    name,
    state,
    path,
  });
  const group = (name: string, path: ReadonlyArray<string>) => ({
    remote: undefined,
    group: { path, names: [name] },
  });

  it("warns for an unset string value no check needed", () => {
    const problems = classifyEnvProblems({
      envRefs: [use("SITE", ["auth", "site_url"], "unset")],
      groups: [group("SITE", ["auth", "site_url"])],
      keys,
      neededEnv: new Set(),
    });

    expect(problems).toMatchObject([{ code: "env_unset", severity: "warning" }]);
  });

  it("errors when a deferred check needed the variable", () => {
    const problems = classifyEnvProblems({
      envRefs: [use("SITE", ["auth", "site_url"], "empty")],
      groups: [group("SITE", ["auth", "site_url"])],
      keys,
      neededEnv: new Set(["SITE"]),
    });

    expect(problems).toMatchObject([{ code: "env_empty", severity: "error" }]);
  });

  it("errors when the literal reference would be rejected by the key's type", () => {
    const problems = classifyEnvProblems({
      envRefs: [use("PORT", ["api", "port"], "unset")],
      groups: [group("PORT", ["api", "port"])],
      keys,
      neededEnv: new Set(),
    });

    expect(problems).toMatchObject([{ code: "env_unset", severity: "error" }]);
  });
});

describe("runUnitsInContext", () => {
  it.effect("defers the units that read an unknown value and reports the rest", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const io = yield* makeCliConfigUnitIo("local");
      const merged = {
        project_id: "demo",
        db: { major_version: 12 },
        auth: { site_url: "env(SITE)" },
      };
      const context = analyzeContext({
        merged,
        base: merged,
        groups: [{ path: ["auth", "site_url"], names: ["SITE"] }],
        changed: undefined,
        env: undefined,
        standIn: undefined,
        workdir: "/tmp/config-validate-engine",
        pathService: path,
      });
      if (context.config === undefined) return yield* Effect.die("context did not decode");

      const runs = yield* runUnitsInContext({
        context,
        config: context.config,
        io,
        workdir: "/tmp/config-validate-engine",
        configPath: "supabase/config.toml",
      });

      const siteUrl = runs.find((run) => run.unit === "auth.site_url");
      expect(siteUrl?.findings).toEqual([]);
      expect(siteUrl?.waits.map((wait) => wait.envNames)).toEqual([["SITE"]]);
      const major = runs.find((run) => run.unit === "db.major_version");
      expect(major?.waits).toEqual([]);
      expect(major?.findings.map((found) => found.path.join("."))).toEqual(["db.major_version"]);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});

describe("independent findings", () => {
  const checkedProblems = (toml: string) =>
    run(toml).pipe(
      Effect.map((result) => labels(result.problems)),
      Effect.scoped,
      Effect.provide(BunServices.layer),
    );

  it.effect("reports a missing captcha provider while the secret is unknown", () =>
    Effect.gen(function* () {
      expect(
        yield* checkedProblems(`project_id = "demo"

[auth.captcha]
enabled = true
secret = "env(CAPTCHA_SECRET)"
`),
      ).toEqual(["base:auth.captcha.provider:missing_required"]);
    }),
  );

  it.effect("reports missing rp_origins while rp_id is unknown", () =>
    Effect.gen(function* () {
      expect(
        yield* checkedProblems(`project_id = "demo"

[auth.passkey]
enabled = true

[auth.webauthn]
rp_id = "env(RP_ID)"
`),
      ).toEqual(["base:auth.webauthn.rp_origins:missing_required"]);
    }),
  );

  it.effect("reports a missing custom provider secret while its client_id is unknown", () =>
    Effect.gen(function* () {
      expect(
        yield* checkedProblems(`project_id = "demo"

[auth.external.my_oidc]
enabled = true
client_id = "env(IDP_ID)"
`),
      ).toEqual(["base:auth.external.my_oidc.secret:missing_required"]);
    }),
  );

  it.effect("reports a studio port problem while api_url is unknown", () =>
    Effect.gen(function* () {
      expect(
        yield* checkedProblems(`project_id = "demo"

[studio]
enabled = true
port = 0
api_url = "env(STUDIO_URL)"
`),
      ).toEqual(["base:studio.port:missing_required"]);
    }),
  );

  it.effect("reports the other gcp fields while one is unknown", () =>
    Effect.gen(function* () {
      expect(
        yield* checkedProblems(`project_id = "demo"

[analytics]
enabled = true
backend = "bigquery"
gcp_project_id = "env(GCP_ID)"
`),
      ).toEqual([
        "base:analytics.gcp_jwt_path:missing_required",
        "base:analytics.gcp_project_number:missing_required",
      ]);
    }),
  );

  it.effect("reports the other sms provider fields while one is unknown", () =>
    Effect.gen(function* () {
      expect(
        yield* checkedProblems(`project_id = "demo"

[auth.sms.twilio]
enabled = true
account_sid = "env(SID)"
`),
      ).toEqual([
        "base:auth.sms.twilio.auth_token:missing_required",
        "base:auth.sms.twilio.message_service_sid:missing_required",
      ]);
    }),
  );

  it.effect("collects every missing cognito field", () =>
    Effect.gen(function* () {
      expect(
        yield* checkedProblems(`project_id = "demo"

[auth.third_party.aws_cognito]
enabled = true
`),
      ).toEqual([
        "base:auth.third_party.aws_cognito.user_pool_id:missing_required",
        "base:auth.third_party.aws_cognito.user_pool_region:missing_required",
      ]);
    }),
  );

  it.effect("reports every duplicate remote project id, not just the first", () =>
    Effect.gen(function* () {
      const ref = "cccccccccccccccccccc";
      expect(
        yield* checkedProblems(`project_id = "demo"

[remotes.one]
project_id = "${ref}"

[remotes.two]
project_id = "${ref}"

[remotes.three]
project_id = "${ref}"
`),
      ).toEqual(["three:project_id:remote_project_id", "two:project_id:remote_project_id"]);
    }),
  );

  it.effect("does not repeat an inherited error for a remote that changes a sibling field", () =>
    Effect.gen(function* () {
      expect(
        yield* checkedProblems(`project_id = "demo"

[auth.captcha]
enabled = true
provider = "hcaptcha"

[remotes.staging]
project_id = "abcdefghijklmnopqrst"

[remotes.staging.auth.captcha]
provider = "turnstile"
`),
      ).toEqual(["base:auth.captcha.secret:missing_required"]);
    }),
  );

  it.effect('keeps a remote named "" apart from the base', () =>
    Effect.gen(function* () {
      expect(
        yield* checkedProblems(`project_id = "demo"

[api]
port = "x"

[remotes.""]
project_id = "abcdefghijklmnopqrst"

[remotes."".api]
port = "y"
`),
      ).toEqual([":api.port:invalid_value", "base:api.port:invalid_value"]);
    }),
  );

  it.effect(
    "counts one deferral for a check and its table rule twin, and keeps distinct checks",
    () =>
      Effect.gen(function* () {
        const result = yield* run(`project_id = "demo"

[auth.email.smtp]
enabled = "env(SMTP_ENABLED)"
`);

        expect(result.deferred.map((item) => item.check).toSorted()).toEqual([
          "auth.email.smtp.admin_email",
          "auth.email.smtp.host",
          "auth.email.smtp.pass",
          "auth.email.smtp.port",
          "auth.email.smtp.user",
        ]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("tells an env() deferral from one waiting on an invalid value", () =>
    Effect.gen(function* () {
      const result = yield* run(`project_id = "demo"

[api]
enabled = "maybe"

[auth.captcha]
enabled = true
provider = "turnstile"
secret = "env(CAPTCHA_SECRET)"
`);

      const reasons = Object.fromEntries(result.deferred.map((item) => [item.check, item.reason]));
      expect(reasons["auth.captcha.secret"]).toBe("env");
      expect(reasons["api.port"]).toBe("invalid");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});

describe("collapseProblems contexts", () => {
  it('keeps a remote named "" apart from the base', () => {
    const base = { path: ["api", "port"], rank: 1, code: "invalid_value", reason: "x" } as const;
    const kept = collapseProblems([
      { ...base, remote: undefined },
      { ...base, remote: "" },
    ]);

    expect(kept).toHaveLength(2);
  });
});

describe("runUnitsInContext file reads", () => {
  const WORKDIR = "/tmp/config-validate-engine";
  const UNKNOWN_AUTH = [{ path: ["auth", "enabled"], names: ["AUTH_ON"] }];

  const contextOf = Effect.fnUntraced(function* (
    merged: Record<string, unknown>,
    groups: ReadonlyArray<{ path: ReadonlyArray<string>; names: ReadonlyArray<string> }>,
  ) {
    const path = yield* Path.Path;
    const context = analyzeContext({
      merged,
      base: merged,
      groups,
      changed: undefined,
      env: undefined,
      standIn: undefined,
      workdir: WORKDIR,
      pathService: path,
    });
    if (context.config === undefined) return yield* Effect.die("context did not decode");
    return context;
  });

  const recordingIo = () => {
    const reads: Array<string> = [];
    const io: CliConfigUnitIo = {
      readText: (absPath) =>
        Effect.sync(() => {
          reads.push(absPath);
          return Exit.succeed("[]");
        }),
      readFailureCause: (error) => error,
      filesAllowed: () => true,
    };
    return { io, reads };
  };

  const runUnits = Effect.fnUntraced(function* (
    merged: Record<string, unknown>,
    io: CliConfigUnitIo,
    groups: ReadonlyArray<{ path: ReadonlyArray<string>; names: ReadonlyArray<string> }> = [],
  ) {
    const context = yield* contextOf(merged, groups);
    if (context.config === undefined) return yield* Effect.die("context did not decode");
    return yield* runUnitsInContext({
      context,
      config: context.config,
      io,
      workdir: WORKDIR,
      configPath: "supabase/config.toml",
    });
  });

  it.effect("opens no file while a switch the check reads is unknown", () =>
    Effect.gen(function* () {
      const { io, reads } = recordingIo();
      const runs = yield* runUnits(
        {
          project_id: "demo",
          auth: { enabled: "env(AUTH_ON)", signing_keys_path: "keys.json" },
        },
        io,
        UNKNOWN_AUTH,
      );

      expect(reads).toEqual([]);
      expect(runs.find((run) => run.unit === "auth.signing_keys")?.waits).not.toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("opens the file once every value the check reads is known", () =>
    Effect.gen(function* () {
      const { io, reads } = recordingIo();
      yield* runUnits(
        { project_id: "demo", auth: { enabled: true, signing_keys_path: "keys.json" } },
        io,
      );

      expect(reads.some((read) => read.endsWith("keys.json"))).toBe(true);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("touches no file for an email template path while auth is unknown", () =>
    Effect.gen(function* () {
      const touched: Array<string> = [];
      const record = (method: string) => (target: string) =>
        Effect.sync(() => {
          touched.push(`${method}:${target}`);
        }).pipe(
          Effect.andThen(
            Effect.fail(
              PlatformError.systemError({
                _tag: "NotFound",
                module: "FileSystem",
                method,
                pathOrDescriptor: target,
              }),
            ),
          ),
        );
      const fs = FileSystem.makeNoop({
        realPath: record("realPath"),
        stat: record("stat"),
        readLink: record("readLink"),
        exists: (target) =>
          Effect.sync(() => {
            touched.push(`exists:${target}`);
            return false;
          }),
      });
      const { io } = recordingIo();
      yield* runUnits(
        {
          project_id: "demo",
          auth: {
            enabled: "env(AUTH_ON)",
            email: { template: { invite: { content_path: "./invite.html" } } },
          },
        },
        io,
        UNKNOWN_AUTH,
      ).pipe(Effect.provideService(FileSystem.FileSystem, fs));

      expect(touched).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
