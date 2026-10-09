import { Effect, Option, Path, Result } from "effect";
import { describe, expect, it } from "vitest";

import {
  commaListCodec,
  boolCodec,
  globListCodec,
  uintCodec,
  literalCodec,
  optionalCliConfigKey,
  pickCliConfigKey,
  pickCliEnvName,
  portCodec,
  requiredCliConfigKey,
  stringCodec,
  cliEnvName,
  type CliConfigKey,
  type CliConfigSources,
} from "./cli-config-key.ts";

const pathService = Effect.runSync(
  Effect.gen(function* () {
    return yield* Path.Path;
  }).pipe(Effect.provide(Path.layer)),
);

interface SourceParts {
  readonly flags?: Readonly<Record<string, unknown>>;
  readonly shell?: Readonly<Record<string, string>>;
  readonly projectEnv?: Readonly<Record<string, string>>;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly dotenvPrivateKeys?: ReadonlyArray<string>;
}

const makeSources = (parts: SourceParts = {}): CliConfigSources => {
  const config = parts.config ?? {};
  return {
    flags: (path) =>
      parts.flags !== undefined && path in parts.flags
        ? { flag: `--${path}`, value: parts.flags[path] }
        : undefined,
    shell: (name) => parts.shell?.[name],
    projectEnv: (name) => {
      const value = parts.projectEnv?.[name];
      return value === undefined ? undefined : { value, file: "/work/supabase/.env" };
    },
    config: (path) =>
      path in config
        ? { value: config[path], origin: { path: path.split("."), source: "local" } }
        : undefined,
    dotenvPrivateKeys: parts.dotenvPrivateKeys ?? [],
    context: {
      workdir: "/work/app",
      projectRef: Option.none(),
      path: pathService,
      configAt: (path) => config[path],
    },
  };
};

const seed = requiredCliConfigKey({
  path: "db.seed.enabled",
  env: ["SUPABASE_DB_SEED_ENABLED"],
  codec: boolCodec,
  default: true,
});

const valueOf = <A, X>(key: CliConfigKey<A, X>, parts?: SourceParts) => {
  const picked = pickCliConfigKey(key, makeSources(parts));
  if (Result.isFailure(picked)) throw picked.failure;
  return picked.success;
};

const failureOf = <A, X>(key: CliConfigKey<A, X>, parts?: SourceParts) => {
  const picked = pickCliConfigKey(key, makeSources(parts));
  if (Result.isSuccess(picked)) throw new Error("expected a failure");
  return picked.failure;
};

describe("pickCliConfigKey tiers", () => {
  const all: SourceParts = {
    flags: { "db.seed.enabled": false },
    shell: { SUPABASE_DB_SEED_ENABLED: "true" },
    projectEnv: { SUPABASE_DB_SEED_ENABLED: "false" },
    config: { "db.seed.enabled": "true" },
  };

  it("resolves flag over shell over project env over config over default", () => {
    const withoutFlag = { ...all, flags: {} };
    const withoutShell = { ...withoutFlag, shell: {} };
    const withoutProject = { ...withoutShell, projectEnv: {} };
    const withoutConfig = { ...withoutProject, config: {} };

    expect(valueOf(seed, all)).toMatchObject({ value: false, origin: { tier: "flag" } });
    expect(valueOf(seed, withoutFlag)).toMatchObject({
      value: true,
      origin: { tier: "shell", envName: "SUPABASE_DB_SEED_ENABLED" },
    });
    expect(valueOf(seed, withoutShell)).toMatchObject({
      value: false,
      origin: {
        tier: "projectEnv",
        envName: "SUPABASE_DB_SEED_ENABLED",
        file: "/work/supabase/.env",
      },
    });
    expect(valueOf(seed, withoutProject)).toMatchObject({
      value: true,
      origin: { tier: "config" },
    });
    expect(valueOf(seed, withoutConfig)).toEqual({ value: true, origin: { tier: "default" } });
  });

  it("lets a set-but-empty shell variable shadow the project env and fall through to config", () => {
    const picked = valueOf(seed, {
      shell: { SUPABASE_DB_SEED_ENABLED: "" },
      projectEnv: { SUPABASE_DB_SEED_ENABLED: "false" },
      config: { "db.seed.enabled": true },
    });

    expect(picked).toMatchObject({ value: true, origin: { tier: "config" } });
  });

  it("treats an empty project env value as absent", () => {
    const picked = valueOf(seed, {
      projectEnv: { SUPABASE_DB_SEED_ENABLED: "" },
      config: { "db.seed.enabled": false },
    });

    expect(picked).toMatchObject({ value: false, origin: { tier: "config" } });
  });

  it("wraps an absent optional key as None", () => {
    const key = optionalCliConfigKey({
      path: "db.orioledb_version",
      env: ["SUPABASE_DB_ORIOLEDB_VERSION"],
      codec: stringCodec,
    });

    expect(valueOf(key).value).toEqual(Option.none());
    expect(valueOf(key, { shell: { SUPABASE_DB_ORIOLEDB_VERSION: "15.1" } }).value).toEqual(
      Option.some("15.1"),
    );
  });

  it("evaluates a context default against the loaded document", () => {
    const smtp = requiredCliConfigKey({
      path: "auth.email.smtp.enabled",
      codec: boolCodec,
      defaultFrom: (ctx) => ctx.configAt("auth.email.smtp") !== undefined,
    });

    expect(valueOf(smtp).value).toBe(false);
    expect(valueOf(smtp, { config: { "auth.email.smtp": {} } }).value).toBe(true);
  });
});

describe("pickCliConfigKey env expansion", () => {
  it("expands one env() level at the shell tier from the project env", () => {
    const picked = valueOf(seed, {
      shell: { SUPABASE_DB_SEED_ENABLED: "env(SEED)" },
      projectEnv: { SEED: "false" },
    });

    expect(picked.value).toBe(false);
  });

  it("expands one env() level at the project env tier from the shell", () => {
    const picked = valueOf(seed, {
      projectEnv: { SUPABASE_DB_SEED_ENABLED: "env(SEED)" },
      shell: { SEED: "false" },
    });

    expect(picked.value).toBe(false);
  });

  it("does not expand a second level", () => {
    const failure = failureOf(seed, {
      shell: { SUPABASE_DB_SEED_ENABLED: "env(A)", A: "env(B)", B: "true" },
    });

    expect(failure.message).toContain('Invalid SUPABASE_DB_SEED_ENABLED="env(B)"');
  });

  it("keeps an unresolved env() literal and reports it", () => {
    const failure = failureOf(seed, { shell: { SUPABASE_DB_SEED_ENABLED: "env(MISSING)" } });

    expect(failure.tier).toBe("shell");
    expect(failure.message).toContain('Invalid SUPABASE_DB_SEED_ENABLED="env(MISSING)"');
  });

  it("resolves a config-tier env() reference with a lowercase name", () => {
    const picked = valueOf(seed, {
      config: { "db.seed.enabled": "env(seed_flag)" },
      projectEnv: { seed_flag: "false" },
    });

    expect(picked.value).toBe(false);
  });

  it("keeps the config-tier literal when the referenced variable is set but empty", () => {
    const failure = failureOf(seed, {
      config: { "db.seed.enabled": "env(SEED)" },
      shell: { SEED: "" },
    });

    expect(failure.tier).toBe("config");
  });
});

describe("pickCliConfigKey attributes", () => {
  const poolMode = requiredCliConfigKey({
    path: "db.pooler.pool_mode",
    env: ["SUPABASE_DB_POOLER_POOL_MODE"],
    codec: literalCodec(["transaction", "session"]),
    default: "transaction",
  });

  it("uses a deprecated alias and reports it, with the canonical name winning when both are set", () => {
    const pgdelta = requiredCliConfigKey({
      path: "experimental.pgdelta.enabled",
      env: ["SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED", "SUPABASE_EXPERIMENTAL_PG_DELTA"],
      codec: boolCodec,
      default: false,
    });

    expect(valueOf(pgdelta, { shell: { SUPABASE_EXPERIMENTAL_PG_DELTA: "true" } })).toMatchObject({
      value: true,
      origin: { tier: "shell", envName: "SUPABASE_EXPERIMENTAL_PG_DELTA" },
    });
    const both = valueOf(pgdelta, {
      shell: {
        SUPABASE_EXPERIMENTAL_PG_DELTA: "true",
        SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED: "false",
      },
    });
    expect(both.value).toBe(false);
    expect(both.origin).toEqual({
      tier: "shell",
      envName: "SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED",
    });
  });

  it("applies envRequiresSection only to the env tiers", () => {
    const webhooks = requiredCliConfigKey({
      path: "experimental.webhooks.enabled",
      env: ["SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED"],
      codec: boolCodec,
      default: false,
      envRequiresSection: "experimental.webhooks",
    });
    const shell = { SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED: "true" };

    expect(valueOf(webhooks, { shell }).origin.tier).toBe("default");
    expect(valueOf(webhooks, { shell, config: { "experimental.webhooks": {} } })).toMatchObject({
      value: true,
      origin: { tier: "shell" },
    });
    expect(
      valueOf(webhooks, { flags: { "experimental.webhooks.enabled": true } }).origin.tier,
    ).toBe("flag");
  });

  it("decrypts the winning secret at every tier", () => {
    const ciphertext =
      "encrypted:BKiXH15AyRzeohGyUrmB6cGjSklCrrBjdesQlX1VcXo/Xp20Bi2gGZ3AlIqxPQDmjVAALnhZamKnuY73l8Dz1P+BYiZUgxTSLzdCvdYUyVbNekj2UudbdUizBViERtZkuQwZHIv/";
    const dotenvPrivateKeys = ["7fd7210cef8f331ee8c55897996aaaafd853a2b20a4dc73d6d75759f65d2a7eb"];
    const secret = optionalCliConfigKey({
      path: "auth.captcha.secret",
      env: ["SUPABASE_AUTH_CAPTCHA_SECRET"],
      codec: stringCodec,
      secret: true,
    });

    expect(
      valueOf(secret, { shell: { SUPABASE_AUTH_CAPTCHA_SECRET: ciphertext }, dotenvPrivateKeys })
        .value,
    ).toEqual(Option.some("value"));
    expect(
      valueOf(secret, { config: { "auth.captcha.secret": ciphertext }, dotenvPrivateKeys }).value,
    ).toEqual(Option.some("value"));
  });

  it("fails a secret that cannot be decrypted without echoing the ciphertext", () => {
    const secret = optionalCliConfigKey({
      path: "auth.captcha.secret",
      env: ["SUPABASE_AUTH_CAPTCHA_SECRET"],
      codec: stringCodec,
      secret: true,
    });

    const failure = failureOf(secret, {
      shell: { SUPABASE_AUTH_CAPTCHA_SECRET: "encrypted:abcd" },
    });

    expect(failure.message).toBe("failed to parse config: missing private key");
  });

  it("normalizes the winner and keeps the unnormalized value", () => {
    const sqlPaths = requiredCliConfigKey({
      path: "db.seed.sql_paths",
      env: ["SUPABASE_DB_SEED_SQL_PATHS"],
      codec: commaListCodec,
      default: ["./seed.sql"],
      normalize: (value, ctx) => value.map((entry) => ctx.path.join("supabase", entry)),
    });

    const picked = valueOf(sqlPaths, { shell: { SUPABASE_DB_SEED_SQL_PATHS: "a.sql,b.sql" } });

    expect(picked.value).toEqual(["supabase/a.sql", "supabase/b.sql"]);
    expect(picked.unnormalized).toEqual(["a.sql", "b.sql"]);
  });

  it("splits a comma list without trimming and reads an empty config string as an empty list", () => {
    const schemas = requiredCliConfigKey({
      path: "api.schemas",
      env: ["SUPABASE_API_SCHEMAS"],
      codec: commaListCodec,
      default: ["public"],
    });

    expect(valueOf(schemas, { shell: { SUPABASE_API_SCHEMAS: "a, b" } }).value).toEqual([
      "a",
      " b",
    ]);
    expect(valueOf(schemas, { config: { "api.schemas": "" } }).value).toEqual([]);
  });

  it("accepts a flag value of the key's type and rejects another", () => {
    expect(valueOf(poolMode, { flags: { "db.pooler.pool_mode": "session" } }).value).toBe(
      "session",
    );
    expect(failureOf(poolMode, { flags: { "db.pooler.pool_mode": "other" } }).tier).toBe("flag");
  });

  it("never consults the document for a key without a document path", () => {
    const password = optionalCliConfigKey({
      path: "linkedDb.password",
      env: ["SUPABASE_DB_PASSWORD"],
      codec: stringCodec,
      document: false,
    });

    expect(valueOf(password, { config: { "linkedDb.password": "from-config" } }).origin.tier).toBe(
      "default",
    );
  });
});

describe("pickCliConfigKey failure text", () => {
  it("names the env variable, the key and the expected bool", () => {
    const failure = failureOf(seed, { shell: { SUPABASE_DB_SEED_ENABLED: "maybe" } });

    expect(failure.message).toBe(
      'Invalid SUPABASE_DB_SEED_ENABLED="maybe" (sets db.seed.enabled): expected true or false.',
    );
  });

  it("names the expected range for a port out of range", () => {
    const port = requiredCliConfigKey({
      path: "api.port",
      env: ["SUPABASE_API_PORT"],
      codec: portCodec,
      default: 54321,
    });

    const failure = failureOf(port, { shell: { SUPABASE_API_PORT: "70000" } });

    expect(failure.message).toBe(
      'Invalid SUPABASE_API_PORT="70000" (sets api.port): expected a port (0-65535).',
    );
  });

  it("rejects a malformed uint and keeps the base-prefix grammar", () => {
    const jwtExpiry = requiredCliConfigKey({
      path: "auth.jwt_expiry",
      env: ["SUPABASE_AUTH_JWT_EXPIRY"],
      codec: uintCodec,
      default: 3600,
    });

    expect(failureOf(jwtExpiry, { shell: { SUPABASE_AUTH_JWT_EXPIRY: "08" } }).message).toBe(
      'Invalid SUPABASE_AUTH_JWT_EXPIRY="08" (sets auth.jwt_expiry): expected a non-negative integer.',
    );
    expect(valueOf(jwtExpiry, { shell: { SUPABASE_AUTH_JWT_EXPIRY: "0x10" } }).value).toBe(16);
    expect(valueOf(jwtExpiry, { shell: { SUPABASE_AUTH_JWT_EXPIRY: "010" } }).value).toBe(8);
    expect(valueOf(jwtExpiry, { shell: { SUPABASE_AUTH_JWT_EXPIRY: "1_000" } }).value).toBe(1000);
  });

  it("caps a uint at the largest safe integer instead of rounding", () => {
    const jwtExpiry = requiredCliConfigKey({
      path: "auth.jwt_expiry",
      env: ["SUPABASE_AUTH_JWT_EXPIRY"],
      codec: uintCodec,
      default: 3600,
    });

    expect(
      valueOf(jwtExpiry, { shell: { SUPABASE_AUTH_JWT_EXPIRY: "9007199254740991" } }).value,
    ).toBe(Number.MAX_SAFE_INTEGER);
    expect(
      failureOf(jwtExpiry, { shell: { SUPABASE_AUTH_JWT_EXPIRY: "9007199254740993" } }).message,
    ).toBe(
      'Invalid SUPABASE_AUTH_JWT_EXPIRY="9007199254740993" (sets auth.jwt_expiry): expected a non-negative integer.',
    );
    expect(
      failureOf(jwtExpiry, { config: { "auth.jwt_expiry": "9007199254740993" } }).message,
    ).toBe('Invalid auth.jwt_expiry: "9007199254740993" is not a non-negative integer.');
  });

  it("lists the allowed values of an enum", () => {
    const backend = requiredCliConfigKey({
      path: "analytics.backend",
      env: ["SUPABASE_ANALYTICS_BACKEND"],
      codec: literalCodec(["postgres", "bigquery"]),
      default: "postgres",
    });

    const failure = failureOf(backend, { shell: { SUPABASE_ANALYTICS_BACKEND: "sqlite" } });

    expect(failure.message).toBe(
      'Invalid SUPABASE_ANALYTICS_BACKEND="sqlite" (sets analytics.backend): expected one of "postgres", "bigquery".',
    );
  });

  it("does not echo a secret value", () => {
    const secretBool = requiredCliConfigKey({
      path: "x.secret",
      env: ["SUPABASE_X_SECRET"],
      codec: boolCodec,
      default: false,
      secret: true,
    });

    expect(
      failureOf(secretBool, { shell: { SUPABASE_X_SECRET: "hunter2" } }).message,
    ).not.toContain("hunter2");
  });
});

describe("portCodec", () => {
  it.each(["08080", "00", "0123", "070000"])("rejects the leading-zero decimal %s", (raw) => {
    expect(portCodec.parse(raw)).toBeUndefined();
  });

  it.each([
    ["0", 0],
    ["8080", 8080],
    ["0x1F90", 8080],
    ["0o17", 15],
    ["0b101", 5],
  ])("accepts %s", (raw, port) => {
    expect(portCodec.parse(raw)).toBe(port);
  });
});

describe("pickCliConfigKey weak config values", () => {
  it("reads a case-variant bool token and a numeric bool from the document", () => {
    expect(valueOf(seed, { config: { "db.seed.enabled": "TRUE" } })).toMatchObject({
      value: true,
      origin: { tier: "config" },
    });
    expect(valueOf(seed, { config: { "db.seed.enabled": 0 } }).value).toBe(false);
  });

  const sqlPaths = requiredCliConfigKey({
    path: "db.seed.sql_paths",
    env: ["SUPABASE_DB_SEED_SQL_PATHS"],
    codec: globListCodec,
    default: ["supabase/seed.sql"],
  });
  const globOf = (config: unknown) =>
    valueOf(sqlPaths, { config: { "db.seed.sql_paths": config } }).value;

  it("decodes a glob list from a bare string, a scalar, a mixed array and an empty table", () => {
    expect(globOf("a.sql,b.sql")).toEqual(["a.sql", "b.sql"]);
    expect(globOf(true)).toEqual(["1"]);
    expect(globOf(["a.sql", 1, false, 1e21])).toEqual([
      "a.sql",
      "1",
      "0",
      "1000000000000000000000",
    ]);
    expect(globOf([Number.POSITIVE_INFINITY, Number.NaN])).toEqual(["+Inf", "NaN"]);
    expect(globOf({})).toEqual([]);
  });

  it("names every unsupported entry in one decoding-failed error", () => {
    const failure = failureOf(sqlPaths, {
      config: { "db.seed.sql_paths": [["nested"], "ok", { k: "v" }] },
    });

    expect(failure).toMatchObject({ tier: "config", path: "db.seed.sql_paths" });
    expect(failure.issues).toEqual([
      "db.seed.sql_paths[0]: expected a string, got array",
      "db.seed.sql_paths[2]: expected a string, got table",
    ]);
    expect(failure.message).toBe(`failed to parse config:\n${failure.issues?.join("\n")}`);
  });
});

describe("pickCliEnvName", () => {
  const projectId = cliEnvName({ name: "SUPABASE_PROJECT_ID", codec: stringCodec });

  it("reads the shell only and treats empty as unset", () => {
    expect(Result.getOrThrow(pickCliEnvName(projectId, { shell: () => "abc" }))).toEqual(
      Option.some("abc"),
    );
    expect(Result.getOrThrow(pickCliEnvName(projectId, { shell: () => "" }))).toEqual(
      Option.none(),
    );
    expect(Result.getOrThrow(pickCliEnvName(projectId, { shell: () => undefined }))).toEqual(
      Option.none(),
    );
  });
});
