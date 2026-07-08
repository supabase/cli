import { describe, expect, it } from "vitest";

import {
  LEGACY_BUCKET_NAME_PATTERN,
  LEGACY_CLERK_DOMAIN_PATTERN,
  LEGACY_FUNCTION_SLUG_PATTERN,
  LEGACY_HOOK_SECRET_PATTERN,
  LEGACY_PROJECT_REF_PATTERN,
  type LegacyAuthInput,
  type LegacyConfigValidationInput,
  legacyParseGoBool,
  legacyValidateResolvedConfig,
} from "./legacy-config-validate.ts";

// Starter suite for the symbols relocated from `legacy-db-config.toml-read.ts` in an earlier
// commit (see the module header in `legacy-config-validate.ts`). The bulk of `Config.Validate`
// behavioral coverage — direct calls to `legacyValidateResolvedConfig`, covering every branch
// this module owns regardless of which caller (D or L) exercises it — lives further down this
// file; it was consolidated here from `legacy-local-config-values.unit.test.ts`, where it used
// to be exercised only indirectly through `legacyResolveLocalConfigValues`.

describe("legacyParseGoBool", () => {
  it("accepts Go's strconv.ParseBool true forms", () => {
    for (const value of ["1", "t", "T", "TRUE", "true", "True"]) {
      expect(legacyParseGoBool(value)).toBe(true);
    }
  });

  it("accepts Go's strconv.ParseBool false forms, including the empty string", () => {
    for (const value of ["0", "f", "F", "FALSE", "false", "False", ""]) {
      expect(legacyParseGoBool(value)).toBe(false);
    }
  });

  it("returns undefined for a value outside Go's strconv.ParseBool acceptance set", () => {
    expect(legacyParseGoBool("yes")).toBeUndefined();
    expect(legacyParseGoBool("2")).toBeUndefined();
  });
});

describe("LEGACY_PROJECT_REF_PATTERN", () => {
  it("matches a valid 20-character lowercase project ref", () => {
    expect(LEGACY_PROJECT_REF_PATTERN.test("abcdefghijklmnopqrst")).toBe(true);
  });

  it("rejects refs of the wrong length or case", () => {
    expect(LEGACY_PROJECT_REF_PATTERN.test("short")).toBe(false);
    expect(LEGACY_PROJECT_REF_PATTERN.test("ABCDEFGHIJKLMNOPQRST")).toBe(false);
  });
});

describe("LEGACY_BUCKET_NAME_PATTERN", () => {
  it("matches Go-legal bucket name characters", () => {
    expect(LEGACY_BUCKET_NAME_PATTERN.test("my-bucket.1")).toBe(true);
  });

  it("rejects characters outside Go's bucketNamePattern", () => {
    expect(LEGACY_BUCKET_NAME_PATTERN.test("bad#name")).toBe(false);
    expect(LEGACY_BUCKET_NAME_PATTERN.test("bad/name")).toBe(false);
  });
});

describe("LEGACY_FUNCTION_SLUG_PATTERN", () => {
  it("matches a valid function slug (letters, digits, _ and -)", () => {
    expect(LEGACY_FUNCTION_SLUG_PATTERN.test("my-function")).toBe(true);
    expect(LEGACY_FUNCTION_SLUG_PATTERN.test("function_1")).toBe(true);
  });

  it("rejects a slug that doesn't start with a letter", () => {
    expect(LEGACY_FUNCTION_SLUG_PATTERN.test("123")).toBe(false);
    expect(LEGACY_FUNCTION_SLUG_PATTERN.test("1bad")).toBe(false);
  });
});

describe("LEGACY_HOOK_SECRET_PATTERN", () => {
  it("matches a valid v1,whsec_ secret", () => {
    expect(LEGACY_HOOK_SECRET_PATTERN.test(`v1,whsec_${"a".repeat(32)}`)).toBe(true);
  });

  it("rejects a secret that doesn't match Go's hookSecretPattern", () => {
    expect(LEGACY_HOOK_SECRET_PATTERN.test("not-a-valid-secret")).toBe(false);
  });
});

describe("LEGACY_CLERK_DOMAIN_PATTERN", () => {
  it("matches a valid clerk.example.com domain", () => {
    expect(LEGACY_CLERK_DOMAIN_PATTERN.test("clerk.example.com")).toBe(true);
  });

  it("matches a valid <slug>.clerk.accounts.dev domain", () => {
    expect(LEGACY_CLERK_DOMAIN_PATTERN.test("example.clerk.accounts.dev")).toBe(true);
  });

  it("rejects a domain that doesn't match Go's clerkDomainPattern", () => {
    expect(LEGACY_CLERK_DOMAIN_PATTERN.test("not-a-clerk-domain")).toBe(false);
  });
});

/**
 * A trivially-passing full input. Every test below spreads/overrides only the field(s) its
 * check cares about, matching the fixture-building style of `legacy-local-config-values.unit
 * .test.ts`'s own `baseConfig()` helper.
 */
function minimalInput(
  overrides: Partial<LegacyConfigValidationInput> = {},
): LegacyConfigValidationInput {
  return {
    db: { port: 5432, majorVersion: 17 },
    storageBucketNames: [],
    functionSlugs: [],
    edgeRuntimeDenoVersion: 2,
    analytics: {
      enabled: false,
      backend: undefined,
      gcpProjectId: "",
      gcpProjectNumber: "",
      gcpJwtPath: "",
    },
    experimental: { pgdeltaFormatOptions: "" },
    ...overrides,
  };
}

/** A trivially-passing `[auth]` section — auth enabled, nothing else configured. */
function minimalAuthInput(overrides: Partial<LegacyAuthInput> = {}): LegacyAuthInput {
  return {
    siteUrl: "http://localhost:3000",
    hooks: [],
    mfa: [],
    thirdParty: [],
    ...overrides,
  };
}

// Moved from `legacy-local-config-values.unit.test.ts`: these describe blocks exercise checks
// that now live entirely inside `legacyValidateResolvedConfig` and can be phrased as direct
// calls with a hand-built `LegacyConfigValidationInput` — no `ProjectConfig`/schema decode, no
// env-override machinery, no file I/O, no `document` threading. Everything that still needs
// one of those (value derivation, env-override mechanics, the 3 I/O checks' actual file reads)
// stays in `legacy-local-config-values.unit.test.ts`.
describe("legacyValidateResolvedConfig", () => {
  // config.go:1034-1062 — db.major_version switch. The env-override
  // (SUPABASE_DB_MAJOR_VERSION) variants stay in legacy-local-config-values.unit.test.ts.
  describe("db.major_version", () => {
    it("rejects a configured major_version of 0", () => {
      expect(() =>
        legacyValidateResolvedConfig(minimalInput({ db: { port: 5432, majorVersion: 0 } })),
      ).toThrow("Missing required field in config: db.major_version");
    });

    it("rejects the unsupported Postgres 12.x major_version with Go's dedicated message", () => {
      expect(() =>
        legacyValidateResolvedConfig(minimalInput({ db: { port: 5432, majorVersion: 12 } })),
      ).toThrow("Postgres version 12.x is unsupported.");
    });

    it.each([13, 14, 15, 17])("accepts the supported major_version %d", (majorVersion) => {
      expect(() =>
        legacyValidateResolvedConfig(minimalInput({ db: { port: 5432, majorVersion } })),
      ).not.toThrow();
    });

    it("rejects an unsupported major_version with the generic invalid-value message", () => {
      expect(() =>
        legacyValidateResolvedConfig(minimalInput({ db: { port: 5432, majorVersion: 16 } })),
      ).toThrow("Failed reading config: Invalid db.major_version: 16.");
    });
  });

  // config.go:1064-1068, pattern @ 1549-1554 — unconditional, no storage.enabled-style gate.
  describe("storage.buckets", () => {
    it("rejects a bucket name Go's ValidateBucketName refuses", () => {
      expect(() =>
        legacyValidateResolvedConfig(minimalInput({ storageBucketNames: ["bad/name"] })),
      ).toThrow("Invalid Bucket name: bad/name.");
    });

    it("does not throw for a valid bucket name", () => {
      expect(() =>
        legacyValidateResolvedConfig(minimalInput({ storageBucketNames: ["avatars.public"] })),
      ).not.toThrow();
    });

    it("does not throw when no buckets are configured", () => {
      expect(() => legacyValidateResolvedConfig(minimalInput())).not.toThrow();
    });
  });

  // config.go:1164-1173 — edge_runtime.deno_version switch, unconditional, not gated on
  // edge_runtime.enabled (there is no such field on LegacyConfigValidationInput at all). The
  // env-override (SUPABASE_EDGE_RUNTIME_DENO_VERSION) variants stay in
  // legacy-local-config-values.unit.test.ts.
  describe("edge_runtime.deno_version", () => {
    it("rejects a configured deno_version of 0", () => {
      expect(() =>
        legacyValidateResolvedConfig(minimalInput({ edgeRuntimeDenoVersion: 0 })),
      ).toThrow("Missing required field in config: edge_runtime.deno_version");
    });

    it.each([1, 2])("accepts the supported deno_version %d", (denoVersion) => {
      expect(() =>
        legacyValidateResolvedConfig(minimalInput({ edgeRuntimeDenoVersion: denoVersion })),
      ).not.toThrow();
    });

    it("rejects an unsupported deno_version with the generic invalid-value message", () => {
      expect(() =>
        legacyValidateResolvedConfig(minimalInput({ edgeRuntimeDenoVersion: 3 })),
      ).toThrow("Failed reading config: Invalid edge_runtime.deno_version: 3.");
    });

    it("rejects an invalid deno_version even when edge_runtime is disabled", () => {
      // There is no `edgeRuntime.enabled`-style gate on `LegacyConfigValidationInput` at
      // all — this is identical to the "rejects a configured deno_version of 0" case above,
      // which is itself the point: Go never gates this check on edge_runtime.enabled.
      expect(() =>
        legacyValidateResolvedConfig(minimalInput({ edgeRuntimeDenoVersion: 0 })),
      ).toThrow("Missing required field in config: edge_runtime.deno_version");
    });
  });

  // config.go:1174-1187 — analytics.gcp_*, gated on enabled && backend === "bigquery". The
  // env-override (SUPABASE_ANALYTICS_*) variants stay in legacy-local-config-values.unit.test.ts.
  describe("analytics (BigQuery backend required fields)", () => {
    it("rejects an enabled bigquery backend without gcp_project_id", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            analytics: {
              enabled: true,
              backend: "bigquery",
              gcpProjectId: "",
              gcpProjectNumber: "",
              gcpJwtPath: "",
            },
          }),
        ),
      ).toThrow("Missing required field in config: analytics.gcp_project_id");
    });

    it("rejects an enabled bigquery backend without gcp_project_number", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            analytics: {
              enabled: true,
              backend: "bigquery",
              gcpProjectId: "proj",
              gcpProjectNumber: "",
              gcpJwtPath: "",
            },
          }),
        ),
      ).toThrow("Missing required field in config: analytics.gcp_project_number");
    });

    it("rejects an enabled bigquery backend without gcp_jwt_path", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            analytics: {
              enabled: true,
              backend: "bigquery",
              gcpProjectId: "proj",
              gcpProjectNumber: "123",
              gcpJwtPath: "",
            },
          }),
        ),
      ).toThrow(
        "Path to GCP Service Account Key must be provided in config, relative to config.toml: analytics.gcp_jwt_path",
      );
    });

    it("does not throw when an enabled bigquery backend has all three GCP fields", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            analytics: {
              enabled: true,
              backend: "bigquery",
              gcpProjectId: "proj",
              gcpProjectNumber: "123",
              gcpJwtPath: "gcp.json",
            },
          }),
        ),
      ).not.toThrow();
    });

    it("does not throw for the postgres backend, however incomplete the GCP fields are", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            analytics: {
              enabled: true,
              backend: "postgres",
              gcpProjectId: "",
              gcpProjectNumber: "",
              gcpJwtPath: "",
            },
          }),
        ),
      ).not.toThrow();
    });

    it("does not throw when analytics is disabled, however incomplete the GCP fields are", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            analytics: {
              enabled: false,
              backend: "bigquery",
              gcpProjectId: "",
              gcpProjectNumber: "",
              gcpJwtPath: "",
            },
          }),
        ),
      ).not.toThrow();
    });
  });

  // config.go:1846-1854 — experimental.validate(), unconditional, internally gated.
  describe("experimental.*", () => {
    it("rejects a present [experimental.webhooks] section with enabled omitted", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({ experimental: { webhooksPresent: true, pgdeltaFormatOptions: "" } }),
        ),
      ).toThrow(
        "Webhooks cannot be deactivated. [experimental.webhooks] enabled can either be true or left undefined",
      );
    });

    it("rejects a present [experimental.webhooks] section with enabled = false", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            experimental: {
              webhooksPresent: true,
              webhooksEnabled: false,
              pgdeltaFormatOptions: "",
            },
          }),
        ),
      ).toThrow(
        "Webhooks cannot be deactivated. [experimental.webhooks] enabled can either be true or left undefined",
      );
    });

    it("does not throw when [experimental.webhooks] enabled = true", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            experimental: {
              webhooksPresent: true,
              webhooksEnabled: true,
              pgdeltaFormatOptions: "",
            },
          }),
        ),
      ).not.toThrow();
    });

    it("does not throw when [experimental.webhooks] is absent entirely", () => {
      expect(() => legacyValidateResolvedConfig(minimalInput())).not.toThrow();
    });

    it("rejects invalid JSON in experimental.pgdelta.format_options", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({ experimental: { pgdeltaFormatOptions: "{not json" } }),
        ),
      ).toThrow("Invalid config for experimental.pgdelta.format_options: must be valid JSON");
    });

    it("does not throw for valid JSON in experimental.pgdelta.format_options", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({ experimental: { pgdeltaFormatOptions: '{"keywordCase":"upper"}' } }),
        ),
      ).not.toThrow();
    });

    it("does not throw when experimental.pgdelta.format_options is unset", () => {
      expect(() =>
        legacyValidateResolvedConfig(minimalInput({ experimental: { pgdeltaFormatOptions: "" } })),
      ).not.toThrow();
    });
  });

  // config.go:1088-1090 — auth.site_url, checked first inside `if c.Auth.Enabled`. An absent
  // `auth` section on `LegacyConfigValidationInput` IS "auth disabled" from this function's
  // perspective. The SUPABASE_AUTH_ENABLED/SUPABASE_AUTH_SITE_URL env-override variants stay in
  // legacy-local-config-values.unit.test.ts.
  describe("auth.site_url", () => {
    it("rejects an explicit empty site_url when auth is enabled", () => {
      expect(() =>
        legacyValidateResolvedConfig(minimalInput({ auth: minimalAuthInput({ siteUrl: "" }) })),
      ).toThrow("Missing required field in config: auth.site_url");
    });

    it("does not throw when site_url is set and auth is enabled", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({ auth: minimalAuthInput({ siteUrl: "http://localhost:3000" }) }),
        ),
      ).not.toThrow();
    });

    it("does not throw an explicit empty site_url when auth is disabled", () => {
      expect(() => legacyValidateResolvedConfig(minimalInput())).not.toThrow();
    });
  });

  // config.go:1099-1109 + auth.go:58-71 — auth.captcha, checked right after auth.site_url.
  describe("auth.captcha", () => {
    it("rejects an enabled captcha without a provider", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              captcha: { enabled: true, provider: undefined, secret: undefined },
            }),
          }),
        ),
      ).toThrow("Missing required field in config: auth.captcha.provider");
    });

    it("rejects an enabled captcha with a provider but no secret", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              captcha: { enabled: true, provider: "hcaptcha", secret: undefined },
            }),
          }),
        ),
      ).toThrow("Missing required field in config: auth.captcha.secret");
    });

    it("does not throw when an enabled captcha has both provider and secret", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              captcha: { enabled: true, provider: "hcaptcha", secret: "shh" },
            }),
          }),
        ),
      ).not.toThrow();
    });

    it("does not throw when captcha is disabled, however incomplete", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              captcha: { enabled: false, provider: undefined, secret: undefined },
            }),
          }),
        ),
      ).not.toThrow();
    });

    it("does not throw an enabled captcha without provider/secret when auth is disabled", () => {
      expect(() => legacyValidateResolvedConfig(minimalInput())).not.toThrow();
    });
  });

  // config.go:1117-1134 — auth.passkey/auth.webauthn, right after the (caller-side) signing-keys
  // read.
  describe("auth.passkey / auth.webauthn", () => {
    it("rejects passkey.enabled without an [auth.webauthn] section", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              passkey: { webauthnPresent: false, rpId: undefined, rpOrigins: undefined },
            }),
          }),
        ),
      ).toThrow(
        "Missing required config section: auth.webauthn (required when auth.passkey.enabled is true)",
      );
    });

    it("rejects passkey.enabled with [auth.webauthn] missing rp_id", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              passkey: {
                webauthnPresent: true,
                rpId: undefined,
                rpOrigins: ["http://localhost:3000"],
              },
            }),
          }),
        ),
      ).toThrow("Missing required field in config: auth.webauthn.rp_id");
    });

    it("rejects passkey.enabled with [auth.webauthn] missing rp_origins", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              passkey: { webauthnPresent: true, rpId: "localhost", rpOrigins: undefined },
            }),
          }),
        ),
      ).toThrow("Missing required field in config: auth.webauthn.rp_origins");
    });

    it("does not throw when passkey.enabled has a complete [auth.webauthn] section", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              passkey: {
                webauthnPresent: true,
                rpId: "localhost",
                rpOrigins: ["http://localhost:3000"],
              },
            }),
          }),
        ),
      ).not.toThrow();
    });

    it("does not throw when passkey is absent from the input", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({ auth: minimalAuthInput({ passkey: undefined }) }),
        ),
      ).not.toThrow();
    });

    it("does not throw when auth carries no passkey data at all", () => {
      // Distinct from the previous test only in the original (L-level) caller's derivation —
      // "webauthn absent from the document" vs. "no document was threaded through at all".
      // Both collapse to `passkey: undefined` at this shared, direct-call layer.
      expect(() =>
        legacyValidateResolvedConfig(minimalInput({ auth: minimalAuthInput() })),
      ).not.toThrow();
    });

    it("does not throw an enabled passkey without webauthn when auth is disabled", () => {
      expect(() => legacyValidateResolvedConfig(minimalInput())).not.toThrow();
    });
  });

  // config.go:1325-1344 — auth.email.smtp, gated on the raw table being present AND enabled.
  describe("auth.email.smtp", () => {
    it("rejects a present [auth.email.smtp] table with no fields", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              smtp: { enabled: true, host: "", port: 0, user: "", pass: "", adminEmail: "" },
            }),
          }),
        ),
      ).toThrow("Missing required field in config: auth.email.smtp.host");
    });

    it("rejects a present [auth.email.smtp] table missing port/user/pass/admin_email", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              smtp: {
                enabled: true,
                host: "smtp.example.com",
                port: 0,
                user: "",
                pass: "",
                adminEmail: "",
              },
            }),
          }),
        ),
      ).toThrow("Missing required field in config: auth.email.smtp.port");
    });

    it("does not throw when [auth.email.smtp] explicitly sets enabled = false", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              smtp: {
                enabled: false,
                host: "smtp.example.com",
                port: 0,
                user: "",
                pass: "",
                adminEmail: "",
              },
            }),
          }),
        ),
      ).not.toThrow();
    });

    it("does not throw when [auth.email.smtp] is a complete table", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              smtp: {
                enabled: true,
                host: "smtp.example.com",
                port: 587,
                user: "user",
                pass: "pass",
                adminEmail: "admin@example.com",
              },
            }),
          }),
        ),
      ).not.toThrow();
    });

    it("does not throw when [auth.email.smtp] is absent from the input", () => {
      expect(() =>
        legacyValidateResolvedConfig(minimalInput({ auth: minimalAuthInput({ smtp: undefined }) })),
      ).not.toThrow();
    });

    it("does not throw when auth carries no smtp data at all", () => {
      // See the equivalent passkey note above — both collapse to `smtp: undefined` here.
      expect(() =>
        legacyValidateResolvedConfig(minimalInput({ auth: minimalAuthInput() })),
      ).not.toThrow();
    });

    it("does not throw a present but incomplete [auth.email.smtp] table when auth is disabled", () => {
      expect(() => legacyValidateResolvedConfig(minimalInput())).not.toThrow();
    });
  });

  // config.go:1136-1138, checks @ 1453-1521 — auth.hook.*, caller pre-filters to enabled-only.
  describe("auth.hook.*", () => {
    it("rejects an enabled hook without a uri", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              hooks: [{ type: "custom_access_token", uri: "", secrets: "" }],
            }),
          }),
        ),
      ).toThrow("Missing required field in config: auth.hook.custom_access_token.uri");
    });

    it("rejects an http(s) hook uri without secrets", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              hooks: [
                { type: "custom_access_token", uri: "https://example.test/hook", secrets: "" },
              ],
            }),
          }),
        ),
      ).toThrow("Missing required field in config: auth.hook.custom_access_token.secrets");
    });

    it("rejects an http(s) hook secret that doesn't match Go's hookSecretPattern", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              hooks: [
                {
                  type: "custom_access_token",
                  uri: "https://example.test/hook",
                  secrets: "not-a-valid-secret",
                },
              ],
            }),
          }),
        ),
      ).toThrow(
        'auth.hook.custom_access_token.secrets must be formatted as "v1,whsec_<base64_encoded_secret>"',
      );
    });

    it("does not throw for a valid http(s) hook secret", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              hooks: [
                {
                  type: "custom_access_token",
                  uri: "https://example.test/hook",
                  secrets: `v1,whsec_${"a".repeat(32)}`,
                },
              ],
            }),
          }),
        ),
      ).not.toThrow();
    });

    it("rejects a pg-functions hook uri with secrets set", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              hooks: [
                {
                  type: "custom_access_token",
                  uri: "pg-functions://postgres/public/hook",
                  secrets: `v1,whsec_${"a".repeat(32)}`,
                },
              ],
            }),
          }),
        ),
      ).toThrow("auth.hook.custom_access_token.secrets is unsupported for pg-functions URI");
    });

    it("does not throw for a pg-functions hook uri without secrets", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              hooks: [
                {
                  type: "custom_access_token",
                  uri: "pg-functions://postgres/public/hook",
                  secrets: "",
                },
              ],
            }),
          }),
        ),
      ).not.toThrow();
    });

    it("rejects a hook uri with an unsupported scheme", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              hooks: [{ type: "custom_access_token", uri: "ftp://example.test/hook", secrets: "" }],
            }),
          }),
        ),
      ).toThrow("auth.hook.custom_access_token.uri should be a HTTP, HTTPS, or pg-functions URI");
    });

    // Go calls `url.Parse` before the scheme switch (config.go:1497-1499) and fails the whole
    // load on a malformed URI, rather than treating any `http:`/`https:` prefix as valid.
    it("rejects a hook uri that fails Go's url.Parse (malformed IPv6 host)", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              hooks: [{ type: "custom_access_token", uri: "http://[::1", secrets: "" }],
            }),
          }),
        ),
      ).toThrow("failed to parse template url:");
    });

    it("does not throw for a disabled hook, however incomplete", () => {
      // The caller pre-filters to enabled-only hooks — a disabled hook is simply absent from
      // `hooks`, matching an empty array here.
      expect(() =>
        legacyValidateResolvedConfig(minimalInput({ auth: minimalAuthInput({ hooks: [] }) })),
      ).not.toThrow();
    });

    it("does not throw an enabled hook without a uri when auth is disabled", () => {
      expect(() => legacyValidateResolvedConfig(minimalInput())).not.toThrow();
    });
  });

  // config.go:1139-1141, checks @ 1523-1534 — auth.mfa.*, fixed totp/phone/web_authn order.
  describe("auth.mfa.*", () => {
    it.each([
      ["totp", "auth.mfa.totp.enroll_enabled requires verify_enabled"],
      ["phone", "auth.mfa.phone.enroll_enabled requires verify_enabled"],
      ["web_authn", "auth.mfa.web_authn.enroll_enabled requires verify_enabled"],
    ] as const)("rejects %s enroll_enabled without verify_enabled", (label, message) => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              mfa: [{ label, enrollEnabled: true, verifyEnabled: false }],
            }),
          }),
        ),
      ).toThrow(message);
    });

    it("does not throw when enroll_enabled and verify_enabled are both true", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              mfa: [{ label: "totp", enrollEnabled: true, verifyEnabled: true }],
            }),
          }),
        ),
      ).not.toThrow();
    });

    it("does not throw an enroll_enabled MFA factor without verify_enabled when auth is disabled", () => {
      expect(() => legacyValidateResolvedConfig(minimalInput())).not.toThrow();
    });
  });

  // config.go:1151-1153, checks @ 1635-1683 — auth.third_party.*, fixed provider order, caller
  // pre-filters to enabled-only.
  describe("auth.third_party.*", () => {
    it("rejects firebase enabled without a project_id", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({ thirdParty: [{ provider: "firebase", requiredField: "" }] }),
          }),
        ),
      ).toThrow("Invalid config: auth.third_party.firebase is enabled but without a project_id.");
    });

    it("rejects auth0 enabled without a tenant", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({ thirdParty: [{ provider: "auth0", requiredField: "" }] }),
          }),
        ),
      ).toThrow("Invalid config: auth.third_party.auth0 is enabled but without a tenant.");
    });

    it("rejects aws_cognito enabled without a user_pool_id", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({ thirdParty: [{ provider: "cognito", requiredField: "" }] }),
          }),
        ),
      ).toThrow("Invalid config: auth.third_party.cognito is enabled but without a user_pool_id.");
    });

    it("rejects aws_cognito enabled with a user_pool_id but no user_pool_region", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              thirdParty: [
                { provider: "cognito", requiredField: "pool-1", cognitoUserPoolRegion: undefined },
              ],
            }),
          }),
        ),
      ).toThrow(
        "Invalid config: auth.third_party.cognito is enabled but without a user_pool_region.",
      );
    });

    it("rejects clerk enabled without a domain", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({ thirdParty: [{ provider: "clerk", requiredField: "" }] }),
          }),
        ),
      ).toThrow("Invalid config: auth.third_party.clerk is enabled but without a domain.");
    });

    it("rejects clerk enabled with a domain that doesn't match Go's clerkDomainPattern", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              thirdParty: [{ provider: "clerk", requiredField: "not-a-clerk-domain" }],
            }),
          }),
        ),
      ).toThrow("Invalid config: auth.third_party.clerk has invalid domain");
    });

    it("does not throw for a valid clerk.example.com domain", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              thirdParty: [{ provider: "clerk", requiredField: "clerk.example.com" }],
            }),
          }),
        ),
      ).not.toThrow();
    });

    it("rejects workos enabled without an issuer_url", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({ thirdParty: [{ provider: "workos", requiredField: "" }] }),
          }),
        ),
      ).toThrow("Invalid config: auth.third_party.workos is enabled but without a issuer_url.");
    });

    it("rejects more than one third_party provider enabled at once", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              thirdParty: [
                { provider: "firebase", requiredField: "proj" },
                { provider: "auth0", requiredField: "tenant" },
              ],
            }),
          }),
        ),
      ).toThrow("Invalid config: Only one third_party provider allowed to be enabled at a time.");
    });

    it("does not throw when no third_party provider is enabled", () => {
      expect(() =>
        legacyValidateResolvedConfig(minimalInput({ auth: minimalAuthInput() })),
      ).not.toThrow();
    });

    it("does not throw an enabled third_party provider missing its required field when auth is disabled", () => {
      expect(() => legacyValidateResolvedConfig(minimalInput())).not.toThrow();
    });
  });

  // config.go:1159-1163, pattern @ 1539-1544 — every [functions.*] key, unconditional, not
  // gated on auth.enabled.
  describe("functions.*", () => {
    it("rejects a function slug Go's ValidateFunctionSlug refuses", () => {
      expect(() => legacyValidateResolvedConfig(minimalInput({ functionSlugs: ["1bad"] }))).toThrow(
        "Invalid Function name: 1bad.",
      );
    });

    it("does not throw for a valid function slug", () => {
      expect(() =>
        legacyValidateResolvedConfig(minimalInput({ functionSlugs: ["hello-world_v2"] })),
      ).not.toThrow();
    });

    it("does not throw when no functions are configured", () => {
      expect(() => legacyValidateResolvedConfig(minimalInput())).not.toThrow();
    });

    it("rejects an invalid function slug even when auth is disabled", () => {
      expect(() => legacyValidateResolvedConfig(minimalInput({ functionSlugs: ["1bad"] }))).toThrow(
        "Invalid Function name: 1bad.",
      );
    });
  });

  // config.go:1006-1027 — only the "exactly one of cert/key set" presence rule; the actual
  // file reads and the disabled-skip/env-override tests stay in
  // legacy-local-config-values.unit.test.ts.
  describe("api.tls", () => {
    it("rejects cert_path set without key_path", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            api: {
              enabled: true,
              port: 54321,
              tls: { enabled: true, certPath: "cert.pem", keyPath: undefined },
            },
          }),
        ),
      ).toThrow("Missing required field in config: api.tls.key_path");
    });

    it("rejects key_path set without cert_path", () => {
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            api: {
              enabled: true,
              port: 54321,
              tls: { enabled: true, certPath: undefined, keyPath: "key.pem" },
            },
          }),
        ),
      ).toThrow("Missing required field in config: api.tls.cert_path");
    });
  });

  // Direct-shared-level regression/divergence coverage (Part C) — behavior that's either new
  // (the D fix) or only meaningfully testable at this exact layer (the captcha enum), not a
  // move from either caller's own suite.
  describe("Config.Validate divergence regression coverage", () => {
    it("throws the Go-parity missing-required message for db.major_version = 0 (regression for the D fix in 0c62a914)", () => {
      // D used to fall through to the generic "Invalid db.major_version: 0" message; both D
      // and L now go through this exact branch, so pin it directly here too, not just via
      // D's/L's own suites.
      expect(() =>
        legacyValidateResolvedConfig({ ...minimalInput(), db: { port: 5432, majorVersion: 0 } }),
      ).toThrow("Missing required field in config: db.major_version");
    });

    it("throws Go's decode-time enum message for an invalid auth.captcha.provider, regardless of enabled", () => {
      // This scenario is only meaningful at this direct shared-validator level: it's
      // unreachable through L's real ProjectConfig-typed flow — `@supabase/config`'s schema
      // (packages/config/src/auth/captcha.ts, stringEnum(["hcaptcha", "turnstile"])) already
      // narrows `provider` to "hcaptcha" | "turnstile" | undefined before it ever reaches
      // `legacyResolveLocalConfigValues`, so an invalid provider value would fail schema
      // decoding first, on a completely different code path. D's real TOML flow CAN reach
      // this branch (an untyped raw string) — D's own suite
      // (`legacy-db-config.toml-read.unit.test.ts`) covers that separately. This test's job is
      // only to pin the shared function's own behavior directly.
      expect(() =>
        legacyValidateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              captcha: { enabled: false, provider: "not-a-real-provider", secret: undefined },
            }),
          }),
        ),
      ).toThrow(
        "failed to parse config: decoding failed due to the following error(s):\n\n'auth.captcha.provider' must be one of [hcaptcha turnstile]",
      );
    });
  });
});
