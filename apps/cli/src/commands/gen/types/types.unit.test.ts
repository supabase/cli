import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { parseSchemaFlags } from "../../../command-internal/schema-flags.ts";
import {
  defaultSchemas,
  rootCaBundle,
  localDbContainerId,
  localNetworkId,
  parseQueryTimeoutMillis,
} from "./types.shared.ts";

describe("parseQueryTimeoutMillis", () => {
  it.effect("parses compound durations", () =>
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
    // CSV parsing does no trimming; an empty value yields no field.
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

  it("bundles the staging and production CA certificates", () => {
    expect(rootCaBundle().length).toBeGreaterThan(0);
  });
});
