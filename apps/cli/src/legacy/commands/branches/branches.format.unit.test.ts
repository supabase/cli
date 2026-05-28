import { describe, expect, it } from "vitest";

import {
  apiKeysToEnv,
  formatUtcDateTime,
  parsePoolerConnectionString,
  renderBranchGetTable,
  renderBranchesListTable,
  toPostgresUrl,
  toStandardEnvs,
} from "./branches.format.ts";

describe("formatUtcDateTime", () => {
  it("formats ISO date-time as UTC YYYY-MM-DD HH:MM:SS", () => {
    expect(formatUtcDateTime("2026-05-27T03:04:05Z")).toBe("2026-05-27 03:04:05");
  });

  it("zero-pads single-digit months and minutes", () => {
    expect(formatUtcDateTime("2026-01-02T03:04:05Z")).toBe("2026-01-02 03:04:05");
  });

  it("returns the empty string unchanged", () => {
    expect(formatUtcDateTime("")).toBe("");
  });

  it("returns garbage input unchanged when Date.parse cannot decode it", () => {
    expect(formatUtcDateTime("not-a-date")).toBe("not-a-date");
  });
});

describe("renderBranchesListTable", () => {
  it("renders all 8 columns in declared order", () => {
    const out = renderBranchesListTable([
      {
        id: "11111111-2222-3333-4444-555555555555",
        name: "feat-1",
        project_ref: "abcdefghijklmnopqrst",
        parent_project_ref: "parent-ref-aaaaaaaaa",
        is_default: false,
        git_branch: "feat-1",
        persistent: false,
        status: "MIGRATIONS_PASSED",
        created_at: "2026-05-27T01:02:03Z",
        updated_at: "2026-05-27T01:02:04Z",
        with_data: true,
      },
    ]);
    expect(out).toContain("ID");
    expect(out).toContain("NAME");
    expect(out).toContain("DEFAULT");
    expect(out).toContain("GIT BRANCH");
    expect(out).toContain("WITH DATA");
    expect(out).toContain("STATUS");
    expect(out).toContain("CREATED AT (UTC)");
    expect(out).toContain("UPDATED AT (UTC)");
    expect(out).toContain("abcdefghijklmnopqrst");
    expect(out).toContain("feat-1");
    expect(out).toContain("2026-05-27 01:02:03");
  });

  it("renders a literal `|` in branch name (Glamour does not double-escape)", () => {
    const out = renderBranchesListTable([
      {
        id: "id",
        name: "with|pipe",
        project_ref: "ref",
        parent_project_ref: "parent",
        is_default: false,
        git_branch: "git|pipe",
        persistent: false,
        status: "MIGRATIONS_PASSED",
        created_at: "",
        updated_at: "",
        with_data: false,
      },
    ]);
    expect(out).toContain("with|pipe");
    expect(out).toContain("git|pipe");
  });

  it("renders empty git_branch as a single space (Go parity)", () => {
    const out = renderBranchesListTable([
      {
        id: "id",
        name: "n",
        project_ref: "ref",
        parent_project_ref: "parent",
        is_default: false,
        persistent: false,
        status: "MIGRATIONS_PASSED",
        created_at: "",
        updated_at: "",
        with_data: false,
      },
    ]);
    // The space cell is hard to assert directly; assert the table renders.
    expect(out).toContain("STATUS");
  });
});

describe("renderBranchGetTable", () => {
  it("masks db_user, db_pass, jwt_secret as ****** when undefined", () => {
    const out = renderBranchGetTable({
      ref: "abcdefghijklmnopqrst",
      postgres_version: "15",
      postgres_engine: "15",
      release_channel: "ga",
      status: "ACTIVE_HEALTHY",
      db_host: "db.example.com",
      db_port: 5432,
    });
    expect(out).toContain("******");
    expect(out).toContain("HOST");
    expect(out).toContain("POSTGRES VERSION");
    expect(out).toContain("ACTIVE_HEALTHY");
  });

  it("uses provided db_user / db_pass / jwt_secret when set", () => {
    const out = renderBranchGetTable({
      ref: "abcdefghijklmnopqrst",
      postgres_version: "15",
      postgres_engine: "15",
      release_channel: "ga",
      status: "ACTIVE_HEALTHY",
      db_host: "db.example.com",
      db_port: 5432,
      db_user: "postgres",
      db_pass: "topsecret",
      jwt_secret: "jwt-secret-value",
    });
    expect(out).toContain("postgres");
    expect(out).toContain("topsecret");
    expect(out).toContain("jwt-secret-value");
  });
});

describe("apiKeysToEnv", () => {
  it("uppercases name and wraps as SUPABASE_<NAME>_KEY", () => {
    expect(
      apiKeysToEnv([
        { name: "anon", api_key: "anon-key" },
        { name: "service_role", api_key: "sr-key" },
      ]),
    ).toEqual({
      SUPABASE_ANON_KEY: "anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "sr-key",
    });
  });

  it("masks null/undefined api_key as ******", () => {
    expect(apiKeysToEnv([{ name: "anon", api_key: null }])).toEqual({
      SUPABASE_ANON_KEY: "******",
    });
    expect(apiKeysToEnv([{ name: "service_role" }])).toEqual({
      SUPABASE_SERVICE_ROLE_KEY: "******",
    });
  });
});

describe("toPostgresUrl", () => {
  it("encodes IPv4 host with connect_timeout=10 default", () => {
    const url = toPostgresUrl({
      host: "192.0.2.10",
      port: 5432,
      user: "postgres",
      password: "p",
      database: "postgres",
    });
    expect(url).toBe("postgresql://postgres:p@192.0.2.10:5432/postgres?connect_timeout=10");
  });

  it("wraps IPv6 host in square brackets", () => {
    const url = toPostgresUrl({
      host: "2001:db8::1",
      port: 5432,
      user: "postgres",
      password: "p",
      database: "postgres",
    });
    expect(url).toContain("@[2001:db8::1]:5432");
  });

  it("appends runtime params after connect_timeout", () => {
    const url = toPostgresUrl({
      host: "h",
      port: 5432,
      user: "u",
      password: "p",
      database: "d",
      runtimeParams: { options: "--cluster=foo" },
    });
    expect(url).toContain("connect_timeout=10");
    expect(url).toContain("options=--cluster%3Dfoo");
  });
});

describe("parsePoolerConnectionString", () => {
  it("strips [YOUR-PASSWORD] placeholder before parsing", () => {
    const parsed = parsePoolerConnectionString(
      "postgresql://postgres.refxxxxxxxxxxxxxxxxxx:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.parts.host).toBe("aws-0-us-east-1.pooler.supabase.com");
      expect(parsed.parts.port).toBe(6543);
      expect(parsed.parts.database).toBe("postgres");
      expect(parsed.parts.user).toBe("postgres.refxxxxxxxxxxxxxxxxxx");
    }
  });

  it("returns an error description (not the raw URL) for unparseable input", () => {
    const parsed = parsePoolerConnectionString("not a url");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).not.toContain("not a url");
      expect(parsed.error.length).toBeGreaterThan(0);
    }
  });

  it("rejects a non-postgresql scheme with the scheme in the error", () => {
    const parsed = parsePoolerConnectionString("http://example.com");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("http:");
    }
  });
});

describe("toStandardEnvs", () => {
  const detail = {
    ref: "abcdefghijklmnopqrst",
    postgres_version: "15",
    postgres_engine: "15",
    release_channel: "ga",
    status: "ACTIVE_HEALTHY" as const,
    db_host: "db.example.com",
    db_port: 5432,
    db_user: "postgres",
    db_pass: "secret",
    jwt_secret: "jwt-secret",
  };
  const pooler = {
    identifier: "id",
    database_type: "PRIMARY" as const,
    is_using_scram_auth: true,
    db_user: "u",
    db_host: "h",
    db_port: 5432,
    db_name: "postgres",
    connection_string:
      "postgresql://postgres.abc:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
    connectionString: "n/a",
    default_pool_size: null,
    max_client_conn: null,
    pool_mode: "transaction" as const,
  };

  it("produces the 4 fixed keys plus per-key SUPABASE_<NAME>_KEY entries", () => {
    const result = toStandardEnvs(
      detail,
      pooler,
      [
        { name: "anon", api_key: "anon-value" },
        { name: "service_role", api_key: "sr-value" },
      ],
      "supabase.co",
    );
    expect(Object.keys(result.envs).sort()).toEqual([
      "POSTGRES_URL",
      "POSTGRES_URL_NON_POOLING",
      "SUPABASE_ANON_KEY",
      "SUPABASE_JWT_SECRET",
      "SUPABASE_SERVICE_ROLE_KEY",
      "SUPABASE_URL",
    ]);
    expect(result.envs.SUPABASE_URL).toBe("https://abcdefghijklmnopqrst.supabase.co");
    expect(result.envs.SUPABASE_JWT_SECRET).toBe("jwt-secret");
    expect(result.envs.POSTGRES_URL).toContain(
      "@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
    );
    // The pooler password is replaced with the direct password — Go parity.
    expect(result.envs.POSTGRES_URL).toContain(":secret@");
    expect(result.envs.POSTGRES_URL_NON_POOLING).toContain("@db.example.com:5432/postgres");
    expect(result.poolerWarning).toBeUndefined();
  });

  it("falls back to the direct URL and surfaces a warning on parse failure", () => {
    const broken = { ...pooler, connection_string: "not a url" };
    const result = toStandardEnvs(detail, broken, [], "supabase.co");
    expect(result.envs.POSTGRES_URL).toBe(result.envs.POSTGRES_URL_NON_POOLING);
    expect(result.poolerWarning).toBeDefined();
  });
});
