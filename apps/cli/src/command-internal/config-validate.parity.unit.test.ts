import { unusedStackServices } from "../../tests/helpers/unused-stack.ts";
import { BunCrypto, BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { CliConfigSchema, type CliConfig } from "@supabase/config";
import { stringify as stringifyToml } from "smol-toml";
import { Effect, Exit, FileSystem, Layer, Path, Schema } from "effect";

import { withEnvVar, mockCommandSettings } from "../../tests/helpers/command-mocks.ts";
import { CommandPlatformApiFactory } from "../auth/command-platform-api-factory.service.ts";
import { readDbConfig } from "./db-config.read.ts";
import { resolveStorageCredentials } from "./storage-credentials.ts";
import { resolveLocalConfigValues, resolveStartAuthDurations } from "./local-config-values.ts";
import { runtimeInfoLayer } from "../shared/runtime/runtime-info.layer.ts";
import { cliConfigValuesTestLayer } from "../../tests/helpers/config-values-layer.ts";

const stringifyJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * Cross-caller parity coverage: for a table of shared misconfigurations, drives both real
 * pipelines — D (`readDbConfig`, Effect/raw-TOML) and L (`resolveLocalConfigValues`,
 * `@supabase/config`-decoded) — and asserts they fail with the same error-message substring,
 * since both run the shared units in `config-check-units.ts`. A third caller, the
 * storage-credentials resolver (S), shares the `api.port`/`api.tls` presence branches and the
 * `auth.jwt_secret`/`auth.service_role_key` resolution; its own describe block below drives
 * that pipeline.
 *
 * D's harness replicates the `withConfig`/`read`/`failsWith` pattern from
 * `db-config.read.unit.test.ts` (file-local there, not exported). L's harness replicates
 * the `baseConfig`/`WORKDIR` pattern from `local-config-values.unit.test.ts`.
 */

const withConfig = (content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "config-validate-parity-" });
    yield* fs.makeDirectory(path.join(dir, "supabase"), { recursive: true });
    yield* fs.writeFileString(path.join(dir, "supabase", "config.toml"), content);
    return dir;
  }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer]));

const readD = (workdir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* readDbConfig(fs, path, workdir);
  }).pipe(
    Effect.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layer, cliConfigValuesTestLayer)),
  );

/** Drives D's real pipeline and asserts the failure message contains `message`. */
function failsWithD(tomlLines: ReadonlyArray<string>, message: string) {
  return Effect.gen(function* () {
    const dir = yield* withConfig(tomlLines.join("\n"));
    const exit = yield* readD(dir).pipe(Effect.exit);
    expect(Exit.isFailure(exit), `D: expected failure containing: ${message}`).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(stringifyJson(exit.cause)).toContain(message);
    }
  }).pipe(Effect.scoped);
}

const decodeConfig = Schema.decodeUnknownSync(CliConfigSchema);
const WORKDIR = "/tmp/config-validate-parity-test";

function baseConfig(overrides: Record<string, unknown> = {}): CliConfig {
  return decodeConfig({ project_id: "test", ...overrides });
}

/** Drives L's real pipeline and asserts the failure message contains `message`. */
function failsWithL(
  overrides: Record<string, unknown>,
  message: string,
  document?: Readonly<Record<string, unknown>>,
) {
  return Effect.gen(function* () {
    const config = baseConfig(overrides);
    const error = yield* Effect.flip(
      resolveLocalConfigValues(config, "127.0.0.1", WORKDIR, document),
    );
    expect(error.message).toContain(message);
  }).pipe(Effect.provide([BunServices.layer, BunCrypto.layer]));
}

interface ParityScenario {
  readonly name: string;
  readonly toml: ReadonlyArray<string>;
  readonly overrides: Record<string, unknown>;
  readonly document?: Readonly<Record<string, unknown>>;
  readonly message: string;
}

const scenarios: ReadonlyArray<ParityScenario> = [
  {
    name: "auth.email.notification content_path missing at both resolution bases",
    toml: [
      "[auth.email.notification.password_changed]",
      "enabled = true",
      'content_path = "./templates/missing.html"',
    ],
    overrides: {
      auth: {
        email: {
          notification: {
            password_changed: { enabled: true, content_path: "./templates/missing.html" },
          },
        },
      },
    },
    message: "Invalid config for auth.email.notification.password_changed.content_path",
  },
  {
    name: "auth.email.notification content_path resolves outside the project root",
    toml: [
      "[auth.email.notification.password_changed]",
      "enabled = true",
      'content_path = "/etc/hosts"',
    ],
    overrides: {
      auth: {
        email: {
          notification: {
            password_changed: { enabled: true, content_path: "/etc/hosts" },
          },
        },
      },
    },
    message: "resolves outside the project root",
  },
  {
    name: "db.port = 0",
    toml: ["[db]", "port = 0"],
    overrides: { db: { port: 0 } },
    message: "Missing required field in config: db.port",
  },
  {
    name: "db.major_version = 0",
    toml: ["[db]", "major_version = 0"],
    overrides: { db: { major_version: 0 } },
    message: "Missing required field in config: db.major_version",
  },
  {
    name: "db.major_version unsupported (13)",
    toml: ["[db]", "major_version = 13"],
    overrides: { db: { major_version: 13 } },
    message:
      "Postgres version 13.x is unsupported. To use the CLI, upgrade your project to Postgres 17, then set db.major_version = 17 in your project config: https://supabase.com/docs/guides/platform/upgrading.",
  },
  {
    name: "db.major_version unsupported (16)",
    toml: ["[db]", "major_version = 16"],
    overrides: { db: { major_version: 16 } },
    message: "Failed reading config: Invalid db.major_version: 16.",
  },
  {
    name: "storage bucket name with an invalid pattern",
    toml: ['[storage.buckets."bad#name"]'],
    overrides: { storage: { buckets: { "bad#name": {} } } },
    message:
      "Invalid Bucket name: bad#name. Only lowercase letters, numbers, dots, hyphens, and spaces are allowed.",
  },
  {
    name: "function slug with an invalid pattern",
    toml: ["[functions.123]"],
    overrides: { functions: { "123": {} } },
    message:
      "Invalid Function name: 123. Must start with at least one letter, and only include alphanumeric characters, underscores, and hyphens.",
  },
  {
    name: "edge_runtime.deno_version = 0",
    toml: ["[edge_runtime]", "deno_version = 0"],
    overrides: { edge_runtime: { deno_version: 0 } },
    message: "Missing required field in config: edge_runtime.deno_version",
  },
  {
    name: "edge_runtime.deno_version unsupported (3)",
    toml: ["[edge_runtime]", "deno_version = 3"],
    overrides: { edge_runtime: { deno_version: 3 } },
    message: "Failed reading config: Invalid edge_runtime.deno_version: 3.",
  },
  {
    name: "auth.site_url empty with auth enabled",
    toml: ["[auth]", "enabled = true", 'site_url = ""'],
    overrides: { auth: { enabled: true, site_url: "" } },
    message: "Missing required field in config: auth.site_url",
  },
  {
    name: "auth.captcha enabled without a provider",
    toml: ["[auth.captcha]", "enabled = true"],
    overrides: {
      auth: {
        enabled: true,
        site_url: "http://localhost:3000",
        captcha: { enabled: true },
      },
    },
    message: "Missing required field in config: auth.captcha.provider",
  },
  {
    name: "auth.captcha enabled with a provider but no secret",
    toml: ["[auth.captcha]", "enabled = true", 'provider = "hcaptcha"'],
    overrides: {
      auth: {
        enabled: true,
        site_url: "http://localhost:3000",
        captcha: { enabled: true, provider: "hcaptcha" },
      },
    },
    message: "Missing required field in config: auth.captcha.secret",
  },
  {
    name: "auth.hook.* with a badly-formatted secret",
    toml: [
      "[auth.hook.custom_access_token]",
      "enabled = true",
      'uri = "https://example.test/hook"',
      'secrets = "not-a-valid-secret"',
    ],
    overrides: {
      auth: {
        enabled: true,
        site_url: "http://localhost:3000",
        hook: {
          custom_access_token: {
            enabled: true,
            uri: "https://example.test/hook",
            secrets: "not-a-valid-secret",
          },
        },
      },
    },
    // D's assertion runs the message through `JSON.stringify`, which backslash-escapes double
    // quotes; trim to the quote-free prefix.
    message: "auth.hook.custom_access_token.secrets must be formatted as",
  },
  {
    name: "auth.mfa.* enroll_enabled without verify_enabled",
    toml: ["[auth.mfa.totp]", "enroll_enabled = true", "verify_enabled = false"],
    overrides: {
      auth: {
        enabled: true,
        site_url: "http://localhost:3000",
        mfa: { totp: { enroll_enabled: true, verify_enabled: false } },
      },
    },
    message: "Invalid MFA config: auth.mfa.totp.enroll_enabled requires verify_enabled",
  },
  {
    name: "auth.third_party.* enabled without its required field",
    toml: ["[auth.third_party.firebase]", "enabled = true"],
    overrides: {
      auth: {
        enabled: true,
        site_url: "http://localhost:3000",
        third_party: { firebase: { enabled: true } },
      },
    },
    message: "Invalid config: auth.third_party.firebase is enabled but without a project_id.",
  },
  {
    name: "auth.third_party.* more than one provider enabled",
    toml: [
      "[auth.third_party.firebase]",
      "enabled = true",
      'project_id = "proj"',
      "[auth.third_party.auth0]",
      "enabled = true",
      'tenant = "tenant"',
    ],
    overrides: {
      auth: {
        enabled: true,
        site_url: "http://localhost:3000",
        third_party: {
          firebase: { enabled: true, project_id: "proj" },
          auth0: { enabled: true, tenant: "tenant" },
        },
      },
    },
    message: "Invalid config: Only one third_party provider allowed to be enabled at a time.",
  },
  {
    name: "auth.email.smtp present table missing a required field",
    // Both pipelines read every smtp field straight off the raw TOML/document, not a
    // schema-decoded, always-defaulted value — L needs the raw `document` (5th param) for this.
    toml: ["[auth.email.smtp]", 'user = "u"'],
    overrides: { auth: { enabled: true, site_url: "http://localhost:3000" } },
    document: { auth: { email: { smtp: { user: "u" } } } },
    message: "Missing required field in config: auth.email.smtp.host",
  },
  {
    name: "experimental.pgdelta.format_options invalid JSON",
    toml: ["[experimental.pgdelta]", 'format_options = "{not json"'],
    overrides: { experimental: { pgdelta: { format_options: "{not json" } } },
    message: "Invalid config for experimental.pgdelta.format_options: must be valid JSON",
  },
  {
    name: "experimental.webhooks present without enabled = true",
    // Both pipelines read webhooks presence from the raw document rather than the
    // always-defaulted decoded `enabled` — L needs the raw `document` (5th param) for this.
    toml: ["[experimental.webhooks]", "enabled = false"],
    overrides: { experimental: { webhooks: { enabled: false } } },
    document: { experimental: { webhooks: { enabled: false } } },
    message:
      "Webhooks cannot be deactivated. [experimental.webhooks] enabled can either be true or left undefined",
  },
  {
    name: "custom auth.external provider enabled without client_id",
    toml: ["[auth.external.my_oidc]", "enabled = true"],
    overrides: {},
    document: { auth: { external: { my_oidc: { enabled: true } } } },
    message: "Missing required field in config: auth.external.my_oidc.client_id",
  },
  {
    name: "custom auth.external provider enabled without secret",
    toml: ["[auth.external.my_oidc]", "enabled = true", 'client_id = "cid"'],
    overrides: {},
    document: { auth: { external: { my_oidc: { enabled: true, client_id: "cid" } } } },
    message: "Missing required field in config: auth.external.my_oidc.secret",
  },
];

// Explicitly skipped (only one caller runs the branch, or the branch isn't exercised the same
// way by both — see `config-check-units.ts` for the per-pipeline orders):
// - `remotes[*].project_id` — D-only, never part of the shared validator
// (it is a validate-only unit).
// - `project_id`, `studio`, `local_smtp` — L-only, D has no equivalent sections. `api.tls`
// presence is D-skipped for the same reason but is shared with S via
// `validateApiTlsPresence` — see the S block below.
describe("config check units cross-caller parity (D vs L)", () => {
  for (const scenario of scenarios) {
    it.effect(`${scenario.name}: D and L fail with the same message`, () =>
      Effect.gen(function* () {
        yield* failsWithD(scenario.toml, scenario.message);
        yield* failsWithL(scenario.overrides, scenario.message, scenario.document);
      }),
    );
  }
});

interface GoldenScenario {
  readonly name: string;
  readonly toml: ReadonlyArray<string>;
  readonly overrides: Record<string, unknown>;
  readonly document?: Readonly<Record<string, unknown>>;
  readonly files?: Readonly<Record<string, string>>;
  /** D's exact first error; `undefined` when D accepts the config. */
  readonly D: string | undefined;
  /** L's exact first error; `undefined` when L accepts the config or the schema rejects it before any unit runs. */
  readonly L: string | undefined;
}

const MESSAGE_AUTH = { enabled: true, site_url: "http://localhost:3000" };

const golden: ReadonlyArray<GoldenScenario> = [
  {
    name: "passkey flag that is not a boolean",
    toml: ["[auth.passkey]", 'enabled = "maybe"'],
    overrides: { auth: MESSAGE_AUTH },
    document: { auth: { passkey: { enabled: "maybe" } } },
    D: 'Invalid auth.passkey.enabled in supabase/config.toml: "maybe" is not true or false.',
    L: 'Invalid config for auth.passkey.enabled: "maybe" is not a valid boolean',
  },
  {
    name: "passkey without a webauthn section",
    toml: ["[auth.passkey]", "enabled = true"],
    overrides: { auth: MESSAGE_AUTH },
    document: { auth: { passkey: { enabled: true } } },
    D: "Missing required config section: auth.webauthn (required when auth.passkey.enabled is true)",
    L: "Missing required config section: auth.webauthn (required when auth.passkey.enabled is true)",
  },
  {
    name: "passkey with a scalar webauthn",
    toml: ["[auth]", 'webauthn = "x"', "[auth.passkey]", "enabled = true"],
    overrides: { auth: MESSAGE_AUTH },
    document: { auth: { passkey: { enabled: true }, webauthn: "x" } },
    D: "Missing required config section: auth.webauthn (required when auth.passkey.enabled is true)",
    L: "Missing required config section: auth.webauthn (required when auth.passkey.enabled is true)",
  },
  {
    name: "webauthn without rp_id",
    toml: ["[auth.passkey]", "enabled = true", "[auth.webauthn]", 'rp_origins = ["http://x.test"]'],
    overrides: { auth: MESSAGE_AUTH },
    document: {
      auth: { passkey: { enabled: true }, webauthn: { rp_origins: ["http://x.test"] } },
    },
    D: "Missing required field in config: auth.webauthn.rp_id",
    L: "Missing required field in config: auth.webauthn.rp_id",
  },
  {
    name: "webauthn without rp_origins",
    toml: ["[auth.passkey]", "enabled = true", "[auth.webauthn]", 'rp_id = "localhost"'],
    overrides: { auth: MESSAGE_AUTH },
    document: { auth: { passkey: { enabled: true }, webauthn: { rp_id: "localhost" } } },
    D: "Missing required field in config: auth.webauthn.rp_origins",
    L: "Missing required field in config: auth.webauthn.rp_origins",
  },
  {
    name: "twilio enabled without account_sid",
    toml: ["[auth.sms.twilio]", "enabled = true"],
    overrides: {},
    D: "Missing required field in config: auth.sms.twilio.account_sid",
    L: undefined,
  },
  {
    name: "vonage enabled without api_key",
    toml: ["[auth.sms.vonage]", "enabled = true", 'from = "f"'],
    overrides: {},
    D: "Missing required field in config: auth.sms.vonage.api_key",
    L: undefined,
  },
  {
    name: "built-in external provider enabled without client_id",
    toml: ["[auth.external.github]", "enabled = true"],
    overrides: {},
    D: "Missing required field in config: auth.external.github.client_id",
    L: undefined,
  },
  {
    name: "built-in external provider enabled without secret",
    toml: ["[auth.external.github]", "enabled = true", 'client_id = "c"'],
    overrides: {},
    D: "Missing required field in config: auth.external.github.secret",
    L: undefined,
  },
  {
    name: "apple enabled without client_id",
    toml: ["[auth.external.apple]", "enabled = true"],
    overrides: {},
    D: "Missing required field in config: auth.external.apple.client_id",
    L: undefined,
  },
  {
    name: "TLS cert that does not exist",
    toml: ["[api.tls]", "enabled = true", 'cert_path = "nope.crt"', 'key_path = "nope.key"'],
    overrides: { api: { tls: { enabled: true, cert_path: "nope.crt", key_path: "nope.key" } } },
    D: undefined,
    L: "failed to read TLS cert: ENOENT: no such file or directory, open '<workdir>/supabase/nope.crt'",
  },
  {
    name: "db.root_key that is not a string",
    toml: ["[db]", "root_key = 5"],
    overrides: {},
    document: { db: { root_key: 5 } },
    D: 'Invalid db.root_key in supabase/config.toml: "<redacted>" is not a string.',
    L: "failed to parse config:\ndb.root_key: expected a table",
  },
  {
    name: "analytics.backend outside the enum",
    toml: ["[analytics]", 'backend = "nope"'],
    overrides: {},
    D: 'Invalid analytics.backend in supabase/config.toml: "nope" is not one of "postgres", "bigquery".',
    L: undefined,
  },
  {
    name: "bigquery analytics without a project id",
    toml: ["[analytics]", "enabled = true", 'backend = "bigquery"'],
    overrides: { analytics: { enabled: true, backend: "bigquery" } },
    D: "Missing required field in config: analytics.gcp_project_id",
    L: "Missing required field in config: analytics.gcp_project_id",
  },
  {
    name: "a signing key the key generation rejects",
    toml: ["[auth]", 'signing_keys_path = "keys.json"'],
    overrides: { auth: { signing_keys_path: "keys.json" } },
    files: {
      "supabase/keys.json": '[{"kty":"EC","crv":"P-256","x":"a","y":"b","d":"c","kid":"k"}]',
    },
    D: undefined,
    L: "failed to convert JWK to private key: failed to decode x coordinate: illegal base64 data at input byte 0",
  },
  {
    name: "auth.email.max_frequency that is not a duration",
    toml: ["[auth.email]", 'max_frequency = "5x"'],
    overrides: { auth: { email: { max_frequency: "5x" } } },
    D: undefined,
    L: 'invalid config for auth.email.max_frequency: time: unknown unit in duration "5x"',
  },
  {
    name: "auth.sms.max_frequency that is not a duration",
    toml: ["[auth.sms]", 'max_frequency = "5x"'],
    overrides: { auth: { sms: { max_frequency: "5x" } } },
    D: undefined,
    L: 'invalid config for auth.sms.max_frequency: time: unknown unit in duration "5x"',
  },
  {
    name: "auth.sessions.timebox that is not a duration",
    toml: ["[auth.sessions]", 'timebox = "5x"'],
    overrides: { auth: { sessions: { timebox: "5x" } } },
    D: undefined,
    L: 'invalid config for auth.sessions.timebox: time: unknown unit in duration "5x"',
  },
  {
    name: "auth.sessions.inactivity_timeout that is not a duration",
    toml: ["[auth.sessions]", 'inactivity_timeout = "5x"'],
    overrides: { auth: { sessions: { inactivity_timeout: "5x" } } },
    D: undefined,
    L: 'invalid config for auth.sessions.inactivity_timeout: time: unknown unit in duration "5x"',
  },
  {
    name: "auth.mfa.phone.max_frequency that is not a duration",
    toml: ["[auth.mfa.phone]", 'max_frequency = "5x"'],
    overrides: { auth: { mfa: { phone: { max_frequency: "5x" } } } },
    D: undefined,
    L: 'invalid config for auth.mfa.phone.max_frequency: time: unknown unit in duration "5x"',
  },
];

const firstErrors = (scenario: GoldenScenario) =>
  Effect.gen(function* () {
    const dir = yield* withConfig(scenario.toml.join("\n"));
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const [file, content] of Object.entries(scenario.files ?? {})) {
      yield* fs.writeFileString(path.join(dir, file), content);
    }
    const d = yield* Effect.flip(readD(dir)).pipe(
      Effect.map((error) => error.message),
      Effect.orElseSucceed(() => undefined),
    );
    const config = yield* Effect.try({
      try: () => baseConfig(scenario.overrides),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined));
    const l =
      config === undefined
        ? undefined
        : yield* resolveLocalConfigValues(config, "127.0.0.1", dir, scenario.document).pipe(
            Effect.andThen(resolveStartAuthDurations(config, dir, scenario.document)),
            Effect.flip,
            Effect.map((error) => error.message.replaceAll(dir, "<workdir>")),
            Effect.orElseSucceed(() => undefined),
            Effect.provide([BunServices.layer, BunCrypto.layer]),
          );
    return { d, l };
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

describe("config check units first-error text, pinned per pipeline", () => {
  for (const scenario of golden) {
    it.effect(`${scenario.name}`, () =>
      Effect.gen(function* () {
        const { d, l } = yield* firstErrors(scenario);

        expect(d).toBe(scenario.D);
        expect(l).toBe(scenario.L);
      }),
    );
  }

  it.effect("two errors: D reports db.major_version 12 before the function slug, verbatim", () =>
    Effect.gen(function* () {
      const { d } = yield* firstErrors({
        name: "",
        toml: ["[db]", "major_version = 12", "[functions.1bad]"],
        overrides: {},
        D: undefined,
        L: undefined,
      });

      expect(d).toBe(
        "Postgres version 12.x is unsupported. To use the CLI, either start a new project or follow project migration steps here: https://supabase.com/docs/guides/database#migrating-between-projects.",
      );
    }),
  );

  it.effect("two errors: D reports db.port first and L the unreadable signing keys, verbatim", () =>
    Effect.gen(function* () {
      const { d, l } = yield* firstErrors({
        name: "",
        toml: ["[db]", "port = 0", "[auth]", 'signing_keys_path = "./nope.json"'],
        overrides: { db: { port: 0 }, auth: { signing_keys_path: "./nope.json" } },
        D: undefined,
        L: undefined,
      });

      expect(d).toBe("Missing required field in config: db.port");
      expect(l).toBe(
        "failed to read signing keys: ENOENT: no such file or directory, open '<workdir>/supabase/nope.json'",
      );
    }),
  );

  it.effect("two errors: L reports the short jwt_secret before db.major_version, verbatim", () =>
    Effect.gen(function* () {
      const { l } = yield* firstErrors({
        name: "",
        toml: ["[db]", "major_version = 12", "[auth]", 'jwt_secret = "short"'],
        overrides: { auth: { jwt_secret: "short" }, db: { major_version: 12 } },
        D: undefined,
        L: undefined,
      });

      expect(l).toBe("Invalid config for auth.jwt_secret. Must be at least 16 characters");
    }),
  );
});

// The `api.port` branch is L-only in the table above (D has no api section) but is shared with
// the storage-credentials resolver (S) through `validateApiPort`, as are the `auth.jwt_secret`
// length rule and `encrypted:` decryption. Drive S and L against the same misconfiguration and
// assert the identical message, so the shared branches cannot drift.
describe("shared api + auth validation branches, cross-caller parity (S vs L)", () => {
  /** Drives S's real pipeline (`resolveStorageCredentials`, local branch) to failure. */
  const failsWithS = (overrides: Record<string, unknown>, message: string) =>
    Effect.gen(function* () {
      const dir = yield* withConfig(stringifyToml({ project_id: "test", ...overrides }));
      const exit = yield* resolveStorageCredentials({ projectRef: "" }).pipe(
        Effect.provide(
          Layer.mergeAll(
            unusedStackServices,
            cliConfigValuesTestLayer,
            BunServices.layer,
            BunCrypto.layer,
            runtimeInfoLayer,
            mockCommandSettings({ workdir: dir }),
            // Local-path parity only — the remote branch (and with it the
            // platform API) is never reached.
            Layer.succeed(CommandPlatformApiFactory, {
              make: Effect.die("unreachable: local-only parity scenario"),
            }),
          ),
        ),
        Effect.exit,
      );
      expect(Exit.isFailure(exit), `S: expected failure containing: ${message}`).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(stringifyJson(exit.cause)).toContain(message);
      }
    }).pipe(Effect.scoped);

  // Ambient SUPABASE_API_* / SUPABASE_AUTH_* values would override the config
  // under test, so pin every participating key to unset for the duration of
  // each scenario.
  const isolated = <A, E, R>(body: Effect.Effect<A, E, R>) =>
    [
      "SUPABASE_API_PORT",
      "SUPABASE_API_ENABLED",
      "SUPABASE_API_TLS_ENABLED",
      "SUPABASE_API_TLS_CERT_PATH",
      "SUPABASE_API_TLS_KEY_PATH",
      "SUPABASE_AUTH_JWT_SECRET",
      "SUPABASE_AUTH_SERVICE_ROLE_KEY",
    ].reduce((inner, name) => withEnvVar(name, undefined, inner), body);

  it.effect("api.port = 0 with the API enabled: S and L fail with the same message", () =>
    isolated(
      Effect.gen(function* () {
        const message = "Missing required field in config: api.port";
        yield* failsWithL({ api: { port: 0 } }, message);
        yield* failsWithS({ api: { port: 0 } }, message);
      }),
    ),
  );

  it.effect("api.tls cert without key: S and L fail with the same presence message", () =>
    isolated(
      Effect.gen(function* () {
        const message = "Missing required field in config: api.tls.key_path";
        yield* failsWithL({ api: { tls: { enabled: true, cert_path: "kong.crt" } } }, message);
        yield* failsWithS({ api: { tls: { enabled: true, cert_path: "kong.crt" } } }, message);
      }),
    ),
  );

  it.effect("auth.jwt_secret shorter than 16 characters: S and L fail with the same message", () =>
    isolated(
      Effect.gen(function* () {
        const message = "Invalid config for auth.jwt_secret. Must be at least 16 characters";
        yield* failsWithL({ auth: { jwt_secret: "short" } }, message);
        yield* failsWithS({ auth: { jwt_secret: "short" } }, message);
      }),
    ),
  );

  it.effect("undecryptable encrypted: auth.service_role_key fails S at resolvedConfig load", () =>
    isolated(
      failsWithS(
        { auth: { service_role_key: "encrypted:not-a-real-ciphertext" } },
        "failed to parse config",
      ),
    ),
  );
});
