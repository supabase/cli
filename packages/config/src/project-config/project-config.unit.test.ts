import { describe, expect, test } from "vitest";
import { CliConfigSchema } from "../base.ts";
import type { LoadedCliConfig } from "../config-document.ts";
import { ProjectConfigParseError } from "../errors.ts";
import { isSecretPath, secretPathPatterns } from "../lib/secret-paths.ts";
import { getDefaultCliConfig, omitDefaultValues, subtractCliConfig } from "../sparse.ts";
import type { EffectiveConfig } from "../sparse.ts";
import { Schema } from "effect";
import {
  attachApiResponse,
  comparableProjectConfigPaths,
  DOCUMENT_ONLY_LOCAL_PATHS,
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
    // information). `realtime` is absent, not present-as-`{}` like `workers`:
    // all 3 of its config-side fields are `DOCUMENT_ONLY_LOCAL_PATHS` entries
    // (CLI-2316), all 3 are always-materialized (not `optionalKey`) so the
    // default config always declares them, and the emptied-by-exclusion
    // section prune (same rule as the secret-stripped case) removes it
    // entirely — see the dedicated describe block below.
    expect(Object.keys(projected).sort()).toEqual([
      "api",
      "auth",
      "db",
      "experimental",
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
    // The top-level `api`/`db` containers are still freshly built (never the
    // same object as `config`'s), even though `toEqual`-comparing them WHOLE
    // against `config.api`/`config.db` would now fail: CLI-2316 strips
    // several of their fields (`api.port`/`tls`/`external_url`,
    // `db.port`/`shadow_port`/`health_timeout`/`major_version`/`pooler`/
    // `migrations`/`seed` — see the dedicated describe block below) from the
    // projection. `storage.s3_protocol` — an always-materialized nested
    // object none of those exclusions touch — is the equality probe instead.
    expect(projected.api).not.toBe(config.api);
    expect(projected.db).not.toBe(config.db);
    expect(projected.storage?.s3_protocol).not.toBe(config.storage.s3_protocol);
    expect(projected.storage?.s3_protocol).toEqual(config.storage.s3_protocol);
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

  // Drift-audit fix (round 30, ADR 0021): the schema types `smtp.port` as an
  // unrestricted number, but the push wrapper stringifies it
  // (`String(local.email.smtp.port)`, auth.sync.ts:2390) and the API arm's
  // own row only ever reports a value `parseUint16` accepts — so without a
  // matching document-side round trip, a fractional/out-of-range document
  // port would disagree with what the API arm reports for the same pushed
  // state.
  test("a fractional smtp.port is omitted (String->parseUint16 round trip), the rest of the block survives", () => {
    const projected = fromConfigDocument({
      auth: {
        email: {
          smtp: {
            enabled: true,
            host: "smtp.example.com",
            port: 25.5,
            user: "u",
            admin_email: "a@b.c",
            sender_name: "S",
          },
        },
      },
    });
    expect(projected.auth?.email?.smtp).toEqual({
      enabled: true,
      host: "smtp.example.com",
      user: "u",
      admin_email: "a@b.c",
      sender_name: "S",
    });
  });

  test("an integer smtp.port survives the round trip unchanged", () => {
    const projected = fromConfigDocument({
      auth: { email: { smtp: { enabled: true, host: "smtp.example.com", port: 25 } } },
    });
    expect(projected.auth?.email?.smtp?.port).toBe(25);
  });

  test("an out-of-range smtp.port (past uint16) is omitted, matching the API arm's own bound", () => {
    const projected = fromConfigDocument({
      auth: { email: { smtp: { enabled: true, host: "smtp.example.com", port: 70_000 } } },
    });
    expect(Object.hasOwn(projected.auth?.email?.smtp ?? {}, "port")).toBe(false);
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

describe("fromConfigDocument — CLI-only field exclusion (CLI-2316)", () => {
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

  test("excludes local ports, db.major_version, and the whole db.pooler/migrations/seed subtrees", () => {
    const document = decodeCliConfig({
      api: { port: 9999, external_url: "http://example.com", max_rows: 42 },
      db: {
        port: 9999,
        shadow_port: 8888,
        health_timeout: "5m",
        major_version: 15,
        pooler: {
          enabled: true,
          port: 7777,
          pool_mode: "session",
          default_pool_size: 5,
          max_client_conn: 50,
        },
        migrations: { enabled: false, schema_paths: ["a.sql"] },
        seed: { enabled: false, sql_paths: ["b.sql"] },
        settings: { max_connections: 5 },
      },
    });

    const projected = fromConfigDocument(document);

    expect(Object.hasOwn(projected.api ?? {}, "port")).toBe(false);
    expect(Object.hasOwn(projected.api ?? {}, "external_url")).toBe(false);
    expect(Object.hasOwn(projected.api ?? {}, "tls")).toBe(false);
    expect(Object.hasOwn(projected.db ?? {}, "port")).toBe(false);
    expect(Object.hasOwn(projected.db ?? {}, "shadow_port")).toBe(false);
    expect(Object.hasOwn(projected.db ?? {}, "health_timeout")).toBe(false);
    expect(Object.hasOwn(projected.db ?? {}, "major_version")).toBe(false);
    expect(Object.hasOwn(projected.db ?? {}, "pooler")).toBe(false);
    expect(Object.hasOwn(projected.db ?? {}, "migrations")).toBe(false);
    expect(Object.hasOwn(projected.db ?? {}, "seed")).toBe(false);
    // Siblings prove the exclusion is targeted, not a section-wide wipe.
    expect(projected.api?.max_rows).toBe(42);
    expect(projected.db?.settings?.max_connections).toBe(5);
  });

  test("excludes the whole realtime section — it survives on neither arm", () => {
    const document = decodeCliConfig({
      realtime: { enabled: false, ip_version: "IPv6", max_header_length: 1 },
    });
    const projected = fromConfigDocument(document);
    // Every config-side `realtime` field is excluded, so — unlike `workers`,
    // which survives as `{}` — the section disappears entirely: it was
    // emptied BY this exclusion, the same prune rule as a secret-stripped
    // section.
    expect(Object.hasOwn(projected, "realtime")).toBe(false);
  });

  test("excludes local-only experimental fields while experimental.webhooks (genuinely pushed) survives", () => {
    const document = decodeCliConfig({
      experimental: {
        orioledb_version: "1.0",
        s3_host: "bucket.s3.example.com",
        s3_region: "us-east-1",
        pgdelta: { enabled: true },
        inspect: { rules: [{ name: "r1" }] },
        webhooks: { enabled: true },
      },
    });
    const projected = fromConfigDocument(document);
    expect(Object.hasOwn(projected.experimental ?? {}, "orioledb_version")).toBe(false);
    expect(Object.hasOwn(projected.experimental ?? {}, "s3_host")).toBe(false);
    expect(Object.hasOwn(projected.experimental ?? {}, "s3_region")).toBe(false);
    expect(Object.hasOwn(projected.experimental ?? {}, "pgdelta")).toBe(false);
    expect(Object.hasOwn(projected.experimental ?? {}, "inspect")).toBe(false);
    expect(projected.experimental?.webhooks).toEqual({ enabled: true });
  });

  test("db.major_version and db.pooler.* still populate from the API arm — only the document arm is silent", () => {
    const documentSide = fromConfigDocument(
      decodeCliConfig({ db: { major_version: 15, pooler: { pool_mode: "session" } } }),
    );
    expect(Object.hasOwn(documentSide.db ?? {}, "major_version")).toBe(false);
    expect(Object.hasOwn(documentSide.db ?? {}, "pooler")).toBe(false);

    const apiSide = fromApiProjectConfig({
      database: { major_version: 17 },
      pooler: { pool_mode: "session", default_pool_size: 15, max_client_conn: 200 },
    });
    expect(apiSide.db?.major_version).toBe(17);
    expect(apiSide.db?.pooler).toEqual({
      pool_mode: "session",
      default_pool_size: 15,
      max_client_conn: 200,
    });
  });

  // Exhaustive counterpart to the hand-picked tests above, iterating
  // `DOCUMENT_ONLY_LOCAL_PATHS` itself rather than a second hand-picked field
  // list. Unlike the x-secret exhaustiveness test just above — which builds
  // its OWN probe programmatically from `secretPathPatterns`, so it can never
  // go vacuous — this probe is still hand-written (`DOCUMENT_ONLY_LOCAL_PATHS`
  // mixes whole-subtree and scalar-leaf entries of different value types, so
  // one generic "put a marker at every path" builder can't populate it the
  // way the all-string x-secret patterns allow). The `toBeDefined` check
  // below on `document` itself is what keeps that hand-written gap from
  // silently rotting: `decodeCliConfig` drops any key the schema doesn't
  // recognize, so a typo in the probe below, or a new
  // `DOCUMENT_ONLY_LOCAL_PATHS` entry the probe forgets to populate, fails
  // loudly here instead of the `toBeUndefined` assertion passing vacuously.
  test("no DOCUMENT_ONLY_LOCAL_PATHS entry survives fromConfigDocument, exhaustively", () => {
    expect(DOCUMENT_ONLY_LOCAL_PATHS.length).toBeGreaterThan(0);

    const document = decodeCliConfig({
      api: {
        port: 1,
        external_url: "http://example.com",
        tls: { enabled: true },
        max_rows: 42,
      },
      db: {
        port: 1,
        shadow_port: 2,
        health_timeout: "5m",
        major_version: 15,
        pooler: { enabled: true },
        migrations: { enabled: false },
        seed: { enabled: false },
        settings: { max_connections: 5 },
      },
      realtime: { enabled: false, ip_version: "IPv6", max_header_length: 1 },
      experimental: {
        orioledb_version: "1.0",
        s3_host: "host",
        s3_region: "region",
        pgdelta: { enabled: true },
        inspect: { rules: [{ name: "r1" }] },
        webhooks: { enabled: true },
      },
    });

    const projected = fromConfigDocument(document);

    for (const path of DOCUMENT_ONLY_LOCAL_PATHS) {
      // The probe actually populated this path — otherwise the assertion
      // below would pass whether or not the exclusion code does anything.
      expect(readAtPath(document, path)).toBeDefined();
      expect(readAtPath(projected, path)).toBeUndefined();
    }

    expect(projected.api?.max_rows).toBe(42);
    expect(projected.db?.settings?.max_connections).toBe(5);
    expect(projected.experimental?.webhooks).toEqual({ enabled: true });
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

  // NaN has no JSON literal — JSON.parse can only ever produce ±Infinity from
  // an overflowing numeral (e.g. `1e400`), never NaN — so a NaN in the raw
  // response can only be programmatic input; the pre-decode walk rejects it
  // with the caller-misuse reason before any row's narrowing runs.
  test("a NaN max_rows is rejected pre-decode as a non-JSON primitive", () => {
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

  // ±Infinity IS JSON-reachable (drift-audit fix, ADR 0019's 2026-08-27
  // addendum) and so passes the pre-decode walk — but on a MAPPED field like
  // `max_rows`, `expectInteger`/`expectNumber`'s own finite check still
  // rejects it, this time with the api_response reason (a platform-response
  // problem, not caller misuse).
  test("an Infinity max_rows decodes past the pre-decode walk but still throws api_response via expectInteger", () => {
    let thrown: unknown;
    try {
      fromApiProjectConfig({ api: { max_rows: Number.POSITIVE_INFINITY } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    // `reason` is absent here — per ProjectConfigParseError's own docstring
    // ("api_response" is the default when absent), that IS the api_response
    // classification, not merely "not caller_misuse".
    expect((thrown as ProjectConfigParseError).reason ?? "api_response").toBe("api_response");
    expect((thrown as ProjectConfigParseError).apiPath).toEqual(["api", "max_rows"]);
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

  // Codex round 31, THREAD B — deliberate, not a gap: a consumed path prunes
  // its WHOLE subtree at apiPath granularity, so a platform-added key nested
  // inside a consumed array's element (here, `comment` on a cidr entry) is
  // never itemized by unmappedApiFields — full fidelity lives in
  // `_apiResponse` instead (unmappedApiFields's own docstring, and the
  // alsoConsumes design comment above consumedApiPathKeys).
  test("an extra key inside a consumed allowed_cidrs entry maps fine, is absent from unmappedApiFields, and survives in _apiResponse", () => {
    const result = fromApiProjectConfig({
      database: {
        network_restrictions: {
          allowed_cidrs: [{ address: "1.2.3.4/32", type: "v4", comment: "office" }],
        },
      },
    });
    // Both allowed_cidrs/allowed_cidrs_v6 rows read this same apiPath and
    // filter by `type` (registry.ts's own `filterCidrAddresses`), so a
    // v4-only entry still produces an (empty) v6 array.
    expect(result.db?.network_restrictions).toEqual({
      allowed_cidrs: ["1.2.3.4/32"],
      allowed_cidrs_v6: [],
    });
    expect(unmappedApiFields(result)).toEqual({});
    expect(result._apiResponse?.["database"]).toEqual({
      network_restrictions: {
        allowed_cidrs: [{ address: "1.2.3.4/32", type: "v4", comment: "office" }],
      },
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
    // `experimental.inspect.rules` was the only schema field shaped as an
    // array of objects (this file's own `copyHostedValueWithoutSecrets`
    // docstring used it as its example) — CLI-2316 excludes the whole
    // `experimental.inspect` subtree as CLI-only, so it can no longer probe
    // this. But `fromConfigDocument` runs no schema validation on its input
    // (see that same docstring), so the object-in-array copy path is still
    // reachable through any surviving array field — `api.schemas` (real
    // schema type `string[]`) is used here as a structurally-typed carrier: a
    // `Record<string, unknown>` operand is assignable to the exported
    // `EffectiveConfig` parameter (every `EffectiveConfig` property is
    // optional, so nothing named on it needs to reconcile against the
    // index-signature type), with no cast, while still reaching this
    // function's fully untyped runtime behavior.
    const element = { nested: "value" };
    const probe: Record<string, unknown> = { api: { schemas: [element] } };
    const projected = fromConfigDocument(probe);
    const copied = projected.api?.schemas?.[0];
    expect(copied).toEqual(element);
    expect(copied).not.toBe(element);
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
    for (const hours of [1e300, 1e22, -1e300, -1e22]) {
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

  test("negative session hours render with their sign, like the legacy apply", () => {
    // auth.sync.ts:1402-1404 renders sessions_timebox: -1 as "-1h0m0s" (the
    // shared durationString prepends the sign), the document schema keeps
    // timebox a plain string, and the push parser reads the leading "-" back
    // (config-sync.duration.ts:101-104) — so a signed hosted value maps
    // instead of throwing.
    expect(fromApiProjectConfig({ auth: { sessions_timebox: -1 } }).auth?.sessions?.timebox).toBe(
      "-1h0m0s",
    );
    expect(
      fromApiProjectConfig({ auth: { sessions_inactivity_timeout: -1.5 } }).auth?.sessions
        ?.inactivity_timeout,
    ).toBe("-1h30m0s");
    // Document-side canonicalization converges on the same spelling.
    const projected = fromConfigDocument({ auth: { sessions: { timebox: "-1h" } } });
    expect(projected.auth?.sessions?.timebox).toBe("-1h0m0s");
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

  test("canonicalization applies the push formatter's h/m sub-second truncation", () => {
    const projected = fromConfigDocument({
      auth: {
        sessions: { timebox: "1h0.5s", inactivity_timeout: "1m0.5s" },
      },
    });
    // The push pipeline normalizes through the truncating legacy formatter
    // (normalizeDurationStr, auth.sync.ts:986-987; config-sync.duration.ts:
    // 39-45) BEFORE durationToHours converts — "1h0.5s" stores exactly one
    // hour, so the canonical document spelling predicts that reading.
    expect(projected.auth?.sessions?.timebox).toBe("1h0m0s");
    expect(projected.auth?.sessions?.inactivity_timeout).toBe("1m0s");
    // Sub-minute magnitudes keep their fraction (legacy seconds branch does).
    const subMinute = fromConfigDocument({ auth: { sessions: { timebox: "59.5s" } } });
    expect(subMinute.auth?.sessions?.timebox).toBe("59.5s");
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
    // Document side: the push-formatter truncation drops the remainder.
    const projected = fromConfigDocument({ auth: { sessions: { timebox: "1h1ns" } } });
    expect(projected.auth?.sessions?.timebox).toBe("1h0m0s");
    // API arm: the Go-faithful formatter renders a hosted sub-second tail
    // fixed-decimal, never exponent notation (1h + 1ns in hours).
    const api = fromApiProjectConfig({ auth: { sessions_timebox: 1 + 1e-9 / 3600 } });
    expect(api.auth?.sessions?.timebox).toBe("1h0m0.000000001s");
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
  // undefined and NaN have no JSON.parse-reachable spelling, so both stay
  // caller-misuse. Drift-audit fix: ±Infinity is JSON-reachable
  // (`JSON.parse('{"x":1e400}')` yields `Infinity`) and was wrongly rejected
  // here too — see the sibling test below.
  test("undefined and NaN raw values throw the typed caller-misuse error", () => {
    for (const bad of [{ x: undefined }, { x: Number.NaN }]) {
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

  test("a ±Infinity raw value on an UNKNOWN field decodes successfully and surfaces as null in unmappedApiFields", () => {
    // 1e400 overflows to Infinity during JSON.parse itself — this is what a
    // real platform payload with a numeric field nothing reads can look like,
    // not a hand-constructed edge case.
    const parsed: { api: { max_rows: number }; brand_new_platform_field: number } = JSON.parse(
      '{"api":{"max_rows":5},"brand_new_platform_field":1e400}',
    );
    expect(parsed.brand_new_platform_field).toBe(Number.POSITIVE_INFINITY);
    const result = fromApiProjectConfig(parsed);
    expect(result.api?.max_rows).toBe(5);
    expect(result._apiResponse?.["brand_new_platform_field"]).toBe(Number.POSITIVE_INFINITY);
    expect(unmappedApiFields(result)).toEqual({ brand_new_platform_field: null });
  });

  test("attachApiResponse also tolerates a ±Infinity raw value — the caller-path counterpart of fromApiProjectConfig's relaxation", () => {
    const parsed: { x: number } = JSON.parse('{"x":1e400}');
    expect(parsed.x).toBe(Number.POSITIVE_INFINITY);
    const result = attachApiResponse({}, parsed);
    expect(result._apiResponse?.["x"]).toBe(Number.POSITIVE_INFINITY);
  });

  test("a bare non-finite scalar at an unmapped path (not nested inside an array) surfaces as null too", () => {
    const parsed: { brand_new_platform_field: number } = JSON.parse(
      '{"brand_new_platform_field":-1e400}',
    );
    expect(parsed.brand_new_platform_field).toBe(Number.NEGATIVE_INFINITY);
    const result = fromApiProjectConfig(parsed);
    expect(unmappedApiFields(result)).toEqual({ brand_new_platform_field: null });
  });

  test("a sub-nanosecond session-hour value truncates to 0s instead of exponent notation", () => {
    const result = fromApiProjectConfig({ auth: { sessions_timebox: 1e-20 } });
    expect(result.auth?.sessions?.timebox).toBe("0s");
  });

  test("the unmapped report is readonly at compile time and an all-finite leaf array keeps the frozen _apiResponse identity", () => {
    const result = fromApiProjectConfig({ brand_new: ["a"] });
    const report = unmappedApiFields(result);
    const leaf = report["brand_new"];
    expect(Array.isArray(leaf)).toBe(true);
    expect(Object.isFrozen(leaf)).toBe(true);
    // No non-finite value anywhere inside — the sanitizing walk must be a
    // no-op and hand back the SAME array `_apiResponse` already holds,
    // rather than a fresh (unfrozen) copy.
    expect(leaf).toBe(result._apiResponse?.["brand_new"]);
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

  // Drift-audit follow-up to Fix 1: `walkUnmapped` returns an unmapped array
  // leaf wholesale (never walked element-by-element the way an object is),
  // so a non-finite number hiding inside one — even nested inside a plain
  // object inside the array — would otherwise reach `unmappedApiFields`'s
  // return unsanitized and violate its own ReadonlyJsonValue contract.
  test("a non-finite number hiding inside an unmapped array leaf (including nested in an object) surfaces as null via a sanitized copy", () => {
    const parsed: { brand_new: ReadonlyArray<unknown> } = JSON.parse(
      '{"brand_new":[1e400,{"x":-1e400,"y":1}]}',
    );
    expect(parsed.brand_new[0]).toBe(Number.POSITIVE_INFINITY);
    const result = fromApiProjectConfig(parsed);
    const report = unmappedApiFields(result);
    expect(report["brand_new"]).toEqual([null, { x: null, y: 1 }]);
    // Sanitizing produces a FRESH copy — unlike the all-finite case above,
    // this is no longer the shared frozen `_apiResponse` reference.
    expect(report["brand_new"]).not.toBe(result._apiResponse?.["brand_new"]);
  });

  // Codex round 31, THREAD C — unmappedApiFields must guard its own input
  // boundary the same way the other public entry points do (toProjectConfig,
  // attachApiResponse), rather than reading `config._apiResponse` directly
  // and leaking a raw TypeError/Error past this package's typed contract.
  test("a non-object operand throws the typed caller-misuse error", () => {
    let thrown: unknown;
    try {
      unmappedApiFields(null as unknown as ProjectConfig);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).reason).toBe("caller_misuse");
  });

  test("an object with a throwing _apiResponse getter throws the typed caller-misuse error, wrapping the accessor error", () => {
    const poisoned: ProjectConfig = Object.defineProperty({}, "_apiResponse", {
      get(): never {
        throw new Error("boom");
      },
      enumerable: true,
      configurable: true,
    });
    let thrown: unknown;
    try {
      unmappedApiFields(poisoned);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).reason).toBe("caller_misuse");
    expect((thrown as ProjectConfigParseError).cause).toBeInstanceOf(Error);
    expect(((thrown as ProjectConfigParseError).cause as Error).message).toBe("boom");
  });

  test("a plain object without _apiResponse still returns an empty report", () => {
    expect(unmappedApiFields({})).toEqual({});
  });

  test("document frequency durations quantize to whole seconds like the legacy push", () => {
    const projected = fromConfigDocument({ auth: { email: { max_frequency: "1.5s" } } });
    // auth.sync.ts:2611-2616 floors to integer seconds on push — the hosted
    // value can only ever be whole seconds, so the document converges on it.
    expect(projected.auth?.email?.max_frequency).toBe("1s");
    // Session durations quantize through the push formatter's h/m
    // truncation instead (normalizeDurationStr runs before durationToHours).
    const sessions = fromConfigDocument({ auth: { sessions: { timebox: "1h0.5s" } } });
    expect(sessions.auth?.sessions?.timebox).toBe("1h0m0s");
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

  test("the Greek small mu spelling stays verbatim (the push parser rejects it)", () => {
    // Go accepts U+03BC, but the push parser takes only us/µs
    // (config-sync.duration.ts:134) — canonicalizing "1μs" into a pushable
    // spelling would fabricate a reading the pipeline never performs.
    const projected = fromConfigDocument({ auth: { sessions: { timebox: "1μs" } } });
    expect(projected.auth?.sessions?.timebox).toBe("1μs");
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

  // Three-state fix (drift audit of CLI-2230/PR #6339): an ABSENT smtp_host
  // says nothing about SMTP status — unlike the explicit "" sentinel above,
  // it must not suppress the siblings. Mirrors smsProviderExplicitlyUnset's
  // own absent-vs-sentinel rule a few rows below in registry-auth.ts.
  test("SMTP siblings map normally when smtp_host is ABSENT, not explicitly disabled", () => {
    const sparse = fromApiProjectConfig({
      auth: { smtp_user: "postmaster", smtp_admin_email: "a@b.c" },
    });
    expect(sparse.auth?.email?.smtp).toEqual({
      user: "postmaster",
      admin_email: "a@b.c",
    });
    expect(unmappedApiFields(sparse)).toEqual({});
  });

  // Thread 3 (human review round on PR #6339): storageToUpdateBody only
  // emits Iceberg/Vector inside a truthy `if (local.analytics.enabled)`
  // branch (storage.sync.ts:287-300) — a disabled container is push-
  // unmanaged, not confirmed-off, so the DOCUMENT arm omits it entirely
  // rather than projecting `{enabled: false}`. The API arm is unaffected:
  // its own `{enabled: false}` reflects real hosted state GoTrue reports.
  test("a disabled storage.analytics/vector container is omitted entirely on the document arm, but the API arm still projects its toggle", () => {
    const projected = fromConfigDocument({
      storage: {
        analytics: { enabled: false, max_tables: 10 },
        vector: { enabled: false, max_buckets: 5 },
      },
    });
    expect(Object.hasOwn(projected.storage ?? {}, "analytics")).toBe(false);
    expect(Object.hasOwn(projected.storage ?? {}, "vector")).toBe(false);

    const enabledDoc = fromConfigDocument({
      storage: { analytics: { enabled: true, max_tables: 10, max_namespaces: 1, max_catalogs: 1 } },
    });
    expect(enabledDoc.storage?.analytics).toEqual({
      enabled: true,
      max_tables: 10,
      max_namespaces: 1,
      max_catalogs: 1,
    });

    const api = fromApiProjectConfig({
      storage: { features: { iceberg_catalog: { enabled: false, max_tables: 10 } } },
    });
    expect(api.storage?.analytics).toEqual({ enabled: false });
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

  test("null gating discriminators read as disabled and still prune their siblings", () => {
    // The GET contract permits null for these booleans, and the legacy
    // reconciliation reads a null discriminator as disabled (auth.sync.ts:
    // 1315 captcha, :1336 hooks, :1789 external providers) — so the gated
    // rows map null to false, letting the sentinel sweep prune the retained
    // siblings instead of projecting them with no `enabled` key.
    const result = fromApiProjectConfig({
      auth: {
        external_github_enabled: null,
        external_github_client_id: "retained-id",
        hook_send_email_enabled: null,
        hook_send_email_uri: "https://retained.example.com",
        security_captcha_enabled: null,
        security_captcha_provider: "hcaptcha",
      },
    });
    expect(result.auth?.external?.github).toEqual({ enabled: false });
    expect(result.auth?.hook?.send_email).toEqual({ enabled: false });
    expect(result.auth?.captcha).toEqual({ enabled: false });
    // Validation still runs before the null→false gate maps.
    expect(() =>
      fromApiProjectConfig({
        auth: { external_github_enabled: null, external_github_client_id: 5 },
      }),
    ).toThrow(ProjectConfigParseError);
    // Non-gating nullable booleans keep the null-skip convention.
    const nonGating = fromApiProjectConfig({ auth: { mfa_totp_enroll_enabled: null } });
    expect(Object.hasOwn(nonGating, "auth")).toBe(false);
    // A true discriminator still projects its siblings unchanged.
    const enabled = fromApiProjectConfig({
      auth: { external_github_enabled: true, external_github_client_id: "live-id" },
    });
    expect(enabled.auth?.external?.github).toEqual({ enabled: true, client_id: "live-id" });
  });

  test("CSV-backed arrays canonicalize to their push round-trip on the document side", () => {
    // The push mapper joins these arrays with "," (auth.sync.ts:2294,
    // api.sync.ts:138,140) and the pull direction re-splits, so an element
    // holding a literal comma round-trips into a different array — the
    // document projection converges on the value that actually exists hosted.
    const doc = fromConfigDocument({
      api: { schemas: ["public,graphql_public"], extra_search_path: [" public", "extensions "] },
      auth: { additional_redirect_urls: ["https://example.com/callback?a=1,2"] },
    });
    expect(doc.api?.schemas).toEqual(["public", "graphql_public"]);
    expect(doc.api?.extra_search_path).toEqual(["public", "extensions"]);
    expect(doc.auth?.additional_redirect_urls).toEqual(["https://example.com/callback?a=1", "2"]);
    // The API arm produces the identical shape for the post-push value.
    const api = fromApiProjectConfig({
      auth: { uri_allow_list: "https://example.com/callback?a=1,2" },
    });
    expect(api.auth?.additional_redirect_urls).toEqual(doc.auth?.additional_redirect_urls);
    // Comma-free arrays pass through unchanged.
    const plain = fromConfigDocument({ api: { schemas: ["public", "storage"] } });
    expect(plain.api?.schemas).toEqual(["public", "storage"]);
  });

  test("an explicitly-unset SMS provider omits retained credentials entirely", () => {
    // Legacy touches neither the flags nor the credentials on a null/empty
    // sms_provider (auth.sync.ts:1664-1666, :1574-1655) — so nothing about
    // the providers projects: no fabricated enabled flags, no retained
    // credentials surviving as unmanaged phantom entries.
    const nullProvider = fromApiProjectConfig({
      auth: { sms_provider: null, sms_messagebird_originator: "retained" },
    });
    expect(Object.hasOwn(nullProvider, "auth")).toBe(false);
    const emptyProvider = fromApiProjectConfig({
      auth: { sms_provider: "", sms_twilio_account_sid: "AC1" },
    });
    expect(Object.hasOwn(emptyProvider, "auth")).toBe(false);
    // An ABSENT provider key says nothing — the credential still maps.
    const absentProvider = fromApiProjectConfig({
      auth: { sms_messagebird_originator: "retained" },
    });
    expect(absentProvider.auth?.sms?.messagebird).toEqual({ originator: "retained" });
    // A named provider keeps the inactive-provider sweep unchanged.
    const named = fromApiProjectConfig({
      auth: {
        sms_provider: "twilio",
        sms_twilio_account_sid: "AC1",
        sms_messagebird_originator: "x",
      },
    });
    expect(named.auth?.sms?.twilio).toEqual({ enabled: true, account_sid: "AC1" });
    expect(named.auth?.sms?.messagebird).toEqual({ enabled: false });
    // Validation still runs before the gate.
    expect(() =>
      fromApiProjectConfig({ auth: { sms_provider: null, sms_messagebird_originator: 42 } }),
    ).toThrow(ProjectConfigParseError);
  });

  test("the sessions floor includes int64's own minimum, asymmetrically", () => {
    // -2^63 ns IS a valid Go duration (the int64 minimum); its hours spelling
    // rounds back to exactly -2^63 through magnitude-then-sign. The next
    // more-negative float already products past 2^63, and the POSITIVE
    // mirror of the endpoint stays rejected (+2^63 is one past max int64).
    const endpoint = fromApiProjectConfig({
      auth: { sessions_timebox: -(2 ** 63) / 3_600_000_000_000 },
    });
    expect(endpoint.auth?.sessions?.timebox).toBe("-2562047h47m16.854775808s");
    for (const hours of [-2562047.788015216, 2562047.7880152157]) {
      expect(() => fromApiProjectConfig({ auth: { sessions_timebox: hours } })).toThrow(
        ProjectConfigParseError,
      );
    }
  });

  test("test_otp records canonicalize to their push round-trip on the document side", () => {
    // The push wrapper serializes k=v pairs joined by commas (mapToEnv,
    // auth.sync.ts:2603-2609) and the pull direction re-parses by splitting
    // on every comma — a value holding a literal comma converges on the
    // post-push hosted record.
    const doc = fromConfigDocument({
      auth: { sms: { test_otp: { "15551234567": "123,456" } } },
    });
    expect(doc.auth?.sms?.test_otp).toEqual({ "15551234567": "123" });
    // The API arm produces the identical record for the post-push value.
    const api = fromApiProjectConfig({ auth: { sms_test_otp: "15551234567=123,456" } });
    expect(api.auth?.sms?.test_otp).toEqual(doc.auth?.sms?.test_otp);
    // Comma-free records pass through unchanged.
    const plain = fromConfigDocument({
      auth: { sms: { test_otp: { "15551234567": "123456" } } },
    });
    expect(plain.auth?.sms?.test_otp).toEqual({ "15551234567": "123456" });
  });

  test("throwing envelope accessors surface as caller misuse, not raw errors", () => {
    const cases: Array<Record<string, unknown>> = [
      {
        get data(): unknown {
          throw new Error("boom");
        },
      },
      {
        data: {
          type: "project_config",
          get attributes(): unknown {
            throw new Error("boom");
          },
        },
      },
      {
        type: "project_config",
        get attributes(): unknown {
          throw new Error("boom");
        },
      },
      {
        data: {
          get type(): unknown {
            throw new Error("boom");
          },
          attributes: {},
        },
      },
    ];
    for (const input of cases) {
      let thrown: unknown;
      try {
        fromApiProjectConfig(input);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ProjectConfigParseError);
      expect((thrown as ProjectConfigParseError).reason).toBe("caller_misuse");
    }
  });

  test("an empty test_otp map normalizes to unmanaged absence", () => {
    // The push wrapper omits sms_test_otp when the serialized map is empty
    // (auth.sync.ts:2487-2495), so an explicit {} can never clear a retained
    // remote value — projecting it would fabricate permanent drift.
    const empty = fromConfigDocument({ auth: { sms: { test_otp: {} } } });
    expect(Object.hasOwn(empty, "auth")).toBe(false);
    // A record whose entries all dissolve in the round-trip empties too.
    const dissolved = fromConfigDocument({ auth: { sms: { test_otp: { ",": "x" } } } });
    expect(Object.hasOwn(dissolved, "auth")).toBe(false);
    // Siblings survive the pruned leaf.
    const withSibling = fromConfigDocument({
      auth: { sms: { test_otp: {}, enable_signup: true } },
    });
    expect(withSibling.auth?.sms).toEqual({ enable_signup: true });
  });

  test("descendants of mapped container paths are comparable", () => {
    // sms.test_otp maps a record, so leaf-path traversals produce entry-level
    // paths — exactly as comparable as the mapped container itself.
    expect(isComparableProjectConfigPath(["auth", "sms", "test_otp"])).toBe(true);
    expect(isComparableProjectConfigPath(["auth", "sms", "test_otp", "15551234567"])).toBe(true);
    // A bare prefix names a section, not a mapped value.
    expect(isComparableProjectConfigPath(["auth", "sms"])).toBe(false);
    expect(isComparableProjectConfigPath(["auth", "sms", "nope"])).toBe(false);
  });

  test("the document parser rejects the positive int64 endpoint the API arm rejects", () => {
    // +2^63 ns is one past Go's maximum; a non-canonical spelling summing to
    // exactly 2^63 stays verbatim instead of canonicalizing into a duration
    // fromApiProjectConfig would reject.
    const positive = fromConfigDocument({
      auth: { sessions: { timebox: "2562047h47m16s854775808ns" } },
    });
    expect(positive.auth?.sessions?.timebox).toBe("2562047h47m16s854775808ns");
    // The negative endpoint IS valid int64 and still canonicalizes.
    const negative = fromConfigDocument({
      auth: { sessions: { timebox: "-2562047h47m16s854775808ns" } },
    });
    // The push-formatter truncation drops the sub-second tail on the
    // document side; the API arm's faithful endpoint render is pinned above.
    expect(negative.auth?.sessions?.timebox).toBe("-2562047h47m16s");
  });

  test("multiple enabled SMS providers converge on the push switch's first-enabled precedence", () => {
    // The push switch selects the FIRST enabled provider in its fixed order
    // and sends only that one (auth.sync.ts:2498-2539) — later enabled flags
    // flip to false and their siblings prune, matching the API arm's report
    // of the post-push hosted state.
    const doc = fromConfigDocument({
      auth: {
        sms: {
          twilio: { enabled: true, account_sid: "AC1" },
          messagebird: { enabled: true, originator: "x" },
        },
      },
    });
    expect(doc.auth?.sms?.twilio).toEqual({ enabled: true, account_sid: "AC1" });
    expect(doc.auth?.sms?.messagebird).toEqual({ enabled: false });
    // Cross-arm equality for that post-push hosted state.
    const api = fromApiProjectConfig({
      auth: {
        sms_provider: "twilio",
        sms_twilio_account_sid: "AC1",
        sms_messagebird_originator: "x",
      },
    });
    expect(api.auth?.sms?.twilio).toEqual(doc.auth?.sms?.twilio);
    expect(api.auth?.sms?.messagebird).toEqual(doc.auth?.sms?.messagebird);
    // A single enabled provider is untouched.
    const single = fromConfigDocument({
      auth: { sms: { vonage: { enabled: true, from: "+1555" } } },
    });
    expect(single.auth?.sms?.vonage).toEqual({ enabled: true, from: "+1555" });
  });

  test("negative unsigned-style document values clamp like the pull direction", () => {
    // The push mapper sends the local value unchanged (auth.sync.ts:
    // 2304-2309) and the pull direction clamps what the API reports — a
    // pushed -1 projects back as 0, so the document spelling converges.
    // `api.max_rows` is the one exception (thread 2, human review round on
    // PR #6339): push OMITS max_rows entirely when non-positive
    // (api.sync.ts:141), so the document arm omits rather than clamps —
    // see the dedicated max_rows tests below for the full omit/keep matrix.
    const doc = fromConfigDocument({
      auth: { rate_limit: { anonymous_users: -1 } },
      api: { enabled: true, max_rows: -5 },
      storage: { analytics: { enabled: true, max_tables: -3 } },
    });
    expect(doc.auth?.rate_limit?.anonymous_users).toBe(0);
    expect(Object.hasOwn(doc.api ?? {}, "max_rows")).toBe(false);
    expect(doc.storage?.analytics?.max_tables).toBe(0);
    const api = fromApiProjectConfig({ auth: { rate_limit_anonymous_users: -1 } });
    expect(api.auth?.rate_limit?.anonymous_users).toBe(0);
    // Positive values stay verbatim.
    const positive = fromConfigDocument({ auth: { rate_limit: { anonymous_users: 30 } } });
    expect(positive.auth?.rate_limit?.anonymous_users).toBe(30);
  });

  // Thread 2 (human review round on PR #6339): api.sync.ts:141 only sends
  // max_rows when strictly positive — the document arm mirrors that by
  // omitting rather than clamping. The API arm is unaffected (hosted `0` is
  // real, reported state).
  test.each([
    ["0", 0],
    ["-0", -0],
    ["negative", -5],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    // TOML's `nan` literal is a real reachable document value here —
    // `smol-toml` (this package's TOML parser, `io.ts`) parses
    // `max_rows = nan` to `Number.NaN` — and `NaN <= 0` is `false`, which
    // would have let a NaN slip past a naive non-positive check (engineer
    // review round on PR #6339): `!(value > 0)` catches it because
    // `NaN > 0` is also `false`.
    ["NaN", Number.NaN],
  ])("api.max_rows: %s is omitted on the document arm", (_description, value) => {
    const doc = fromConfigDocument({ api: { enabled: true, max_rows: value } });
    expect(Object.hasOwn(doc.api ?? {}, "max_rows")).toBe(false);
  });

  test.each([
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a fraction", 0.5],
    ["a whole positive", 100],
  ])("api.max_rows: %s is kept on the document arm", (_description, value) => {
    const doc = fromConfigDocument({ api: { enabled: true, max_rows: value } });
    expect(doc.api?.max_rows).toBe(value);
  });

  test("api.max_rows: 0 is still reported on the API arm (real hosted state)", () => {
    const api = fromApiProjectConfig({ api: { db_schema: "public", max_rows: 0 } });
    expect(api.api?.max_rows).toBe(0);
  });

  test("throwing dispatcher source accessors surface as caller misuse", () => {
    const cases: ReadonlyArray<Parameters<typeof toProjectConfig>[0]> = [
      {
        get apiResponse(): unknown {
          throw new Error("boom");
        },
      },
      {
        get cliConfig(): EffectiveConfig {
          throw new Error("boom");
        },
      },
      // The toProjectConfig-nested variant (engineer review round on PR
      // #6339, item 2): the dispatcher's own `cliConfig` read succeeds fine
      // (it just returns this plain object reference) — the throw happens
      // one level deeper, inside fromConfigDocument's own { config,
      // document } unwrapping, which used to read `input["config"]"`/
      // `input["document"]` unguarded.
      {
        cliConfig: {
          get config(): EffectiveConfig {
            throw new Error("boom");
          },
        },
      },
    ];
    for (const source of cases) {
      let thrown: unknown;
      try {
        toProjectConfig(source);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ProjectConfigParseError);
      expect((thrown as ProjectConfigParseError).reason).toBe("caller_misuse");
    }
  });

  // Direct fromConfigDocument calls (not routed through the toProjectConfig
  // dispatcher above) — engineer review round on PR #6339, item 2: both the
  // "config" and "document" properties of the { config, document } pair
  // shape must be read through the same guarded boundary as every other
  // accessor-backed operand this file handles.
  test("a throwing config or document getter on the { config, document } pair surfaces as caller misuse", () => {
    const throwingConfig = {
      get config(): EffectiveConfig {
        throw new Error("boom");
      },
    };
    let configThrown: unknown;
    try {
      fromConfigDocument(throwingConfig);
    } catch (error) {
      configThrown = error;
    }
    expect(configThrown).toBeInstanceOf(ProjectConfigParseError);
    expect((configThrown as ProjectConfigParseError).reason).toBe("caller_misuse");

    const throwingDocument = {
      config: {},
      get document(): Record<string, unknown> {
        throw new Error("boom");
      },
    };
    let documentThrown: unknown;
    try {
      fromConfigDocument(throwingDocument);
    } catch (error) {
      documentThrown = error;
    }
    expect(documentThrown).toBeInstanceOf(ProjectConfigParseError);
    expect((documentThrown as ProjectConfigParseError).reason).toBe("caller_misuse");
  });

  test("an explicitly empty schemas array normalizes to unmanaged absence", () => {
    // Push only sends db_schema when the array is non-empty (api.sync.ts:
    // 137-139, "" being the disable sentinel), and the pull side reads ""
    // as disabled — the API arm can never project [], so keeping it would
    // fabricate permanent drift.
    const empty = fromConfigDocument({ api: { enabled: true, schemas: [] } });
    expect(empty.api?.schemas).toBeUndefined();
    expect(empty.api?.enabled).toBe(true);
    // extra_search_path differs: its push join is unconditional, so its
    // empty array round-trips ("" → []) and stays declared.
    const search = fromConfigDocument({ api: { enabled: true, extra_search_path: [] } });
    expect(search.api?.extra_search_path).toEqual([]);
  });

  test("a throwing enumerable config getter surfaces as caller misuse on attach", () => {
    const props: Record<string, unknown> = {
      get api(): unknown {
        throw new Error("boom");
      },
    };
    let thrown: unknown;
    try {
      attachApiResponse(props, { api: { max_rows: 100 } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).reason).toBe("caller_misuse");
  });

  test("sub-minute fractional seconds quantize to the push formatter's toPrecision(10)", () => {
    // The legacy seconds branch renders toPrecision(10) (config-sync.
    // duration.ts:47-55) — "59.123456789s" pushes as "59.12345679s", so the
    // canonical document spelling predicts that reading.
    const doc = fromConfigDocument({ auth: { sessions: { timebox: "59.123456789s" } } });
    expect(doc.auth?.sessions?.timebox).toBe("59.12345679s");
    // Cross-arm equality for the post-push hosted value.
    const api = fromApiProjectConfig({ auth: { sessions_timebox: 59.12345679 / 3600 } });
    expect(api.auth?.sessions?.timebox).toBe(doc.auth?.sessions?.timebox);
    // Nine or fewer significant digits pass through unchanged.
    const short = fromConfigDocument({ auth: { sessions: { timebox: "59.5s" } } });
    expect(short.auth?.sessions?.timebox).toBe("59.5s");
    // Below one second the two formatters' branches are identical.
    const subSecond = fromConfigDocument({ auth: { sessions: { timebox: "999.999999ms" } } });
    expect(subSecond.auth?.sessions?.timebox).toBe("999.999999ms");
  });

  test("throwing hosted-section getters surface as caller misuse in fromConfigDocument", () => {
    const topLevel: EffectiveConfig = {
      get auth(): EffectiveConfig["auth"] {
        throw new Error("boom");
      },
    };
    const nested: EffectiveConfig = {
      auth: {
        get site_url(): string {
          throw new Error("boom");
        },
      },
    };
    for (const config of [topLevel, nested]) {
      let thrown: unknown;
      try {
        fromConfigDocument(config);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ProjectConfigParseError);
      expect((thrown as ProjectConfigParseError).reason).toBe("caller_misuse");
    }
  });

  test("session canonicalization rides the push payload's hours round-trip", () => {
    // Sessions travel as fractional hours (durationToHours = parse / 3.6e12,
    // auth.sync.ts:2621-2627) and map back via Math.round(|hours| * 3.6e12) —
    // "1024h4s" comes back one nanosecond high, so the canonical document
    // spelling predicts that exact post-push reading.
    const doc = fromConfigDocument({ auth: { sessions: { timebox: "1024h4s" } } });
    expect(doc.auth?.sessions?.timebox).toBe("1024h0m4.000000001s");
    // Cross-arm equality with the hosted hours value the push would store.
    const api = fromApiProjectConfig({
      auth: { sessions_timebox: 3_686_404_000_000_000 / 3_600_000_000_000 },
    });
    expect(api.auth?.sessions?.timebox).toBe(doc.auth?.sessions?.timebox);
    // Values whose hours trip is exact stay untouched.
    const exact = fromConfigDocument({ auth: { sessions: { timebox: "8760h30m" } } });
    expect(exact.auth?.sessions?.timebox).toBe("8760h30m0s");
  });

  test("orphan secret paths validate like isSecret rows before being suppressed", () => {
    // The four unmappedSecretApiPaths are in the consumed set, so without
    // validation a contract-invalid value (string-or-null only) would vanish
    // completely — never emitted AND hidden from unmappedApiFields.
    let thrown: unknown;
    try {
      fromApiProjectConfig({ auth: { external_slack_secret: 123 } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProjectConfigParseError);
    expect((thrown as ProjectConfigParseError).apiPath).toEqual(["auth", "external_slack_secret"]);
    // String and null values stay silently suppressed, like isSecret rows.
    const ok = fromApiProjectConfig({
      auth: { external_slack_secret: "hmac-digest", nimbus_oauth_client_secret: null },
    });
    expect(Object.hasOwn(ok, "auth")).toBe(false);
  });

  test("documents with auth or storage disabled project only the toggle", () => {
    const projected = fromConfigDocument({
      auth: { enabled: false, site_url: "http://localhost:3000" },
      storage: { enabled: false, file_size_limit: "50MiB" },
    });
    expect(projected.auth).toEqual({ enabled: false });
    expect(projected.storage).toEqual({ enabled: false });
  });

  test("the email rate limit is pruned only on an EXPLICIT smtp.enabled === false, never on absence", () => {
    // Document arm: a real document is fully defaulted (`smtp.enabled` is
    // always present, true or false), so an explicit disable is what this
    // fixture spells out.
    const doc = fromConfigDocument({
      auth: { email: { smtp: { enabled: false } }, rate_limit: { email_sent: 30, sms_sent: 30 } },
    });
    expect(doc.auth?.rate_limit).toEqual({ sms_sent: 30 });

    // API arm, smtp_host ABSENT: says nothing (same sibling rule as the SMTP
    // three-state fix) — email_sent must NOT be pruned.
    const apiAbsent = fromApiProjectConfig({
      auth: { smtp_user: "u", smtp_admin_email: "a@b.c", rate_limit_email_sent: 5 },
    });
    expect(apiAbsent.auth?.rate_limit).toEqual({ email_sent: 5 });

    // API arm, smtp_host EXPLICITLY "" (disabled sentinel): still pruned.
    const apiDisabled = fromApiProjectConfig({
      auth: { smtp_host: "", rate_limit_email_sent: 30 },
    });
    expect(apiDisabled.auth?.rate_limit).toBeUndefined();

    // API arm, smtp_host present and non-empty: keeps mapping normally.
    const apiWithSmtp = fromApiProjectConfig({
      auth: { smtp_host: "smtp.example.com", rate_limit_email_sent: 30 },
    });
    expect(apiWithSmtp.auth?.rate_limit).toEqual({ email_sent: 30 });
  });
});

describe("review round: oauth_server disabled sentinel (CLI-2230)", () => {
  test("a disabled OAuth server projects only its toggle on the API arm (real hosted state)", () => {
    const api = fromApiProjectConfig({
      auth: { oauth_server_enabled: false, oauth_server_authorization_path: "/stale" },
    });
    expect(api.auth?.oauth_server).toEqual({ enabled: false });
  });

  // Thread 3 (human review round on PR #6339): authToUpdateBody has NO
  // oauth_server handling at all, so the whole subtree is unconditionally
  // unmanaged by push — the document arm omits it entirely, regardless of
  // `enabled`, superseding the round-17 disabled-sentinel treatment that
  // used to keep `{enabled: false}` here.
  test("auth.oauth_server is omitted entirely on the document arm, enabled or not", () => {
    const disabled = fromConfigDocument({
      auth: { oauth_server: { enabled: false, authorization_url_path: "/stale" } },
    });
    expect(Object.hasOwn(disabled.auth ?? {}, "oauth_server")).toBe(false);
    const enabledDoc = fromConfigDocument({
      auth: { oauth_server: { enabled: true, allow_dynamic_registration: true } },
    });
    expect(Object.hasOwn(enabledDoc.auth ?? {}, "oauth_server")).toBe(false);
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

describe("fromConfigDocument — raw-presence masking (CliConfigWithRawPresence, thread 1, human review round on PR #6339)", () => {
  // Engineer review round on PR #6339, item 6: pins the collision
  // `unwrapConfigDocumentSource`'s shape-sniffing relies on — no top-level
  // `CliConfig` field is literally named "config" or "document", so a real
  // decoded document can never be misread as the { config, document } pair
  // shape. A future top-level `[config]`/`[document]` section would
  // silently reroute every bare-operand call into the pair arm; this test
  // fails loudly the moment one is added, rather than the collision
  // surfacing as a confusing runtime misread.
  test("no top-level CliConfig field is named config or document (the shape-sniffing collision this relies on)", () => {
    const topLevelKeys = Object.keys(CliConfigSchema.fields);
    expect(topLevelKeys).not.toContain("config");
    expect(topLevelKeys).not.toContain("document");
  });

  test("without a document, decode-materialized defaults leak through (the presence-relativity limit ADR 0021 documents)", () => {
    const config = decodeCliConfig({});
    const projected = fromConfigDocument(config);
    // All 19 providers present with their schema-defaulted shape — this is
    // exactly the limit CliConfigWithRawPresence exists to close.
    expect(Object.keys(projected.auth?.external ?? {}).length).toBeGreaterThan(1);
  });

  test("a raw-absent provider is omitted once document is supplied; apple always survives; a raw-present provider keeps its decoded value", () => {
    const document = {
      auth: { external: { google: { enabled: true, client_id: "google-client" } } },
    };
    const config = decodeCliConfig(document);
    const projected = fromConfigDocument({ config, document });
    expect(Object.keys(projected.auth?.external ?? {}).sort()).toEqual(["apple", "google"]);
    // Declared with only client_id — the rest still comes from the DECODED
    // schema-defaulted shape, masking only decides presence, not values.
    expect(projected.auth?.external?.google).toEqual(config.auth.external.google);
    // Apple is schema-defaulted `enabled: false` here (never raw-declared),
    // so the pre-existing disabled-sentinel sweep (unrelated to presence
    // masking) still prunes its siblings down to the toggle alone — apple
    // "always sent" means always PRESENT, not exempt from that sweep.
    expect(projected.auth?.external?.apple).toEqual({ enabled: false });
  });

  test("raw-absent auth.captcha is omitted with a document, present (schema-defaulted) without one", () => {
    const document = {};
    const config = decodeCliConfig(document);
    expect(fromConfigDocument(config).auth?.captcha).toBeDefined();
    const projected = fromConfigDocument({ config, document });
    expect(Object.hasOwn(projected.auth ?? {}, "captcha")).toBe(false);
  });

  // Engineer review round on PR #6339, item 3: an own key set to an
  // EXPLICIT `undefined` must read as absent, matching `legacyPresenceIn`'s
  // own `x?.["key"] !== undefined` predicate exactly (a value comparison,
  // not `Object.hasOwn`) — the degenerate case a naive `Object.hasOwn`
  // check would get wrong.
  test("an own key set to explicit undefined reads as absent, same as omitted entirely", () => {
    // `document` need not itself be schema-decodable — it's the raw
    // presence signal, independent of `config` — so this deliberately
    // malformed-looking `{ captcha: undefined }` shape is paired with an
    // ordinary fully-defaulted decoded config instead of decoding itself.
    const document = { auth: { captcha: undefined } };
    expect(Object.hasOwn(document.auth, "captcha")).toBe(true);
    const config = decodeCliConfig({});
    const projected = fromConfigDocument({ config, document });
    expect(Object.hasOwn(projected.auth ?? {}, "captcha")).toBe(false);
  });

  test("each raw-absent auth.hook.<name> is omitted; a raw-present one survives with its decoded value", () => {
    const document = {
      auth: { hook: { send_email: { enabled: true, uri: "https://example.com/hook" } } },
    };
    const config = decodeCliConfig(document);
    const projected = fromConfigDocument({ config, document });
    expect(Object.keys(projected.auth?.hook ?? {})).toEqual(["send_email"]);
    expect(projected.auth?.hook?.send_email).toEqual({
      enabled: true,
      uri: "https://example.com/hook",
    });
  });

  test("raw-absent auth.email.smtp omits the smtp block AND auth.rate_limit.email_sent, but keeps email_sent's siblings", () => {
    const document = {};
    const config = decodeCliConfig(document);
    const projected = fromConfigDocument({ config, document });
    expect(Object.hasOwn(projected.auth?.email ?? {}, "smtp")).toBe(false);
    expect(Object.hasOwn(projected.auth?.rate_limit ?? {}, "email_sent")).toBe(false);
    expect(projected.auth?.rate_limit?.sms_sent).toBe(config.auth.rate_limit.sms_sent);
  });

  test("raw-absent db.ssl_enforcement / storage.image_transformation / storage.s3_protocol are omitted", () => {
    const document = {};
    const config = decodeCliConfig(document);
    const projected = fromConfigDocument({ config, document });
    expect(Object.hasOwn(projected.db ?? {}, "ssl_enforcement")).toBe(false);
    expect(Object.hasOwn(projected.storage ?? {}, "image_transformation")).toBe(false);
    expect(Object.hasOwn(projected.storage ?? {}, "s3_protocol")).toBe(false);
  });

  test("a raw-present db.ssl_enforcement / storage.image_transformation / storage.s3_protocol survives with its decoded value", () => {
    const document = {
      db: { ssl_enforcement: { enabled: true } },
      storage: { image_transformation: { enabled: true }, s3_protocol: { enabled: false } },
    };
    const config = decodeCliConfig(document);
    const projected = fromConfigDocument({ config, document });
    expect(projected.db?.ssl_enforcement).toEqual({ enabled: true });
    expect(projected.storage?.image_transformation).toEqual({ enabled: true });
    expect(projected.storage?.s3_protocol).toEqual({ enabled: false });
  });

  test("a LoadedCliConfig value is accepted directly, without a cast", () => {
    const document = { api: { max_rows: 5 } };
    const config = decodeCliConfig(document);
    const loaded: LoadedCliConfig = {
      path: "supabase/config.toml",
      format: "toml",
      config,
      document,
      ignoredPaths: [],
    };
    // No `as` cast anywhere above or below — this is the compile-time half
    // of "LoadedCliConfig is structurally assignable without a cast".
    const projected = fromConfigDocument(loaded);
    expect(projected.api?.max_rows).toBe(5);
  });

  test("toProjectConfig({ cliConfig: loaded }) applies the same masking through the dispatcher", () => {
    const document = {};
    const config = decodeCliConfig(document);
    const projected = toProjectConfig({ cliConfig: { config, document } });
    expect(Object.hasOwn(projected.auth ?? {}, "captcha")).toBe(false);
  });

  // Engineer review round on PR #6339, item 4: absent/explicit-undefined
  // `document` is legal (no masking, asserted elsewhere in this file); a
  // PRESENT but non-object `document` is a different, caller-error case —
  // silently disabling masking with no signal would be asymmetric with the
  // throwing guard `config` already gets.
  test.each([
    ["null", null],
    ["a string", "oops"],
    ["an array", []],
  ])(
    "a present but non-object document (%s) throws the typed caller-misuse error",
    (_description, document) => {
      const config = decodeCliConfig({});
      let thrown: unknown;
      try {
        // A JavaScript caller can hand a non-object `document` despite the
        // compile-time type — same rationale as this file's other
        // `as unknown as` runtime-misuse pins (e.g. `unmappedApiFields(null as
        // unknown as ProjectConfig)` above).
        fromConfigDocument({ config, document } as unknown as EffectiveConfig);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ProjectConfigParseError);
      expect((thrown as ProjectConfigParseError).reason).toBe("caller_misuse");
    },
  );

  test("saveCliConfig's LoadedCliConfig shape (no document field at all) falls back to the un-remedied, unmasked behavior", () => {
    // Mirrors io.ts's saveCliConfig return literal exactly: no `document`
    // key at all, not even `undefined` — there is no raw file to re-read on
    // a save.
    const config = decodeCliConfig({});
    const saved = { path: "supabase/config.toml", format: "toml", config, ignoredPaths: [] };
    const projected = fromConfigDocument(saved);
    // Unmasked: the schema-defaulted captcha section survives, same as the
    // "without a document" behavior pinned earlier in this file.
    expect(projected.auth?.captcha).toBeDefined();
  });
});
