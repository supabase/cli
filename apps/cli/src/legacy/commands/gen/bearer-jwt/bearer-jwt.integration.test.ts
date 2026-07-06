import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { Command } from "effect/unstable/cli";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import { legacyGenBearerJwtCommand } from "./bearer-jwt.command.ts";
import { legacyGenBearerJwt } from "./bearer-jwt.handler.ts";

function setupLegacyGenBearerJwt() {
  const calls: Array<ReadonlyArray<string>> = [];
  const layer = Layer.succeed(LegacyGoProxy, {
    exec: (args) =>
      Effect.sync(() => {
        calls.push(args);
      }),
    execCapture: () => Effect.succeed(""),
  });
  return { layer, calls };
}

const legacyTestRoot = Command.make("supabase").pipe(
  Command.withSubcommands([legacyGenBearerJwtCommand]),
);

function rejectsMissingRole(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "errors" in error &&
    Array.isArray((error as { errors: unknown }).errors) &&
    (error as { errors: Array<{ _tag?: string; option?: string }> }).errors.some(
      (candidate) => candidate._tag === "MissingOption" && candidate.option === "role",
    )
  );
}

describe("legacy gen bearer-jwt", () => {
  it.live("forwards --role to the Go binary", () => {
    const { layer, calls } = setupLegacyGenBearerJwt();
    return Effect.gen(function* () {
      yield* legacyGenBearerJwt({
        role: "anon",
        sub: Option.none(),
        exp: Option.none(),
        validFor: Option.none(),
        payload: Option.none(),
      });
      expect(calls).toEqual([["gen", "bearer-jwt", "--role", "anon"]]);
    }).pipe(Effect.provide(layer));
  });

  it.live("forwards all optional flags when set", () => {
    const { layer, calls } = setupLegacyGenBearerJwt();
    return Effect.gen(function* () {
      yield* legacyGenBearerJwt({
        role: "service_role",
        sub: Option.some("user-123"),
        exp: Option.some("2026-01-01T00:00:00Z"),
        validFor: Option.some("1h"),
        payload: Option.some('{"foo":"bar"}'),
      });
      expect(calls).toEqual([
        [
          "gen",
          "bearer-jwt",
          "--role",
          "service_role",
          "--sub",
          "user-123",
          "--exp",
          "2026-01-01T00:00:00Z",
          "--valid-for",
          "1h",
          "--payload",
          '{"foo":"bar"}',
        ],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "rejects omitting --role before reaching the Go binary (Go parity: MarkFlagRequired)",
    () => {
      const { layer, calls } = setupLegacyGenBearerJwt();
      return Effect.gen(function* () {
        const exit = yield* Command.runWith(legacyTestRoot, { version: "0.0.0-test" })([
          "bearer-jwt",
        ]).pipe(Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause);
          expect(rejectsMissingRole(error)).toBe(true);
        }
        expect(calls).toEqual([]);
      }).pipe(Effect.provide(layer)) as Effect.Effect<void>;
    },
  );

  it.live("accepts --role from real argv via the command parser", () => {
    const { layer, calls } = setupLegacyGenBearerJwt();
    return Effect.gen(function* () {
      yield* Command.runWith(legacyTestRoot, { version: "0.0.0-test" })([
        "bearer-jwt",
        "--role",
        "authenticated",
      ]);
      expect(calls).toEqual([["gen", "bearer-jwt", "--role", "authenticated"]]);
    }).pipe(Effect.provide(layer)) as Effect.Effect<void>;
  });
});
