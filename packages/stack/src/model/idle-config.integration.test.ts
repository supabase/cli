import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { InvalidStackConfigError } from "../public/Errors.ts";
import { compileStack } from "./Compiler.ts";

const compile = (config: Parameters<typeof compileStack>[0]["config"]) =>
  compileStack({ projectRoot: "/tmp/supabase-project", runtime: { kind: "native" }, config }).pipe(
    Effect.provide(NodeServices.layer),
  );

const failureOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

describe("traffic idle timeout configuration", () => {
  it.live("defaults supported lazy capabilities to a 60 second timeout", () =>
    Effect.gen(function* () {
      const result = yield* compile({});
      for (const name of ["rest", "auth", "realtime", "studio", "pooler"] as const) {
        expect(result.definition.capabilities[name]).toMatchObject({
          activation: "lazy",
          idleTimeoutSeconds: 60,
        });
      }
    }),
  );

  it.live("allows disabling idle stopping explicitly", () =>
    Effect.gen(function* () {
      const result = yield* compile({
        capabilities: {
          rest: { idleTimeoutSeconds: false },
          auth: { idleTimeoutSeconds: false },
          realtime: { idleTimeoutSeconds: false },
          studio: { idleTimeoutSeconds: false },
          pooler: { idleTimeoutSeconds: false },
        },
      });
      for (const name of ["rest", "auth", "realtime", "studio", "pooler"] as const)
        expect(result.definition.capabilities[name].idleTimeoutSeconds).toBe(false);
    }),
  );

  it.live("persists a positive finite timeout override", () =>
    Effect.gen(function* () {
      const result = yield* compile({
        capabilities: { rest: { idleTimeoutSeconds: 15.5 } },
      });
      expect(result.definition.capabilities.rest.idleTimeoutSeconds).toBe(15.5);
    }),
  );

  it.live("does not idle-stop eager capabilities", () =>
    Effect.gen(function* () {
      const result = yield* compile({
        capabilities: {
          rest: { activation: "eager", idleTimeoutSeconds: 15 },
          studio: { activation: "eager" },
        },
      });
      expect(result.definition.capabilities.rest).toMatchObject({
        activation: "eager",
        idleTimeoutSeconds: false,
      });
      expect(result.definition.capabilities.studio).toMatchObject({
        activation: "eager",
        idleTimeoutSeconds: false,
      });
    }),
  );

  it.live("keeps unsupported services opted out of idle stopping", () =>
    Effect.gen(function* () {
      const defaults = yield* compile({});
      for (const name of ["database", "storage", "functions", "mail", "analytics"] as const)
        expect(defaults.definition.capabilities[name].idleTimeoutSeconds).toBe(false);

      for (const name of ["database", "storage", "functions", "mail", "analytics"] as const) {
        const result = yield* compile({
          capabilities: { [name]: { idleTimeoutSeconds: 30 } },
        } as never).pipe(Effect.exit);
        expect(failureOf(result)).toBeInstanceOf(InvalidStackConfigError);
      }
    }),
  );

  it.live("rejects zero, negative, and non-finite timeouts", () =>
    Effect.gen(function* () {
      for (const value of [0, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
        const result = yield* compile({
          capabilities: { rest: { idleTimeoutSeconds: value } },
        } as never).pipe(Effect.exit);
        expect(failureOf(result)).toBeInstanceOf(InvalidStackConfigError);
      }
    }),
  );
});
