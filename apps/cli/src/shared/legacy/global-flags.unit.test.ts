import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { CliArgs } from "../cli/cli-args.service.ts";
import {
  LEGACY_GLOBAL_FLAGS,
  LegacyAgentFlag,
  LegacyCreateTicketFlag,
  LegacyDebugFlag,
  LegacyDnsResolverFlag,
  LegacyExperimentalFlag,
  LegacyNetworkIdFlag,
  LegacyOutputFlag,
  LegacyProfileFlag,
  LegacyWorkdirFlag,
  LegacyYesFlag,
  legacyGlobalFlagValues,
  legacyResolveDebug,
} from "./global-flags.ts";

describe("legacyGlobalFlagValues", () => {
  it.live(
    "resolves every flag declared in LEGACY_GLOBAL_FLAGS by id (CLI-1896 drift guard: an 11th global flag added here without a matching read in legacyGlobalFlagValues fails this test instead of silently redacting forever)",
    () => {
      const layer = Layer.mergeAll(
        Layer.succeed(LegacyAgentFlag, "yes" as const),
        Layer.succeed(LegacyCreateTicketFlag, true),
        Layer.succeed(LegacyDebugFlag, true),
        Layer.succeed(LegacyDnsResolverFlag, "https" as const),
        Layer.succeed(LegacyExperimentalFlag, true),
        Layer.succeed(LegacyNetworkIdFlag, Option.some("my-network")),
        Layer.succeed(LegacyOutputFlag, Option.some("json" as const)),
        Layer.succeed(LegacyProfileFlag, "custom-profile"),
        Layer.succeed(LegacyWorkdirFlag, Option.some("/tmp/project")),
        Layer.succeed(LegacyYesFlag, true),
      );

      return legacyGlobalFlagValues.pipe(
        Effect.provide(layer),
        Effect.tap((values) =>
          Effect.sync(() => {
            // The key set must exactly match LEGACY_GLOBAL_FLAGS's own ids —
            // this is what fails loudly if the array grows without a matching
            // read here.
            expect(Object.keys(values).sort()).toEqual(
              LEGACY_GLOBAL_FLAGS.map((flag) => flag.id).sort(),
            );
            expect(values).toEqual({
              agent: "yes",
              "create-ticket": true,
              debug: true,
              "dns-resolver": "https",
              experimental: true,
              "network-id": Option.some("my-network"),
              output: Option.some("json"),
              profile: "custom-profile",
              workdir: Option.some("/tmp/project"),
              yes: true,
            });
          }),
        ),
      );
    },
  );

  it.live("omits every flag when no global-flag context is provided", () => {
    return legacyGlobalFlagValues.pipe(
      Effect.tap((values) =>
        Effect.sync(() => {
          expect(values).toEqual({});
        }),
      ),
    );
  });

  it.live("only includes flags whose service was actually provided", () => {
    return legacyGlobalFlagValues.pipe(
      Effect.provide(Layer.succeed(LegacyDebugFlag, true)),
      Effect.tap((values) =>
        Effect.sync(() => {
          expect(values).toEqual({ debug: true });
        }),
      ),
    );
  });
});

describe("legacyResolveDebug", () => {
  // Regression (review: PRRT_kwDOErm0O86XKYiG): the raw-argv "explicitly false" scan used to be
  // an `Array.some` over every `--debug=<value>` occurrence, so ANY earlier `--debug=false` forced
  // the result to `false` even when a LATER occurrence in the same invocation explicitly turned it
  // back on. pflag's `Value.Set` runs for every occurrence in argv order — the LAST one wins, not
  // "any occurrence is false" — matching the same pflag-vs-Effect-parser divergence already
  // binary-verified for `--skip-url-validation`
  // (`apps/cli/src/legacy/commands/sso/sso.pflag-reconcile.ts:306-321`).
  it.effect("resolves false for a single explicit --debug=false, overriding the flag", () =>
    Effect.gen(function* () {
      const result = yield* legacyResolveDebug;
      expect(result).toBe(false);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(LegacyDebugFlag, true),
          Layer.succeed(CliArgs, { args: ["--debug=false"] }),
        ),
      ),
    ),
  );

  it.effect(
    "resolves true for a repeated --debug where the LAST occurrence is =true, not forced false by an earlier =false",
    () =>
      Effect.gen(function* () {
        const result = yield* legacyResolveDebug;
        expect(result).toBe(true);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(LegacyDebugFlag, true),
            Layer.succeed(CliArgs, { args: ["--debug=false", "--debug=true"] }),
          ),
        ),
      ),
  );

  it.effect(
    "resolves true for --debug=false followed by a trailing bare --debug (last occurrence wins)",
    () =>
      Effect.gen(function* () {
        const result = yield* legacyResolveDebug;
        expect(result).toBe(true);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(LegacyDebugFlag, true),
            Layer.succeed(CliArgs, { args: ["--debug=false", "--debug"] }),
          ),
        ),
      ),
  );

  it.effect("is unaffected by an unrelated flag containing the same substring", () =>
    Effect.gen(function* () {
      const result = yield* legacyResolveDebug;
      expect(result).toBe(true);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(LegacyDebugFlag, true),
          Layer.succeed(CliArgs, { args: ["--some-other-debug-flag=false"] }),
        ),
      ),
    ),
  );
});
