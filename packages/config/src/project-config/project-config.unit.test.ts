import { describe, expect, test } from "vitest";
import { CliConfigSchema } from "../base.ts";
import { ProjectConfigParseError } from "../errors.ts";
import { getDefaultCliConfig, omitDefaultValues, subtractCliConfig } from "../sparse.ts";
import type { EffectiveConfig } from "../sparse.ts";
import { Schema } from "effect";
import {
  attachApiResponse,
  comparableProjectConfigPaths,
  fromApiProjectConfig,
  fromConfigDocument,
  isComparableProjectConfigPath,
  toProjectConfig,
  unmappedApiFields,
  type ProjectConfig,
} from "./project-config.ts";

const decodeCliConfig = Schema.decodeUnknownSync(CliConfigSchema);

/**
 * A realistic v2 `data.attributes` payload exercising every mapped section
 * plus, in each section, at least one known-but-unmapped field, and — at the
 * top level — one whole unmapped section (`new_service`) and two metadata-
 * shaped keys (`$weird`, `_private`) inside `api`. Values were chosen and
 * hand-traced against `./registry.ts`/`./registry-auth.ts` (see the sibling
 * describe blocks below for the derivation of each expected output).
 */
const fullAttributesFixture: Record<string, unknown> = {
  database: {
    major_version: 17,
    ssl_enforced: true,
    network_restrictions: {
      entitlement: "allowed",
      status: "applied",
      allowed_cidrs: [
        { address: "1.2.3.4/32", type: "v4" },
        { address: "::/0", type: "v6" },
      ],
      updated_at: "2026-01-01T00:00:00Z",
      applied_at: "2026-01-01T00:05:00Z",
    },
    postgres_settings: {
      effective_cache_size: "4GB",
      statement_timeout: "30000ms",
      max_connections: -1,
      track_commit_timestamp: true,
      log_checkpoints: true,
    },
  },
  pooler: {
    pool_mode: "transaction",
    ignore_startup_parameters: "extra_float_digits",
    server_idle_timeout: 600,
    server_lifetime: 3600,
    query_wait_timeout: 120,
    reserve_pool_size: 5,
    default_pool_size: 15,
    max_client_conn: 200,
  },
  auth: {
    disable_signup: true,
    external_github_enabled: true,
    smtp_pass: "supersecret",
    external_github_secret: "ghsecret",
    some_new_setting: true,
  },
  api: {
    db_schema: "public,graphql_public",
    db_extra_search_path: "public,extensions",
    max_rows: -5,
    db_pool_acquisition_timeout: 10,
    db_pool: null,
    brand_new_field: 123,
    $weird: 1,
    _private: 2,
  },
  realtime: {
    private_only: true,
    max_concurrent_users: 10,
    max_events_per_second: 5,
    max_bytes_per_second: 5,
    max_channels_per_client: 5,
    max_joins_per_second: 5,
    max_presence_events_per_second: 5,
    max_payload_size_in_kb: 5,
    presence_enabled: true,
    suspend: false,
    connection_pool: 5,
    postgres_changes_pool: null,
  },
  storage: {
    file_size_limit: 52428800,
    features: {
      image_transformation: { enabled: true },
      s3_protocol: { enabled: true },
      purge_cache: { enabled: false },
      iceberg_catalog: { enabled: true, max_namespaces: 5, max_tables: 10, max_catalogs: 2 },
      vector_buckets: { enabled: true, max_buckets: 3, max_indexes: 4 },
    },
    capabilities: { list_v2: true, iceberg_catalog: false },
    upstream_target: "main",
    migration_version: "v1",
    database_pool_mode: "transaction",
  },
  new_service: { foo: "bar" },
};

const expectedFullMappedOutput = {
  api: {
    schemas: ["public", "graphql_public"],
    enabled: true,
    extra_search_path: ["public", "extensions"],
    max_rows: 0,
  },
  db: {
    major_version: 17,
    ssl_enforcement: { enabled: true },
    settings: {
      effective_cache_size: "4GB",
      statement_timeout: "30000ms",
      track_commit_timestamp: true,
      max_connections: 0,
    },
    network_restrictions: {
      allowed_cidrs: ["1.2.3.4/32"],
      allowed_cidrs_v6: ["::/0"],
    },
    pooler: {
      pool_mode: "transaction",
      default_pool_size: 15,
      max_client_conn: 200,
    },
  },
  storage: {
    file_size_limit: "50MiB",
    image_transformation: { enabled: true },
    s3_protocol: { enabled: true },
    analytics: { enabled: true, max_namespaces: 5, max_tables: 10, max_catalogs: 2 },
    vector: { enabled: true, max_buckets: 3, max_indexes: 4 },
  },
  auth: {
    enable_signup: false,
    external: { github: { enabled: true } },
  },
};

function apiEnvelope(attributes: Record<string, unknown>): unknown {
  return { data: { type: "project_config", id: "abcdefghijklmnopqrst", attributes } };
}

describe("fromConfigDocument", () => {
  test("projecting the default config keeps exactly the hosted sections", () => {
    const projected = fromConfigDocument(getDefaultCliConfig());
    expect(Object.keys(projected).sort()).toEqual([
      "api",
      "auth",
      "db",
      "experimental",
      "realtime",
      "storage",
      "workers",
    ]);
    // Local-only sections never appear, however they're spelled on `CliConfig`.
    for (const droppedKey of [
      "project_id",
      "studio",
      "edge_runtime",
      "analytics",
      "functions",
      "local_smtp",
      "remotes",
    ]) {
      expect(Object.hasOwn(projected, droppedKey)).toBe(false);
    }
  });

  test("a sparse EffectiveConfig input yields only the section it carries", () => {
    const projected = fromConfigDocument({ api: { max_rows: 100 } });
    expect(projected).toEqual({ api: { max_rows: 100 } });
    expect(Object.hasOwn(projected, "db")).toBe(false);
    expect(Object.hasOwn(projected, "auth")).toBe(false);
  });

  test("an empty EffectiveConfig input yields an empty projection", () => {
    expect(fromConfigDocument({})).toEqual({});
  });

  test("result carries no _apiResponse own property", () => {
    const projected = fromConfigDocument(getDefaultCliConfig());
    expect(Object.getOwnPropertyNames(projected)).not.toContain("_apiResponse");
  });

  test("composes with omitDefaultValues to an empty overlay for a fully-default config", () => {
    expect(omitDefaultValues(fromConfigDocument(getDefaultCliConfig()))).toEqual({});
    expect(omitDefaultValues(fromConfigDocument(decodeCliConfig({})))).toEqual({});
  });

  test("deep-copies rather than sharing the subtree reference", () => {
    const config = getDefaultCliConfig();
    const projected = fromConfigDocument(config);
    expect(projected.api).not.toBe(config.api);
    expect(projected.api).toEqual(config.api);
    expect(projected.auth?.captcha).not.toBe(config.auth.captcha);
    expect(projected.auth?.captcha).toEqual(config.auth.captcha);
  });

  test("omits every x-secret leaf from the projected sections", () => {
    const withSecrets = decodeCliConfig({
      auth: {
        captcha: { enabled: true, provider: "hcaptcha", secret: "captcha-secret" },
        email: {
          smtp: {
            enabled: true,
            host: "smtp.example.com",
            port: 587,
            user: "smtp-user",
            pass: "smtp-secret",
            admin_email: "admin@example.com",
          },
        },
        external: { github: { enabled: true, client_id: "id", secret: "github-secret" } },
      },
      experimental: { s3_access_key: "access-key", s3_secret_key: "s3-secret" },
    });

    const projected = fromConfigDocument(withSecrets);

    expect(projected.auth?.captcha?.secret).toBeUndefined();
    expect(projected.auth?.captcha?.provider).toBe("hcaptcha");
    expect(projected.auth?.email?.smtp?.pass).toBeUndefined();
    expect(projected.auth?.email?.smtp?.host).toBe("smtp.example.com");
    expect(projected.auth?.external?.github?.secret).toBeUndefined();
    expect(projected.auth?.external?.github?.client_id).toBe("id");
    // Both experimental S3 fields are `secret()`-annotated (`../experimental.ts`),
    // not just `s3_secret_key`.
    expect(projected.experimental?.s3_secret_key).toBeUndefined();
    expect(projected.experimental?.s3_access_key).toBeUndefined();

    // Never merely enumerable-hidden — genuinely absent, own or otherwise.
    expect(Object.hasOwn(projected.auth?.captcha ?? {}, "secret")).toBe(false);
  });

  test("canonicalizes duration and byte-size document spellings to match the API side's canonical form", () => {
    const document = decodeCliConfig({
      auth: {
        sessions: { timebox: "24h", inactivity_timeout: "1h" },
        email: { max_frequency: "60s" },
        mfa: { phone: { max_frequency: "5s" } },
        sms: { max_frequency: "5s" },
      },
      storage: { file_size_limit: "52428800" },
    });

    const projected = fromConfigDocument(document);

    expect(projected.auth?.sessions?.timebox).toBe("24h0m0s");
    expect(projected.auth?.sessions?.inactivity_timeout).toBe("1h0m0s");
    expect(projected.auth?.email?.max_frequency).toBe("1m0s");
    expect(projected.auth?.mfa?.phone?.max_frequency).toBe("5s");
    expect(projected.auth?.sms?.max_frequency).toBe("5s");
    expect(projected.storage?.file_size_limit).toBe("50MiB");
  });
});

describe("fromApiProjectConfig — envelope unwrapping", () => {
  test("the full envelope, bare data object, and bare attributes all produce equal results", () => {
    const attributes = { api: { max_rows: 5 } };
    const fromEnvelope = fromApiProjectConfig(apiEnvelope(attributes));
    const fromBareData = fromApiProjectConfig({
      type: "project_config",
      id: "abcdefghijklmnopqrst",
      attributes,
    });
    const fromBareAttributes = fromApiProjectConfig(attributes);

    expect(fromEnvelope).toEqual({ api: { max_rows: 5 } });
    expect(fromBareData).toEqual(fromEnvelope);
    expect(fromBareAttributes).toEqual(fromEnvelope);
  });

  test.each([
    [null, "null"],
    ["x", "string"],
    [42, "number"],
  ])("throws ProjectConfigParseError for non-object input %p", (input, description) => {
    let thrown: unknown;
    try {
      fromApiProjectConfig(input);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).message).toBe(
      `Could not read the project config from the Management API response: expected an object, got ${description}`,
    );
  });

  test("throws ProjectConfigParseError for a non-object array input", () => {
    let thrown: unknown;
    try {
      fromApiProjectConfig([]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).message).toBe(
      "Could not read the project config from the Management API response: expected an object, got an array",
    );
  });

  test("throws ProjectConfigParseError with a cause and a message naming the offending path for a known-key type mismatch", () => {
    let thrown: unknown;
    try {
      fromApiProjectConfig({ api: { max_rows: "high" } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    const error = thrown as ProjectConfigParseError;
    expect(error.cause).toBeDefined();
    // `api.max_rows` is schema-concrete (mapped), so this fails at the
    // lenient-schema decode itself — before any registry `transform` runs —
    // and the message is built from the v4 schema-error formatter, not the
    // registry's own `expectNumber` wording.
    expect(error.apiPath).toEqual(["api", "max_rows"]);
    expect(error.message).toContain(
      "Could not read the project config from the Management API response: at data.attributes.api.max_rows:",
    );
    expect(error.detail).toBeDefined();
  });

  // A malformed envelope must throw rather than silently fall through to
  // "bare attributes" — see unwrapApiResponse's docstring in
  // `./project-config.ts`.
  test.each([
    [{ data: { attributes: 5 } }, "data.attributes is not an object"],
    [{ data: 5 }, "data is not an object"],
    [{ attributes: "x" }, "attributes is not an object"],
  ])("throws ProjectConfigParseError for a malformed envelope %j", (input, detail) => {
    let thrown: unknown;
    try {
      fromApiProjectConfig(input);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).message).toBe(
      `Could not read the project config from the Management API response: malformed envelope — ${detail}`,
    );
  });
});

describe("fromApiProjectConfig — api section", () => {
  test("a comma-separated db_schema becomes schemas[] and enables the Data API", () => {
    const result = fromApiProjectConfig({ api: { db_schema: "public, graphql_public" } });
    expect(result.api).toEqual({ schemas: ["public", "graphql_public"], enabled: true });
  });

  // An explicit `db_schema: ""` is the remote's disable sentinel
  // (api.sync.ts:84-87 early-returns without applying anything else from the
  // section), so ONLY `enabled: false` is reported — the sibling fields'
  // remote values are meaningless while the service is off. An *absent*
  // `db_schema` does not gate the siblings (see the minimal fixtures in the
  // surrounding tests, which map `max_rows` without one).
  test("an empty db_schema disables the Data API and omits the sibling fields", () => {
    const result = fromApiProjectConfig({
      api: { db_schema: "", db_extra_search_path: "public", max_rows: 100 },
    });
    expect(result.api).toEqual({ enabled: false });
  });

  test("max_rows is clamped to zero when negative", () => {
    const result = fromApiProjectConfig({ api: { max_rows: -5 } });
    expect(result.api?.max_rows).toBe(0);
  });
});

describe("fromApiProjectConfig — schema decode failure message", () => {
  test("a struct-typed field failing the lenient schema itself names the offending path and carries a fuller detail", () => {
    let thrown: unknown;
    try {
      fromApiProjectConfig({ database: { major_version: "not-a-number" } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    const error = thrown as ProjectConfigParseError;
    expect(error.apiPath).toEqual(["database", "major_version"]);
    expect(error.message).toContain(
      "Could not read the project config from the Management API response: at data.attributes.database.major_version:",
    );
    expect(error.detail).toBeDefined();
    expect(error.detail).toContain("major_version");
    expect(error.suggestion).toContain("upgrading the Supabase CLI");
  });
});

describe("fromApiProjectConfig — db section", () => {
  test("major_version passes through identically", () => {
    const result = fromApiProjectConfig({ database: { major_version: 17 } });
    expect(result.db?.major_version).toBe(17);
  });

  test("ssl_enforced maps to db.ssl_enforcement.enabled", () => {
    const result = fromApiProjectConfig({ database: { ssl_enforced: true } });
    expect(result.db?.ssl_enforcement).toEqual({ enabled: true });
  });

  test("postgres_settings passthrough and uint clamp", () => {
    const result = fromApiProjectConfig({
      database: {
        postgres_settings: {
          max_connections: -1,
          statement_timeout: "30000ms",
        },
      },
    });
    expect(result.db?.settings).toEqual({
      max_connections: 0,
      statement_timeout: "30000ms",
    });
  });

  test("splits the type-tagged allowed_cidrs array into v4/v6 arrays", () => {
    const result = fromApiProjectConfig({
      database: {
        network_restrictions: {
          allowed_cidrs: [
            { address: "1.2.3.4/32", type: "v4" },
            { address: "::/0", type: "v6" },
          ],
        },
      },
    });
    expect(result.db?.network_restrictions).toEqual({
      allowed_cidrs: ["1.2.3.4/32"],
      allowed_cidrs_v6: ["::/0"],
    });
  });

  test.each([
    ["missing address", { type: "v4" }],
    ["missing type", { address: "1.2.3.4/32" }],
    ["unrecognized type", { address: "1.2.3.4/32", type: "v5" }],
    ["a bare string entry", "1.2.3.4/32"],
  ])(
    "throws ProjectConfigParseError rather than silently dropping a malformed allowed_cidrs entry (%s)",
    (_description, entry) => {
      expect(() =>
        fromApiProjectConfig({
          database: { network_restrictions: { allowed_cidrs: [entry] } },
        }),
      ).toThrow(ProjectConfigParseError);
    },
  );

  test("pool_mode 'transaction' is mapped onto db.pooler.pool_mode", () => {
    const result = fromApiProjectConfig({ pooler: { pool_mode: "transaction" } });
    expect(result.db?.pooler).toEqual({ pool_mode: "transaction" });
  });

  test("pool_mode 'statement' is omitted from typed output and from unmappedApiFields, but stays in _apiResponse", () => {
    const result = fromApiProjectConfig({ pooler: { pool_mode: "statement" } });
    expect(result.db?.pooler).toBeUndefined();
    expect(unmappedApiFields(result)).toEqual({});
    expect(result._apiResponse).toEqual({ pooler: { pool_mode: "statement" } });
  });

  test("session_replication_role 'origin' maps onto db.settings.session_replication_role", () => {
    const result = fromApiProjectConfig({
      database: { postgres_settings: { session_replication_role: "origin" } },
    });
    expect(result.db?.settings).toEqual({ session_replication_role: "origin" });
  });

  // Mirrors the pool_mode "statement" case above: guarded to the enum the
  // config schema accepts, but — unlike pool_mode — this path IS consumed by
  // a registry row (`sessionReplicationRoleRow`), so an out-of-enum value is
  // omitted from typed output but does NOT surface in unmappedApiFields.
  test("an unrecognized session_replication_role is omitted from typed output and from unmappedApiFields, but stays in _apiResponse", () => {
    const result = fromApiProjectConfig({
      database: { postgres_settings: { session_replication_role: "weird" } },
    });
    expect(result.db).toBeUndefined();
    expect(unmappedApiFields(result)).toEqual({});
    expect(result._apiResponse).toEqual({
      database: { postgres_settings: { session_replication_role: "weird" } },
    });
  });
});

describe("fromApiProjectConfig — storage section", () => {
  test("file_size_limit is formatted as a BytesSize string", () => {
    const result = fromApiProjectConfig({ storage: { file_size_limit: 52428800 } });
    expect(result.storage?.file_size_limit).toBe("50MiB");
  });

  // Significant-digit (`%.4g`-equivalent) formatting cases, verified against
  // the real `bytesSize` implementation before writing these assertions.
  test.each([
    [1500, "1.465KiB"],
    [1234567890, "1.15GiB"],
  ])(
    "file_size_limit %i bytes formats with correct significant digits as %s",
    (bytes, expected) => {
      const result = fromApiProjectConfig({ storage: { file_size_limit: bytes } });
      expect(result.storage?.file_size_limit).toBe(expected);
    },
  );

  test("features.iceberg_catalog maps to storage.analytics", () => {
    const result = fromApiProjectConfig({
      storage: {
        features: {
          iceberg_catalog: { enabled: true, max_namespaces: 5, max_tables: 10, max_catalogs: 2 },
        },
      },
    });
    expect(result.storage?.analytics).toEqual({
      enabled: true,
      max_namespaces: 5,
      max_tables: 10,
      max_catalogs: 2,
    });
  });

  test("features.vector_buckets maps to storage.vector", () => {
    const result = fromApiProjectConfig({
      storage: {
        features: {
          vector_buckets: { enabled: true, max_buckets: 3, max_indexes: 4 },
        },
      },
    });
    expect(result.storage?.vector).toEqual({ enabled: true, max_buckets: 3, max_indexes: 4 });
  });
});

describe("fromApiProjectConfig — realtime section", () => {
  test("zero rows are mapped: no realtime key, every field surfaces as unmapped", () => {
    const attributes = {
      private_only: true,
      max_concurrent_users: 10,
      max_events_per_second: 5,
      max_bytes_per_second: 5,
      max_channels_per_client: 5,
      max_joins_per_second: 5,
      max_presence_events_per_second: 5,
      max_payload_size_in_kb: 5,
      presence_enabled: true,
      suspend: false,
      connection_pool: 5,
      postgres_changes_pool: null,
    };
    const result = fromApiProjectConfig({ realtime: attributes });
    expect(result.realtime).toBeUndefined();
    expect(unmappedApiFields(result)).toEqual({ realtime: attributes });
  });
});

describe("fromApiProjectConfig — auth section", () => {
  test("a bool-typed GoTrue key with a wrong-typed value throws with the apiPath", () => {
    let thrown: unknown;
    try {
      fromApiProjectConfig({ auth: { disable_signup: "yes" } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    const boolMismatch = thrown as ProjectConfigParseError;
    expect(boolMismatch.apiPath).toEqual(["auth", "disable_signup"]);
    expect(boolMismatch.message).toBe(
      "Could not read the project config from the Management API response: at data.attributes.auth.disable_signup: expected a boolean, got string",
    );
    expect(boolMismatch.suggestion).toContain("upgrading the Supabase CLI");
  });

  test("a string-typed GoTrue key with a number throws with the apiPath", () => {
    let thrown: unknown;
    try {
      fromApiProjectConfig({ auth: { site_url: 123 } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    const stringMismatch = thrown as ProjectConfigParseError;
    expect(stringMismatch.apiPath).toEqual(["auth", "site_url"]);
    expect(stringMismatch.message).toBe(
      "Could not read the project config from the Management API response: at data.attributes.auth.site_url: expected a string, got number",
    );
  });

  test("disable_signup inverts to auth.enable_signup", () => {
    const result = fromApiProjectConfig({ auth: { disable_signup: true } });
    expect(result.auth?.enable_signup).toBe(false);
  });

  test("mailer_autoconfirm inverts to auth.email.enable_confirmations", () => {
    const result = fromApiProjectConfig({ auth: { mailer_autoconfirm: true } });
    expect(result.auth?.email?.enable_confirmations).toBe(false);
  });

  test("sms_autoconfirm maps to auth.sms.enable_confirmations WITHOUT inverting", () => {
    // Deliberate, per registry-auth.ts's smsBaseRows comment: unlike
    // mailer_autoconfirm/email.enable_confirmations, this GoTrue key maps
    // identically on both the pull (auth.sync.ts:1677) and push
    // (auth.sync.ts:2485) sides.
    const result = fromApiProjectConfig({ auth: { sms_autoconfirm: true } });
    expect(result.auth?.sms?.enable_confirmations).toBe(true);
  });

  test("rate_limit_otp renames to auth.rate_limit.sign_in_sign_ups", () => {
    const result = fromApiProjectConfig({ auth: { rate_limit_otp: 30 } });
    expect(result.auth?.rate_limit).toEqual({ sign_in_sign_ups: 30 });
  });

  test("sessions_timebox (hours) converts to a Go duration string", () => {
    // hoursToDurationString(2) => durationString(2 * 3_600_000_000_000)
    // => hours=2, minutes=0, secs=0 => "2h0m0s" (verified against
    // registry-auth.ts's durationString before writing this assertion).
    const result = fromApiProjectConfig({ auth: { sessions_timebox: 2 } });
    expect(result.auth?.sessions?.timebox).toBe("2h0m0s");
  });

  test("smtp_max_frequency (seconds) converts to a Go duration string", () => {
    // secondsToDurationString(60) => durationString(60_000_000_000)
    // => hours=0, minutes=1, secs=0 => "1m0s".
    const result = fromApiProjectConfig({ auth: { smtp_max_frequency: 60 } });
    expect(result.auth?.email?.max_frequency).toBe("1m0s");
  });

  test("smtp_host null disables SMTP and omits host", () => {
    const result = fromApiProjectConfig({ auth: { smtp_host: null } });
    expect(result.auth?.email?.smtp).toEqual({ enabled: false });
  });

  test("a non-empty smtp_host enables SMTP and maps the host", () => {
    const result = fromApiProjectConfig({ auth: { smtp_host: "smtp.example.com" } });
    expect(result.auth?.email?.smtp).toEqual({ enabled: true, host: "smtp.example.com" });
  });

  test("smtp_port parses a numeric string", () => {
    const result = fromApiProjectConfig({ auth: { smtp_port: "2500" } });
    expect(result.auth?.email?.smtp).toEqual({ port: 2500 });
  });

  test("an unparsable smtp_port is omitted", () => {
    const result = fromApiProjectConfig({ auth: { smtp_port: "notaport" } });
    expect(result.auth).toBeUndefined();
  });

  test.each(["smtp_host", "smtp_port"] as const)(
    "a non-string, non-null %s throws rather than silently reporting a default",
    (apiKey) => {
      expect(() => fromApiProjectConfig({ auth: { [apiKey]: 12345 } })).toThrow(
        ProjectConfigParseError,
      );
    },
  );

  test("password_required_characters maps the letters_digits charset literal", () => {
    const result = fromApiProjectConfig({
      auth: {
        password_required_characters:
          "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
      },
    });
    expect(result.auth?.password_requirements).toBe("letters_digits");
  });

  test("an unrecognized password_required_characters charset is omitted", () => {
    const result = fromApiProjectConfig({
      auth: { password_required_characters: "totally-unknown-charset" },
    });
    expect(result.auth).toBeUndefined();
  });

  test("sms_provider selects exactly one provider's enabled flag", () => {
    const result = fromApiProjectConfig({ auth: { sms_provider: "twilio" } });
    expect(result.auth?.sms).toEqual({
      twilio: { enabled: true },
      twilio_verify: { enabled: false },
      messagebird: { enabled: false },
      textlocal: { enabled: false },
      vonage: { enabled: false },
    });
  });

  test("external_github_enabled maps to auth.external.github.enabled", () => {
    const result = fromApiProjectConfig({ auth: { external_github_enabled: true } });
    expect(result.auth?.external?.github).toEqual({ enabled: true });
  });

  test("apple client_id folds in the additional_client_ids sibling", () => {
    const result = fromApiProjectConfig({
      auth: {
        external_apple_client_id: "a",
        external_apple_additional_client_ids: "b,c",
      },
    });
    expect(result.auth?.external?.apple?.client_id).toBe("a,b,c");
  });

  test("sms_test_otp parses the env-map string into a record", () => {
    const result = fromApiProjectConfig({ auth: { sms_test_otp: "15551234567=123456" } });
    expect(result.auth?.sms?.test_otp).toEqual({ "15551234567": "123456" });
  });
});

describe("fromApiProjectConfig — secrets (ADR 0019 rule 5)", () => {
  test.each([
    ["smtp_pass", ["auth", "email", "smtp", "pass"]],
    ["external_github_secret", ["auth", "external", "github", "secret"]],
    ["sms_twilio_auth_token", ["auth", "sms", "twilio", "auth_token"]],
    ["hook_send_email_secrets", ["auth", "hook", "send_email", "secrets"]],
    ["security_captcha_secret", ["auth", "captcha", "secret"]],
  ])(
    "%s is absent from typed output and unmappedApiFields, but present in _apiResponse",
    (apiKey) => {
      const result = fromApiProjectConfig({ auth: { [apiKey]: "the-secret-value" } });
      expect(result.auth).toBeUndefined();
      expect(unmappedApiFields(result)).toEqual({});
      expect((result._apiResponse as Record<string, unknown>).auth).toEqual({
        [apiKey]: "the-secret-value",
      });
    },
  );

  // `figma` has no row at all (no config-schema counterpart), so it would
  // otherwise leak its HMAC digest into `unmappedApiFields` — the
  // `unmappedSecretApiPaths` orphan list (`./registry-auth.ts`) treats it as
  // consumed anyway.
  test("a secret-shaped GoTrue key with no registry row (external_figma_secret) is still absent from unmappedApiFields", () => {
    const result = fromApiProjectConfig({ auth: { external_figma_secret: "figma-secret" } });
    expect(unmappedApiFields(result)).toEqual({});
    expect((result._apiResponse as Record<string, unknown>).auth).toEqual({
      external_figma_secret: "figma-secret",
    });
  });
});

describe("fromApiProjectConfig — null convention", () => {
  // `stringRow` (registry-auth.ts) declares a `transform` specifically so it
  // can treat `null` as "omit" itself, rather than throwing via
  // `expectString` — see the null-safety note on the row factories.
  test("auth.site_url null is omitted via stringRow's own transform", () => {
    const result = fromApiProjectConfig({ auth: { site_url: null } });
    expect(result.auth).toBeUndefined();
  });

  test("api.db_pool null has no counterpart row at all (still omitted)", () => {
    const result = fromApiProjectConfig({ api: { db_pool: null } });
    expect(result.api).toBeUndefined();
    expect(unmappedApiFields(result)).toEqual({ api: { db_pool: null } });
  });
});

describe("fromApiProjectConfig — unknown/API-ahead fields", () => {
  test("a fake field inside a known section, an unknown auth key, and a whole new section all decode without failing", () => {
    const attributes = {
      api: { max_rows: 5, brand_new_field: "future" },
      auth: { some_new_setting: true },
      new_service: { foo: "bar" },
    };
    expect(() => fromApiProjectConfig(attributes)).not.toThrow();
    const result = fromApiProjectConfig(attributes);

    // Never on the typed output.
    expect(result.api).toEqual({ max_rows: 5 });
    expect(Object.hasOwn(result, "new_service")).toBe(false);

    // Always reachable via unmappedApiFields and _apiResponse.
    expect(unmappedApiFields(result)).toEqual({
      api: { brand_new_field: "future" },
      auth: { some_new_setting: true },
      new_service: { foo: "bar" },
    });
    expect(result._apiResponse).toEqual(attributes);
  });
});

describe("fromApiProjectConfig — _apiResponse (ADR 0019 rules 1/3/4)", () => {
  test("is an own, non-enumerable, frozen deep clone of the unwrapped attributes", () => {
    const attributes = { api: { max_rows: 5 } };
    const result = fromApiProjectConfig(apiEnvelope(attributes));

    expect(Object.getOwnPropertyNames(result)).toContain("_apiResponse");
    expect(Object.keys(result)).not.toContain("_apiResponse");
    expect(result._apiResponse).toEqual(attributes);
    expect(result._apiResponse).not.toBe(attributes);
    expect(result._apiResponse?.api).not.toBe(attributes.api);
    expect(Object.isFrozen(result._apiResponse)).toBe(true);
    expect(Object.isFrozen(result._apiResponse?.api)).toBe(true);
  });

  test("mutating the caller's input after the call does not affect the attached _apiResponse", () => {
    const attributes: { api: { max_rows: number } } = { api: { max_rows: 5 } };
    const result = fromApiProjectConfig(attributes);
    attributes.api.max_rows = 999;
    expect(result._apiResponse).toEqual({ api: { max_rows: 5 } });
  });

  test("is invisible to JSON.stringify, object spread, and Object.assign", () => {
    const result = fromApiProjectConfig({ api: { max_rows: 5 } });

    expect(JSON.stringify(result)).not.toContain("_apiResponse");
    const spread = { ...result };
    expect(Object.hasOwn(spread, "_apiResponse")).toBe(false);
    const assigned = Object.assign({}, result);
    expect(Object.hasOwn(assigned, "_apiResponse")).toBe(false);
  });

  test("subtractCliConfig never surfaces _apiResponse in its result", () => {
    const result = fromApiProjectConfig({ api: { max_rows: 5 } });
    const overlay = subtractCliConfig(result, {});
    expect(Object.getOwnPropertyNames(overlay)).not.toContain("_apiResponse");
  });
});

describe("attachApiResponse", () => {
  test("restores _apiResponse lost across a spread, as a new object", () => {
    const result = fromApiProjectConfig({ api: { max_rows: 5 } });
    const spread: ProjectConfig = { ...result };
    expect(spread._apiResponse).toBeUndefined();

    const restored = attachApiResponse(spread, { api: { max_rows: 5 } });
    expect(restored).not.toBe(spread);
    expect(restored.api).toEqual({ max_rows: 5 });
    expect(restored._apiResponse).toEqual({ api: { max_rows: 5 } });
    expect(unmappedApiFields(restored)).toEqual({});
  });

  test("restores _apiResponse lost across structuredClone", () => {
    const result = fromApiProjectConfig({ api: { max_rows: 5 }, new_field: "x" });
    const cloned: ProjectConfig = structuredClone(result);
    expect(cloned._apiResponse).toBeUndefined();

    const restored = attachApiResponse(cloned, { api: { max_rows: 5 }, new_field: "x" });
    expect(unmappedApiFields(restored)).toEqual({ new_field: "x" });
  });
});

describe("fromApiProjectConfig — composition with the sparse core", () => {
  test("subtracting a mapped result from itself yields an empty overlay", () => {
    const result = fromApiProjectConfig(fullAttributesFixture);
    expect(subtractCliConfig(result, result)).toEqual({});
  });

  test("a mapped ProjectConfig is assignable to EffectiveConfig without a cast", () => {
    const asEffectiveConfig: EffectiveConfig = fromApiProjectConfig(fullAttributesFixture);
    expect(asEffectiveConfig).toEqual(expectedFullMappedOutput);
  });

  test("maps every exercised section of a realistic fixture to the expected typed output", () => {
    const result = fromApiProjectConfig(fullAttributesFixture);
    expect(result).toEqual(expectedFullMappedOutput);
  });
});

describe("document/API duration and byte-size convergence", () => {
  test("a document spelling and the equivalent API encoding converge on identical strings and subtract to {} for those fields", () => {
    const documentSide = fromConfigDocument(
      decodeCliConfig({
        auth: { sessions: { timebox: "24h" }, email: { max_frequency: "60s" } },
        storage: { file_size_limit: "52428800" },
      }),
    );
    const apiSide = fromApiProjectConfig({
      auth: { sessions_timebox: 24, smtp_max_frequency: 60 },
      storage: { file_size_limit: 52428800 },
    });

    expect(documentSide.auth?.sessions?.timebox).toBe(apiSide.auth?.sessions?.timebox);
    expect(documentSide.auth?.email?.max_frequency).toBe(apiSide.auth?.email?.max_frequency);
    expect(documentSide.storage?.file_size_limit).toBe(apiSide.storage?.file_size_limit);

    const isolate = (config: ProjectConfig) => ({
      auth: {
        sessions: { timebox: config.auth?.sessions?.timebox },
        email: { max_frequency: config.auth?.email?.max_frequency },
      },
      storage: { file_size_limit: config.storage?.file_size_limit },
    });
    expect(subtractCliConfig(isolate(documentSide), isolate(apiSide))).toEqual({});
    expect(subtractCliConfig(isolate(apiSide), isolate(documentSide))).toEqual({});
  });
});

describe("toProjectConfig", () => {
  test("the { cliConfig } arm dispatches to fromConfigDocument", () => {
    const config = getDefaultCliConfig();
    expect(toProjectConfig({ cliConfig: config })).toEqual(fromConfigDocument(config));
  });

  test("the { apiResponse } arm dispatches to fromApiProjectConfig", () => {
    expect(toProjectConfig({ apiResponse: fullAttributesFixture })).toEqual(
      fromApiProjectConfig(fullAttributesFixture),
    );
  });

  test("throws ProjectConfigParseError rather than a raw TypeError when neither own key is present", () => {
    let thrown: unknown;
    try {
      // @ts-expect-error — exercising the runtime guard against a source with neither own key.
      toProjectConfig({});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).message).toContain("got neither");
  });

  test("throws ProjectConfigParseError when both own keys are present", () => {
    let thrown: unknown;
    try {
      toProjectConfig({ cliConfig: getDefaultCliConfig(), apiResponse: fullAttributesFixture });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).message).toContain("got both");
  });
});

describe("comparableProjectConfigPaths / isComparableProjectConfigPath", () => {
  test("contains representative mapped paths and excludes secret rows and realtime", () => {
    const hasPath = (target: ReadonlyArray<string>) =>
      comparableProjectConfigPaths.some(
        (path) =>
          path.length === target.length && path.every((segment, i) => segment === target[i]),
      );

    expect(hasPath(["api", "max_rows"])).toBe(true);
    expect(hasPath(["auth", "enable_signup"])).toBe(true);
    expect(hasPath(["auth", "captcha", "secret"])).toBe(false);
    expect(hasPath(["auth", "email", "smtp", "pass"])).toBe(false);
    expect(comparableProjectConfigPaths.some((path) => path[0] === "realtime")).toBe(false);
  });

  test("isComparableProjectConfigPath agrees with comparableProjectConfigPaths' membership", () => {
    expect(isComparableProjectConfigPath(["api", "max_rows"])).toBe(true);
    expect(isComparableProjectConfigPath(["auth", "enable_signup"])).toBe(true);
    expect(isComparableProjectConfigPath(["auth", "captcha", "secret"])).toBe(false);
    expect(isComparableProjectConfigPath(["realtime", "enabled"])).toBe(false);
    expect(isComparableProjectConfigPath(["not", "a", "real", "path"])).toBe(false);
  });

  test("a diff restricted to comparableProjectConfigPaths ignores the phantom drift of unconditionally-mapped fields", () => {
    // The API side maps `email.smtp.enabled` unconditionally even when the
    // local document never declared `[auth.email.smtp]` at all (CLI-2230's
    // granularity finding) — an unrestricted diff would report that as
    // drift; restricting to comparableProjectConfigPaths lets a consumer
    // choose to ignore it, but the field itself is still genuinely present
    // on both sides in a way a documented baseline can pin.
    const apiSide = fromApiProjectConfig({ auth: { smtp_host: "" } });
    const documentSide = fromConfigDocument(getDefaultCliConfig());
    expect(isComparableProjectConfigPath(["auth", "email", "smtp", "enabled"])).toBe(true);
    expect(apiSide.auth?.email?.smtp?.enabled).toBe(false);
    expect(documentSide.auth?.email?.smtp?.enabled).toBe(false);
  });
});

describe("unmappedApiFields", () => {
  test("is {} for a file-sourced ProjectConfig (no _apiResponse at all)", () => {
    const fileSourced: ProjectConfig = fromConfigDocument(getDefaultCliConfig());
    expect(unmappedApiFields(fileSourced)).toEqual({});
  });

  test("reports known-but-unmapped fields and omits mapped fields and secrets", () => {
    const result = fromApiProjectConfig(fullAttributesFixture);
    const unmapped = unmappedApiFields(result);

    // Known-but-unmapped fields survive.
    expect(unmapped.api).toMatchObject({ db_pool_acquisition_timeout: 10 });
    expect(unmapped.pooler).toMatchObject({ server_lifetime: 3600 });
    expect(unmapped.storage).toMatchObject({
      capabilities: { list_v2: true },
      upstream_target: "main",
    });
    expect(unmapped.database).toMatchObject({ postgres_settings: { log_checkpoints: true } });
    expect(unmapped.realtime).toBeDefined();

    // Mapped fields never show up as unmapped.
    expect(unmapped.api).not.toHaveProperty("db_schema");
    expect(unmapped.database).not.toHaveProperty("major_version");

    // Secret keys stay absent even from the unmapped report.
    expect(unmapped.auth).not.toHaveProperty("smtp_pass");
    expect(unmapped.auth).not.toHaveProperty("external_github_secret");
  });

  test("API-ahead keys shaped like our metadata convention ($x/_x) surface as unmapped, since raw API attributes never legitimately carry it", () => {
    const result = fromApiProjectConfig(fullAttributesFixture);
    const unmapped = unmappedApiFields(result);

    expect(unmapped.api).toMatchObject({ $weird: 1, _private: 2 });
  });

  test("returns {} when every field in _apiResponse is fully mapped", () => {
    const result = fromApiProjectConfig({ api: { max_rows: 5 } });
    expect(unmappedApiFields(result)).toEqual({});
  });

  test("throws ProjectConfigParseError (not an uncaught RangeError) on pathologically deep nesting", () => {
    let deeplyNested: Record<string, unknown> = { leaf: "value" };
    for (let i = 0; i < 100; i += 1) {
      deeplyNested = { nested: deeplyNested };
    }
    const result = fromApiProjectConfig({ new_service: deeplyNested });
    expect(() => unmappedApiFields(result)).toThrow(ProjectConfigParseError);
  });
});
