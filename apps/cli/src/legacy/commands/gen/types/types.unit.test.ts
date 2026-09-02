import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import {
  applyProbedSslMode,
  applyQueryTimeouts,
  defaultSchemas,
  legacyGenTypesNetworkIdUnusedWarning,
  localDbPassword,
  parseQueryTimeoutSeconds,
} from "./types.shared.ts";

function expectInvalidDuration(exit: Exit.Exit<unknown, unknown>, raw: string) {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(String(exit.cause)).toContain(`invalid duration ${JSON.stringify(raw)}`);
  }
}

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

  it.effect("accepts Go's bare 0 as disable", () =>
    Effect.gen(function* () {
      expect(yield* parseQueryTimeoutSeconds("0")).toBe(0);
      expect(yield* parseQueryTimeoutSeconds("0s")).toBe(0);
      expect(yield* parseQueryTimeoutSeconds("0ms")).toBe(0);
    }),
  );

  it.effect("rounds 500ms up to a still-applied 1s bound", () =>
    Effect.gen(function* () {
      expect(yield* parseQueryTimeoutSeconds("500ms")).toBe(1);
    }),
  );

  it.effect("rejects a positive duration that would disable the timeout", () =>
    Effect.gen(function* () {
      for (const raw of ["1ms", "400ms", `15${"µ"}s`, `15${"μ"}s`]) {
        expectInvalidDuration(yield* parseQueryTimeoutSeconds(raw).pipe(Effect.exit), raw);
      }
    }),
  );

  it.effect("rejects an empty duration", () =>
    Effect.gen(function* () {
      expectInvalidDuration(yield* parseQueryTimeoutSeconds("  ").pipe(Effect.exit), "  ");
    }),
  );

  it.effect("rejects a duration with a leading non-duration prefix", () =>
    Effect.gen(function* () {
      expectInvalidDuration(yield* parseQueryTimeoutSeconds("x15s").pipe(Effect.exit), "x15s");
    }),
  );

  it.effect("rejects a duration with trailing junk", () =>
    Effect.gen(function* () {
      expectInvalidDuration(yield* parseQueryTimeoutSeconds("15s30").pipe(Effect.exit), "15s30");
    }),
  );

  it.effect("rejects a string with no recognizable units", () =>
    Effect.gen(function* () {
      expectInvalidDuration(yield* parseQueryTimeoutSeconds("abc").pipe(Effect.exit), "abc");
    }),
  );

  it.effect("rejects a negative duration", () =>
    Effect.gen(function* () {
      expectInvalidDuration(yield* parseQueryTimeoutSeconds("-5s").pipe(Effect.exit), "-5s");
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

describe("legacyGenTypesNetworkIdUnusedWarning", () => {
  it("names the unused flag and the docker run + npx workaround", () => {
    const warning = legacyGenTypesNetworkIdUnusedWarning("mycompose_default");
    expect(warning).toContain("--network-id is unused");
    expect(warning).toContain("docker run --rm --network mycompose_default");
    expect(warning).toContain("npx --yes supabase gen types --db-url <url>");
  });

  it("uses a placeholder when the flag value is empty", () => {
    expect(legacyGenTypesNetworkIdUnusedWarning("")).toContain("--network <network-id>");
  });
});

describe("oxfmt binding pin", () => {
  it("stays on the oxfmt version postgrest-typegen resolves", () => {
    const cliPackageJson = fileURLToPath(new URL("../../../../../package.json", import.meta.url));
    const cliPkg = JSON.parse(readFileSync(cliPackageJson, "utf8")) as {
      readonly devDependencies: Readonly<Record<string, string>>;
    };
    const typegenReq = createRequire(cliPackageJson);
    const typegenPkg = typegenReq("@supabase/postgrest-typegen/package.json") as {
      readonly dependencies: Readonly<Record<string, string>>;
    };
    const oxfmtVersion = typegenPkg.dependencies["oxfmt"];
    expect(oxfmtVersion).toEqual(expect.stringMatching(/^\d+\.\d+\.\d+/));
    const bindingPins = Object.entries(cliPkg.devDependencies).filter(([name]) =>
      name.startsWith("@oxfmt/binding-"),
    );
    expect(bindingPins.length).toBeGreaterThan(0);
    for (const [, version] of bindingPins) {
      expect(version).toBe(oxfmtVersion);
    }
  });
});
