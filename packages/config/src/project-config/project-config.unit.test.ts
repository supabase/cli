import { describe, expect, test } from "vitest";
import { CliConfigSchema } from "../base.ts";
import { ProjectConfigParseError } from "../errors.ts";
import { isSecretPath, secretPathPatterns } from "../lib/secret-paths.ts";
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
  type ReadonlyJsonValue,
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
    // `workers` survives as `{}`: the prune removes only containers the copy
    // itself EMPTIED (secret stripping) — an originally-empty container is
    // declared data (a record entry's value can be an empty struct by schema
    // design, e.g. `storage.analytics.buckets` entries, where the key is the
    // information).
    expect(Object.keys(projected).sort()).toEqual([
      "api",
      "auth",
      "db",
      "experimental",
      "realtime",
      "storage",
      "workers",
    ]);
    expect(projected.workers).toEqual({});
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

  test("prunes an empty container left behind by secret stripping, rather than keeping it as litter", () => {
    // `auth.captcha` here declares nothing but its secret leaf — a sparse
    // `EffectiveConfig` literal, not a decoded document (decoding would
    // materialize `enabled`/`provider` defaults alongside it and mask this
    // case). `auth.site_url` keeps the surrounding `auth` section itself
    // non-empty, isolating the nested prune. Once `secret` is stripped,
    // `captcha` is left with zero keys and must be pruned rather than
    // surviving as `{}` litter (CLI-2230's secret-strip empty-container
    // finding) — an empty container carries no comparable information, but
    // `subtractCliConfig` would otherwise keep it forever as phantom drift
    // against any baseline that never declared `captcha` at all.
    const projected = fromConfigDocument({
      auth: { site_url: "https://example.com", captcha: { secret: "captcha-secret" } },
    });
    expect(Object.hasOwn(projected.auth ?? {}, "captcha")).toBe(false);
    expect(projected.auth).toEqual({ site_url: "https://example.com" });
  });

  test("a section that only contains a secret disappears entirely from the projection", () => {
    // Unlike the nested case above, here the ENTIRE `experimental` section
    // (both of whose declared fields are `secret()`-annotated,
    // `../experimental.ts`) has nothing left after stripping — pruning must
    // bubble all the way up through `fromConfigDocument`'s own per-section
    // loop, not just `copyHostedValueWithoutSecrets`'s internal recursion.
    const projected = fromConfigDocument({
      experimental: { s3_access_key: "access-key", s3_secret_key: "s3-secret" },
    });
    expect(Object.hasOwn(projected, "experimental")).toBe(false);
    expect(projected).toEqual({});
  });

  // Schema-derived, exhaustive counterpart to the 5-hand-picked-field test
  // above (CLI-2230's review): rather than trusting a hand-picked field list
  // to stay in sync with `CliConfigSchema`'s actual `x-secret` annotations,
  // this enumerates every `x-secret` path pattern the schema declares
  // (`secretPathPatterns`, `../lib/secret-paths.ts` — the same source of
  // truth `isSecretPath` itself is built from), builds one probe document
  // that populates every pattern reachable through a hosted section, and
  // asserts none of them survive `fromConfigDocument`. This is the real
  // "no x-secret path survives" contract; the hand-picked test above stays
  // as a readable, minimal illustration of the same guarantee.
  test("no x-secret path from the schema's own pattern list survives fromConfigDocument, exhaustively", () => {
    // Mirrors `HOSTED_SECTION_KEYS` (`./project-config.ts`): `fromConfigDocument`
    // only ever copies these seven sections, so a secret pattern rooted
    // anywhere else (`remotes.*`, `studio.*`, `edge_runtime.secrets.*`) is
    // unreachable through it and deliberately excluded from this probe.
    const HOSTED_TOP_LEVEL_KEYS = new Set([
      "api",
      "auth",
      "db",
      "realtime",
      "storage",
      "workers",
      "experimental",
    ]);

    const reachablePatterns = secretPathPatterns.filter((pattern) =>
      HOSTED_TOP_LEVEL_KEYS.has(pattern[0] ?? ""),
    );
    // Guards the loop below against passing vacuously if the schema-derived
    // pattern list is ever empty due to a broken import.
    expect(reachablePatterns.length).toBeGreaterThan(0);

    const WILDCARD_KEY = "probe_key";
    const concretePaths = reachablePatterns.map((pattern) =>
      pattern.map((segment) => (segment === "*" ? WILDCARD_KEY : segment)),
    );

    // Every concrete path must actually be recognized as secret by the same
    // predicate `copyHostedValueWithoutSecrets` consults — otherwise this
    // probe would be asserting nothing.
    for (const path of concretePaths) {
      expect(isSecretPath(path)).toBe(true);
    }

    function setAtPath(root: Record<string, unknown>, path: ReadonlyArray<string>): void {
      let current = root;
      for (let index = 0; index < path.length - 1; index += 1) {
        const segment = path[index] as string;
        const existing = current[segment];
        if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
          current[segment] = {};
        }
        current = current[segment] as Record<string, unknown>;
      }
      current[path[path.length - 1] as string] = "SECRET_PROBE_VALUE";
    }

    function readAtPath(root: unknown, path: ReadonlyArray<string>): unknown {
      let current = root;
      for (const segment of path) {
        if (current === null || typeof current !== "object" || Array.isArray(current)) {
          return undefined;
        }
        current = (current as Record<string, unknown>)[segment];
      }
      return current;
    }

    const probeDocument: Record<string, unknown> = {};
    // A benign sibling one level up keeps its parent container non-empty
    // regardless of pruning, so a passing assertion below actually proves
    // the SECRET leaf was removed rather than the whole subtree
    // disappearing for an unrelated reason (e.g. a bug that wipes the
    // projection entirely). Skipped when the sibling path would itself be
    // secret-shaped — `db.vault.*` matches every key under `db.vault`, so no
    // sibling there can ever prove non-vacuousness; other sections' siblings
    // still do.
    const survivingSiblingPaths: Array<ReadonlyArray<string>> = [];
    for (const path of concretePaths) {
      setAtPath(probeDocument, path);
      const parentPath = path.slice(0, -1);
      if (parentPath.length === 0) {
        continue;
      }
      const siblingPath = [...parentPath, "__probe_sibling__"];
      if (!isSecretPath(siblingPath)) {
        setAtPath(probeDocument, siblingPath);
        survivingSiblingPaths.push(siblingPath);
      }
    }
    expect(survivingSiblingPaths.length).toBeGreaterThan(0);

    const projected = fromConfigDocument(probeDocument);

    for (const path of concretePaths) {
      expect(readAtPath(projected, path)).toBeUndefined();
    }
    for (const siblingPath of survivingSiblingPaths) {
      expect(readAtPath(projected, siblingPath)).toBe("SECRET_PROBE_VALUE");
    }
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

  // JSON cannot encode NaN/Infinity, so a non-finite number in the raw
  // response can only be programmatic input — the pre-decode walk rejects it
  // with the caller-misuse reason before any row's narrowing runs (the
  // expect*-level finite check remains as defense in depth).
  test("a non-finite max_rows is rejected pre-decode as a non-JSON primitive", () => {
    let thrown: unknown;
    try {
      fromApiProjectConfig({ api: { max_rows: Number.NaN } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).reason).toBe("caller_misuse");
    expect((thrown as ProjectConfigParseError).message).toContain("non-JSON primitive");
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

  test("smtp_port parses a numeric string (when SMTP is enabled)", () => {
    // The port is gated on an enabled smtp_host like every SMTP sibling —
    // the push writes only smtp_host: "" when disabling.
    const result = fromApiProjectConfig({
      auth: { smtp_host: "smtp.example.com", smtp_port: "2500" },
    });
    expect(result.auth?.email?.smtp).toEqual({
      enabled: true,
      host: "smtp.example.com",
      port: 2500,
    });
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

  // None of these four have a registry row at all (no config-schema
  // counterpart), so they would otherwise leak their HMAC digest into
  // `unmappedApiFields` — the `unmappedSecretApiPaths` orphan list
  // (`./registry-auth.ts`) treats each as consumed anyway.
  test.each([
    "external_figma_secret",
    "external_slack_secret",
    "hook_after_user_created_secrets",
    "nimbus_oauth_client_secret",
  ])(
    "a secret-shaped GoTrue key with no registry row (%s) is still absent from unmappedApiFields",
    (apiKey) => {
      const result = fromApiProjectConfig({ auth: { [apiKey]: "the-secret-value" } });
      expect(unmappedApiFields(result)).toEqual({});
      expect((result._apiResponse as Record<string, unknown>).auth).toEqual({
        [apiKey]: "the-secret-value",
      });
    },
  );
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

describe("fromApiProjectConfig — clone/freeze robustness (CLI-2230)", () => {
  // Attaching `_apiResponse` clones and freezes the raw attributes
  // (`attachFrozenApiResponse`) BEFORE any depth check existed; each of these
  // three payload shapes used to escape this package's documented
  // `ProjectConfigParseError` contract with a raw, uncaught failure instead.
  test("a pathologically deep raw attributes payload throws ProjectConfigParseError, not an uncaught RangeError", () => {
    let deeplyNested: Record<string, unknown> = { leaf: "value" };
    for (let i = 0; i < 100; i += 1) {
      deeplyNested = { nested: deeplyNested };
    }
    expect(() => fromApiProjectConfig({ new_service: deeplyNested })).toThrow(
      ProjectConfigParseError,
    );
  });

  test("a self-referential (cyclic) raw attributes payload throws ProjectConfigParseError, not an uncaught RangeError", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => fromApiProjectConfig({ new_service: cyclic })).toThrow(ProjectConfigParseError);
  });

  test("a function-valued unmapped field throws ProjectConfigParseError, not an uncaught DOMException", () => {
    expect(() => fromApiProjectConfig({ new_service: { fn: () => 1 } })).toThrow(
      ProjectConfigParseError,
    );
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

  test("throws ProjectConfigParseError rather than silently substituting {} for a non-object config", () => {
    let thrown: unknown;
    try {
      // @ts-expect-error — exercising the runtime guard against a non-object config.
      attachApiResponse("not an object", { api: { max_rows: 5 } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).message).toContain("got string");
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

  test("comparableProjectConfigPaths does NOT rescue a diff against a document operand that never declared the sub-section at all", () => {
    // The API side maps `email.smtp.enabled` unconditionally, even when the
    // *document* operand's `auth` section is genuinely present (it declares
    // `site_url`) but never mentions `[auth.email.smtp]` at all (CLI-2230's
    // granularity finding). This pins the case `comparableProjectConfigPaths`
    // does NOT cover: `auth.email.smtp.enabled` IS a comparable leaf path,
    // yet it still survives `subtractCliConfig` as phantom drift, because the
    // baseline has no `smtp` key at that depth to compare against
    // (`subtractValue` keeps a value verbatim whenever its baseline
    // counterpart is absent). Restricting to comparableProjectConfigPaths
    // only removes the WHOLE-SECTION-granularity false positives (e.g.
    // `realtime`); it cannot rescue this finer-grained one — see
    // `comparableProjectConfigPaths`'s docstring.
    const apiSide = fromApiProjectConfig({ auth: { smtp_host: "" } });
    const documentSide = fromConfigDocument({ auth: { site_url: "https://example.com" } });

    expect(isComparableProjectConfigPath(["auth", "email", "smtp", "enabled"])).toBe(true);
    expect(documentSide).toEqual({ auth: { site_url: "https://example.com" } });

    const overlay = subtractCliConfig(apiSide, documentSide);
    expect(overlay).toEqual({ auth: { email: { smtp: { enabled: false } } } });
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

  // `walkUnmapped`'s own `MAX_UNMAPPED_WALK_DEPTH` guard is no longer
  // reachable through the public API on its own: every path that attaches
  // `_apiResponse` (`fromApiProjectConfig`, `attachApiResponse`) now shares
  // the same bound at construction time (`assertRawAttributesDepthWithinBound`,
  // CLI-2230's clone/freeze finding), so a payload deep enough to trip
  // `walkUnmapped`'s check always fails earlier, at construction — see
  // "fromApiProjectConfig — clone/freeze robustness (CLI-2230)" above.
  // `walkUnmapped`'s own guard remains as defense in depth.
});

describe("review round: numeric and provider narrowing (CLI-2230)", () => {
  test("a fractional value on an integer-typed field throws with its apiPath", () => {
    let thrown: unknown;
    try {
      fromApiProjectConfig({ api: { max_rows: 1.5 } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).apiPath).toEqual(["api", "max_rows"]);
    expect((thrown as ProjectConfigParseError).message).toContain("integer");
  });

  test("fractional session hours map faithfully (no whole-hour rounding)", () => {
    const result = fromApiProjectConfig({ auth: { sessions_timebox: 1.5 } });
    // Deliberate divergence from the legacy apply's Math.round
    // (auth.sync.ts:1402-1407): a standalone mapping must represent the
    // hosted value, not change it.
    expect(result.auth?.sessions?.timebox).toBe("1h30m0s");
  });

  test("a non-string apple client_id throws instead of silently omitting", () => {
    let thrown: unknown;
    try {
      fromApiProjectConfig({ auth: { external_apple_client_id: 123 } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).apiPath).toEqual([
      "auth",
      "external_apple_client_id",
    ]);
  });

  test("a non-string apple additional_client_ids throws instead of being ignored", () => {
    let thrown: unknown;
    try {
      fromApiProjectConfig({
        auth: { external_apple_client_id: "main", external_apple_additional_client_ids: 5 },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).apiPath).toEqual([
      "auth",
      "external_apple_additional_client_ids",
    ]);
  });

  test("a digit-less document duration stays verbatim instead of rewriting to 0s", () => {
    // Go's ParseDuration rejects "s"; the canonicalizer therefore leaves it
    // untouched rather than silently reading it as zero.
    const projected = fromConfigDocument({ auth: { sessions: { timebox: "s" } } });
    expect(projected.auth?.sessions?.timebox).toBe("s");
  });
});

describe("review round: aliasing, unknown-empty sections, path encoding (CLI-2230)", () => {
  test("object elements inside hosted arrays are copied, not aliased", () => {
    const rule = { name: "r1" };
    const projected = fromConfigDocument({ experimental: { inspect: { rules: [rule] } } });
    const copied = projected.experimental?.inspect?.rules?.[0];
    expect(copied).toEqual(rule);
    expect(copied).not.toBe(rule);
  });

  test("an unknown empty section survives into unmappedApiFields", () => {
    const result = fromApiProjectConfig({ brand_new_service: {} });
    expect(unmappedApiFields(result)).toEqual({ brand_new_service: {} });
  });

  test("a raw key that would collide with a registry path under join-encoding stays unmapped", () => {
    // One key containing a NUL between "auth" and "site_url" must not collide
    // with the consumed two-segment path ["auth", "site_url"] — pathKey
    // JSON-encodes the segment array instead of joining on a delimiter.
    const collidingKey = ["auth", "site_url"].join(String.fromCharCode(0));
    const result = fromApiProjectConfig({ [collidingKey]: "x" });
    expect(unmappedApiFields(result)).toEqual({ [collidingKey]: "x" });
  });

  test("a non-string password_required_characters throws with its apiPath", () => {
    let thrown: unknown;
    try {
      fromApiProjectConfig({ auth: { password_required_characters: 123 } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).apiPath).toEqual([
      "auth",
      "password_required_characters",
    ]);
  });

  test("an unrecognized password character-class string still omits the field", () => {
    // An enum member this package version doesn't model — tolerable skew,
    // same bucket as pool_mode "statement": absent from typed output and
    // (path consumed) from unmappedApiFields; reachable via _apiResponse.
    const result = fromApiProjectConfig({ auth: { password_required_characters: "abc" } });
    expect(Object.hasOwn(result, "auth")).toBe(false);
    expect(unmappedApiFields(result)).toEqual({});
  });
});

describe("review round: oauth_server rows, known-empty pruning, DAG walk (CLI-2230)", () => {
  test("oauth_server settings map, including the authorization path rename", () => {
    const result = fromApiProjectConfig({
      auth: {
        oauth_server_enabled: true,
        oauth_server_allow_dynamic_registration: false,
        oauth_server_authorization_path: "/oauth/authorize",
      },
    });
    expect(result.auth?.oauth_server).toEqual({
      enabled: true,
      allow_dynamic_registration: false,
      authorization_url_path: "/oauth/authorize",
    });
  });

  test("known-but-empty containers are pruned from unmappedApiFields", () => {
    const result = fromApiProjectConfig({ database: { postgres_settings: {} }, auth: {} });
    expect(unmappedApiFields(result)).toEqual({});
  });

  test("a shared-reference DAG is rejected in bounded time with a typed error", () => {
    // ~40 shared levels × 2 properties = ~2^41 tree paths within the depth
    // bound — the visit cap must reject it as pathological (typed, fast)
    // instead of hanging. Real JSON off the network can never share
    // references, so nothing legitimate hits this.
    let node: Record<string, unknown> = { leaf: true };
    for (let level = 0; level < 40; level++) {
      node = { a: node, b: node };
    }
    const startedAt = performance.now();
    expect(() => fromApiProjectConfig({ shared_dag: node })).toThrow(ProjectConfigParseError);
    expect(performance.now() - startedAt).toBeLessThan(5_000);
  });

  test("a non-string sms_test_otp throws with its apiPath", () => {
    let thrown: unknown;
    try {
      fromApiProjectConfig({ auth: { sms_test_otp: 123 } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).apiPath).toEqual(["auth", "sms_test_otp"]);
  });

  test("a non-string captcha provider throws; a recognized one maps; an unknown string omits", () => {
    let thrown: unknown;
    try {
      fromApiProjectConfig({ auth: { security_captcha_provider: 7 } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);

    const recognized = fromApiProjectConfig({ auth: { security_captcha_provider: "hcaptcha" } });
    expect(recognized.auth?.captcha?.provider).toBe("hcaptcha");

    const unknown = fromApiProjectConfig({ auth: { security_captcha_provider: "novelcaptcha" } });
    expect(Object.hasOwn(unknown, "auth")).toBe(false);
  });
});

describe("review round: pre-decode depth guard, caller-misuse reason, readonly metadata (CLI-2230)", () => {
  test("a pathologically deep value under auth throws typed before schema decode", () => {
    let node: Record<string, unknown> = { leaf: true };
    for (let level = 0; level < 200; level++) {
      node = { nested: node };
    }
    let thrown: unknown;
    try {
      fromApiProjectConfig({ auth: { some_future_key: node } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
  });

  test("a null dispatcher source throws the typed caller-misuse error, not a TypeError", () => {
    let thrown: unknown;
    try {
      toProjectConfig(null as unknown as Parameters<typeof toProjectConfig>[0]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).reason).toBe("caller_misuse");
    expect((thrown as ProjectConfigParseError).suggestion).toBeUndefined();
  });

  test("neither/both dispatcher sources carry the caller-misuse reason without the upgrade suggestion", () => {
    for (const source of [{}, { cliConfig: {}, apiResponse: {} }]) {
      let thrown: unknown;
      try {
        toProjectConfig(source as unknown as Parameters<typeof toProjectConfig>[0]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ProjectConfigParseError);
      expect((thrown as ProjectConfigParseError).reason).toBe("caller_misuse");
      expect((thrown as ProjectConfigParseError).suggestion).toBeUndefined();
    }
  });

  test("malformed API payloads keep the api_response semantics (no caller-misuse reason)", () => {
    let thrown: unknown;
    try {
      fromApiProjectConfig(42);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).reason).toBeUndefined();
    expect((thrown as ProjectConfigParseError).suggestion).toBeDefined();
  });

  test("_apiResponse is readonly at compile time and frozen at runtime", () => {
    const result = fromApiProjectConfig({ api: { max_rows: 5 } });
    const metadata = result._apiResponse;
    expect(metadata).toBeDefined();
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(() => {
      // @ts-expect-error — the frozen metadata must not be assignable; the
      // runtime counterpart is the strict-mode TypeError asserted here.
      metadata["foo"] = "bar";
    }).toThrow(TypeError);
  });
});

describe("review round: deep-readonly metadata, integer frequencies, provider narrowing (CLI-2230)", () => {
  test("nested _apiResponse arrays are readonly under a readonly-preserving guard and frozen at runtime", () => {
    // The lib's own Array.isArray narrows to a MUTABLE any[] view
    // (microsoft/TypeScript#17002) — the type's docstring directs consumers
    // to a readonly-preserving guard like this one, under which mutation
    // does not compile. Runtime deep-freeze backstops the lib-guard path.
    const isReadonlyJsonArray = (
      value: ReadonlyJsonValue | undefined,
    ): value is ReadonlyArray<ReadonlyJsonValue> => Array.isArray(value);

    const result = fromApiProjectConfig({ some_new_top: ["a", "b"] });
    const nested = result._apiResponse?.["some_new_top"];
    if (!isReadonlyJsonArray(nested)) {
      throw new Error("expected some_new_top to narrow to a readonly array");
    }
    expect(Object.isFrozen(nested)).toBe(true);
    // @ts-expect-error — a readonly-narrowed nested array has no push.
    expect(() => nested.push("c")).toThrow(TypeError);
  });

  test("a fractional *_max_frequency throws (the contract types it isInt)", () => {
    let thrown: unknown;
    try {
      fromApiProjectConfig({ auth: { smtp_max_frequency: 1.5 } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).apiPath).toEqual(["auth", "smtp_max_frequency"]);
  });

  test("a non-string sms_provider throws with its apiPath", () => {
    let thrown: unknown;
    try {
      fromApiProjectConfig({ auth: { sms_provider: 7 } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).apiPath).toEqual(["auth", "sms_provider"]);
  });
});

describe("review round: operand guards, empty-entry preservation, duration bounds (CLI-2230)", () => {
  test("a non-object fromConfigDocument operand throws the typed caller-misuse error", () => {
    for (const operand of [null, undefined, ["not", "a", "config"]]) {
      let thrown: unknown;
      try {
        fromConfigDocument(operand as unknown as Parameters<typeof fromConfigDocument>[0]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ProjectConfigParseError);
      expect((thrown as ProjectConfigParseError).reason).toBe("caller_misuse");
    }
  });

  test("record entries whose values are empty structs by design survive projection", () => {
    const projected = fromConfigDocument({
      storage: { analytics: { buckets: { reports: {} } } },
    });
    expect(projected.storage?.analytics?.buckets).toEqual({ reports: {} });
  });

  test("sections the copy itself emptied still disappear", () => {
    const withOnlySecret = decodeCliConfig({
      auth: { captcha: { enabled: true, provider: "hcaptcha", secret: "captcha-secret" } },
    });
    const projected = fromConfigDocument({ auth: { captcha: withOnlySecret.auth.captcha } });
    // captcha kept its non-secret fields; only the secret leaf is gone.
    expect(projected.auth?.captcha).toEqual({ enabled: true, provider: "hcaptcha" });
  });

  test("session-hour values beyond the formatter's range throw with their apiPath", () => {
    for (const hours of [1e300, 1e22, -1]) {
      let thrown: unknown;
      try {
        fromApiProjectConfig({ auth: { sessions_timebox: hours } });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ProjectConfigParseError);
      expect((thrown as ProjectConfigParseError).apiPath).toEqual(["auth", "sessions_timebox"]);
    }
    // A sane value still maps.
    const result = fromApiProjectConfig({ auth: { sessions_timebox: 24 } });
    expect(result.auth?.sessions?.timebox).toBe("24h0m0s");
  });
});

describe("review round: sibling validation, formatter overflow, prototype lookups (CLI-2230)", () => {
  test("a malformed additional_client_ids throws even when the main client id is null", () => {
    let thrown: unknown;
    try {
      fromApiProjectConfig({
        auth: { external_apple_client_id: null, external_apple_additional_client_ids: 5 },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).apiPath).toEqual([
      "auth",
      "external_apple_additional_client_ids",
    ]);
    // A null anchor with a VALID sibling still omits the field entirely.
    const omitted = fromApiProjectConfig({
      auth: { external_apple_client_id: null, external_apple_additional_client_ids: "b,c" },
    });
    expect(Object.hasOwn(omitted, "auth")).toBe(false);
  });

  test("a document duration too large for the formatter stays verbatim", () => {
    const projected = fromConfigDocument({
      auth: { sessions: { timebox: "1000000000000000000000h" } },
    });
    expect(projected.auth?.sessions?.timebox).toBe("1000000000000000000000h");
  });

  test("prototype-inherited charset keys are omitted, not resolved", () => {
    for (const key of ["constructor", "__proto__", "toString"]) {
      const result = fromApiProjectConfig({ auth: { password_required_characters: key } });
      expect(Object.hasOwn(result, "auth")).toBe(false);
    }
  });

  test("a document file_size_limit that overflows through its suffix stays verbatim", () => {
    const projected = fromConfigDocument({ storage: { file_size_limit: "1e308KiB" } });
    expect(projected.storage?.file_size_limit).toBe("1e308KiB");
  });
});

describe("review round: duration/size bounds and freeze failures (CLI-2230)", () => {
  test("an out-of-range *_max_frequency throws instead of formatting an unparsable duration", () => {
    let thrown: unknown;
    try {
      fromApiProjectConfig({ auth: { smtp_max_frequency: 10_000_000_000 } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).apiPath).toEqual(["auth", "smtp_max_frequency"]);
  });

  test("a negative storage file_size_limit throws instead of formatting -1B", () => {
    let thrown: unknown;
    try {
      fromApiProjectConfig({ storage: { file_size_limit: -1 } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).apiPath).toEqual(["storage", "file_size_limit"]);
  });

  test("canonicalization preserves fractional seconds in hours/minutes durations", () => {
    const projected = fromConfigDocument({
      auth: {
        sessions: { timebox: "1h0.5s", inactivity_timeout: "1m0.5s" },
      },
    });
    // Go's Duration.String() prints fractional seconds in these branches;
    // the legacy port truncates them (config-sync.duration.ts:62-69) — this
    // copy deliberately matches Go so canonicalizing never changes the value.
    expect(projected.auth?.sessions?.timebox).toBe("1h0m0.5s");
    expect(projected.auth?.sessions?.inactivity_timeout).toBe("1m0.5s");
  });

  test("an unfreezable raw attribute value throws the typed caller-misuse error", () => {
    let thrown: unknown;
    try {
      attachApiResponse({}, { bytes: new Uint8Array([1]) });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).reason).toBe("caller_misuse");
  });
});

describe("review round: absent anchors, exponent-free seconds, non-plain values (CLI-2230)", () => {
  test("a malformed additional_client_ids throws even when the anchor key is absent", () => {
    let thrown: unknown;
    try {
      fromApiProjectConfig({ auth: { external_google_additional_client_ids: 5 } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).apiPath).toEqual([
      "auth",
      "external_google_additional_client_ids",
    ]);
    // A VALID sibling with an absent anchor still omits the field (nothing
    // to fold into) and stays consumed.
    const omitted = fromApiProjectConfig({
      auth: { external_google_additional_client_ids: "b,c" },
    });
    expect(Object.hasOwn(omitted, "auth")).toBe(false);
    expect(unmappedApiFields(omitted)).toEqual({});
  });

  test("sub-microsecond remainders format fixed-decimal, never exponent notation", () => {
    const projected = fromConfigDocument({ auth: { sessions: { timebox: "1h1ns" } } });
    expect(projected.auth?.sessions?.timebox).toBe("1h0m0.000000001s");
  });

  test("non-plain structured-cloneable values are rejected before attach", () => {
    for (const nonPlain of [new Map(), new Set(), new Date()]) {
      let thrown: unknown;
      try {
        attachApiResponse({}, { x: nonPlain as unknown as ReadonlyJsonValue } as unknown as Record<
          string,
          unknown
        >);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ProjectConfigParseError);
      expect((thrown as ProjectConfigParseError).reason).toBe("caller_misuse");
    }
  });
});

describe("review round: clone taxonomy, precision bound, type discriminator, secret validation (CLI-2230)", () => {
  test("a non-cloneable raw value carries the caller-misuse reason", () => {
    let thrown: unknown;
    try {
      attachApiResponse({}, { x: () => {} });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).reason).toBe("caller_misuse");
  });

  test("a duration past the float precision bound stays verbatim (no silent rounding)", () => {
    const projected = fromConfigDocument({ auth: { sessions: { timebox: "2502h1ns" } } });
    // 2502h1ns exceeds Number.MAX_SAFE_INTEGER nanoseconds — canonicalizing
    // would silently drop the 1ns, so the value must stay as written.
    expect(projected.auth?.sessions?.timebox).toBe("2502h1ns");
  });

  test("an envelope for a different resource type throws instead of partially mapping", () => {
    let thrown: unknown;
    try {
      fromApiProjectConfig({
        data: { type: "some_other_resource", attributes: { api: { max_rows: 5 } } },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    // An envelope WITHOUT a type stays tolerated.
    const lenient = fromApiProjectConfig({ data: { attributes: { api: { max_rows: 5 } } } });
    expect(lenient.api?.max_rows).toBe(5);
  });

  test("a malformed secret value throws instead of being silently consumed", () => {
    let thrown: unknown;
    try {
      fromApiProjectConfig({ auth: { smtp_pass: 123 } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).apiPath).toEqual(["auth", "smtp_pass"]);
    // Null and digest strings still omit without throwing.
    expect(Object.hasOwn(fromApiProjectConfig({ auth: { smtp_pass: null } }), "auth")).toBe(false);
    expect(Object.hasOwn(fromApiProjectConfig({ auth: { smtp_pass: "hmac" } }), "auth")).toBe(
      false,
    );
  });
});

describe("review round: safe integers, Go truncation, bigint, fractional-hour bound (CLI-2230)", () => {
  test("an unsafe integer throws instead of laundering JSON parse rounding", () => {
    let thrown: unknown;
    try {
      fromApiProjectConfig({ api: { max_rows: Number.MAX_SAFE_INTEGER + 2 } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).message).toContain("a safe integer");
  });

  test("fractional nanoseconds round like the push parser (the pipeline authority)", () => {
    // The push parser (config-sync.duration.ts:155) ROUNDS fractional
    // nanoseconds — it is what actually processes the document on push, so
    // canonicalization predicts its reading. (Go itself truncates; matching
    // Go would canonicalize toward a hosted value the pipeline never
    // produces.)
    const projected = fromConfigDocument({ auth: { sessions: { timebox: "1.0000000005s" } } });
    expect(projected.auth?.sessions?.timebox).toBe("1.000000001s");
  });

  test("a bigint raw value throws the typed caller-misuse error", () => {
    let thrown: unknown;
    try {
      attachApiResponse({}, { new_service: 1n });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).reason).toBe("caller_misuse");
  });

  test("fractional session hours inside the safe range map instead of tripping a whole-hour ceiling", () => {
    const result = fromApiProjectConfig({ auth: { sessions_timebox: 2501.5 } });
    expect(result.auth?.sessions?.timebox).toBe("2501h30m0s");
  });
});

describe("review round: non-JSON primitives, tiny hours, readonly report, whole-second frequencies, disabled sentinel (CLI-2230)", () => {
  test("undefined and non-finite raw values throw the typed caller-misuse error", () => {
    for (const bad of [{ x: undefined }, { x: Number.NaN }, { x: Number.POSITIVE_INFINITY }]) {
      let thrown: unknown;
      try {
        attachApiResponse({}, bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ProjectConfigParseError);
      expect((thrown as ProjectConfigParseError).reason).toBe("caller_misuse");
    }
  });

  test("a sub-nanosecond session-hour value truncates to 0s instead of exponent notation", () => {
    const result = fromApiProjectConfig({ auth: { sessions_timebox: 1e-20 } });
    expect(result.auth?.sessions?.timebox).toBe("0s");
  });

  test("the unmapped report is readonly at compile time and its leaf arrays stay frozen", () => {
    const result = fromApiProjectConfig({ brand_new: ["a"] });
    const report = unmappedApiFields(result);
    const leaf = report["brand_new"];
    expect(Array.isArray(leaf)).toBe(true);
    expect(Object.isFrozen(leaf)).toBe(true);
    expect(() => {
      // @ts-expect-error — the report's index is readonly.
      report["brand_new"] = null;
      // The rebuilt top-level container is NOT frozen, so pin the compile
      // error via the runtime no-op-or-throw distinction: assignment on the
      // fresh record succeeds at runtime, which is why the compile-level
      // readonly matters. Throw manually to keep the expectation uniform.
      throw new TypeError("compile-only guard");
    }).toThrow(TypeError);
  });

  test("document frequency durations quantize to whole seconds like the legacy push", () => {
    const projected = fromConfigDocument({ auth: { email: { max_frequency: "1.5s" } } });
    // auth.sync.ts:2611-2616 floors to integer seconds on push — the hosted
    // value can only ever be whole seconds, so the document converges on it.
    expect(projected.auth?.email?.max_frequency).toBe("1s");
    // Sessions durations are NOT quantized (fractional seconds are pushable
    // as fractional hours).
    const sessions = fromConfigDocument({ auth: { sessions: { timebox: "1h0.5s" } } });
    expect(sessions.auth?.sessions?.timebox).toBe("1h0m0.5s");
  });

  test("a document with the Data API disabled projects only the enabled sentinel", () => {
    const projected = fromConfigDocument({
      api: { enabled: false, schemas: ["public"], extra_search_path: ["public"], max_rows: 500 },
    });
    expect(projected.api).toEqual({ enabled: false });
  });
});

describe("review round: fraction exactness, hour round-trip, bigint discriminator (CLI-2230)", () => {
  test("18-digit duration fractions canonicalize to the push parser's reading", () => {
    const projected = fromConfigDocument({
      auth: { sessions: { timebox: "0.999999999999999999s" } },
    });
    // The push parser's float accumulation reads this as exactly 1s — and
    // ITS reading is the pipeline authority the canonical spelling predicts.
    // (Go itself would truncate to 999999999ns; see parseDuration's
    // authority-scoping note for why push wins for fractional arithmetic.)
    expect(projected.auth?.sessions?.timebox).toBe("1s");
  });

  test("hour values quantized from integer-nanosecond durations round-trip exactly", () => {
    // Pushing "65s" stores 65e9/3.6e12 hours; the float product lands a hair
    // below 65e9 and truncation shaved a nanosecond ("1m4.999999999s").
    const hours = 65_000_000_000 / 3_600_000_000_000;
    const result = fromApiProjectConfig({ auth: { sessions_timebox: hours } });
    expect(result.auth?.sessions?.timebox).toBe("1m5s");
  });

  test("a bigint resource-type discriminator stays inside the typed error contract", () => {
    let thrown: unknown;
    try {
      fromApiProjectConfig({ type: 1n, attributes: {} });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).message).toContain("bigint");
  });
});

describe("review round: Go fraction order, mu units, realms, disabled-gate validation (CLI-2230)", () => {
  test("short decimal fractions scale exactly like Go", () => {
    const projected = fromConfigDocument({ auth: { sessions: { timebox: "0.2593ms" } } });
    // Go computes int64(f * (unit/scale)) = 2593 * 100 = 259300ns exactly;
    // the old operand order truncated a nanosecond short (259.299µs).
    expect(projected.auth?.sessions?.timebox).toBe("259.3µs");
  });

  test("the Greek small mu spelling canonicalizes like Go accepts it", () => {
    const projected = fromConfigDocument({ auth: { sessions: { timebox: "1μs" } } });
    expect(projected.auth?.sessions?.timebox).toBe("1µs");
  });

  test("plain JSON objects with a foreign prototype chain are accepted", () => {
    // Simulates a cross-realm JSON.parse result: same shape, different
    // Object.prototype identity.
    const foreign = Object.assign(Object.create(Object.create(null)), { max_rows: 5 });
    const result = fromApiProjectConfig({ api: foreign });
    expect(result.api?.max_rows).toBe(5);
  });

  test("disabled network restrictions project only the enabled sentinel", () => {
    const projected = fromConfigDocument({
      db: { network_restrictions: { enabled: false, allowed_cidrs: ["0.0.0.0/0"] } },
    });
    expect(projected.db?.network_restrictions).toEqual({ enabled: false });
  });

  test("a malformed value alongside the disabled Data API sentinel still throws", () => {
    let thrown: unknown;
    try {
      fromApiProjectConfig({ api: { db_schema: "", max_rows: 1.5 } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).apiPath).toEqual(["api", "max_rows"]);
  });
});

describe("review round: Go-range sessions, SMTP/provider/storage disabled sentinels (CLI-2230)", () => {
  test("year-scale whole-hour durations parse and map inside Go's range", () => {
    // "8760h" is a valid push-side value (sent as 8760 hours); the earlier
    // float-precision ceiling wrongly rejected it. Single whole-unit
    // components stay exact at any magnitude inside Go's range.
    const projected = fromConfigDocument({ auth: { sessions: { timebox: "8760h" } } });
    expect(projected.auth?.sessions?.timebox).toBe("8760h0m0s");
    const mapped = fromApiProjectConfig({ auth: { sessions_timebox: 8760 } });
    expect(mapped.auth?.sessions?.timebox).toBe("8760h0m0s");
  });

  test("SMTP siblings are omitted when the host reports SMTP disabled", () => {
    const disabled = fromApiProjectConfig({
      auth: { smtp_host: "", smtp_user: "stale", smtp_admin_email: "old@x.co" },
    });
    expect(disabled.auth?.email?.smtp).toEqual({ enabled: false });
    const enabled = fromApiProjectConfig({
      auth: { smtp_host: "smtp.example.com", smtp_user: "user" },
    });
    expect(enabled.auth?.email?.smtp).toEqual({
      enabled: true,
      host: "smtp.example.com",
      user: "user",
    });
    // Validation still runs before the gate.
    expect(() => fromApiProjectConfig({ auth: { smtp_host: "", smtp_user: 5 } })).toThrow(
      ProjectConfigParseError,
    );
  });

  test("disabled storage features project only their toggle", () => {
    const projected = fromConfigDocument({
      storage: { analytics: { enabled: false, max_tables: 10 } },
    });
    expect(projected.storage?.analytics).toEqual({ enabled: false });
  });

  test("disabled external providers project only their toggle", () => {
    const projected = fromConfigDocument({
      auth: { external: { github: { enabled: false, client_id: "retired" } } },
    });
    expect(projected.auth?.external?.github).toEqual({ enabled: false });
    const enabled = fromConfigDocument({
      auth: { external: { github: { enabled: true, client_id: "live" } } },
    });
    expect(enabled.auth?.external?.github).toEqual({ enabled: true, client_id: "live" });
  });
});

describe("review round: exactness parsing, cross-arm disabled sentinels (CLI-2230)", () => {
  test("multi-component long durations parse when every addition is float-exact", () => {
    const zeroTail = fromConfigDocument({ auth: { sessions: { timebox: "8760h0m" } } });
    expect(zeroTail.auth?.sessions?.timebox).toBe("8760h0m0s");
    const coarseTail = fromConfigDocument({ auth: { sessions: { timebox: "8760h30m" } } });
    expect(coarseTail.auth?.sessions?.timebox).toBe("8760h30m0s");
    // Precision-losing additions still stay verbatim.
    const lossy = fromConfigDocument({ auth: { sessions: { timebox: "2502h1ns" } } });
    expect(lossy.auth?.sessions?.timebox).toBe("2502h1ns");
  });

  test("the API arm prunes unmanaged fields behind disabled toggles too", () => {
    const result = fromApiProjectConfig({
      auth: {
        security_captcha_enabled: false,
        security_captcha_provider: "turnstile",
        hook_send_email_enabled: false,
        hook_send_email_uri: "https://stale.example.com",
        sms_provider: "twilio",
        sms_messagebird_originator: "stale-originator",
        external_github_enabled: false,
        external_github_client_id: "retired-id",
      },
      storage: {
        features: {
          iceberg_catalog: { enabled: false, max_namespaces: 5, max_tables: 10, max_catalogs: 2 },
        },
      },
    });
    expect(result.auth?.captcha).toEqual({ enabled: false });
    expect(result.auth?.hook?.send_email).toEqual({ enabled: false });
    expect(result.auth?.sms?.messagebird).toEqual({ enabled: false });
    expect(result.auth?.external?.github).toEqual({ enabled: false });
    expect(result.storage?.analytics).toEqual({ enabled: false });
  });

  test("documents with auth or storage disabled project only the toggle", () => {
    const projected = fromConfigDocument({
      auth: { enabled: false, site_url: "http://localhost:3000" },
      storage: { enabled: false, file_size_limit: "50MiB" },
    });
    expect(projected.auth).toEqual({ enabled: false });
    expect(projected.storage).toEqual({ enabled: false });
  });

  test("the email rate limit is omitted while SMTP is unmanaged", () => {
    const doc = fromConfigDocument({
      auth: { rate_limit: { email_sent: 30, sms_sent: 30 } },
    });
    expect(doc.auth?.rate_limit).toEqual({ sms_sent: 30 });
    const api = fromApiProjectConfig({ auth: { rate_limit_email_sent: 30 } });
    expect(Object.hasOwn(api, "auth")).toBe(false);
    const apiWithSmtp = fromApiProjectConfig({
      auth: { smtp_host: "smtp.example.com", rate_limit_email_sent: 30 },
    });
    expect(apiWithSmtp.auth?.rate_limit).toEqual({ email_sent: 30 });
  });
});

describe("review round: oauth_server disabled sentinel (CLI-2230)", () => {
  test("a disabled OAuth server projects only its toggle on both arms", () => {
    const api = fromApiProjectConfig({
      auth: { oauth_server_enabled: false, oauth_server_authorization_path: "/stale" },
    });
    expect(api.auth?.oauth_server).toEqual({ enabled: false });
    const doc = fromConfigDocument({
      auth: { oauth_server: { enabled: false, authorization_url_path: "/stale" } },
    });
    expect(doc.auth?.oauth_server).toEqual({ enabled: false });
  });
});

describe("review round: clone-snapshot validation, provenance, digit exactness (CLI-2230)", () => {
  test("a getter that changes answers cannot desynchronize validation from the attached snapshot", () => {
    // Clone-first ordering: structuredClone reads the getter exactly once,
    // and the VALIDATED value is the CLONE — so either the snapshot is plain
    // JSON and attaches coherently (this case: first read returns 1), or the
    // snapshot itself fails validation typed. No ordering lets a value that
    // wasn't validated get attached.
    let reads = 0;
    const sneaky: Record<string, unknown> = {};
    Object.defineProperty(sneaky, "flip", {
      enumerable: true,
      get() {
        reads += 1;
        return reads > 1 ? 1n : 1;
      },
    });
    const attached = attachApiResponse({}, sneaky);
    expect((attached as ProjectConfig)._apiResponse?.["flip"]).toBe(1);
  });

  test("pathological structures via attachApiResponse carry caller provenance", () => {
    let node: Record<string, unknown> = { leaf: true };
    for (let level = 0; level < 200; level++) {
      node = { nested: node };
    }
    let thrown: unknown;
    try {
      attachApiResponse({}, { deep: node });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).reason).toBe("caller_misuse");
    expect((thrown as ProjectConfigParseError).suggestion).toBeUndefined();
    // The same structure via the API arm stays a platform-response failure.
    let apiThrown: unknown;
    try {
      fromApiProjectConfig({ deep: node });
    } catch (error) {
      apiThrown = error;
    }
    expect(apiThrown).toBeInstanceOf(ProjectConfigParseError);
    expect((apiThrown as ProjectConfigParseError).reason).toBeUndefined();
  });

  test("integer duration components past the safe range stay verbatim", () => {
    const projected = fromConfigDocument({
      auth: { sessions: { timebox: "9007199254740993ns" } },
    });
    expect(projected.auth?.sessions?.timebox).toBe("9007199254740993ns");
  });
});

describe("review round: unified snapshot, exact scaling, signed frequencies, endpoint (CLI-2230)", () => {
  test("decode, mapping, and metadata all read one snapshot", () => {
    let reads = 0;
    const flippy: Record<string, unknown> = {};
    Object.defineProperty(flippy, "max_rows", {
      enumerable: true,
      get() {
        reads += 1;
        return reads;
      },
    });
    const result = fromApiProjectConfig({ api: flippy });
    // Whatever the first (and only) read produced is BOTH the mapped value
    // and the metadata value — no desync possible.
    expect(result.api?.max_rows).toBe(1);
    expect(result._apiResponse?.["api"]).toEqual({ max_rows: 1 });
  });

  test("a safe integer component that rounds through its unit stays verbatim", () => {
    const projected = fromConfigDocument({
      auth: { sessions: { timebox: "9007199254740ms" } },
    });
    expect(projected.auth?.sessions?.timebox).toBe("9007199254740ms");
  });

  test("negative frequencies map (the contract types them signed)", () => {
    const result = fromApiProjectConfig({ auth: { smtp_max_frequency: -5 } });
    expect(result.auth?.email?.max_frequency).toBe("-5s");
  });

  test("the session-hour ceiling itself maps below Go's maximum duration", () => {
    const ceilingHours = (2 ** 63 - 2 ** 10) / 3_600_000_000_000;
    const result = fromApiProjectConfig({ auth: { sessions_timebox: ceilingHours } });
    expect(typeof result.auth?.sessions?.timebox).toBe("string");
    expect(result.auth?.sessions?.timebox).not.toContain("e");
  });
});

describe("review round: fractional-addition exactness (CLI-2230)", () => {
  test("a fractional addition that rounds onto a large whole component stays verbatim", () => {
    const projected = fromConfigDocument({
      auth: { sessions: { timebox: "9000000000000.001ms" } },
    });
    expect(projected.auth?.sessions?.timebox).toBe("9000000000000.001ms");
  });
});
