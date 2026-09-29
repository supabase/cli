import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { encodeStackEnv, stackEnvOverrides, stackEnvValues } from "./status.env.ts";

describe("stack dotenv encoding", () => {
  it("matches the legacy `status -o env` quoting: double-quoted with escaping", () => {
    const encoded = encodeStackEnv({
      QUOTED: "it's a secret",
      PLAIN: "plain$(value)",
      BACKSLASH: 'with "quotes" and \\backslash',
    });
    expect(encoded).toBe(
      [
        'BACKSLASH="with \\"quotes\\" and \\\\backslash"',
        'PLAIN="plain$(value)"',
        `QUOTED="it's a secret"`,
      ].join("\n") + "\n",
    );
  });

  it("emits integer-parseable values unquoted, matching godotenv's strconv.Atoi branch", () => {
    expect(encodeStackEnv({ PORT: "54321" })).toBe("PORT=54321\n");
  });

  it("escapes embedded newlines, carriage returns, and tabs", () => {
    expect(encodeStackEnv({ SECRET: "line one\nline two\rwith\ttab" })).toBe(
      'SECRET="line one\\nline two\\rwith\\ttab"\n',
    );
  });

  it("sorts keys lexicographically", () => {
    expect(encodeStackEnv({ Z: "z-val", A: "a-val", M: "m-val" }).split("\n")).toEqual([
      'A="a-val"',
      'M="m-val"',
      'Z="z-val"',
      "",
    ]);
  });
});

describe("stack environment overrides", () => {
  it.effect("exports the saved effective API credentials unchanged", () =>
    Effect.gen(function* () {
      const names = yield* stackEnvOverrides([]);
      const values = stackEnvValues(
        {
          endpoints: {},
          credentials: {
            publishableKey: "sb_publishable_saved",
            secretKey: "sb_secret_saved",
            anonKey: "asymmetric-anon-token",
            serviceRoleKey: "asymmetric-service-token",
          },
        },
        {},
        names,
      );
      expect(values).toEqual({
        PUBLISHABLE_KEY: "sb_publishable_saved",
        SECRET_KEY: "sb_secret_saved",
        ANON_KEY: "asymmetric-anon-token",
        SERVICE_ROLE_KEY: "asymmetric-service-token",
      });
    }),
  );

  it.effect("accepts renames and rejects malformed or colliding destinations", () =>
    Effect.gen(function* () {
      const names = yield* stackEnvOverrides(["API_URL=NEXT_PUBLIC_API_URL"]);
      expect(names.get("API_URL")).toBe("NEXT_PUBLIC_API_URL");
      expect(
        stackEnvValues({ endpoints: { api: { url: "http://127.0.0.1:54321" } } }, {}, names),
      ).toEqual({ NEXT_PUBLIC_API_URL: "http://127.0.0.1:54321" });

      for (const entries of [
        ["UNKNOWN=value"],
        ["API_URL="],
        ["API_URL=ONE=two"],
        ["API_URL=NAME", "API_URL=OTHER"],
        ["API_URL=DB_URL"],
      ]) {
        const error = yield* stackEnvOverrides(entries).pipe(Effect.flip);
        expect(error.reason).toBe("flags");
      }
    }),
  );
});
