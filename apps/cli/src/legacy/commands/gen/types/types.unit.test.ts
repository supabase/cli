import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import {
  applyProbedSslMode,
  applyQueryTimeouts,
  defaultSchemas,
  localDbPassword,
  parseQueryTimeoutSeconds,
} from "./types.shared.ts";

const BASE_CONN = {
  host: "db.example.com",
  port: 5432,
  user: "postgres",
  password: "secret",
  database: "postgres",
};

function withEnv<T>(key: string, value: string | undefined, run: () => T): T {
  const previous = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

describe("parseQueryTimeoutSeconds", () => {
  it.effect("parses compound Go durations", () =>
    Effect.gen(function* () {
      expect(yield* parseQueryTimeoutSeconds("15s")).toBe(15);
      expect(yield* parseQueryTimeoutSeconds("1h")).toBe(3600);
      expect(yield* parseQueryTimeoutSeconds("1m30s")).toBe(90);
      expect(yield* parseQueryTimeoutSeconds("2h30m")).toBe(9000);
    }),
  );

  it.effect("rounds sub-second durations to whole seconds", () =>
    Effect.gen(function* () {
      expect(yield* parseQueryTimeoutSeconds("500ms")).toBe(1);
      expect(yield* parseQueryTimeoutSeconds("400ms")).toBe(0);
    }),
  );

  it.effect("rejects an empty duration", () =>
    Effect.gen(function* () {
      const exit = yield* parseQueryTimeoutSeconds("  ").pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("rejects a duration with a leading non-duration prefix", () =>
    Effect.gen(function* () {
      const exit = yield* parseQueryTimeoutSeconds("x15s").pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("rejects a duration with trailing junk", () =>
    Effect.gen(function* () {
      const exit = yield* parseQueryTimeoutSeconds("15s30").pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("rejects a string with no recognizable units", () =>
    Effect.gen(function* () {
      const exit = yield* parseQueryTimeoutSeconds("abc").pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("rejects a negative duration", () =>
    Effect.gen(function* () {
      const exit = yield* parseQueryTimeoutSeconds("-5s").pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("accepts Go-style microsecond duration aliases", () =>
    Effect.gen(function* () {
      expect(yield* parseQueryTimeoutSeconds(`15${"µ"}s`)).toBe(0);
      expect(yield* parseQueryTimeoutSeconds(`15${"μ"}s`)).toBe(0);
    }),
  );
});

describe("applyQueryTimeouts", () => {
  it("writes statement_timeout last so the flag overrides a DSN value", () => {
    const conn = applyQueryTimeouts(
      { ...BASE_CONN, runtimeParams: { statement_timeout: "0", search_path: "public" } },
      15,
    );
    expect(conn.runtimeParams).toEqual({
      statement_timeout: "15000",
      search_path: "public",
    });
    expect(conn.connectTimeoutSeconds).toBe(15);
  });

  it("leaves connect timeout unset when the query timeout is zero", () => {
    const conn = applyQueryTimeouts(BASE_CONN, 0);
    expect(conn.connectTimeoutSeconds).toBeUndefined();
    expect(conn.runtimeParams).toEqual({ statement_timeout: "0" });
  });

  it("keeps an explicit DSN connect_timeout", () => {
    const conn = applyQueryTimeouts({ ...BASE_CONN, connectTimeoutSeconds: 30 }, 15);
    expect(conn.connectTimeoutSeconds).toBe(30);
  });
});

describe("applyProbedSslMode", () => {
  it("disables TLS when the probe reports a plain-TCP server", () => {
    expect(applyProbedSslMode(BASE_CONN, false).sslmode).toBe("disable");
  });

  it("pins require plus the CA path when the probe reports TLS", () => {
    expect(applyProbedSslMode(BASE_CONN, true, "/tmp/root.crt")).toMatchObject({
      sslmode: "require",
      sslrootcert: "/tmp/root.crt",
    });
  });

  it("leaves an explicit sslmode unchanged", () => {
    const conn = { ...BASE_CONN, sslmode: "verify-full" };
    expect(applyProbedSslMode(conn, true, "/tmp/root.crt")).toBe(conn);
  });
});

describe("schema and password helpers", () => {
  it("prepends public and removes duplicates from default schemas", () => {
    expect(defaultSchemas(["auth", "public", "storage"])).toEqual(["public", "auth", "storage"]);
    expect(defaultSchemas()).toEqual(["public"]);
  });

  it("reads the db password from the environment", () => {
    expect(withEnv("SUPABASE_DB_PASSWORD", undefined, () => localDbPassword())).toBe("postgres");
    expect(withEnv("SUPABASE_DB_PASSWORD", "secret", () => localDbPassword())).toBe("secret");
  });
});
