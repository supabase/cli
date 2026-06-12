import { createServer, type Server, type Socket } from "node:net";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { legacyGetHostname } from "../../../shared/legacy-hostname.ts";
import {
  buildPostgresUrl,
  defaultSchemas,
  legacyRootCaBundle,
  localDbContainerId,
  localDbPassword,
  localNetworkId,
  normalizeSchemaFlags,
  parseDatabaseUrl,
  parseQueryTimeoutSeconds,
  probeTlsSupport,
  resolvePgmetaImage,
} from "./types.shared.ts";

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

async function withTcpServer<T>(
  handler: (socket: Socket) => void,
  run: (port: number) => Promise<T>,
): Promise<T> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("failed to bind tcp server");
  }
  try {
    return await run(address.port);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
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
});

describe("parseDatabaseUrl", () => {
  it.effect("parses a full postgresql url", () =>
    Effect.gen(function* () {
      const result = yield* parseDatabaseUrl("postgresql://user:pw@example.com:6543/mydb");
      expect(result.host).toBe("example.com");
      expect(result.port).toBe(6543);
      expect(result.networkMode).toBe("host");
      expect(result.url).toContain("/mydb");
    }),
  );

  it.effect("accepts the postgres:// scheme and defaults the database", () =>
    Effect.gen(function* () {
      const result = yield* parseDatabaseUrl("postgres://user:pw@example.com/");
      expect(result.url).toContain("/postgres");
    }),
  );

  it.effect("defaults the port to 5432 when omitted", () =>
    Effect.gen(function* () {
      const result = yield* parseDatabaseUrl("postgresql://user:pw@example.com/db");
      expect(result.port).toBe(5432);
    }),
  );

  it.effect("rejects an unsupported scheme", () =>
    Effect.gen(function* () {
      const exit = yield* parseDatabaseUrl("mysql://user:pw@example.com/db").pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("rejects a malformed connection string", () =>
    Effect.gen(function* () {
      const exit = yield* parseDatabaseUrl("not a url").pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});

describe("resolvePgmetaImage", () => {
  it("uses the default pgmeta version when no override is given", () => {
    const image = withEnv("SUPABASE_INTERNAL_IMAGE_REGISTRY", undefined, () =>
      resolvePgmetaImage(),
    );
    expect(image).toContain("postgres-meta");
  });

  it("strips a leading v from a version override", () => {
    const image = withEnv("SUPABASE_INTERNAL_IMAGE_REGISTRY", "docker.io", () =>
      resolvePgmetaImage("v1.2.3"),
    );
    expect(image).toBe("supabase/postgres-meta:v1.2.3");
  });

  it("falls back to the default when the override is blank", () => {
    const withOverride = withEnv("SUPABASE_INTERNAL_IMAGE_REGISTRY", "docker.io", () =>
      resolvePgmetaImage("   "),
    );
    const withoutOverride = withEnv("SUPABASE_INTERNAL_IMAGE_REGISTRY", "docker.io", () =>
      resolvePgmetaImage(),
    );
    expect(withOverride).toBe(withoutOverride);
  });

  it("uses the supabase registry for any non docker.io registry", () => {
    const image = withEnv("SUPABASE_INTERNAL_IMAGE_REGISTRY", undefined, () =>
      resolvePgmetaImage("1.2.3"),
    );
    expect(image).not.toBe("supabase/postgres-meta:v1.2.3");
    expect(image).toContain("postgres-meta:v1.2.3");
  });
});

describe("schema and id helpers", () => {
  it("normalizes comma separated and repeated schema flags", () => {
    expect(normalizeSchemaFlags(["public, auth", " storage ", ""])).toEqual([
      "public",
      "auth",
      "storage",
    ]);
  });

  it("prepends public and removes duplicates from default schemas", () => {
    expect(defaultSchemas(["auth", "public", "storage"])).toEqual(["public", "auth", "storage"]);
    expect(defaultSchemas()).toEqual(["public"]);
  });

  it("derives sanitized docker ids from the project id", () => {
    expect(localDbContainerId("..my project")).toBe("supabase_db_my_project");
    expect(localNetworkId("..my project")).toBe("supabase_network_my_project");
  });

  it("truncates an over-long project id to 40 characters", () => {
    const longId = "a".repeat(60);
    expect(localDbContainerId(longId)).toBe(`supabase_db_${"a".repeat(40)}`);
  });

  it("reads the services hostname and db password from the environment", () => {
    expect(
      withEnv("DOCKER_HOST", undefined, () =>
        withEnv("SUPABASE_SERVICES_HOSTNAME", undefined, () => legacyGetHostname()),
      ),
    ).toBe("127.0.0.1");
    expect(withEnv("SUPABASE_SERVICES_HOSTNAME", "db.internal", () => legacyGetHostname())).toBe(
      "db.internal",
    );
    expect(withEnv("SUPABASE_DB_PASSWORD", undefined, () => localDbPassword())).toBe("postgres");
    expect(withEnv("SUPABASE_DB_PASSWORD", "secret", () => localDbPassword())).toBe("secret");
  });

  it("brackets ipv6 hosts in the generated postgres url", () => {
    const url = buildPostgresUrl({
      host: "::1",
      port: 5432,
      user: "postgres",
      password: "pw",
      database: "postgres",
    });
    expect(url).toContain("@[::1]:5432/");
  });

  it("bundles the staging and production CA certificates", () => {
    expect(legacyRootCaBundle().length).toBeGreaterThan(0);
  });
});

describe("probeTlsSupport", () => {
  it.effect("detects TLS support from an 'S' response", () =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise(() =>
        withTcpServer(
          (socket) =>
            socket.once("data", () => {
              socket.write(Buffer.from("S"));
              socket.end();
            }),
          (port) => Effect.runPromise(probeTlsSupport("127.0.0.1", port)),
        ),
      );
      expect(result).toBe(true);
    }),
  );

  it.effect("detects a refused TLS connection from an 'N' response", () =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise(() =>
        withTcpServer(
          (socket) =>
            socket.once("data", () => {
              socket.write(Buffer.from("N"));
              socket.end();
            }),
          (port) => Effect.runPromise(probeTlsSupport("127.0.0.1", port)),
        ),
      );
      expect(result).toBe(false);
    }),
  );

  it.effect("fails on an unexpected probe response", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.tryPromise(() =>
        withTcpServer(
          (socket) =>
            socket.once("data", () => {
              socket.write(Buffer.from("X"));
              socket.end();
            }),
          (port) => Effect.runPromise(probeTlsSupport("127.0.0.1", port)),
        ),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("fails when the connection closes before responding", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.tryPromise(() =>
        withTcpServer(
          (socket) => socket.destroy(),
          (port) => Effect.runPromise(probeTlsSupport("127.0.0.1", port)),
        ),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});
