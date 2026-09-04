import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { CliConfigSchema, type CliConfig } from "@supabase/config";
import { Effect, Exit, FileSystem, Layer, Path, Schema } from "effect";

import { legacyWithEnv, mockLegacyCliSettings } from "../../../tests/helpers/legacy-mocks.ts";
import { LegacyPlatformApiFactory } from "../auth/legacy-platform-api-factory.service.ts";
import { legacyReadDbToml } from "./legacy-db-config.toml-read.ts";
import { legacyResolveStorageCredentials } from "./legacy-storage-credentials.ts";
import { legacyResolveLocalConfigValues } from "./legacy-local-config-values.ts";

/**
 * Cross-caller parity coverage: for a table of Go-parity misconfigurations, drives BOTH real
 * pipelines — D (`legacyReadDbToml`, Effect/raw-TOML) and L (`legacyResolveLocalConfigValues`,
 * `@supabase/config`-decoded) — and asserts they fail with the SAME shared error-message
 * substring, since both now route through the single `legacyValidateResolvedConfig`. The two
 * pipelines don't need byte-identical exception wrapping, just the same core Go-parity message
 * text (`.toContain(...)` on both sides with the same expected string). A third caller — the
 * storage-credentials resolver (S, `legacyResolveStorageCredentials`) — shares the `api.port`
 * and `api.tls` presence branches through the exported helpers; its own describe block below
 * drives that pipeline.
 *
 * D's harness replicates the `withConfig`/`read`/`failsWith` pattern from
 * `legacy-db-config.toml-read.unit.test.ts` (file-local there, not exported — faithfully
 * reproduced here rather than imported). L's harness replicates the `baseConfig`/`WORKDIR`
 * pattern from `legacy-local-config-values.unit.test.ts` (same reasoning).
 */

function withConfig(content: string) {
  const dir = mkdtempSync(join(tmpdir(), "legacy-config-validate-parity-"));
  mkdirSync(join(dir, "supabase"), { recursive: true });
  writeFileSync(join(dir, "supabase", "config.toml"), content);
  return dir;
}

const readD = (workdir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* legacyReadDbToml(fs, path, workdir);
  }).pipe(Effect.provide(BunServices.layer));

/** Drives D's real pipeline and asserts the failure message contains `message`. */
function failsWithD(tomlLines: ReadonlyArray<string>, message: string) {
  return Effect.gen(function* () {
    const dir = withConfig(tomlLines.join("\n"));
    const exit = yield* readD(dir).pipe(Effect.exit);
    expect(Exit.isFailure(exit), `D: expected failure containing: ${message}`).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain(message);
    }
    rmSync(dir, { recursive: true, force: true });
  });
}

const decodeConfig = Schema.decodeUnknownSync(CliConfigSchema);
const WORKDIR = "/tmp/legacy-config-validate-parity-test";

function baseConfig(overrides: Record<string, unknown> = {}): CliConfig {
  return decodeConfig({ project_id: "test", ...overrides });
}

/** Drives L's real pipeline and asserts the failure message contains `message`. */
function failsWithL(
  overrides: Record<string, unknown>,
  message: string,
  document?: Readonly<Record<string, unknown>>,
) {
  const config = baseConfig(overrides);
  expect(() =>
    legacyResolveLocalConfigValues(config, "127.0.0.1", WORKDIR, undefined, document),
  ).toThrow(message);
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
    // D's assertion goes through `JSON.stringify(exit.cause)`, which backslash-escapes the
    // message's embedded double quotes — trim the substring to the quote-free prefix, same
    // convention D's own suite uses for this message.
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
    // Both pipelines read every smtp field straight off the raw TOML/document rather than a
    // schema-decoded, always-defaulted value (this section's presence-based `enabled`
    // default) — L needs the raw `document` (5th param) for this, matching D's raw
    // smol-toml document.
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
    // Both pipelines read webhooks presence from the raw document rather than the always-defaulted
    // decoded `enabled` — L needs the raw `document` (5th param) for this,
    // matching D's raw smol-toml document. D previously never populated `webhooksPresent`/
    // `webhooksEnabled` on its `LegacyExperimentalInput` at all, so this branch was D-unreachable
    // (review: PRRT_kwDOErm0O86WE42i) — now shared like every other scenario in this table.
    toml: ["[experimental.webhooks]", "enabled = false"],
    overrides: { experimental: { webhooks: { enabled: false } } },
    document: { experimental: { webhooks: { enabled: false } } },
    message:
      "Webhooks cannot be deactivated. [experimental.webhooks] enabled can either be true or left undefined",
  },
];

// Explicitly SKIPPED (only one caller runs the branch, or the branch isn't exercised the same
// way by both — see the module header in `legacy-config-validate.ts` for the full explicitly
// out-of-scope list):
// - `remotes[*].project_id`, `auth.sms`, `auth.external` — D-only, never part of the shared
// validator (`LegacyConfigValidationInput` has no fields for these at all).
// - `project_id`, `studio`, `local_smtp` — L-only, D has no equivalent sections. `api.tls`
// presence is D-skipped for the same reason but IS shared with S via
// `legacyValidateApiTlsPresence` — see the S block below.
describe("legacyValidateResolvedConfig cross-caller parity (D vs L)", () => {
  for (const scenario of scenarios) {
    it.effect(`${scenario.name}: D and L fail with the same message`, () =>
      Effect.gen(function* () {
        yield* failsWithD(scenario.toml, scenario.message);
        failsWithL(scenario.overrides, scenario.message, scenario.document);
      }),
    );
  }
});

// The `api.port` branch is L-only in the D-vs-L table above (D has no api section), but it is
// now ALSO shared with the storage-credentials resolver (S) through `legacyValidateApiPort`
// (#6467 review). Drive S's real pipeline and L against the same zero-port config and assert
// the identical message, so the shared branch cannot drift for either caller.
describe("shared api validation branches, cross-caller parity (S vs L)", () => {
  /** Drives S's real pipeline (`legacyResolveStorageCredentials`, local branch) to failure. */
  const failsWithS = (config: CliConfig, message: string) =>
    Effect.gen(function* () {
      const dir = withConfig("");
      const exit = yield* legacyResolveStorageCredentials({ projectRef: "", config }).pipe(
        Effect.provide(
          Layer.mergeAll(
            BunServices.layer,
            mockLegacyCliSettings({ workdir: dir }),
            // Local-path parity only — the remote branch (and with it the
            // platform API) is never reached.
            Layer.succeed(LegacyPlatformApiFactory, {
              make: Effect.die("unreachable: local-only parity scenario"),
            }),
          ),
        ),
        Effect.exit,
      );
      expect(Exit.isFailure(exit), `S: expected failure containing: ${message}`).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain(message);
      }
      rmSync(dir, { recursive: true, force: true });
    });

  // Ambient SUPABASE_API_* values would override the config under test, so pin
  // every participating key to unset for the duration of each scenario.
  const isolated = <A, E, R>(body: Effect.Effect<A, E, R>) =>
    [
      "SUPABASE_API_PORT",
      "SUPABASE_API_ENABLED",
      "SUPABASE_API_TLS_ENABLED",
      "SUPABASE_API_TLS_CERT_PATH",
      "SUPABASE_API_TLS_KEY_PATH",
    ].reduce((inner, name) => legacyWithEnv(name, undefined, inner), body);

  it.effect("api.port = 0 with the API enabled: S and L fail with the same message", () =>
    isolated(
      Effect.gen(function* () {
        const message = "Missing required field in config: api.port";
        failsWithL({ api: { port: 0 } }, message);
        yield* failsWithS(baseConfig({ api: { port: 0 } }), message);
      }),
    ),
  );

  it.effect("api.tls cert without key: S and L fail with the same presence message", () =>
    isolated(
      Effect.gen(function* () {
        const message = "Missing required field in config: api.tls.key_path";
        failsWithL({ api: { tls: { enabled: true, cert_path: "kong.crt" } } }, message);
        yield* failsWithS(
          baseConfig({ api: { tls: { enabled: true, cert_path: "kong.crt" } } }),
          message,
        );
      }),
    ),
  );
});
