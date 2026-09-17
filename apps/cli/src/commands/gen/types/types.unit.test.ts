import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, Layer } from "effect";
import { runtimeInfoLayer } from "../../../shared/runtime/runtime-info.layer.ts";
import { getHostname } from "../../../command-internal/hostname.ts";
import { parseSchemaFlags } from "../../../command-internal/schema-flags.ts";
import {
  defaultSchemas,
  rootCaBundle,
  localDbContainerId,
  localDbPassword,
  localNetworkId,
  parseQueryTimeoutMillis,
} from "./types.shared.ts";

const resolvePassword = () =>
  Effect.runSync(
    localDbPassword().pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnvRecord({ ...process.env }, { preserveEmptyStrings: true }),
      ),
    ),
  );

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

describe("parseQueryTimeoutMillis", () => {
  it.effect("parses compound Go durations", () =>
    Effect.gen(function* () {
      expect(yield* parseQueryTimeoutMillis("15s")).toBe(15000);
      expect(yield* parseQueryTimeoutMillis("1h")).toBe(3600000);
      expect(yield* parseQueryTimeoutMillis("1m30s")).toBe(90000);
      expect(yield* parseQueryTimeoutMillis("2h30m")).toBe(9000000);
    }),
  );

  it.effect("preserves sub-second precision", () =>
    Effect.gen(function* () {
      expect(yield* parseQueryTimeoutMillis("500ms")).toBe(500);
      expect(yield* parseQueryTimeoutMillis("400ms")).toBe(400);
    }),
  );

  it.effect("rejects an empty duration", () =>
    Effect.gen(function* () {
      const exit = yield* parseQueryTimeoutMillis("  ").pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("rejects a duration with a leading non-duration prefix", () =>
    Effect.gen(function* () {
      const exit = yield* parseQueryTimeoutMillis("x15s").pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("rejects a duration with trailing junk", () =>
    Effect.gen(function* () {
      const exit = yield* parseQueryTimeoutMillis("15s30").pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("rejects a string with no recognizable units", () =>
    Effect.gen(function* () {
      const exit = yield* parseQueryTimeoutMillis("abc").pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("rejects a negative duration", () =>
    Effect.gen(function* () {
      const exit = yield* parseQueryTimeoutMillis("-5s").pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});

describe("schema and id helpers", () => {
  it("normalizes comma separated and repeated schema flags", () => {
    // pflag's StringSlice parses via encoding/csv with no trimming; an empty value yields no field.
    expect(parseSchemaFlags(["public, auth", " storage ", ""])).toEqual([
      "public",
      " auth",
      " storage ",
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

  it.effect("reads the services hostname and db password from the environment", () =>
    Effect.gen(function* () {
      expect(yield* getHostname({ SUPABASE_SERVICES_HOSTNAME: "" })).toBe("127.0.0.1");
      expect(yield* getHostname({ SUPABASE_SERVICES_HOSTNAME: "db.internal" })).toBe("db.internal");
      expect(withEnv("SUPABASE_DB_PASSWORD", undefined, resolvePassword)).toBe("postgres");
      expect(withEnv("SUPABASE_DB_PASSWORD", "secret", resolvePassword)).toBe("secret");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          runtimeInfoLayer,
          ConfigProvider.layer(ConfigProvider.fromEnvRecord({ DOCKER_HOST: undefined })),
        ),
      ),
    ),
  );

  it("bundles the staging and production CA certificates", () => {
    expect(rootCaBundle().length).toBeGreaterThan(0);
  });
});
