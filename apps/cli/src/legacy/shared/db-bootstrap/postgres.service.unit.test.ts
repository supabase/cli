import type { CliConfig } from "@supabase/config";
import { afterEach, describe, expect, test, vi } from "vitest";

import { LEGACY_START_DB_RESTORE_SH } from "./templates/db-restore.sh.ts";
import { LEGACY_START_DB_SCHEMA_SQL } from "./templates/db-schema.sql.ts";
import { LEGACY_START_DB_SUPABASE_SQL } from "./templates/db-supabase.sql.ts";
import { LEGACY_START_DB_WEBHOOK_SQL } from "./templates/db-webhook.sql.ts";
import { LEGACY_POSTGRES_DEFAULT_ROOT_KEY } from "../legacy-local-config-values.ts";
import {
  LEGACY_SHADOW_ENTRYPOINT_ARGS,
  legacyBuildPostgresStartContainerSpec,
  legacyBuildShadowPostgresContainerSpec,
  legacyPostgresImageVersionTag,
  legacyPostgresSettingsToConfigArgs,
  legacyPostgresSettingsToPostgresConfig,
  legacyPostgresVersionCompare,
  type LegacyPostgresStartServiceInput,
  type LegacyShadowPostgresContainerSpecInput,
} from "./postgres.service.ts";

const POSTGRES_CONFIG_HEADER = "\n# supabase [db.settings] configuration\n";

const SLIM_POSTGRES_IMAGE = "ghcr.io/supabase/cli/postgres:17.6.1.165";

afterEach(() => {
  vi.unstubAllEnvs();
});

function baseDb(overrides: Partial<CliConfig["db"]> = {}): CliConfig["db"] {
  return {
    port: 54322,
    shadow_port: 54320,
    health_timeout: "2m",
    major_version: 17,
    pooler: {
      enabled: false,
      port: 54329,
      pool_mode: "transaction",
      default_pool_size: 20,
      max_client_conn: 100,
    },
    migrations: { enabled: true, schema_paths: [] },
    seed: { enabled: true, sql_paths: [] },
    settings: {},
    network_restrictions: { enabled: false, allowed_cidrs: [], allowed_cidrs_v6: [] },
    ...overrides,
  };
}

function baseExperimental(
  overrides: Partial<CliConfig["experimental"]> = {},
): CliConfig["experimental"] {
  return {
    webhooks: { enabled: false },
    pgdelta: { enabled: false },
    inspect: { rules: [] },
    ...overrides,
  };
}

function baseInput(
  overrides: Partial<LegacyPostgresStartServiceInput> = {},
): LegacyPostgresStartServiceInput {
  return {
    db: baseDb(),
    experimental: baseExperimental(),
    jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
    jwtExpiry: 3600,
    projectId: "myproj",
    networkId: "supabase_network_myproj",
    image: "public.ecr.aws/supabase/postgres:17.4.1.030",
    configImage: "supabase/postgres:17.4.1.030",
    ...overrides,
  };
}

describe("legacyBuildPostgresStartContainerSpec", () => {
  test("PG >= 15: concatenates schema.sql + webhook.sql + _supabase.sql into the schema heredoc, appends the postgres config, and carries the pgsodium root key as a secretFile instead of a heredoc", () => {
    const spec = legacyBuildPostgresStartContainerSpec(
      baseInput({ db: baseDb({ major_version: 17 }) }),
    );

    expect(spec.entrypoint).toBe("sh");
    const script = spec.cmd?.[1];
    expect(script).toBe(
      "\n" +
        "cat <<'EOF' > /etc/postgresql.schema.sql && \\\n" +
        "cat <<'EOF' >> /etc/postgresql/postgresql.conf && \\\n" +
        "exec docker-entrypoint.sh postgres -D /etc/postgresql \n" +
        `${LEGACY_START_DB_SCHEMA_SQL}\n` +
        `${LEGACY_START_DB_WEBHOOK_SQL}\n` +
        `${LEGACY_START_DB_SUPABASE_SQL}\n` +
        "EOF\n" +
        `${POSTGRES_CONFIG_HEADER}\n` +
        "EOF",
    );
    expect(script).not.toContain(LEGACY_POSTGRES_DEFAULT_ROOT_KEY);
    expect(script).not.toContain("pgsodium_root.key");
    expect(spec.tmpfs).toBeUndefined();
    expect(spec.secretFiles).toEqual([
      {
        containerPath: "/etc/postgresql-custom/pgsodium_root.key",
        content: LEGACY_POSTGRES_DEFAULT_ROOT_KEY,
      },
    ]);
  });

  test("PG <= 14: writes only _supabase.sql (no schema.sql/webhook.sql, no pgsodium root key) and sets the initdb tmpfs mount", () => {
    const spec = legacyBuildPostgresStartContainerSpec(
      baseInput({ db: baseDb({ major_version: 14 }) }),
    );

    const script = spec.cmd?.[1];
    expect(script).toBe(
      "\n" +
        "cat <<'EOF' > /docker-entrypoint-initdb.d/supabase_schema.sql && \\\n" +
        "cat <<'EOF' >> /etc/postgresql/postgresql.conf && \\\n" +
        "exec docker-entrypoint.sh postgres -D /etc/postgresql \n" +
        `${LEGACY_START_DB_SUPABASE_SQL}\n` +
        "EOF\n" +
        `${POSTGRES_CONFIG_HEADER}\n` +
        "EOF",
    );
    expect(script).not.toContain("postgresql.schema.sql");
    expect(script).not.toContain("pgsodium_root.key");
    expect(spec.tmpfs).toEqual({ "/docker-entrypoint-initdb.d": "" });
    expect(spec.secretFiles).toBeUndefined();
  });

  test("uses a rootKey override instead of the Go default when provided", () => {
    const spec = legacyBuildPostgresStartContainerSpec(
      baseInput({ db: baseDb({ major_version: 17 }), rootKey: "custom-root-key" }),
    );
    expect(spec.secretFiles).toEqual([
      { containerPath: "/etc/postgresql-custom/pgsodium_root.key", content: "custom-root-key" },
    ]);
    expect(spec.cmd?.[1]).not.toContain("custom-root-key");
    expect(spec.cmd?.[1]).not.toContain(LEGACY_POSTGRES_DEFAULT_ROOT_KEY);
  });

  test("base env carries password, host, jwt secret, and jwt expiry", () => {
    const spec = legacyBuildPostgresStartContainerSpec(baseInput());
    expect(spec.env).toMatchObject({
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_HOST: "/var/run/postgresql",
      JWT_SECRET: "super-secret-jwt-token-with-at-least-32-characters-long",
      JWT_EXP: "3600",
    });
  });

  test("OrioleDB branch: adds POSTGRES_INITDB_ARGS + S3 env vars and skips the version-compare branch", () => {
    const spec = legacyBuildPostgresStartContainerSpec(
      baseInput({
        experimental: baseExperimental({
          orioledb_version: "17.4.1.030",
          s3_host: "s3.example.com",
          s3_region: "us-east-1",
          s3_access_key: "access-key",
          s3_secret_key: "secret-key",
        }),
        // Old enough to trigger the version-compare branch too, if it weren't skipped.
        image: "supabase/postgres:orioledb-15.1.0.55",
      }),
    );
    expect(spec.env).toEqual({
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_HOST: "/var/run/postgresql",
      JWT_SECRET: "super-secret-jwt-token-with-at-least-32-characters-long",
      JWT_EXP: "3600",
      POSTGRES_INITDB_ARGS: "--lc-collate=C --lc-ctype=C",
      S3_ENABLED: "true",
      S3_HOST: "s3.example.com",
      S3_REGION: "us-east-1",
      S3_ACCESS_KEY: "access-key",
      S3_SECRET_KEY: "secret-key",
    });
  });

  test("OrioleDB branch defaults unset S3 fields to empty strings, matching Go's zero-value string fields", () => {
    const spec = legacyBuildPostgresStartContainerSpec(
      baseInput({ experimental: baseExperimental({ orioledb_version: "17.4.1.030" }) }),
    );
    expect(spec.env).toMatchObject({
      S3_HOST: "",
      S3_REGION: "",
      S3_ACCESS_KEY: "",
      S3_SECRET_KEY: "",
    });
  });

  test("version-compare branch: adds POSTGRES_INITDB_ARGS=--lc-collate=C.UTF-8 when the image tag is below the threshold", () => {
    const spec = legacyBuildPostgresStartContainerSpec(
      baseInput({
        image: "public.ecr.aws/supabase/postgres:15.1.0.117",
        configImage: "supabase/postgres:15.1.0.117",
      }),
    );
    expect(spec.env.POSTGRES_INITDB_ARGS).toBe("--lc-collate=C.UTF-8");
  });

  test("version-compare branch is skipped when the image tag is at or above the threshold", () => {
    const atThreshold = legacyBuildPostgresStartContainerSpec(
      baseInput({
        image: "public.ecr.aws/supabase/postgres:15.8.1.005",
        configImage: "supabase/postgres:15.8.1.005",
      }),
    );
    expect(atThreshold.env.POSTGRES_INITDB_ARGS).toBeUndefined();

    const aboveThreshold = legacyBuildPostgresStartContainerSpec(
      baseInput({
        image: "public.ecr.aws/supabase/postgres:17.4.1.030",
        configImage: "supabase/postgres:17.4.1.030",
      }),
    );
    expect(aboveThreshold.env.POSTGRES_INITDB_ARGS).toBeUndefined();
  });

  test("version-compare branch reads the pre-registry-rewrite configImage, not the registry-resolved image (a port-bearing registry override must not break the tag parse)", () => {
    const spec = legacyBuildPostgresStartContainerSpec(
      baseInput({
        image: "localhost:5000/supabase/postgres:17.4.1.030",
        configImage: "supabase/postgres:17.4.1.030",
      }),
    );
    expect(spec.env.POSTGRES_INITDB_ARGS).toBeUndefined();
  });

  test("healthcheck matches Go's pg_isready probe", () => {
    const spec = legacyBuildPostgresStartContainerSpec(baseInput());
    expect(spec.healthcheck).toEqual({
      test: ["CMD", "pg_isready", "-U", "postgres", "-h", "127.0.0.1", "-p", "5432"],
      intervalSeconds: 10,
      timeoutSeconds: 2,
      retries: 3,
    });
  });

  test("healthcheck stays the plain pg_isready probe on docker.io even with the slim flag set", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "1");
    const spec = legacyBuildPostgresStartContainerSpec(baseInput());
    expect(spec.healthcheck?.test).toEqual([
      "CMD",
      "pg_isready",
      "-U",
      "postgres",
      "-h",
      "127.0.0.1",
      "-p",
      "5432",
    ]);
  });

  test("port binding maps the configured db.port to container port 5432", () => {
    const spec = legacyBuildPostgresStartContainerSpec(baseInput({ db: baseDb({ port: 12345 }) }));
    expect(spec.ports).toEqual([{ hostPort: "12345", containerPort: "5432" }]);
  });

  test("binds a named volume keyed by the container's own (sanitized) name", () => {
    const spec = legacyBuildPostgresStartContainerSpec(baseInput({ projectId: "my project!" }));
    expect(spec.containerName).toBe("supabase_db_my_project_");
    expect(spec.binds).toEqual(["supabase_db_my_project_:/var/lib/postgresql/data"]);
  });

  test("--from-backup: PG >= 15 uses the restore entrypoint (schema.sql + _supabase.sql, no webhook.sql), appends migrate.sh/postgresql.conf heredocs and cron.launch_active_jobs=off, and still carries the root key as a secretFile", () => {
    const spec = legacyBuildPostgresStartContainerSpec(
      baseInput({ db: baseDb({ major_version: 17 }), fromBackup: "/abs/host/backup.sql" }),
    );

    expect(spec.entrypoint).toBe("sh");
    const script = spec.cmd?.[1];
    expect(script).toBe(
      "\n" +
        "cat <<'EOF' > /etc/postgresql.schema.sql && \\\n" +
        "cat <<'EOF' > /docker-entrypoint-initdb.d/migrate.sh && \\\n" +
        "cat <<'EOF' >> /etc/postgresql/postgresql.conf && \\\n" +
        "exec docker-entrypoint.sh postgres -D /etc/postgresql\n" +
        `${LEGACY_START_DB_SCHEMA_SQL}\n` +
        `${LEGACY_START_DB_SUPABASE_SQL}\n` +
        "EOF\n" +
        `${LEGACY_START_DB_RESTORE_SH}\n` +
        "EOF\n" +
        `${POSTGRES_CONFIG_HEADER}\n` +
        "cron.launch_active_jobs = off\n" +
        "EOF",
    );
    expect(script).not.toContain(LEGACY_START_DB_WEBHOOK_SQL);
    expect(script).not.toContain(LEGACY_POSTGRES_DEFAULT_ROOT_KEY);
    expect(spec.secretFiles).toEqual([
      {
        containerPath: "/etc/postgresql-custom/pgsodium_root.key",
        content: LEGACY_POSTGRES_DEFAULT_ROOT_KEY,
      },
    ]);
    expect(spec.binds).toEqual([
      "supabase_db_myproj:/var/lib/postgresql/data",
      "/abs/host/backup.sql:/etc/backup.sql:ro",
    ]);
  });

  test("--from-backup: PG <= 14 still uses the restore entrypoint (unconditional override) but keeps the PG<=14 initdb tmpfs mount", () => {
    const spec = legacyBuildPostgresStartContainerSpec(
      baseInput({ db: baseDb({ major_version: 14 }), fromBackup: "/abs/host/backup.sql" }),
    );

    expect(spec.cmd?.[1]).toContain("/docker-entrypoint-initdb.d/migrate.sh");
    expect(spec.tmpfs).toEqual({ "/docker-entrypoint-initdb.d": "" });
    expect(spec.secretFiles).toEqual([
      {
        containerPath: "/etc/postgresql-custom/pgsodium_root.key",
        content: LEGACY_POSTGRES_DEFAULT_ROOT_KEY,
      },
    ]);
  });

  test("--from-backup: converts a Windows-style host path through legacyToDockerPath for the backup bind", () => {
    const spec = legacyBuildPostgresStartContainerSpec(
      baseInput({ fromBackup: "C:\\Users\\me\\backup.sql" }),
    );
    expect(spec.binds).toContain("/Users/me/backup.sql:/etc/backup.sql:ro");
  });

  test("no --from-backup: binds only the data volume, matching the pre-existing behavior", () => {
    const spec = legacyBuildPostgresStartContainerSpec(baseInput());
    expect(spec.binds).toEqual(["supabase_db_myproj:/var/lib/postgresql/data"]);
  });

  test("network id, aliases, restart policy, and image pass through unchanged", () => {
    const spec = legacyBuildPostgresStartContainerSpec(
      baseInput({ networkId: "supabase_network_myproj", image: "some/resolved-image:17.4.1.030" }),
    );
    expect(spec.networkId).toBe("supabase_network_myproj");
    expect(spec.networkAliases).toEqual(["db", "db.supabase.internal"]);
    expect(spec.restartPolicy).toBe("unless-stopped");
    expect(spec.image).toBe("some/resolved-image:17.4.1.030");
    expect(spec.labels).toEqual({});
  });
});

describe("legacyPostgresSettingsToPostgresConfig", () => {
  test("only set values appear, in the configured field's TOML form", () => {
    const config = legacyPostgresSettingsToPostgresConfig({
      max_connections: 100,
      max_locks_per_transaction: 64,
      shared_buffers: "128MB",
      work_mem: "4MB",
    });
    expect(config).toContain("max_connections = 100");
    expect(config).toContain("max_locks_per_transaction = 64");
    expect(config).toContain("shared_buffers = '128MB'");
    expect(config).toContain("work_mem = '4MB'");
    expect(config).not.toContain("effective_cache_size");
    expect(config).not.toContain("maintenance_work_mem");
    expect(config).not.toContain("max_parallel_workers");
  });

  test("session_replication_role is single-quoted like every other string field", () => {
    const config = legacyPostgresSettingsToPostgresConfig({ session_replication_role: "origin" });
    expect(config).toContain("session_replication_role = 'origin'");
  });

  test("empty settings produce just the header, with no trailing content", () => {
    const config = legacyPostgresSettingsToPostgresConfig({});
    expect(config).toBe(POSTGRES_CONFIG_HEADER);
    expect(config).not.toContain("=");
  });

  test("a boolean field is emitted unquoted", () => {
    const config = legacyPostgresSettingsToPostgresConfig({ track_commit_timestamp: true });
    expect(config).toContain("track_commit_timestamp = true");
  });
});

describe("legacyPostgresVersionCompare", () => {
  test.each([
    ["15.1.0.55", "15.1.0.55", 0],
    ["15.8.1.085", "15.1.0.55", 1],
    ["15.1.0.55", "15.8.1.085", -1],
    ["17.4.1.005", "17.4.1.005", 0],
    ["17.4.1.030", "17.4.1.005", 1],
    ["17.4.1.005", "17.4.1.030", -1],
    ["15.8.1", "15.8.1", 0],
    ["17", "15.8", 1],
    ["14", "15.8", -1],
    ["oriole-17", "oriole-17", 0],
    ["17", "oriole-17", 1],
    ["oriole-17", "17", -1],
  ] as const)("VersionCompare(%s, %s) === %d", (a, b, expected) => {
    expect(legacyPostgresVersionCompare(a, b)).toBe(expected);
  });
});

describe("legacyPostgresImageVersionTag", () => {
  test("extracts the tag after the last colon, ignoring any registry host prefix", () => {
    expect(legacyPostgresImageVersionTag("public.ecr.aws/supabase/postgres:15.1.0.117")).toBe(
      "15.1.0.117",
    );
    expect(legacyPostgresImageVersionTag("supabase/postgres:17.4.1.030")).toBe("17.4.1.030");
  });

  test("degrades to the whole string when there is no colon at all, matching Go's Image[i+1:] with i=-1", () => {
    expect(legacyPostgresImageVersionTag("supabase/postgres")).toBe("supabase/postgres");
  });
});

function baseShadowInput(
  overrides: Partial<LegacyShadowPostgresContainerSpecInput> = {},
): LegacyShadowPostgresContainerSpecInput {
  return {
    db: { major_version: 17, settings: {} },
    experimental: baseExperimental(),
    jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
    jwtExpiry: 3600,
    networkId: "supabase_network_myproj",
    image: "public.ecr.aws/supabase/postgres:17.4.1.030",
    configImage: "supabase/postgres:17.4.1.030",
    shadowPort: 54320,
    password: "postgres",
    ...overrides,
  };
}

describe("legacyBuildShadowPostgresContainerSpec", () => {
  test("PG >= 15: splices the shadow entrypoint args into the SAME trailing-space join point the real db container uses, and still carries the pgsodium root key as a secretFile", () => {
    const spec = legacyBuildShadowPostgresContainerSpec(
      baseShadowInput({ db: { major_version: 17, settings: {} } }),
    );
    const script = spec.cmd?.[1];
    expect(script).toContain(
      `exec docker-entrypoint.sh postgres -D /etc/postgresql ${LEGACY_SHADOW_ENTRYPOINT_ARGS}\n`,
    );
    expect(spec.secretFiles).toEqual([
      {
        containerPath: "/etc/postgresql-custom/pgsodium_root.key",
        content: LEGACY_POSTGRES_DEFAULT_ROOT_KEY,
      },
    ]);
    expect(spec.tmpfs).toBeUndefined();
  });

  test("PG <= 14: splices the same args, no pgsodium secretFile, and sets the initdb tmpfs mount", () => {
    const spec = legacyBuildShadowPostgresContainerSpec(
      baseShadowInput({ db: { major_version: 14, settings: {} } }),
    );
    const script = spec.cmd?.[1];
    expect(script).toContain(
      `exec docker-entrypoint.sh postgres -D /etc/postgresql ${LEGACY_SHADOW_ENTRYPOINT_ARGS}\n`,
    );
    expect(spec.secretFiles).toBeUndefined();
    expect(spec.tmpfs).toEqual({ "/docker-entrypoint-initdb.d": "" });
  });

  test("has no name (Docker auto-generates one), no network aliases, no volume bind, and no restart policy — unlike the real db container", () => {
    const spec = legacyBuildShadowPostgresContainerSpec(baseShadowInput());
    expect(spec.containerName).toBe("");
    expect(spec.networkAliases).toBeUndefined();
    expect(spec.binds).toEqual([]);
    expect(spec.restartPolicy).toBeUndefined();
  });

  test("sets autoRemove and publishes the shadow port to 5432/tcp", () => {
    const spec = legacyBuildShadowPostgresContainerSpec(baseShadowInput({ shadowPort: 54399 }));
    expect(spec.autoRemove).toBe(true);
    expect(spec.ports).toEqual([{ hostPort: "54399", containerPort: "5432" }]);
  });

  test("labels are still applied (empty map here — the caller merges project/compose labels in, same as every other container)", () => {
    const spec = legacyBuildShadowPostgresContainerSpec(baseShadowInput());
    expect(spec.labels).toEqual({});
  });

  test("initializes POSTGRES_PASSWORD from the resolved [db] password, not a hardcoded literal — the deliberate TS extension the input's own doc describes (Go rejects the toml key at config load and always uses 'postgres')", () => {
    const spec = legacyBuildShadowPostgresContainerSpec(baseShadowInput({ password: "hunter2" }));
    expect(spec.env?.["POSTGRES_PASSWORD"]).toBe("hunter2");
  });
});

describe("legacyPostgresSettingsToConfigArgs", () => {
  test("renders each set value as its own -c key=value pair, unquoted", () => {
    expect(
      legacyPostgresSettingsToConfigArgs({
        max_connections: 100,
        shared_buffers: "128MB",
        session_replication_role: "origin",
        track_commit_timestamp: true,
      }),
    ).toEqual([
      "-c",
      "max_connections=100",
      "-c",
      "shared_buffers=128MB",
      "-c",
      "session_replication_role=origin",
      "-c",
      "track_commit_timestamp=true",
    ]);
  });

  test("emits nothing for empty settings, unlike the conf renderer's header-only output", () => {
    expect(legacyPostgresSettingsToConfigArgs({})).toEqual([]);
    expect(legacyPostgresSettingsToConfigArgs(undefined)).toEqual([]);
  });
});

describe("slim Postgres image spec", () => {
  test("keeps the image's own entrypoint and passes [db.settings] as trailing -c argv instead of a heredoc script", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "1");
    const spec = legacyBuildPostgresStartContainerSpec(
      baseInput({
        image: SLIM_POSTGRES_IMAGE,
        db: baseDb({ settings: { max_connections: 120, effective_cache_size: "512MB" } }),
      }),
    );

    expect(spec.entrypoint).toBeUndefined();
    expect(spec.cmd).toEqual(["-c", "max_connections=120", "-c", "effective_cache_size=512MB"]);
    expect(spec.cmd?.join(" ")).not.toContain("docker-entrypoint.sh");
  });

  test("stages the schema SQL the bundled migrate.sh hook runs, plus the pgsodium root key it is pointed at by env", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "1");
    const spec = legacyBuildPostgresStartContainerSpec(
      baseInput({ image: SLIM_POSTGRES_IMAGE, rootKey: "custom-root-key" }),
    );

    expect(spec.env).toEqual({
      POSTGRES_PASSWORD: "postgres",
      JWT_SECRET: "super-secret-jwt-token-with-at-least-32-characters-long",
      JWT_EXP: "3600",
      PGSODIUM_KEY_FILE: "/etc/postgresql-custom/pgsodium_root.key",
    });
    expect(spec.secretFiles).toEqual([
      { containerPath: "/etc/postgresql-custom/pgsodium_root.key", content: "custom-root-key" },
      {
        containerPath: "/etc/postgresql.schema.sql",
        content: `${LEGACY_START_DB_SCHEMA_SQL}\n${LEGACY_START_DB_WEBHOOK_SQL}\n${LEGACY_START_DB_SUPABASE_SQL}\n`,
      },
    ]);
  });

  test("leaves the volume bind, published port, healthcheck, and network wiring untouched", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "1");
    const spec = legacyBuildPostgresStartContainerSpec(
      baseInput({ image: SLIM_POSTGRES_IMAGE, db: baseDb({ port: 12345 }) }),
    );

    expect(spec.binds).toEqual(["supabase_db_myproj:/var/lib/postgresql/data"]);
    expect(spec.ports).toEqual([{ hostPort: "12345", containerPort: "5432" }]);
    expect(spec.healthcheck).toEqual({
      test: [
        "CMD",
        "sh",
        "-ec",
        'case "$(cat /proc/1/comm)" in postgres|.postgres-wrapp) pg_isready -U postgres -h 127.0.0.1 -p 5432 ;; *) exit 1 ;; esac',
      ],
      intervalSeconds: 10,
      timeoutSeconds: 2,
      retries: 3,
    });
    expect(spec.networkAliases).toEqual(["db", "db.supabase.internal"]);
    expect(spec.restartPolicy).toBe("unless-stopped");
  });

  test("healthcheck gates on the final postgres process, not the entrypoint shell PID 1 stays during first-boot init", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "1");
    const dbSpec = legacyBuildPostgresStartContainerSpec(baseInput({ image: SLIM_POSTGRES_IMAGE }));
    const shadowSpec = legacyBuildShadowPostgresContainerSpec(
      baseShadowInput({ image: SLIM_POSTGRES_IMAGE }),
    );
    const expected = [
      "CMD",
      "sh",
      "-ec",
      'case "$(cat /proc/1/comm)" in postgres|.postgres-wrapp) pg_isready -U postgres -h 127.0.0.1 -p 5432 ;; *) exit 1 ;; esac',
    ];
    expect(dbSpec.healthcheck?.test).toEqual(expected);
    expect(shadowSpec.healthcheck?.test).toEqual(expected);
  });

  test("appends the shadow's worker cap to the same trailing argv", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "1");
    const spec = legacyBuildShadowPostgresContainerSpec(
      baseShadowInput({
        image: SLIM_POSTGRES_IMAGE,
        db: { major_version: 17, settings: { max_connections: 120 } },
        password: "hunter2",
      }),
    );

    expect(spec.entrypoint).toBeUndefined();
    expect(spec.cmd).toEqual(["-c", "max_connections=120", "-c", "max_worker_processes=0"]);
    expect(spec.env?.["POSTGRES_PASSWORD"]).toBe("hunter2");
    expect(spec.autoRemove).toBe(true);
    expect(spec.secretFiles?.map((file) => file.containerPath)).toEqual([
      "/etc/postgresql-custom/pgsodium_root.key",
      "/etc/postgresql.schema.sql",
    ]);
  });

  // The whole slim path hangs off the resolved ref, so a registry override that
  // lands on docker.io keeps the heredoc entrypoint even with the flag set.
  test("stays on the docker.io entrypoint when the flag is set but the resolved image is not a slim ref", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "1");
    const spec = legacyBuildPostgresStartContainerSpec(baseInput());
    expect(spec.entrypoint).toBe("sh");
    expect(spec.cmd?.[1]).toContain("exec docker-entrypoint.sh");
  });

  test("stays on the docker.io entrypoint for a slim ref while the flag is off", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", undefined);
    const spec = legacyBuildPostgresStartContainerSpec(baseInput({ image: SLIM_POSTGRES_IMAGE }));
    expect(spec.entrypoint).toBe("sh");
    expect(spec.cmd?.[1]).toContain("exec docker-entrypoint.sh");
  });
});
